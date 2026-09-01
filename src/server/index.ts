import { createServer as createHttpServer } from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import QRCode from 'qrcode';
import { WebSocketServer, WebSocket } from 'ws';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { AgentMessage, AgentRequest, AgentResponse, ToolName } from '../shared/protocol.js';
import { approve, authorizationPage, exchangeToken, oauthMetadata, protectedResourceMetadata, registerClient, validAccessToken } from './oauth.js';
import { getDb, saveDb } from './db.js';
import { otpauthUri, randomBase32 } from './totp.js';

const PORT = Number(process.env.PORT ?? 8787);
const AGENT_TOKEN = process.env.AGENT_TOKEN;
const LEGACY_MCP_TOKEN = process.env.MCP_TOKEN;
const PUBLIC_URL = (process.env.PUBLIC_URL ?? 'https://bombless.duckdns.org').replace(/\/$/, '');
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 60_000);
const MCP_DEBUG = process.env.MCP_DEBUG === '1' || process.env.DEBUG_MCP === '1';
if (!AGENT_TOKEN) throw new Error('AGENT_TOKEN must be set');

function mcpDebug(event: string, details: Record<string, unknown> = {}) { if (MCP_DEBUG) console.log(`[mcp] ${event} ${JSON.stringify(details)}`); }
function requestId(req: express.Request) { return req.get('x-request-id') ?? crypto.randomUUID(); }
function safeAuthInfo(req: express.Request) { const authorization = req.header('authorization'); return { hasAuthorization: Boolean(authorization), scheme: authorization?.split(/\s+/, 1)[0], tokenLength: authorization?.startsWith('Bearer ') ? authorization.slice(7).length : undefined }; }

class AgentRegistry {
  private readonly agents = new Map<string, WebSocket>();
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  add(agentId: string, socket: WebSocket) { const old = this.agents.get(agentId); old?.close(4000, 'replaced by a newer connection'); this.agents.set(agentId, socket); socket.on('close', () => { if (this.agents.get(agentId) === socket) this.agents.delete(agentId); }); }
  get(agentId: string) { const socket = this.agents.get(agentId); return socket?.readyState === WebSocket.OPEN ? socket : undefined; }
  list() { return [...this.agents.keys()]; }
  async call(agentId: string, tool: ToolName, args: Record<string, unknown>) {
    const socket = this.get(agentId);
    if (!socket) { mcpDebug('agent-call:missing', { agentId, tool }); throw new Error(`Windows agent '${agentId}' is not connected`); }
    const id = crypto.randomUUID(); const request: AgentRequest = { type: 'request', id, tool, args }; mcpDebug('agent-call:start', { requestId: id, agentId, tool });
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); mcpDebug('agent-call:timeout', { requestId: id, agentId, tool, timeoutMs: REQUEST_TIMEOUT_MS }); reject(new Error(`Agent request timed out after ${REQUEST_TIMEOUT_MS}ms`)); }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); mcpDebug('agent-call:success', { requestId: id, agentId, tool }); resolve(value); }, reject: error => { clearTimeout(timer); mcpDebug('agent-call:error', { requestId: id, agentId, tool, error: error.message }); reject(error); } });
      try { socket.send(JSON.stringify(request)); } catch (error) { this.pending.delete(id); clearTimeout(timer); mcpDebug('agent-call:send-error', { requestId: id, agentId, tool, error: String(error) }); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  handleMessage(message: AgentMessage) { if (message.type !== 'response') return; const response = message as AgentResponse; const item = this.pending.get(response.id); if (!item) { mcpDebug('agent-response:orphan', { requestId: response.id }); return; } this.pending.delete(response.id); if (response.ok) item.resolve(response.result); else item.reject(new Error(response.error ?? 'Agent request failed')); }
}
const registry = new AgentRegistry();
function resultContent(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    structuredContent: { result: value },
  };
}
function bearer(req: express.Request) { const value = req.header('authorization'); return value?.startsWith('Bearer ') ? value.slice(7) : undefined; }
async function mcpAuthorized(req: express.Request) { const token = bearer(req); const oauthValid = await validAccessToken(token); const legacyValid = !!LEGACY_MCP_TOKEN && token === LEGACY_MCP_TOKEN; mcpDebug('authorization:check', { ...safeAuthInfo(req), oauthValid, legacyValid }); return oauthValid || legacyValid; }
function mcpUnauthorized(res: express.Response, req?: express.Request) { if (req) mcpDebug('authorization:rejected', safeAuthInfo(req)); res.setHeader('WWW-Authenticate', `Bearer resource_metadata=\"${PUBLIC_URL}/.well-known/oauth-protected-resource\"`); return res.status(401).json({ error: 'unauthorized', error_description: 'OAuth access token required' }); }

async function fetchImage(url: string) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Image fetch failed: HTTP ${response.status}`);
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!contentType.startsWith('image/')) throw new Error(`URL did not return an image (content-type: ${contentType || 'unknown'})`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error('Image response was empty');
  return { bytes, mimeType: contentType };
}

function normalizeImageMimeType(mimeType: string) {
  return mimeType.toLowerCase().split(';', 1)[0]?.trim() || 'image/png';
}

function buildMcpServer() {
  const server = new McpServer({ name: 'chatgpt-windows-bridge', version: '0.3.0' });
  const agentIdSchema = z.string().min(1).describe('Windows agent ID, e.g. desktop-01');
  const cwdSchema = z.string().min(1).optional().describe('Workspace directory; must be inside AGENT_WORKSPACE.');
  const intentSchema = z.string().regex(/^let me .+$/u).max(500).describe('A short sentence explaining what you are doing and why. It must start with "let me ".');
  const commandResultSchema = z.object({ stdout: z.string(), stderr: z.string(), code: z.number().int() });
  const pythonJobSchema = z.object({ jobId: z.string(), pid: z.number().int(), status: z.enum(['running', 'exited', 'failed', 'killed']), command: z.string(), cwd: z.string(), args: z.array(z.string()), startedAt: z.string(), finishedAt: z.string().nullable(), exitCode: z.number().int().nullable(), signal: z.string().nullable(), stdout: z.string(), stderr: z.string(), stdoutTruncated: z.boolean(), stderrTruncated: z.boolean() });
  const input = <const T extends Record<string, z.ZodTypeAny>>(shape: T): T & { intent: typeof intentSchema } => ({ ...shape, intent: intentSchema });
  const codingTool = (name: ToolName, description: string, shape: Record<string, z.ZodTypeAny>, outputSchema: z.ZodTypeAny) =>
    server.registerTool(name, { description, inputSchema: input(shape), outputSchema }, async (args: Record<string, unknown>) =>
      resultContent(await registry.call(String(args.agentId), name, args)));

  server.registerTool('list_agents', { description: 'List connected Windows computers.', inputSchema: { intent: intentSchema }, outputSchema: z.object({ result: z.array(z.string()) }) }, async () => resultContent(registry.list()));
  server.registerTool('read_file', { description: 'Read a UTF-8 text file on Windows.', inputSchema: input({ agentId: agentIdSchema, path: z.string().min(1) }), outputSchema: z.object({ result: z.string() }) }, async ({ agentId, path }) => resultContent(await registry.call(agentId, 'read_file', { path })));
  server.registerTool('write_file', { description: 'Write UTF-8 text to a Windows file. Parent directories must already exist.', inputSchema: input({ agentId: agentIdSchema, path: z.string().min(1), content: z.string() }), outputSchema: z.object({ result: z.object({ ok: z.literal(true), path: z.string() }) }) }, async ({ agentId, path, content }) => resultContent(await registry.call(agentId, 'write_file', { path, content })));
  server.registerTool('list_directory', { description: 'List a Windows directory.', inputSchema: input({ agentId: agentIdSchema, path: z.string().min(1) }), outputSchema: z.object({ result: z.array(z.object({ name: z.string(), type: z.enum(['directory', 'file']) })) }) }, async ({ agentId, path }) => resultContent(await registry.call(agentId, 'list_directory', { path })));
  server.registerTool('move_file', { description: 'Move or rename a Windows file or directory.', inputSchema: input({ agentId: agentIdSchema, source: z.string().min(1), destination: z.string().min(1) }), outputSchema: z.object({ result: z.object({ ok: z.literal(true), source: z.string(), destination: z.string() }) }) }, async ({ agentId, source, destination }) => resultContent(await registry.call(agentId, 'move_file', { source, destination })));
  server.registerTool('delete_file', { description: 'Delete a Windows file or empty directory.', inputSchema: input({ agentId: agentIdSchema, path: z.string().min(1) }), outputSchema: z.object({ result: z.object({ ok: z.literal(true), path: z.string() }) }) }, async ({ agentId, path }) => resultContent(await registry.call(agentId, 'delete_file', { path })));
  server.registerTool('execute_powershell', { description: 'Execute PowerShell 7.1 on Windows. Agent policy may disable it.', inputSchema: input({ agentId: agentIdSchema, command: z.string().min(1) }), outputSchema: z.object({ result: commandResultSchema }) }, async ({ agentId, command }) => resultContent(await registry.call(agentId, 'execute_powershell', { command })));
  server.registerTool('get_system_info', { description: 'Get basic Windows system information.', inputSchema: input({ agentId: agentIdSchema }), outputSchema: z.object({ result: z.object({ hostname: z.string(), platform: z.string(), arch: z.string(), release: z.string(), workspace: z.string(), commandExecutionEnabled: z.boolean() }) }) }, async ({ agentId }) => resultContent(await registry.call(agentId, 'get_system_info', {})));

  server.registerTool('fetch_image_block', { description: 'Fetch an image URL and return it as an MCP image content block. Useful for testing whether the MCP client renders image blocks.', inputSchema: input({ url: z.string().url() }), outputSchema: z.object({ result: z.unknown() }) }, async ({ url }) => {
    const { bytes, mimeType } = await fetchImage(url);
    const content = [{ type: 'image' as const, data: bytes.toString('base64'), mimeType: normalizeImageMimeType(mimeType) }];
    return { content, structuredContent: { result: content } };
  });

  server.registerTool('fetch_image_base64', { description: 'Fetch an image URL and return its Base64-encoded bytes as text.', inputSchema: input({ url: z.string().url() }), outputSchema: z.object({ result: z.object({ mimeType: z.string(), base64: z.string() }) }) }, async ({ url }) => {
    const { bytes, mimeType } = await fetchImage(url);
    return resultContent({ mimeType: normalizeImageMimeType(mimeType), base64: bytes.toString('base64') });
  });

  server.registerTool('fetch_image_url', { description: 'Return the supplied image URL unchanged. Useful for testing whether ChatGPT can display an image from a URL.', inputSchema: input({ url: z.string().url() }), outputSchema: z.object({ result: z.object({ url: z.string().url() }) }) }, async ({ url }) => resultContent({ url }));

  codingTool('run_npm', 'Run npm with arguments in the workspace. Requires ALLOW_COMMAND_EXECUTION=true.', { agentId: agentIdSchema, args: z.array(z.string()).default([]), cwd: cwdSchema }, z.object({ result: commandResultSchema }));
  codingTool('run_python', 'Run Python with arguments in the workspace. By default waits for completion with COMMAND_TIMEOUT_MS; set async=true to start a background Python job and receive a jobId. Requires ALLOW_COMMAND_EXECUTION=true.', { agentId: agentIdSchema, args: z.array(z.string()).default([]), cwd: cwdSchema, async: z.boolean().default(false) }, z.object({ result: z.union([commandResultSchema, z.object({ jobId: z.string(), pid: z.number().int(), status: z.literal('running'), command: z.string(), cwd: z.string(), startedAt: z.string() })]) }));
  codingTool('python_job_inspect', 'Inspect a background Python job by jobId, including status and captured stdout/stderr.', { agentId: agentIdSchema, jobId: z.string().min(1) }, z.object({ result: pythonJobSchema }));
  codingTool('python_job_kill', 'Terminate a background Python job by jobId and its process tree. Requires ALLOW_COMMAND_EXECUTION=true.', { agentId: agentIdSchema, jobId: z.string().min(1) }, z.object({ result: pythonJobSchema }));
  codingTool('python_jobs', 'List background Python jobs known by this Windows agent.', { agentId: agentIdSchema }, z.object({ result: z.array(pythonJobSchema) }));
  codingTool('run_node', 'Run Node.js with arguments in the workspace. Requires ALLOW_COMMAND_EXECUTION=true.', { agentId: agentIdSchema, args: z.array(z.string()).default([]), cwd: cwdSchema }, z.object({ result: commandResultSchema }));
  codingTool('read_file_range', 'Read only a 1-based inclusive line range from a UTF-8 file.', { agentId: agentIdSchema, path: z.string().min(1), startLine: z.number().int().min(1), endLine: z.number().int().min(1) }, z.object({ result: z.string() }));
  codingTool('tail_file', 'Read the last N lines of a UTF-8 text file.', { agentId: agentIdSchema, path: z.string().min(1), lines: z.number().int().min(1).max(10000).default(100) }, z.object({ result: z.string() }));
  codingTool('get_file_info', 'Get file type, size, modification time and mode.', { agentId: agentIdSchema, path: z.string().min(1) }, z.object({ result: z.object({ path: z.string(), type: z.enum(['directory', 'file', 'other']), size: z.number(), mtime: z.string(), mode: z.number() }) }));
  codingTool('create_directory', 'Create a directory recursively inside the workspace.', { agentId: agentIdSchema, path: z.string().min(1) }, z.object({ result: z.object({ ok: z.literal(true), path: z.string() }) }));
  codingTool('copy_file', 'Copy a file inside the workspace.', { agentId: agentIdSchema, source: z.string().min(1), destination: z.string().min(1) }, z.object({ result: z.object({ ok: z.literal(true), source: z.string(), destination: z.string() }) }));
  codingTool('process_list', 'List running processes on the Windows machine.', { agentId: agentIdSchema }, z.object({ result: commandResultSchema }));
  codingTool('kill_process', 'Terminate a process by PID. Requires ALLOW_COMMAND_EXECUTION=true; refuses to kill the agent itself.', { agentId: agentIdSchema, pid: z.number().int().positive() }, z.object({ result: z.object({ ok: z.literal(true), pid: z.number().int() }) }));
  codingTool('rg', 'Search workspace text with ripgrep. Returns line and column matches.', { agentId: agentIdSchema, query: z.string().min(1), cwd: cwdSchema, glob: z.string().optional(), ignoreCase: z.boolean().optional(), maxResults: z.number().int().min(1).max(5000).default(500) }, z.object({ result: z.object({ stdout: z.string(), stderr: z.string(), code: z.number().int(), matches: z.boolean(), truncated: z.boolean() }) }));
  codingTool('git', 'Run git with arguments in the workspace. Requires ALLOW_COMMAND_EXECUTION=true.', { agentId: agentIdSchema, args: z.array(z.string()).min(1), cwd: cwdSchema }, z.object({ result: commandResultSchema }));
  codingTool('apply_patch', 'Apply a unified git patch inside the workspace. Requires ALLOW_COMMAND_EXECUTION=true.', { agentId: agentIdSchema, patch: z.string().min(1), cwd: cwdSchema }, z.object({ result: commandResultSchema }));
  codingTool('find_files', 'Find workspace files using a glob pattern.', { agentId: agentIdSchema, pattern: z.string().optional(), cwd: cwdSchema, maxResults: z.number().int().min(1).max(5000).default(500) }, z.object({ result: z.object({ files: z.array(z.string()), truncated: z.boolean(), count: z.number().int() }) }));
  codingTool('cdp_version', 'Get Chrome DevTools Protocol version information.', { agentId: agentIdSchema }, z.object({ result: z.unknown() }));
  codingTool('cdp_list_targets', 'List Chrome DevTools Protocol targets.', { agentId: agentIdSchema }, z.object({ result: z.unknown() }));
  codingTool('cdp_call', 'Call a Chrome DevTools Protocol method.', { agentId: agentIdSchema, method: z.string().min(1), params: z.record(z.string(), z.unknown()).optional(), targetId: z.string().optional() }, z.object({ result: z.unknown() }));

  return server;
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json(protectedResourceMetadata()));
app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(oauthMetadata()));
app.post('/oauth/register', async (req, res) => { try { res.status(201).json(await registerClient(req.body)); } catch (error) { res.status(400).json({ error: 'invalid_client_metadata', error_description: String(error) }); } });
app.get('/oauth/authorize', async (req, res) => { try { const r = await authorizationPage(req); res.status(r.status).type('html').send(r.body); } catch (error) { res.status(400).send(String(error)); } });
app.get('/oauth/approve', async (req, res) => { try { const r = await approve(req); if (r.status === 302 && 'location' in r) return res.redirect(r.location); res.status(r.status).type('html').send(r.body); } catch (error) { res.status(400).send(String(error)); } });
app.post('/oauth/token', async (req, res) => { try { res.json(await exchangeToken(req.body)); } catch (error) { res.status(400).json({ error: 'invalid_grant', error_description: String(error) }); } });

const mcpHandler = toNodeHandler(createMcpHandler(() => buildMcpServer()));
app.all('/mcp', async (req, res) => { if (!(await mcpAuthorized(req))) return mcpUnauthorized(res, req); return mcpHandler(req, res); });

const httpServer = createHttpServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/agent' });
wss.on('connection', (socket, req) => {
  const url = new URL(req.url ?? '/agent', `http://${req.headers.host ?? 'localhost'}`);
  if (url.searchParams.get('token') !== AGENT_TOKEN) { socket.close(4001, 'unauthorized'); return; }
  const agentId = url.searchParams.get('agentId') || crypto.randomUUID();
  registry.add(agentId, socket);
  socket.send(JSON.stringify({ type: 'hello', agentId }));
  socket.on('message', data => { try { registry.handleMessage(JSON.parse(data.toString()) as AgentMessage); } catch { /* ignore malformed agent messages */ } });
});

httpServer.listen(PORT, () => console.log(`chatgpt-mcp listening on ${PUBLIC_URL}:${PORT}`));
