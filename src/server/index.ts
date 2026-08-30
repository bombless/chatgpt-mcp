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
if (!AGENT_TOKEN) throw new Error('AGENT_TOKEN must be set');

class AgentRegistry {
  private readonly agents = new Map<string, WebSocket>();
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  add(agentId: string, socket: WebSocket) { const old = this.agents.get(agentId); old?.close(4000, 'replaced by a newer connection'); this.agents.set(agentId, socket); socket.on('close', () => { if (this.agents.get(agentId) === socket) this.agents.delete(agentId); }); }
  get(agentId: string) { const socket = this.agents.get(agentId); return socket?.readyState === WebSocket.OPEN ? socket : undefined; }
  list() { return [...this.agents.keys()]; }
  async call(agentId: string, tool: ToolName, args: Record<string, unknown>) { const socket = this.get(agentId); if (!socket) throw new Error(`Windows agent '${agentId}' is not connected`); const id = crypto.randomUUID(); const request: AgentRequest = { type: 'request', id, tool, args }; return await new Promise<unknown>((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Agent request timed out after ${REQUEST_TIMEOUT_MS}ms`)); }, REQUEST_TIMEOUT_MS); this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } }); try { socket.send(JSON.stringify(request)); } catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); } }); }
  handleMessage(message: AgentMessage) { if (message.type !== 'response') return; const response = message as AgentResponse; const item = this.pending.get(response.id); if (!item) return; this.pending.delete(response.id); if (response.ok) item.resolve(response.result); else item.reject(new Error(response.error ?? 'Agent request failed')); }
}
const registry = new AgentRegistry();
function resultContent(value: unknown) { return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }; }
function bearer(req: express.Request) { const value = req.header('authorization'); return value?.startsWith('Bearer ') ? value.slice(7) : undefined; }
function mcpAuthorized(req: express.Request) { const token = bearer(req); return validAccessToken(token) || (!!LEGACY_MCP_TOKEN && token === LEGACY_MCP_TOKEN); }
function mcpUnauthorized(res: express.Response) { res.setHeader('WWW-Authenticate', `Bearer resource_metadata=\"${PUBLIC_URL}/.well-known/oauth-protected-resource\"`); return res.status(401).json({ error: 'unauthorized', error_description: 'OAuth access token required' }); }

function buildMcpServer() {
  const server = new McpServer({ name: 'chatgpt-windows-bridge', version: '0.3.0' });
  const agentIdSchema = z.string().min(1).describe('Windows agent ID, e.g. desktop-01');
  const cwdSchema = z.string().min(1).optional().describe('Workspace directory; must be inside AGENT_WORKSPACE.');
  const codingTool = (name: ToolName, description: string, inputSchema: z.ZodTypeAny) => server.registerTool(name, { description, inputSchema }, async (args) => resultContent(await registry.call(String(args.agentId), name, args as Record<string, unknown>)));

  server.registerTool('list_agents', { description: 'List connected Windows computers.', inputSchema: z.object({}) }, async () => resultContent(registry.list()));
  server.registerTool('read_file', { description: 'Read a UTF-8 text file on Windows.', inputSchema: z.object({ agentId: agentIdSchema, path: z.string().min(1) }) }, async ({ agentId, path }) => resultContent(await registry.call(agentId, 'read_file', { path })));
  server.registerTool('write_file', { description: 'Write UTF-8 text to a Windows file. Parent directories must already exist.', inputSchema: z.object({ agentId: agentIdSchema, path: z.string().min(1), content: z.string() }) }, async ({ agentId, path, content }) => resultContent(await registry.call(agentId, 'write_file', { path, content })));
  server.registerTool('list_directory', { description: 'List a Windows directory.', inputSchema: z.object({ agentId: agentIdSchema, path: z.string().min(1) }) }, async ({ agentId, path }) => resultContent(await registry.call(agentId, 'list_directory', { path })));
  server.registerTool('move_file', { description: 'Move or rename a Windows file or directory.', inputSchema: z.object({ agentId: agentIdSchema, source: z.string().min(1), destination: z.string().min(1) }) }, async ({ agentId, source, destination }) => resultContent(await registry.call(agentId, 'move_file', { source, destination })));
  server.registerTool('delete_file', { description: 'Delete a Windows file or empty directory.', inputSchema: z.object({ agentId: agentIdSchema, path: z.string().min(1) }) }, async ({ agentId, path }) => resultContent(await registry.call(agentId, 'delete_file', { path })));
  server.registerTool('execute_powershell', { description: 'Execute PowerShell on Windows. Agent policy may disable it.', inputSchema: z.object({ agentId: agentIdSchema, command: z.string().min(1) }) }, async ({ agentId, command }) => resultContent(await registry.call(agentId, 'execute_powershell', { command })));
  server.registerTool('get_system_info', { description: 'Get basic Windows system information.', inputSchema: z.object({ agentId: agentIdSchema }) }, async ({ agentId }) => resultContent(await registry.call(agentId, 'get_system_info', {})));

  codingTool('run_npm', 'Run npm with arguments in the workspace. Requires ALLOW_COMMAND_EXECUTION=true.', z.object({ agentId: agentIdSchema, args: z.array(z.string()).default([]), cwd: cwdSchema }));
  codingTool('run_python', 'Run Python with arguments in the workspace. Requires ALLOW_COMMAND_EXECUTION=true.', z.object({ agentId: agentIdSchema, args: z.array(z.string()).default([]), cwd: cwdSchema }));
  codingTool('run_node', 'Run Node.js with arguments in the workspace. Requires ALLOW_COMMAND_EXECUTION=true.', z.object({ agentId: agentIdSchema, args: z.array(z.string()).default([]), cwd: cwdSchema }));
  codingTool('read_file_range', 'Read only a 1-based inclusive line range from a UTF-8 file.', z.object({ agentId: agentIdSchema, path: z.string().min(1), startLine: z.number().int().min(1), endLine: z.number().int().min(1) }));
  codingTool('tail_file', 'Read the last N lines of a UTF-8 text file.', z.object({ agentId: agentIdSchema, path: z.string().min(1), lines: z.number().int().min(1).max(10000).default(100) }));
  codingTool('get_file_info', 'Get file type, size, modification time and mode.', z.object({ agentId: agentIdSchema, path: z.string().min(1) }));
  codingTool('create_directory', 'Create a directory recursively inside the workspace.', z.object({ agentId: agentIdSchema, path: z.string().min(1) }));
  codingTool('copy_file', 'Copy a file inside the workspace.', z.object({ agentId: agentIdSchema, source: z.string().min(1), destination: z.string().min(1) }));
  codingTool('process_list', 'List running processes on the Windows machine.', z.object({ agentId: agentIdSchema }));
  codingTool('kill_process', 'Terminate a process by PID. Requires ALLOW_COMMAND_EXECUTION=true; refuses to kill the agent itself.', z.object({ agentId: agentIdSchema, pid: z.number().int().positive() }));
  codingTool('rg', 'Search workspace text with ripgrep. Returns line and column matches.', z.object({ agentId: agentIdSchema, query: z.string().min(1), cwd: cwdSchema, glob: z.string().optional(), ignoreCase: z.boolean().optional(), maxResults: z.number().int().min(1).max(5000).default(500) }));
  codingTool('git', 'Run a git subcommand in a workspace. Requires ALLOW_COMMAND_EXECUTION=true.', z.object({ agentId: agentIdSchema, args: z.array(z.string()).min(1), cwd: cwdSchema }));
  codingTool('apply_patch', 'Apply a unified git patch inside the workspace. Requires ALLOW_COMMAND_EXECUTION=true.', z.object({ agentId: agentIdSchema, patch: z.string().min(1), cwd: cwdSchema }));
  codingTool('find_files', 'Find workspace files using an rg glob pattern.', z.object({ agentId: agentIdSchema, pattern: z.string().default('**/*'), cwd: cwdSchema, maxResults: z.number().int().min(1).max(5000).default(500) }));
  return server;
}

const app = express(); app.disable('x-powered-by'); app.use(express.json({ limit: '2mb' }));
app.get('/healthz', (_req, res) => res.json({ ok: true, agents: registry.list() }));
app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(oauthMetadata()));
app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json(protectedResourceMetadata()));
app.post('/oauth/register', (req, res) => { try { res.status(201).json(registerClient(req.body)); } catch (e) { res.status(400).json({ error: 'invalid_client_metadata', error_description: String(e instanceof Error ? e.message : e) }); } });
app.get('/oauth/authorize', (req, res) => { const result = authorizationPage(req); res.status(result.status).type('html').send(result.body); });
app.post('/oauth/authorize/approve', (req, res) => { const result = approve(req); if (result.location) return res.redirect(302, result.location); return res.status(result.status).send(result.body); });
app.post('/oauth/token', (req, res) => { try { res.json(exchangeToken(req.body)); } catch (e) { const error = String(e instanceof Error ? e.message : e); res.status(400).json({ error }); } });
app.get('/agents', (req, res) => { if (!mcpAuthorized(req)) return mcpUnauthorized(res); res.json({ agents: registry.list() }); });

function isLocalAdminRequest(req: express.Request) { const ip = req.socket.remoteAddress ?? ''; const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'; const fromCaddy = req.get('X-From-Caddy') === 'true'; return loopback && !fromCaddy; }
app.get('/', (req, res) => { if (!isLocalAdminRequest(req)) return res.status(404).send('Not found'); res.type('html').send('<!doctype html><html><body><h1>ChatGPT MCP Gateway</h1><p>Use MCP at /mcp. Admin UI is loopback-only.</p></body></html>'); });
app.post('/_admin/call', async (req, res) => { if (!isLocalAdminRequest(req)) return res.status(404).send('Not found'); try { const { tool, args } = req.body ?? {}; if (!['list_directory','read_file','write_file','get_system_info'].includes(tool)) return res.status(400).json({error:'tool not allowed in admin UI'}); const result = await registry.call(String(args.agentId), tool as ToolName, args); res.json({ok:true,result}); } catch (e) { res.status(500).json({ok:false,error:String(e instanceof Error?e.message:e)}); } });

const mcpHandler = toNodeHandler(createMcpHandler(buildMcpServer));
app.all('/mcp', (req, res) => { if (!mcpAuthorized(req)) return mcpUnauthorized(res); return mcpHandler(req, res); });
const httpServer = createHttpServer(app); const wss = new WebSocketServer({ noServer: true });
httpServer.on('upgrade', (req, socket, head) => { if (req.url !== '/agent') return socket.destroy(); if (req.headers.authorization !== `Bearer ${AGENT_TOKEN}`) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; } wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)); });
wss.on('connection', ws => { let agentId: string | undefined; let initialized = false; ws.on('message', raw => { try { const message = JSON.parse(raw.toString()) as AgentMessage; if (message.type === 'hello') { if (!/^[a-zA-Z0-9._-]{1,64}$/.test(message.agentId)) return ws.close(4002, 'invalid agentId'); agentId = message.agentId; initialized = true; registry.add(agentId, ws); console.log(`[agent] connected ${agentId} (${message.hostname})`); return; } if (!initialized) return ws.close(4003, 'hello required'); registry.handleMessage(message); } catch { ws.close(4004, 'invalid message'); } }); ws.on('close', () => { if (agentId) console.log(`[agent] disconnected ${agentId}`); }); });
httpServer.listen(PORT, '0.0.0.0', () => { console.log(`MCP gateway listening on :${PORT}`); console.log(`Public MCP: ${PUBLIC_URL}/mcp`); console.log(`Agent endpoint: ${PUBLIC_URL}/agent`); console.log('Admin UI: http://127.0.0.1:' + PORT + '/ (loopback only)'); });
