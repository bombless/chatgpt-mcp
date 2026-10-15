import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import type {
  AgentRequest,
  AgentResponse,
  ToolName
} from '../shared/protocol.js'
import { runCodingTool } from './coding-tools.js'
import keytar from 'keytar'

async function getConfig () {
  const get = async (key: string, fallback?: string) => {
    const value = await keytar.getPassword('chatgpt-mcp', key)
    if (value !== null) return value
    return fallback
  }

  return {
    serverUrl: process.env.SERVER_URL || (await get('SERVER_URL')) || 'ws://127.0.0.1:8787/agent',
    agentToken: await get('AGENT_TOKEN'),
    agentId: process.env.AGENT_ID || (await get('AGENT_ID')) || os.hostname(),
    allowCommandExecution: await get('ALLOW_COMMAND_EXECUTION')
  }
}

getConfig().then(config => {
  const execFileAsync = promisify(execFile)
  const SERVER_URL = config.serverUrl
  const AGENT_TOKEN = config.agentToken
  const AGENT_ID = config.agentId
  const AGENT_VERSION = '0.2.0'
  const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_BYTES ?? 1_000_000)
  const ALLOW_COMMAND_EXECUTION = config.allowCommandExecution === 'true'
  const IS_WINDOWS = process.platform === 'win32'
  const IS_LINUX = process.platform === 'linux'

  if (!AGENT_TOKEN) throw new Error('AGENT_TOKEN must be set')

  const WORKSPACE_ROOT = path.resolve(
    process.env.AGENT_WORKSPACE ??
      (IS_LINUX ? '/tmp/mcp-agent-workspace' : 'D:\\mcp-agent-workspace')
  )

  function assertAllowed (target: string, operation: string) {
    const resolved = path.resolve(target)
    const normalizedResolved = IS_WINDOWS ? resolved.toLowerCase() : resolved
    const normalizedRoot = IS_WINDOWS
      ? WORKSPACE_ROOT.toLowerCase()
      : WORKSPACE_ROOT
    const ok =
      normalizedResolved === normalizedRoot ||
      normalizedResolved.startsWith(normalizedRoot + path.sep)
    if (!ok) throw new Error(`Path is outside agent workspace: ${resolved}`)
    return resolved
  }

  function logCommand (command: string, cwd?: string) {
    console.log(`[agent] $ ${command}${cwd ? ` (cwd: ${cwd})` : ''}`)
  }

  async function run (request: AgentRequest): Promise<unknown> {
    switch (request.tool as ToolName) {
      case 'read_file': {
        const file = assertAllowed(String(request.args.path), 'read_file')
        return await fs.readFile(file, 'utf8')
      }
      case 'write_file': {
        const file = assertAllowed(String(request.args.path), 'write_file')
        const content = String(request.args.content)
        await fs.writeFile(file, content, 'utf8')
        return { ok: true, path: file }
      }
      case 'list_directory': {
        const dir = assertAllowed(String(request.args.path), 'list_directory')
        const entries = await fs.readdir(dir, { withFileTypes: true })
        return entries.map(entry => ({
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file'
        }))
      }
      case 'move_file': {
        const source = assertAllowed(
          String(request.args.source),
          'move_file source'
        )
        const destination = assertAllowed(
          String(request.args.destination),
          'move_file destination'
        )
        await fs.rename(source, destination)
        return { ok: true, source, destination }
      }
      case 'delete_file': {
        const target = assertAllowed(String(request.args.path), 'delete_file')
        const stat = await fs.lstat(target)
        if (stat.isDirectory()) await fs.rmdir(target)
        else await fs.unlink(target)
        return { ok: true, path: target }
      }
      case 'execute_powershell': {
        if (!IS_WINDOWS)
          throw new Error(
            'execute_powershell is only available on Windows; use execute_bash on Linux.'
          )
        if (!ALLOW_COMMAND_EXECUTION)
          throw new Error(
            'PowerShell execution is disabled. Set ALLOW_COMMAND_EXECUTION=true on the Windows agent to enable it.'
          )
        const command = String(request.args.command)
        logCommand(
          `pwsh.exe -NoLogo -NoProfile -NonInteractive -Command ${command}`
        )
        try {
          const result = await execFileAsync(
            'pwsh.exe',
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
            { windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES }
          )
          return { stdout: result.stdout, stderr: result.stderr, code: 0 }
        } catch (error: any) {
          return {
            stdout: String(error.stdout ?? ''),
            stderr: String(error.stderr ?? error.message ?? error),
            code: typeof error.status === 'number' ? error.status : 1
          }
        }
      }
      case 'execute_bash': {
        if (!IS_LINUX)
          throw new Error('execute_bash is only available on Linux.')
        if (!ALLOW_COMMAND_EXECUTION)
          throw new Error(
            'Bash execution is disabled. Set ALLOW_COMMAND_EXECUTION=true on the Linux agent to enable it.'
          )
        const command = String(request.args.command)
        logCommand(`bash -lc ${JSON.stringify(command)}`)
        try {
          const result = await execFileAsync('/bin/bash', ['-lc', command], {
            maxBuffer: MAX_OUTPUT_BYTES
          })
          return { stdout: result.stdout, stderr: result.stderr, code: 0 }
        } catch (error: any) {
          return {
            stdout: String(error.stdout ?? ''),
            stderr: String(error.stderr ?? error.message ?? error),
            code: typeof error.status === 'number' ? error.status : 1
          }
        }
      }
      case 'get_system_info':
        return {
          hostname: os.hostname(),
          platform: process.platform,
          arch: process.arch,
          release: os.release(),
          workspace: WORKSPACE_ROOT,
          commandExecutionEnabled: ALLOW_COMMAND_EXECUTION
        }
      default:
        return runCodingTool(request.tool, request.args, logCommand)
    }
  }

  const HEARTBEAT_INTERVAL_MS = Number(process.env.AGENT_HEARTBEAT_INTERVAL_MS ?? 25_000)
  const HEARTBEAT_TIMEOUT_MS = Number(process.env.AGENT_HEARTBEAT_TIMEOUT_MS ?? 65_000)
  let reconnectTimer: NodeJS.Timeout | undefined
  let reconnectDelayMs = 3_000

  function connect () {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
    console.log(`[agent] connecting to ${SERVER_URL}`)
    const ws = new WebSocket(SERVER_URL, {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
      handshakeTimeout: 15_000
    })
    let lastPongAt = Date.now()
    let heartbeatTimer: NodeJS.Timeout | undefined
    let closed = false

    const scheduleReconnect = (reason: string) => {
      if (closed) return
      closed = true
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      console.warn(`[agent] connection ended (${reason}); reconnecting in ${reconnectDelayMs}ms`)
      reconnectTimer = setTimeout(connect, reconnectDelayMs)
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000)
    }

    ws.on('open', () => {
      reconnectDelayMs = 3_000
      lastPongAt = Date.now()
      ws.send(JSON.stringify({
        type: 'hello',
        agentId: AGENT_ID,
        hostname: os.hostname(),
        platform: process.platform,
        version: AGENT_VERSION
      }))
      console.log(`[agent] connected as ${AGENT_ID}; heartbeat every ${HEARTBEAT_INTERVAL_MS}ms`)
      heartbeatTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return
        const silenceMs = Date.now() - lastPongAt
        if (silenceMs > HEARTBEAT_TIMEOUT_MS) {
          console.error(`[agent] heartbeat timed out after ${silenceMs}ms; terminating stale socket`)
          ws.terminate()
          return
        }
        try {
          ws.ping()
        } catch (error) {
          console.error('[agent] failed to send heartbeat:', error)
          ws.terminate()
        }
      }, HEARTBEAT_INTERVAL_MS)
      heartbeatTimer.unref?.()
    })
    ws.on('pong', () => { lastPongAt = Date.now() })
    ws.on('message', async raw => {
      let request: AgentRequest
      try {
        request = JSON.parse(raw.toString()) as AgentRequest
      } catch {
        console.error('[agent] invalid JSON request')
        return
      }
      if ((request as any).type === 'server_diagnostic') {
        const diagnostic = request as any
        console.error(`[agent][server][${diagnostic.level ?? 'error'}] tool=${diagnostic.tool ?? 'unknown'}${diagnostic.requestId ? ` requestId=${diagnostic.requestId}` : ''}: ${diagnostic.message ?? 'unspecified server diagnostic'}`)
        return
      }
      if (request.type !== 'request' || !request.id || !request.tool) return
      const intent = typeof request.args?.intent === 'string' ? request.args.intent.trim() : ''
      const now = new Date()
      const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`
      console.log(`[agent][${time}] tool=${request.tool} requestId=${request.id} started`)
      if (intent) console.log(`[agent][${time}] intent: ${intent}`)
      else console.log(`[agent][${time}] intent: (missing) tool=${request.tool}`)
      const response: AgentResponse = { type: 'response', id: request.id, ok: false }
      try {
        response.result = await run(request)
        response.ok = true
      } catch (error) {
        response.error = error instanceof Error ? error.message : String(error)
        console.error(`[agent][${time}] tool=${request.tool} requestId=${request.id} FAILED: ${response.error}`)
      }
      if (ws.readyState === WebSocket.OPEN) {
        const serialized = JSON.stringify(response)
        console.log(`[agent][${time}] tool=${request.tool} requestId=${request.id} response=${response.ok ? 'ok' : 'error'} payloadBytes=${Buffer.byteLength(serialized, 'utf8')}`)
        ws.send(serialized, error => {
          if (error) console.error(`[agent] failed sending response requestId=${request.id}:`, error.message)
        })
      } else {
        console.error(`[agent][${time}] tool=${request.tool} requestId=${request.id} FAILED: WebSocket is not open; response could not be delivered`)
      }
    })
    ws.on('close', (code, reason) => {
      scheduleReconnect(`close code=${code} reason=${reason.toString() || '(none)'}`)
    })
    ws.on('error', error => {
      console.error('[agent] websocket error:', error.message)
      // The close event normally follows; terminate to guarantee reconnect if it does not.
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
      else scheduleReconnect(`error: ${error.message}`)
    })
  }

  console.log(
    `[agent] mode: ${
      IS_WINDOWS
        ? 'windows/powershell'
        : IS_LINUX
        ? 'linux/bash'
        : process.platform
    }`
  )
  console.log(`[agent] workspace: ${WORKSPACE_ROOT}`)
  console.log(
    `[agent] command execution: ${
      ALLOW_COMMAND_EXECUTION ? 'ENABLED' : 'DISABLED'
    }`
  )
  connect()
}).catch(error => {
  console.error('[agent] fatal startup error:', error instanceof Error ? error.stack ?? error.message : error)
  process.exitCode = 1
})
