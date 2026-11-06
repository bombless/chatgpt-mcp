import { createServer as createHttpServer } from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import QRCode from 'qrcode';
import * as z from 'zod';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { ToolName } from '../shared/protocol.js';
import { AgentRegistry } from './agent-registry.js';
import { approve, authorizationPage, exchangeToken, getBaseUrl, oauthMetadata, protectedResourceMetadata, registerClient, validAccessToken } from './oauth.js';
import { getDb, saveDb } from './db.js';
import { otpauthUri, randomBase32 } from './totp.js';
import { buildMcpServer } from './mcp-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function requestId(req: express.Request) { return req.get('x-request-id') ?? crypto.randomUUID(); }
function safeAuthInfo(req: express.Request) { const authorization = req.header('authorization'); return { hasAuthorization: Boolean(authorization), scheme: authorization?.split(/\s+/, 1)[0], tokenLength: authorization?.startsWith('Bearer ') ? authorization.slice(7).length : undefined }; }
function bearer(req: express.Request) { const value = req.header('authorization'); return value?.startsWith('Bearer ') ? value.slice(7) : undefined; }

export function createExpressApp(registry: AgentRegistry, options: {
  adminPort: number;
  legacyMcpToken?: string;
  mcpDebugEnabled: boolean;
  mcpDebug: (event: string, details?: Record<string, unknown>) => void;
}) {
  const { adminPort, legacyMcpToken, mcpDebugEnabled, mcpDebug } = options;
  async function mcpAuthorized(req: express.Request) { const token = bearer(req); const oauthValid = await validAccessToken(token); const legacyValid = !!legacyMcpToken && token === legacyMcpToken; mcpDebug('authorization:check', { ...safeAuthInfo(req), oauthValid, legacyValid }); return oauthValid || legacyValid; }
  function mcpUnauthorized(res: express.Response, req?: express.Request) { if (req) mcpDebug('authorization:rejected', safeAuthInfo(req)); const baseUrl = getBaseUrl(req); res.setHeader('WWW-Authenticate', `Bearer resource_metadata=\"${baseUrl}/.well-known/oauth-protected-resource\"`); return res.status(401).json({ error: 'unauthorized', error_description: 'OAuth access token required' }); }

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use((req, res, next) => { const id = requestId(req); res.setHeader('X-Request-Id', id); if (mcpDebugEnabled) mcpDebug('http:request', { requestId: id, method: req.method, path: req.path, query: req.query, contentType: req.get('content-type'), bodyKeys: req.body && typeof req.body === 'object' ? Object.keys(req.body) : undefined, ...safeAuthInfo(req) }); res.on('finish', () => { if (mcpDebugEnabled) mcpDebug('http:response', { requestId: id, method: req.method, path: req.path, status: res.statusCode }); }); next(); });
app.get('/healthz', (_req, res) => res.json({ ok: true, agents: registry.list() }));
app.get('/.well-known/oauth-authorization-server', (req, res) => res.json(oauthMetadata(getBaseUrl(req))));
app.get('/.well-known/openid-configuration', (req, res) => res.json(oauthMetadata(getBaseUrl(req))));
app.get('/.well-known/oauth-protected-resource', (req, res) => res.json(protectedResourceMetadata(getBaseUrl(req))));
app.get('/.well-known/oauth-protected-resource/*subpath', (req, res) => res.json(protectedResourceMetadata(getBaseUrl(req))));
app.post('/oauth/register', async (req, res) => { try { res.status(201).json(await registerClient(req.body)); } catch (e) { res.status(400).json({ error: 'invalid_client_metadata', error_description: String(e instanceof Error ? e.message : e) }); } });
app.get('/oauth/authorize', async (req, res) => { const result = await authorizationPage(req); res.status(result.status).type('html').send(result.body); });
app.post('/oauth/authorize/approve', async (req, res) => { const result = await approve(req); if (result.location) return res.redirect(302, result.location); return res.status(result.status).send(result.body); });
app.post('/oauth/token', async (req, res) => { try { res.json(await exchangeToken(req.body)); } catch (e) { const error = String(e instanceof Error ? e.message : e); res.status(400).json({ error }); } });
app.get('/agents', async (req, res) => { if (!await mcpAuthorized(req)) return mcpUnauthorized(res, req); res.json({ agents: registry.list() }); });

function isLocalAdminRequest(req: express.Request) {
  const ip = req.socket.remoteAddress ?? '';
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const hasProxyHeader = Boolean(req.get('x-forwarded-for') || req.get('x-forwarded-host'));
  const fromCaddy = req.get('X-From-Caddy') === 'true' || hasProxyHeader;
  return loopback && !fromCaddy;
}

const adminApp = express();
adminApp.disable('x-powered-by');
adminApp.use(express.json({ limit: '2mb' }));
adminApp.use(express.urlencoded({ extended: false, limit: '64kb' }));
adminApp.use((req, res, next) => {
  const id = requestId(req);
  res.setHeader('X-Request-Id', id);
  next();
});

adminApp.get('/healthz', (_req, res) => res.json({ ok: true, agents: registry.list() }));

adminApp.get('/_admin/agents', async (req, res) => {
  if (!isLocalAdminRequest(req)) return res.status(404).send('Not found');
  res.json({ agents: await registry.listWithCapabilities() });
});

const adminToolAliases: Record<string, { tool: ToolName; args: (args: Record<string, unknown>) => Record<string, unknown> }> = {
  git_status: { tool: 'git', args: a => ({ ...a, args: ['status', ...(Array.isArray(a.args) ? a.args : [])] }) },
  git_diff: { tool: 'git', args: a => ({ ...a, args: ['diff', ...(Array.isArray(a.args) ? a.args : [])] }) },
  git_log: { tool: 'git', args: a => ({ ...a, args: ['log', ...(Array.isArray(a.args) ? a.args : [])] }) },
  git_show: { tool: 'git', args: a => ({ ...a, args: ['show', ...(Array.isArray(a.args) ? a.args : [])] }) },
  git_blame: { tool: 'git', args: a => ({ ...a, args: ['blame', ...(Array.isArray(a.args) ? a.args : [])] }) },
  git_branch: { tool: 'git', args: a => ({ ...a, args: ['branch', ...(Array.isArray(a.args) ? a.args : [])] }) },
  git_add: { tool: 'git', args: a => ({ ...a, args: ['add', ...(Array.isArray(a.args) ? a.args : [])] }) },
  git_commit: { tool: 'git', args: a => ({ ...a, args: ['commit', ...(Array.isArray(a.args) ? a.args : [])] }) },
};

type AdminToolDefinition = { name: string; description: string; inputSchema: Record<string, unknown> };
type RegisteredAdminTool = { description?: string; inputSchema?: z.ZodType };
let cachedAdminToolRegistry: Record<string, RegisteredAdminTool> | undefined;

function getAdminToolRegistry() {
  if (!cachedAdminToolRegistry) {
    const server = buildMcpServer(registry, mcpDebug);
    cachedAdminToolRegistry = (server as unknown as { _registeredTools?: Record<string, RegisteredAdminTool> })._registeredTools;
  }
  if (!cachedAdminToolRegistry) throw new Error('MCP SDK does not expose registered tool definitions');
  return cachedAdminToolRegistry;
}

function getAdminToolDefinitions(): AdminToolDefinition[] {
  const registered = getAdminToolRegistry();
  const definitions: AdminToolDefinition[] = [];
  for (const [name, tool] of Object.entries(registered)) {
    if (!tool.inputSchema) continue;
    const schema = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown> | undefined;
    if (!properties || !('agentId' in properties)) continue;
    definitions.push({ name, description: tool.description ?? '', inputSchema: schema });
  }
  // Git subcommands are named admin actions sharing the registered git schema.
  const git = definitions.find(tool => tool.name === 'git');
  if (git) for (const name of Object.keys(adminToolAliases)) {
    definitions.push({ ...git, name, description: `Git ${name.replace('git_', '')} operation` });
  }
  return definitions.sort((a, b) => a.name.localeCompare(b.name));
}

adminApp.get('/_admin/tools', (req, res) => {
  if (!isLocalAdminRequest(req)) return res.status(404).send('Not found');
  try { res.json({ tools: getAdminToolDefinitions() }); }
  catch (error) { res.status(500).json({ error: error instanceof Error ? error.message : String(error) }); }
});

// Keep the admin console and its assets on the loopback-only 8788 listener.
adminApp.get('/', async (req, res) => {
  if (!isLocalAdminRequest(req)) return res.status(404).send('Not found');
  res.type('html').send(readFileSync(resolve(__dirname, 'admin-ui/admin.html'), 'utf8'));
});
adminApp.use('/assets', (req, res, next) => {
  if (!isLocalAdminRequest(req)) return res.status(404).send('Not found');
  next();
}, express.static(resolve(__dirname, 'admin-ui/assets'), { index: false, immutable: true, maxAge: '1y' }));

adminApp.get('/_admin/totp', async (req, res) => {
  if (!isLocalAdminRequest(req)) return res.status(404).send('Not found');
  try {
    const db = await getDb();
    let config = db.totp_config;
    if (!config) {
      const now = Date.now();
      config = { secret: randomBase32(), created_at: now, updated_at: now };
      db.totp_config = config;
      await saveDb(db);
    }
    const account = 'owner';
    const uri = otpauthUri(config.secret, 'ChatGPT-MCP', account);
    const qrDataUrl = await QRCode.toDataURL(uri, { margin: 2, width: 280 });
    res.json({ configured: true, account, qrDataUrl });
  } catch (e) {
    res.status(500).json({ configured: false, error: String(e instanceof Error ? e.message : e) });
  }
});

adminApp.post('/_admin/call', async (req, res) => {
  if (!isLocalAdminRequest(req)) return res.status(404).send('Not found');
  try {
    const { tool, args } = req.body ?? {};
    if (typeof tool !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) return res.status(400).json({ error: 'tool and JSON object args are required' });
    const definition = getAdminToolDefinitions().find(item => item.name === tool);
    if (!definition) return res.status(400).json({ error: 'tool not available in admin runner' });
    const alias = adminToolAliases[tool];
    const registeredName = alias?.tool ?? tool as ToolName;
    const schema = getAdminToolRegistry()[alias ? 'git' : tool]?.inputSchema;
    if (!schema) return res.status(400).json({ error: 'tool input schema unavailable' });
    const parsed = schema.safeParse(args);
    if (!parsed.success) return res.status(400).json({ error: 'Tool arguments failed schema validation', details: parsed.error.issues });
    const agentId = String(args.agentId ?? '');
    if (!agentId) return res.status(400).json({ error: 'agentId is required' });
    const validatedArgs = parsed.data as Record<string, unknown>;
    const result = await registry.call(agentId, registeredName, alias ? alias.args(validatedArgs) : validatedArgs);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e instanceof Error ? e.message : e) });
  }
});

const toBuffer = (chunk: unknown) => {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  return Buffer.from(String(chunk));
};

const mcpHandler = toNodeHandler(createMcpHandler(() => buildMcpServer(registry, mcpDebug)));
app.all('/mcp', async (req, res) => {
  if (!await mcpAuthorized(req)) return mcpUnauthorized(res, req);
  mcpDebug('handler:dispatch', { method: req.method, contentType: req.get('content-type'), accept: req.get('accept'), bodyKeys: req.body && typeof req.body === 'object' ? Object.keys(req.body) : undefined });
  try {
    const result = mcpHandler(req, res, req.body);
    if (result && typeof (result as Promise<unknown>).then === 'function') void (result as Promise<unknown>).then(() => mcpDebug('handler:complete', { method: req.method })).catch(error => mcpDebug('handler:error', { method: req.method, error: String(error instanceof Error ? error.stack ?? error.message : error) }));
  } catch (error) { mcpDebug('handler:throw', { method: req.method, error: String(error instanceof Error ? error.stack ?? error.message : error) }); throw error; }
});

const adminServer = createHttpServer(adminApp);
adminServer.listen(adminPort, '127.0.0.1', () => {
  console.log(`Admin console listening on http://127.0.0.1:${adminPort}`);
});

  return app;
}
