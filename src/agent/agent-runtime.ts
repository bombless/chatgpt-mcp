import type { AgentMetadata, LocalAgentHandler } from '../shared/protocol.js'
import type { AgentRequest, AgentResponse } from '../shared/protocol.js'
import { createAgentRuntime } from './agent-core.js'
import WebSocket from 'ws'

/** In-process registration: gateway calls handleRequest directly (no WebSocket). */
export async function startLocalAgent (registry: {
  addLocal: (agentId: string, metadata: AgentMetadata, handler: LocalAgentHandler) => void
}) {
  const runtime = await createAgentRuntime()
  runtime.logStartup('local-in-process')
  registry.addLocal(runtime.agentId, runtime.metadata, runtime.handleRequest)
  console.log(`[agent] embedded agent ready as ${runtime.agentId} (zero-IPC)`)
  return runtime
}

/** Standalone agent: connect to gateway over WebSocket (remote or loopback). */
export async function startWebSocketAgent () {
  const runtime = await createAgentRuntime()
  const ctx = (runtime.handleRequest as any)._wsContext as {
    SERVER_URL: string
    AGENT_TOKEN: string
    AGENT_ID: string
    run: (request: AgentRequest) => Promise<unknown>
  }
  const { SERVER_URL, AGENT_TOKEN, AGENT_ID } = ctx
  runtime.logStartup('websocket')

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
          hostname: runtime.metadata.hostname,
          platform: runtime.metadata.platform,
          username: runtime.metadata.username,
          workspace: runtime.metadata.workspace,
          version: runtime.metadata.version
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
      const response: AgentResponse = {
        type: 'response',
        id: request.id,
        ok: false
      }
      try {
        response.result = await runtime.handleRequest(request)
        response.ok = true
      } catch (error) {
        response.error = error instanceof Error ? error.message : String(error)
      }
      if (ws.readyState === WebSocket.OPEN) {
        const serialized = JSON.stringify(response)
        const time = `${new Date().getHours().toString().padStart(2, '0')}:${new Date().getMinutes().toString().padStart(2, '0')}`
        console.log(`[agent][${time}] tool=${request.tool} requestId=${request.id} response=${response.ok ? 'ok' : 'error'} payloadBytes=${Buffer.byteLength(serialized, 'utf8')}`)
        ws.send(serialized)
      } else console.error(`[agent] tool=${request.tool} requestId=${request.id} FAILED: WebSocket is not open; response could not be delivered`)
    })
    ws.on('close', (code, reason) => {
      clearInterval(heartbeat)
      console.error(`[agent] websocket closed code=${code} reason=${reason.toString() || '(empty)'}; reconnecting in 3s`)
      setTimeout(connect, 3000)
    })
    ws.on('error', error => console.error('[agent] websocket error:', error.stack ?? error.message))
  }

  connect()
}
