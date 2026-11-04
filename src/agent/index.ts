import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import type {
  AgentRequest,
  AgentResponse,
  ToolName
} from '../shared/protocol.js'
import { runCodingTool, setCommandExecutionEnabled } from './coding-tools.js'
import keytar from 'keytar'

async function getConfig () {
  const get = async (key: string, fallback?: string) => {
    const value = await keytar.getPassword('chatgpt-mcp', key)
    if (value !== null) return value
    return fallback
  }

  return {
    serverUrl: process.env.SERVER_URL || (await get('SERVER_URL')) || 'ws://127.0.0.1:8787/agent',
    agentToken: process.env.AGENT_TOKEN || await get('AGENT_TOKEN'),
    agentId: process.env.AGENT_ID || (await get('AGENT_ID')) || os.hostname(),
    allowCommandExecution: process.env.ALLOW_COMMAND_EXECUTION || await get('ALLOW_COMMAND_EXECUTION')
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
  setCommandExecutionEnabled(ALLOW_COMMAND_EXECUTION)
  const IS_WINDOWS = process.platform === 'win32'
  const IS_LINUX = process.platform === 'linux'

  if (!AGENT_TOKEN) throw new Error('AGENT_TOKEN must be set')

  const AGENT_WORKSPACE = path.resolve(
    process.env.AGENT_WORKSPACE ??
      (IS_LINUX ? '/tmp/mcp-agent-workspace' : 'D:\\mcp-agent-workspace')
  )

  function assertAllowed (target: string, operation: string) {
    const resolved = path.resolve(target)
    const normalizedResolved = IS_WINDOWS ? resolved.toLowerCase() : resolved
    const normalizedRoot = IS_WINDOWS
      ? AGENT_WORKSPACE.toLowerCase()
      : AGENT_WORKSPACE
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
        const bytes = await fs.readFile(file)
        return { path: file, content: bytes.toString('utf8'), sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
      }
      case 'write_file': {
        const file = assertAllowed(String(request.args.path), 'write_file')
        const content = String(request.args.content)
        const expectedSha256 = typeof request.args.expectedSha256 === 'string' ? request.args.expectedSha256.toLowerCase() : undefined
        let current: Buffer | undefined
        try { current = await fs.readFile(file) } catch (error: any) { if (error.code !== 'ENOENT') throw error }
        if (current && !expectedSha256) throw new Error('expectedSha256 is required when overwriting an existing file; read the file first')
        if (!current && expectedSha256) throw new Error('File changed since it was read: file no longer exists')
        const beforeSha256 = current ? crypto.createHash('sha256').update(current).digest('hex') : null
        if (expectedSha256 && beforeSha256 !== expectedSha256) throw new Error(`File changed since it was read: expected sha256 ${expectedSha256}, current sha256 ${beforeSha256}`)
        const temporary = path.join(path.dirname(file), `.${path.basename(file)}.mcp-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`)
        try {
          await fs.writeFile(temporary, content, 'utf8')
          const latest = await fs.readFile(file).catch((error: any) => error.code === 'ENOENT' ? undefined : Promise.reject(error))
          const latestSha256 = latest ? crypto.createHash('sha256').update(latest).digest('hex') : null
          if (latestSha256 !== beforeSha256) throw new Error('File changed while the write was being prepared; refusing to overwrite it')
          await fs.rename(temporary, file)
        } finally { await fs.rm(temporary, { force: true }) }
        const after = Buffer.from(content, 'utf8')
        return { ok: true, path: file, sha256Before: beforeSha256, sha256After: crypto.createHash('sha256').update(after).digest('hex'), bytesAfter: after.length }
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
        const expectedSha256 = typeof request.args.expectedSha256 === 'string' ? request.args.expectedSha256.toLowerCase() : ''
        if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new Error('expectedSha256 is required; read the source file first')
        const sourceBytes = await fs.readFile(source)
        const sourceSha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex')
        if (sourceSha256 !== expectedSha256) throw new Error(`File changed since it was read: expected sha256 ${expectedSha256}, current sha256 ${sourceSha256}`)
        try { await fs.access(destination); throw new Error(`Destination already exists: ${destination}`) } catch (error: any) { if (error.code !== 'ENOENT') throw error }
        const latest = await fs.readFile(source)
        if (crypto.createHash('sha256').update(latest).digest('hex') !== expectedSha256) throw new Error('File changed while the move was being prepared; refusing to move it')
        await fs.rename(source, destination)
        return { ok: true, source, destination, sha256: expectedSha256 }
      }
      case 'delete_file': {
        const target = assertAllowed(String(request.args.path), 'delete_file')
        const expectedSha256 = typeof request.args.expectedSha256 === 'string' ? request.args.expectedSha256.toLowerCase() : ''
        if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new Error('expectedSha256 is required; read the file first')
        const bytes = await fs.readFile(target)
        const currentSha256 = crypto.createHash('sha256').update(bytes).digest('hex')
        if (currentSha256 !== expectedSha256) throw new Error(`File changed since it was read: expected sha256 ${expectedSha256}, current sha256 ${currentSha256}`)
        const latest = await fs.readFile(target)
        if (crypto.createHash('sha256').update(latest).digest('hex') !== expectedSha256) throw new Error('File changed while deletion was being prepared; refusing to delete it')
        await fs.unlink(target)
        return { ok: true, path: target, sha256Before: currentSha256 }
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
          workspace: AGENT_WORKSPACE,
          commandExecutionEnabled: ALLOW_COMMAND_EXECUTION
        }
      default:
        return runCodingTool(request.tool, request.args, AGENT_WORKSPACE, logCommand)
    }
  }

  function connect () {
    console.log(`[agent] connecting to ${SERVER_URL}`)
    let ws: WebSocket
    try {
      ws = new WebSocket(SERVER_URL, {
        headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
        handshakeTimeout: 15_000
      })
    } catch (error) {
      console.error('[agent] websocket construction failed:', error instanceof Error ? error.stack ?? error.message : String(error))
      setTimeout(connect, 3000)
      return
    }
    let alive = true
    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      if (!alive) {
        console.error('[agent] heartbeat timed out; terminating stale websocket')
        ws.terminate()
        return
      }
      alive = false
      try { ws.ping() } catch (error) { console.error('[agent] websocket ping failed:', error instanceof Error ? error.message : String(error)); ws.terminate() }
    }, 30_000)
    ws.on('pong', () => { alive = true })
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'hello',
          agentId: AGENT_ID,
          hostname: os.hostname(),
          platform: process.platform,
          version: AGENT_VERSION
        })
      )
      console.log(`[agent] connected as ${AGENT_ID}`)
    })
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
      const intent =
        typeof request.args?.intent === 'string'
          ? request.args.intent.trim()
          : ''
      const time = `${new Date()
        .getHours()
        .toString()
        .padStart(2, '0')}:${new Date()
        .getMinutes()
        .toString()
        .padStart(2, '0')}`
      console.log(`[agent][${time}] tool=${request.tool} requestId=${request.id} started`)
      if (intent) console.log(`[agent][${time}] intent: ${intent}`)
      else
        console.log(`[agent][${time}] intent: (missing) tool=${request.tool}`)
      const response: AgentResponse = {
        type: 'response',
        id: request.id,
        ok: false
      }
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
        ws.send(serialized)
      } else console.error(`[agent][${time}] tool=${request.tool} requestId=${request.id} FAILED: WebSocket is not open; response could not be delivered`)
    })
    ws.on('close', (code, reason) => {
      clearInterval(heartbeat)
      console.error(`[agent] websocket closed code=${code} reason=${reason.toString() || '(empty)'}; reconnecting in 3s`)
      setTimeout(connect, 3000)
    })
    ws.on('error', error => console.error('[agent] websocket error:', error.stack ?? error.message))
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
  console.log(`[agent] workspace: ${AGENT_WORKSPACE}`)
  console.log(
    `[agent] command execution: ${
      ALLOW_COMMAND_EXECUTION ? 'ENABLED' : 'DISABLED'
    }`
  )
  connect()
}).catch(error => {
  console.error('[agent] fatal startup/configuration error:', error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})

process.on('uncaughtException', error => {
  console.error('[agent] uncaught exception:', error.stack ?? error.message)
})
process.on('unhandledRejection', reason => {
  console.error('[agent] unhandled rejection:', reason instanceof Error ? reason.stack ?? reason.message : String(reason))
})
