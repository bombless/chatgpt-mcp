import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import QRCode from 'qrcode';
import * as z from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolName } from '../shared/protocol.js';
import { getDb, saveDb } from './db.js';
import { otpauthUri, randomBase32 } from './totp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AdminAppRegistry {
  list(): unknown[];
  listWithCapabilities(): Promise<unknown[]>;
  call(agentId: string, tool: ToolName, args: Record<string, unknown>): Promise<unknown>;
}

export interface AdminAppOptions {
  registry: AdminAppRegistry;
  buildMcpServer: () => McpServer;
}

export function isLocalAdminRequest(req: express.Request) {
  const ip = req.socket.remoteAddress ?? '';
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  const hasProxyHeader = Boolean(req.get('x-forwarded-for') || req.get('x-forwarded-host'));
  const fromCaddy = req.get('X-From-Caddy') === 'true' || hasProxyHeader;
  return loopback && !fromCaddy;
}

export const adminToolAliases: Record<string, { tool: ToolName; args: (args: Record<string, unknown>) => Record<string, unknown> }> = {
  git_status: { tool: 'git', args: a => ({ ...a, args: ['status', ...(Array.isArray(a.args) ? a.args : [])] }) },
  git_diff: { tool: 'git', args: a => ({ ...a, args: ['diff', ...(Array.isArray(a.args) ? a.args : [])] }) },
  git_log: { tool: 'git', args: a => ({ ...a, args: ['log', ...(Array.isArray(a.args) ? a.args : [])] }) },
  git_show: { tool: 'git', args: a => ({ ...a, args: ['show', ...(Array.isArray(a.args) ? a.args : [])] }) },
  git_blame: { tool: 'git', args: a => ({ ...a, args: ['blame', ...(Array.isArray(a.args) ? a.args : [])] }) },
  git_branch: { tool: 'git', args: a => ({ ...a, args: ['branch', ...(Array.isArray(a.args) ? a.args : [])] }) },
  git_add: { tool: 'git', args: a => ({ ...a, args: ['add', ...(Array.isArray(a.args) ? a.args : [])] }) },
  git_commit: { tool: 'git', args: a => ({ ...a, args: ['commit', ...(Array.isArray(a.args) ? a.args : [])] }) },
};

export type AdminToolDefinition = { name: string; description: string; inputSchema: Record<string, unknown> };
export type RegisteredAdminTool = { description?: string; inputSchema?: z.ZodType };

export function createAdminApp({ registry, buildMcpServer }: AdminAppOptions) {
  let cachedAdminToolRegistry: Record<string, RegisteredAdminTool> | undefined;
  function getAdminToolRegistry() {
    if (!cachedAdminToolRegistry) {
      const server = buildMcpServer();
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

  const adminApp = express();
  adminApp.disable('x-powered-by');
  adminApp.use(express.json({ limit: '2mb' }));
  adminApp.use(express.urlencoded({ extended: false, limit: '64kb' }));
  adminApp.use((req, res, next) => {
    const id = req.get('x-request-id') ?? crypto.randomUUID();
    res.setHeader('X-Request-Id', id);
    next();
  });

  adminApp.get('/healthz', (_req, res) => res.json({ ok: true, agents: registry.list() }));
  adminApp.get('/_admin/agents', async (req, res) => {
    if (!isLocalAdminRequest(req)) return res.status(404).send('Not found');
    res.json({ agents: await registry.listWithCapabilities() });
  });
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

  return adminApp;
}
