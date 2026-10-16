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

function timeString (): string {
  const d = new Date()
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  const ss = d.getSeconds().toString().padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

function agentLog (...args: unknown[]) {
  console.log(`[agent][${timeString()}]`, ...args)
}

function agentError (...args: unknown[]) {
  console.error(`[agent][${timeString()}]`, ...args)
}

async function getConfig () {
  const get = async (key: string, fallback?: string) => {
    try {
      const value = await keytar.getPassword('chatgpt-mcp', key)
      if (value !== null) return value
    } catch {
      // Keytar might fail on some platforms or permissions; fallback to env
    }
    return fallback
  }

  return {
    serverUrl: process.env.SERVER_URL || (await get('SERVER_URL')) || 'ws://127.0.0.1:8787/agent',
    agentToken: process.env.AGENT_TOKEN || (await get('AGENT_TOKEN')),
    agentId: process.env.AGENT_ID || (await get('AGENT_ID')) || os.hostname(),
    allowCommandExecution: process.env.ALLOW_COMMAND_EXECUTION || (await get('ALLOW_COMMAND_EXECUTION'))
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

  const PING_INTERVAL_MS = Number(process.env.AGENT_PING_INTERVAL_MS ?? 20_000)
  const PING_TIMEOUT_MS = Number(process.env.AGENT_PING_TIMEOUT_MS ?? 10_000)
  const RECONNECT_DELAY_MS = Number(process.env.AGENT_RECONNECT_DELAY_MS ?? 3_000)
  const STATUS_INTERVAL_MS = Number(process.env.AGENT_STATUS_INTERVAL_MS ?? 300_000) // 5 minutes
  const AGENT_DEBUG = process.env.AGENT_DEBUG === '1' || process.env.DEBUG === '1'

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
    agentLog(`$ ${command}${cwd ? ` (cwd: ${cwd})` : ''}`)
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

  let currentWs: WebSocket | null = null
  let pingTimer: NodeJS.Timeout | null = null
  let pongTimeoutTimer: NodeJS.Timeout | null = null
  let statusTimer: NodeJS.Timeout | null = null
  let reconnectTimer: NodeJS.Timeout | null = null
  let connectionStartTime = 0
  let lastPingTime = 0
  let lastPongLatency = 0
  let terminationReason = ''

  function clearHeartbeatTimers () {
    if (pingTimer) {
      clearInterval(pingTimer)
      pingTimer = null
    }
    if (pongTimeoutTimer) {
      clearTimeout(pongTimeoutTimer)
      pongTimeoutTimer = null
    }
    if (statusTimer) {
      clearInterval(statusTimer)
      statusTimer = null
    }
  }

  function scheduleReconnect (delayMs: number) {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delayMs)
  }

  function startHeartbeat (ws: WebSocket) {
    clearHeartbeatTimers()

    pingTimer = setInterval(() => {
      if (ws !== currentWs || ws.readyState !== WebSocket.OPEN) return

      lastPingTime = Date.now()

      // If pong is not received within PING_TIMEOUT_MS, declare connection dead
      pongTimeoutTimer = setTimeout(() => {
        if (ws !== currentWs) return
        terminationReason = `Heartbeat timeout: server did not respond to ping within ${PING_TIMEOUT_MS / 1000}s`
        agentError(`${terminationReason}. Terminating connection and reconnecting...`)
        try {
          ws.terminate()
        } catch (err: any) {
          agentError(`Error terminating socket: ${err.message}`)
        }
      }, PING_TIMEOUT_MS)

      try {
        ws.ping()
        if (AGENT_DEBUG) {
          agentLog('Ping sent')
        }
      } catch (err: any) {
        agentError(`Failed to send ping: ${err.message}`)
      }
    }, PING_INTERVAL_MS)

    // Periodic heartbeat summary every STATUS_INTERVAL_MS (default 5m)
    statusTimer = setInterval(() => {
      if (ws !== currentWs || ws.readyState !== WebSocket.OPEN) return
      const uptimeMins = Math.floor((Date.now() - connectionStartTime) / 60_000)
      const latencyStr = lastPongLatency > 0 ? `, last ping rtt: ${lastPongLatency}ms` : ''
      agentLog(`Heartbeat active: connection healthy (uptime: ${uptimeMins}m${latencyStr})`)
    }, STATUS_INTERVAL_MS)
  }

  function connect () {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    clearHeartbeatTimers()

    agentLog(`Connecting to ${SERVER_URL} ...`)

    let ws: WebSocket
    try {
      ws = new WebSocket(SERVER_URL, {
        headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
        handshakeTimeout: 10_000
      })
      currentWs = ws
    } catch (err: any) {
      agentError(`Failed to initialize WebSocket: ${err.message}`)
      scheduleReconnect(RECONNECT_DELAY_MS)
      return
    }

    ws.on('open', () => {
      if (ws !== currentWs) return
      connectionStartTime = Date.now()
      lastPingTime = 0
      lastPongLatency = 0
      terminationReason = ''

      // Enable TCP keepalive if underlying socket is available
      try {
        const netSocket = (ws as any)._socket
        if (netSocket && typeof netSocket.setKeepAlive === 'function') {
          netSocket.setKeepAlive(true, 15_000)
        }
      } catch {
        // Best effort
      }

      ws.send(
        JSON.stringify({
          type: 'hello',
          agentId: AGENT_ID,
          hostname: os.hostname(),
          platform: process.platform,
          version: AGENT_VERSION
        })
      )
      agentLog(`Connected as ${AGENT_ID}`)
      agentLog(`Heartbeat keepalive active (interval: ${PING_INTERVAL_MS / 1000}s, timeout: ${PING_TIMEOUT_MS / 1000}s)`)

      startHeartbeat(ws)
    })

    ws.on('pong', () => {
      if (ws !== currentWs) return
      if (pongTimeoutTimer) {
        clearTimeout(pongTimeoutTimer)
        pongTimeoutTimer = null
      }
      if (lastPingTime) {
        lastPongLatency = Date.now() - lastPingTime
      }
      if (AGENT_DEBUG) {
        agentLog(`Pong received (rtt: ${lastPongLatency}ms)`)
      }
    })

    ws.on('ping', () => {
      if (ws !== currentWs) return
      if (AGENT_DEBUG) {
        agentLog('Server ping received')
      }
    })

    ws.on('message', async raw => {
      if (pongTimeoutTimer) {
        clearTimeout(pongTimeoutTimer)
        pongTimeoutTimer = null
      }

      let request: AgentRequest
      try {
        request = JSON.parse(raw.toString()) as AgentRequest
      } catch {
        agentError('Invalid JSON request')
        return
      }
      if ((request as any).type === 'server_diagnostic') {
        const diagnostic = request as any
        agentError(`[server][${diagnostic.level ?? 'error'}] tool=${diagnostic.tool ?? 'unknown'}${diagnostic.requestId ? ` requestId=${diagnostic.requestId}` : ''}: ${diagnostic.message ?? 'unspecified server diagnostic'}`)
        return
      }
      if (request.type !== 'request' || !request.id || !request.tool) return
      const intent =
        typeof request.args?.intent === 'string'
          ? request.args.intent.trim()
          : ''
      agentLog(`tool=${request.tool} requestId=${request.id} started`)
      if (intent) agentLog(`intent: ${intent}`)
      else agentLog(`intent: (missing) tool=${request.tool}`)

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
        agentError(`tool=${request.tool} requestId=${request.id} FAILED: ${response.error}`)
      }
      if (ws.readyState === WebSocket.OPEN) {
        const serialized = JSON.stringify(response)
        agentLog(`tool=${request.tool} requestId=${request.id} response=${response.ok ? 'ok' : 'error'} payloadBytes=${Buffer.byteLength(serialized, 'utf8')}`)
        ws.send(serialized, err => {
          if (err) {
            agentError(`tool=${request.tool} requestId=${request.id} FAILED to deliver response: ${err.message}`)
          }
        })
      } else {
        agentError(`tool=${request.tool} requestId=${request.id} FAILED: WebSocket is not open (readyState=${ws.readyState}); response could not be delivered`)
      }
    })

    ws.on('close', (code, reasonBuf) => {
      if (ws === currentWs) {
        currentWs = null
      }
      clearHeartbeatTimers()

      const reasonStr = reasonBuf ? reasonBuf.toString('utf8') : ''
      const detail = terminationReason || reasonStr || ''
      terminationReason = ''

      let delay = RECONNECT_DELAY_MS

      if (code === 4000) {
        delay = 15_000
        agentError(
          `Disconnected by server: another connection registered with agentId "${AGENT_ID}" (code: 4000). Waiting ${delay / 1000}s before reconnecting to prevent connection conflict...`
        )
      } else if (code === 4001) {
        delay = 10_000
        agentError(
          `Disconnected by server: authentication failed (code: 4001, invalid AGENT_TOKEN). Retrying in ${delay / 1000}s...`
        )
      } else if (code === 4002) {
        delay = 10_000
        agentError(
          `Disconnected by server: invalid agentId "${AGENT_ID}" (code: 4002). Retrying in ${delay / 1000}s...`
        )
      } else if (code === 4003) {
        agentError(`Disconnected by server: hello handshake required (code: 4003). Reconnecting in ${delay / 1000}s...`)
      } else if (code === 1006) {
        agentError(
          `Disconnected (code: 1006 abnormal closure${detail ? `, ${detail}` : ', network dropped or connection reset'}). Reconnecting in ${delay / 1000}s...`
        )
      } else {
        agentLog(
          `Disconnected from server (code: ${code}${detail ? `, reason: "${detail}"` : ''}). Reconnecting in ${delay / 1000}s...`
        )
      }

      scheduleReconnect(delay)
    })

    ws.on('error', error => {
      agentError(`WebSocket error: ${error.message}`)
    })
  }

  process.on('SIGINT', () => {
    agentLog('Received SIGINT, shutting down...')
    clearHeartbeatTimers()
    if (currentWs) {
      try { currentWs.close(1000, 'Agent shutting down') } catch {}
    }
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    agentLog('Received SIGTERM, shutting down...')
    clearHeartbeatTimers()
    if (currentWs) {
      try { currentWs.close(1000, 'Agent shutting down') } catch {}
    }
    process.exit(0)
  })

  process.on('uncaughtException', err => {
    agentError(`Uncaught exception: ${err?.stack || err}`)
  })

  process.on('unhandledRejection', reason => {
    agentError(`Unhandled rejection: ${reason instanceof Error ? reason.stack : reason}`)
  })

  agentLog(
    `Mode: ${
      IS_WINDOWS
        ? 'windows/powershell'
        : IS_LINUX
        ? 'linux/bash'
        : process.platform
    }`
  )
  agentLog(`Workspace: ${WORKSPACE_ROOT}`)
  agentLog(
    `Command execution: ${
      ALLOW_COMMAND_EXECUTION ? 'ENABLED' : 'DISABLED'
    }`
  )
  agentLog(`Server URL: ${SERVER_URL}`)
  connect()
}).catch(err => {
  console.error(`[agent] Fatal initialization error:`, err)
  process.exit(1)
})
