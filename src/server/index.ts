import { createServer as createHttpServer } from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { AgentMessage, AgentRequest, AgentResponse, ToolName } from '../shared/protocol.js';
import { approve, authorizationPage, exchangeToken, oauthMetadata, protectedResourceMetadata, registerClient, validAccessToken } from './oauth.js';

const PORT = Number(process.env.PORT ?? 8787);
const AGENT_TOKEN = process.env.AGENT_TOKEN;
const LEGACY_MCP_TOKEN = process.env.MCP_TOKEN;
const PUBLIC_URL = (process.env.PUBLIC_URL ?? 'https://bombless.duckdns.org').replace(/\/$/, '');
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 60_000);
const MCP_DEBUG = process.env.MCP_DEBUG === '1' || process.env.DEBUG_MCP === '1';
if (!AGENT_TOKEN) throw new Error('AGENT_TOKEN must be set');

function mcpDebug(event: string, details: Record<string, unknown> = {}) {
  if (!MCP_DEBUG) return;
  console.log(`[mcp] ${event} ${JSON.stringify(details)}`);
}
function requestId(req: express.Request) {
  return req.get('x-request-id') ?? crypto.randomUUID();
}
function safeAuthInfo(req: express.Request) {
  const authorization = req.header('authorization');
  return {
    hasAuthorization: Boolean(authorization),
    scheme: authorization?.split(/\s+/, 1)[0],
    tokenLength: authorization?.startsWith('Bearer ') ? authorization.slice(7).length : undefined,
  };
}

class AgentRegistry {
  private readonly agents = new Map<string, WebSocket>();
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  add(agentId: string, socket: WebSocket) { const old = this.agents.get(agentId); old?.close(4000, 'replaced by a newer connection'); this.agents.set(agentId, socket); socket.on('close', () => { if (this.agents.get(agentId) === socket) this.agents.delete(agentId); }); }
  get(agentId: string) { const socket = this.agents.get(agentId); return socket?.readyState === WebSocket.OPEN ? socket : undefined; }
  list() { return [...this.agents.keys()]; }
  async call(agentId: string, tool: ToolName, args: Record<string, unknown>) { const socket = this.get(agentId); if (!socket) { mcpDebug('agent-call:missing', { agentId, tool }); throw new Error(`Windows agent '${agentId}' is not connected`); } const id = crypto.randomUUID(); const request: AgentRequest = { type: 'request', id, tool, args }; mcpDebug('agent-call:start', { requestId: id, agentId, tool }); return await new Promise<unknown>((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); mcpDebug('agent-call:timeout', { requestId: id, agentId, tool, timeoutMs: REQUEST_TIMEOUT_MS }); reject(new Error(`Agent request timed out after ${REQUEST_TIMEOUT_MS}ms`)); }, REQUEST_TIMEOUT_MS); this.pending.set(id, { resolve: value => { clearTimeout(timer); mcpDebug('agent-call:success', { requestId: id, agentId, tool }); resolve(value); }, reject: error => { clearTimeout(timer); mcpDebug('agent-call:error', { requestId: id, agentId, tool, error: error.message }); reject(error); } }); try { socket.send(JSON.stringify(request)); } catch (error) { this.pending.delete(id); clearTimeout(timer); mcpDebug('agent-call:send-error', { requestId: id, agentId, tool, error: String(error) }); reject(error instanceof Error ? error : new Error(String(error))); } }); }
  handleMessage(message: AgentMessage) { if (message.type !== 'response') return; const response = message as AgentResponse; const item = this.pending.get(response.id); if (!item) { mcpDebug('agent-response:orphan', { requestId: response.id }); return; } this.pending.delete(response.id); if (response.ok) item.resolve(response.result); else item.reject(new Error(response.error ?? 'Agent request failed')); }
}
const registry = new AgentRegistry();
function resultContent(value: unknown) { return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }; }
function bearer(req: express.Request) { const value = req.header('authorization'); return value?.startsWith('Bearer ') ? value.slice(7) : undefined; }
function mcpAuthorized(req: express.Request) { const token = bearer(req); const oauthValid = validAccessToken(token); const legacyValid = !!LEGACY_MCP_TOKEN && token === LEGACY_MCP_TOKEN; mcpDebug('authorization:check', { ...safeAuthInfo(req), oauthValid, legacyValid }); return oauthValid || legacyValid; }
function mcpUnauthorized(res: express.Response, req?: express.Request) { if (req) mcpDebug('authorization:rejected', safeAuthInfo(req)); res.setHeader('WWW-Authenticate', `Bearer resource_metadata=\"${PUBLIC_URL}/.well-known/oauth-protected-resource\"`); return res.status(401).json({ error: 'unauthorized', error_description: 'OAuth access token required' }); }

function buildMcpServer() {
  const server = new McpServer({ name: 'chatgpt-windows-bridge', version: '0.2.0' });
  const agentIdSchema = z.string().min(1).describe('Windows agent ID, e.g. desktop-01');
  server.registerTool('list_agents', { description: 'List connected Windows computers.', inputSchema: z.object({}) }, async () => resultContent(registry.list()));
  server.registerTool('read_file', { description: 'Read a UTF-8 text file on Windows.', inputSchema: z.object({ agentId: agentIdSchema, path: z.string().min(1) }) }, async ({ agentId, path }) => resultContent(await registry.call(agentId, 'read_file', { path })));
  server.registerTool('write_file', { description: 'Write UTF-8 text to a Windows file. Parent directories must already exist.', inputSchema: z.object({ agentId: agentIdSchema, path: z.string().min(1), content: z.string() }) }, async ({ agentId, path, content }) => resultContent(await registry.call(agentId, 'write_file', { path, content })));
  server.registerTool('list_directory', { description: 'List a Windows directory.', inputSchema: z.object({ agentId: agentIdSchema, path: z.string().min(1) }) }, async ({ agentId, path }) => resultContent(await registry.call(agentId, 'list_directory', { path })));
  server.registerTool('move_file', { description: 'Move or rename a Windows file or directory.', inputSchema: z.object({ agentId: agentIdSchema, source: z.string().min(1), destination: z.string().min(1) }) }, async ({ agentId, source, destination }) => resultContent(await registry.call(agentId, 'move_file', { source, destination })));
  server.registerTool('delete_file', { description: 'Delete a Windows file or empty directory.', inputSchema: z.object({ agentId: agentIdSchema, path: z.string().min(1) }) }, async ({ agentId, path }) => resultContent(await registry.call(agentId, 'delete_file', { path })));
  server.registerTool('execute_powershell', { description: 'Execute PowerShell on Windows. Agent policy may disable it.', inputSchema: z.object({ agentId: agentIdSchema, command: z.string().min(1) }) }, async ({ agentId, command }) => resultContent(await registry.call(agentId, 'execute_powershell', { command })));
  server.registerTool('get_system_info', { description: 'Get basic Windows system information.', inputSchema: z.object({ agentId: agentIdSchema }) }, async ({ agentId }) => resultContent(await registry.call(agentId, 'get_system_info', {})));
  return server;
}

const app = express(); app.disable('x-powered-by'); app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => { const id = requestId(req); res.setHeader('X-Request-Id', id); if (MCP_DEBUG) mcpDebug('http:request', { requestId: id, method: req.method, path: req.path, query: req.query, ...safeAuthInfo(req) }); res.on('finish', () => { if (MCP_DEBUG) mcpDebug('http:response', { requestId: id, method: req.method, path: req.path, status: res.statusCode }); }); next(); });
app.get('/healthz', (_req, res) => res.json({ ok: true, agents: registry.list() }));
app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(oauthMetadata()));
app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json(protectedResourceMetadata()));
app.post('/oauth/register', (req, res) => { try { res.status(201).json(registerClient(req.body)); } catch (e) { res.status(400).json({ error: 'invalid_client_metadata', error_description: String(e instanceof Error ? e.message : e) }); } });
app.get('/oauth/authorize', (req, res) => { const result = authorizationPage(req); res.status(result.status).type('html').send(result.body); });
app.post('/oauth/authorize/approve', (req, res) => { const result = approve(req); if (result.location) return res.redirect(302, result.location); return res.status(result.status).send(result.body); });
app.post('/oauth/token', (req, res) => { try { res.json(exchangeToken(req.body)); } catch (e) { const error = String(e instanceof Error ? e.message : e); res.status(400).json({ error }); } });
app.get('/agents', (req, res) => { if (!mcpAuthorized(req)) return mcpUnauthorized(res, req); res.json({ agents: registry.list() }); });

// Caddy sets X-From-Caddy on public reverse-proxied requests. The admin UI is only
// available to direct loopback requests (for example through an SSH -L tunnel).
function isLocalAdminRequest(req: express.Request) {
  const ip = req.socket.remoteAddress ?? '';
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const fromCaddy = req.get('X-From-Caddy') === 'true';
  return loopback && !fromCaddy;
}
app.get('/', (req, res) => {
  if (!isLocalAdminRequest(req)) return res.status(404).send('Not found');
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ChatGPT MCP Gateway</title><style>body{font-family:system-ui,sans-serif;max-width:1000px;margin:32px auto;padding:0 16px;background:#f6f7f9;color:#17202a}section{background:white;border:1px solid #ddd;border-radius:12px;padding:18px;margin:14px 0}button{padding:8px 12px;margin:4px;border:1px solid #bbb;border-radius:8px;background:#fff;cursor:pointer}input,textarea,select{width:100%;box-sizing:border-box;padding:9px;margin:6px 0;border:1px solid #bbb;border-radius:8px}textarea{min-height:120px;font-family:monospace}pre{background:#111;color:#eee;padding:12px;border-radius:8px;overflow:auto}</style></head><body><h1>ChatGPT MCP Gateway</h1><section><h2>Agents</h2><button onclick="refresh()">Refresh</button><div id="agents">Loading...</div></section><section><h2>Directory</h2><select id="agent"></select><input id="dir" value="C:\\Users\\bombl\\Desktop"><button onclick="call('list_directory')">List Directory</button><pre id="out"></pre></section><section><h2>Read file</h2><input id="file" value="C:\\Users\\bombl\\Desktop\\mcp-test.txt"><button onclick="call('read_file')">Read</button></section><section><h2>Write file</h2><input id="writepath" value="C:\\Users\\bombl\\Desktop\\mcp-created.txt"><textarea id="content">Hello from MCP Gateway!</textarea><button onclick="call('write_file')">Write</button></section><section><h2>System Info</h2><button onclick="call('get_system_info')">Get System Info</button></section><script>const $=id=>document.getElementById(id);async function refresh(){const r=await fetch('/healthz');const j=await r.json();$('agents').innerHTML=j.agents.length?j.agents.map(x=>'🟢 '+x).join('<br>'):'No agents connected';$('agent').innerHTML=j.agents.map(x=>'<option>'+x+'</option>').join('')}async function call(tool){const agentId=$('agent').value;let args={agentId};if(tool==='list_directory')args.path=$('dir').value;if(tool==='read_file')args.path=$('file').value;if(tool==='write_file'){args.path=$('writepath').value;args.content=$('content').value}const r=await fetch('/_admin/call',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tool,args})});$('out').textContent=await r.text()}refresh();</script></body></html>`);
});
app.post('/_admin/call', async (req, res) => { if (!isLocalAdminRequest(req)) return res.status(404).send('Not found'); try { const { tool, args } = req.body ?? {}; if (!['list_directory','read_file','write_file','get_system_info'].includes(tool)) return res.status(400).json({error:'tool not allowed in admin UI'}); const result = await registry.call(String(args.agentId), tool as ToolName, args); res.json({ok:true,result}); } catch (e) { res.status(500).json({ok:false,error:String(e instanceof Error?e.message:e)}); } });

const mcpHandler = toNodeHandler(createMcpHandler(buildMcpServer));
app.all('/mcp', (req, res) => { if (!mcpAuthorized(req)) return mcpUnauthorized(res, req); mcpDebug('handler:dispatch', { method: req.method, contentType: req.get('content-type'), accept: req.get('accept') }); try { const result = mcpHandler(req, res); if (result && typeof (result as Promise<unknown>).then === 'function') { void (result as Promise<unknown>).then(() => mcpDebug('handler:complete', { method: req.method })).catch(error => mcpDebug('handler:error', { method: req.method, error: String(error instanceof Error ? error.stack ?? error.message : error) })); } } catch (error) { mcpDebug('handler:throw', { method: req.method, error: String(error instanceof Error ? error.stack ?? error.message : error) }); throw error; } });
const httpServer = createHttpServer(app); const wss = new WebSocketServer({ noServer: true });
httpServer.on('upgrade', (req, socket, head) => { if (req.url !== '/agent') return socket.destroy(); if (req.headers.authorization !== `Bearer ${AGENT_TOKEN}`) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; } wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)); });
wss.on('connection', ws => { let agentId: string | undefined; let initialized = false; ws.on('message', raw => { try { const message = JSON.parse(raw.toString()) as AgentMessage; if (message.type === 'hello') { if (!/^[a-zA-Z0-9._-]{1,64}$/.test(message.agentId)) return ws.close(4002, 'invalid agentId'); agentId = message.agentId; initialized = true; registry.add(agentId, ws); console.log(`[agent] connected ${agentId} (${message.hostname})`); return; } if (!initialized) return ws.close(4003, 'hello required'); registry.handleMessage(message); } catch { ws.close(4004, 'invalid message'); } }); ws.on('close', () => { if (agentId) console.log(`[agent] disconnected ${agentId}`); }); });
httpServer.listen(PORT, '0.0.0.0', () => { console.log(`MCP gateway listening on :${PORT}`); console.log(`Public MCP: ${PUBLIC_URL}/mcp`); console.log(`Agent endpoint: ${PUBLIC_URL}/agent`); console.log('Admin UI: http://127.0.0.1:' + PORT + '/ (loopback only)'); console.log(`Debug logging: OAuth=${OAUTH_DEBUG ? 'on' : 'off'} MCP=${MCP_DEBUG ? 'on' : 'off'}`); });
