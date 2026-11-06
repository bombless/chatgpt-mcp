import { createServer as createHttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { AgentMessage } from '../shared/protocol.js';
import { isValidAgentId } from '../shared/agent-id.js';
import { AgentRegistry } from './agent-registry.js';
import { createExpressApp } from './express-app.js';

const PORT = Number(process.env.PORT ?? 8787);
const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 8788);
const AGENT_TOKEN = process.env.AGENT_TOKEN;
const LEGACY_MCP_TOKEN = process.env.MCP_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : undefined;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 60_000);
const MCP_DEBUG = process.env.MCP_DEBUG === '1' || process.env.DEBUG_MCP === '1';
if (!AGENT_TOKEN) throw new Error('AGENT_TOKEN must be set');

function mcpDebug(event: string, details: Record<string, unknown> = {}) { if (MCP_DEBUG) console.log(`[mcp] ${event} ${JSON.stringify(details)}`); }

const registry = new AgentRegistry(REQUEST_TIMEOUT_MS, mcpDebug);
const app = createExpressApp(registry, { adminPort: ADMIN_PORT, legacyMcpToken: LEGACY_MCP_TOKEN, mcpDebugEnabled: MCP_DEBUG, mcpDebug });

const httpServer = createHttpServer(app);
const wss = new WebSocketServer({ noServer: true });
const aliveSockets = new WeakSet<WebSocket>();
const heartbeatTimer = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (!aliveSockets.has(ws)) {
      console.error('[agent][heartbeat] no pong received; terminating stale websocket');
      ws.terminate();
      continue;
    }
    aliveSockets.delete(ws);
    try { ws.ping(); } catch (error) { console.error('[agent][heartbeat] ping failed:', error); ws.terminate(); }
  }
}, 30_000);
heartbeatTimer.unref();
httpServer.on('upgrade', (req, socket, head) => {
  if (req.url !== '/agent') return socket.destroy();
  if (req.headers.authorization !== `Bearer ${AGENT_TOKEN}`) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
wss.on('connection', ws => {
  aliveSockets.add(ws);
  ws.on('pong', () => aliveSockets.add(ws));
  let agentId: string | undefined;
  let initialized = false;
  ws.on('message', raw => {
    try {
      const message = JSON.parse(raw.toString()) as AgentMessage;
      if (message.type === 'hello') {
        if (!isValidAgentId(message.agentId)) return ws.close(4002, 'invalid agentId');
        const connectedAgentId = message.agentId;
        agentId = connectedAgentId;
        initialized = true;
        registry.add(connectedAgentId, ws, {
          hostname: typeof message.hostname === 'string' ? message.hostname : connectedAgentId,
          platform: typeof message.platform === 'string' ? message.platform : 'unknown',
          username: typeof message.username === 'string' ? message.username : 'unknown',
          workspace: typeof message.workspace === 'string' ? message.workspace : 'unknown',
          version: typeof message.version === 'string' ? message.version : 'unknown',
        });
        console.log(`[agent] connected ${agentId} (${message.hostname})`);
        return;
      }
      if (!initialized) return ws.close(4003, 'hello required');
      registry.handleMessage(message);
    } catch { ws.close(4004, 'invalid message'); }
  });
  const time = `${new Date().getHours().toString().padStart(2, '0')}:${new Date().getMinutes().toString().padStart(2, '0')}`;
  ws.on('close', (code, reason) => { if (agentId) console.error(`[agent][${time}] disconnected ${agentId} code=${code} reason=${reason.toString() || '(empty)'}`); });
  ws.on('error', error => console.error(`[agent][${time}] websocket error${agentId ? ` ${agentId}` : ''}:`, error.message));
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`MCP gateway listening on :${PORT}`);
  if (PUBLIC_URL) {
    console.log(`Public MCP: ${PUBLIC_URL}/mcp`);
    console.log(`Agent endpoint: ${PUBLIC_URL}/agent`);
  } else {
    console.log(`Public MCP: dynamic (determined by request Host header, e.g. https://<your-host>/mcp)`);
    console.log(`Agent endpoint: ws://127.0.0.1:${PORT}/agent (or wss://<your-host>/agent)`);
  }
  console.log(`Debug logging: MCP=${MCP_DEBUG ? 'on' : 'off'}`);
});
