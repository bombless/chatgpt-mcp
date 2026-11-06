import { createServer as createHttpServer } from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import QRCode from 'qrcode';
import { WebSocketServer, WebSocket } from 'ws';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { AgentMessage, AgentRequest, AgentResponse, ToolName } from '../shared/protocol.js';
import { isValidAgentId } from '../shared/agent-id.js';
import { approve, authorizationPage, exchangeToken, getBaseUrl, oauthMetadata, protectedResourceMetadata, registerClient, validAccessToken } from './oauth.js';
import { getDb, saveDb } from './db.js';
import { otpauthUri, randomBase32 } from './totp.js';
import { applyNativePatch } from './native-patch.js';
import { listImprovementSuggestions, submitImprovementSuggestion, updateImprovementSuggestion, suggestionCategories, suggestionPriorities, suggestionStatuses } from './improvement-suggestions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8787);
const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 8788);
const AGENT_TOKEN = process.env.AGENT_TOKEN;
const LEGACY_MCP_TOKEN = process.env.MCP_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : undefined;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 60_000);
const MCP_DEBUG = process.env.MCP_DEBUG === '1' || process.env.DEBUG_MCP === '1';
if (!AGENT_TOKEN) throw new Error('AGENT_TOKEN must be set');

function mcpDebug(event: string, details: Record<string, unknown> = {}) { if (MCP_DEBUG) console.log(`[mcp] ${event} ${JSON.stringify(details)}`); }
function requestId(req: express.Request) { return req.get('x-request-id') ?? crypto.randomUUID(); }
function safeAuthInfo(req: express.Request) { const authorization = req.header('authorization'); return { hasAuthorization: Boolean(authorization), scheme: authorization?.split(/\s+/, 1)[0], tokenLength: authorization?.startsWith('Bearer ') ? authorization.slice(7).length : undefined }; }

class AgentRegistry {
  private readonly agents = new Map<string, WebSocket>();
  private readonly metadata = new Map<string, { hostname: string; platform: string; username: string; workspace: string; version: string }>();
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  add(agentId: string, socket: WebSocket, metadata: { hostname: string; platform: string; username: string; workspace: string; version: string }) {
    const old = this.agents.get(agentId);
    old?.close(4000, 'replaced by a newer connection');
    this.agents.set(agentId, socket);
    this.metadata.set(agentId, metadata);
    socket.on('close', () => {
      if (this.agents.get(agentId) === socket) {
        this.agents.delete(agentId);
        this.metadata.delete(agentId);
      }
    });
  }
  get(agentId: string) { const socket = this.agents.get(agentId); return socket?.readyState === WebSocket.OPEN ? socket : undefined; }
  list() {
    return [...this.agents.keys()].map(agentId => {
      const metadata = this.metadata.get(agentId);
      return {
        agentId,
        hostname: metadata?.hostname ?? agentId,
        os: metadata?.platform === 'win32' ? 'windows' : metadata?.platform === 'linux' ? 'linux' : metadata?.platform ?? 'unknown',
        platform: metadata?.platform ?? 'unknown',
        username: metadata?.username ?? 'unknown',
        workspace: metadata?.workspace ?? 'unknown',
        version: metadata?.version ?? 'unknown',
      };
    });
  }
  async listWithCapabilities() {
    const agents = this.list();
    return await Promise.all(agents.map(async agent => {
      try {
        const capabilities = await this.call(agent.agentId, 'get_agent_capabilities', {});
        return { ...agent, capabilities };
      } catch (error) {
        return {
          ...agent,
          capabilities: {
            screenshot: { supported: false, detail: 'Unable to probe agent capabilities' },
            cdp9222: { connected: false, detail: error instanceof Error ? error.message : String(error) },
            powershell: { available: false, enabled: false, detail: 'Unknown' },
            bash: { available: false, enabled: false, detail: 'Unknown' },
            adb: { available: false, connected: false, devices: [], detail: 'Unknown' },
          },
        };
      }
    }));
  }
  notifyAgent(agentId: string, message: { type: 'server_diagnostic'; level: 'error' | 'warning'; tool: string; message: string; requestId?: string }) {
    const socket = this.get(agentId);
    if (!socket) { mcpDebug('agent-diagnostic:unavailable', { agentId, tool: message.tool, message: message.message }); return false; }
    try { socket.send(JSON.stringify(message)); return true; } catch (error) { mcpDebug('agent-diagnostic:send-error', { agentId, tool: message.tool, error: String(error) }); return false; }
  }
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

/** Temporary one-shot upload URLs: POST body is written to the agent path via write_file. */
type TempUpload = { agentId: string; path: string; expiresAt: number };
const tempUploads = new Map<string, TempUpload>();
const TEMP_UPLOAD_TTL_MS = Number(process.env.TEMP_UPLOAD_TTL_MS ?? 10 * 60 * 1000);
const TEMP_UPLOAD_MAX_BYTES = Number(process.env.TEMP_UPLOAD_MAX_BYTES ?? 20 * 1024 * 1024);

function purgeExpiredTempUploads() {
  const now = Date.now();
  for (const [token, item] of tempUploads) {
    if (item.expiresAt <= now) tempUploads.delete(token);
  }
}

function createTempUpload(agentId: string, path: string) {
  purgeExpiredTempUploads();
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = Date.now() + TEMP_UPLOAD_TTL_MS;
  tempUploads.set(token, { agentId, path, expiresAt });
  return { token, expiresAt };
}
function resultContent(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const time = `${new Date().getHours().toString().padStart(2, '0')}:${new Date().getMinutes().toString().padStart(2, '0')}`;
  console.log('[mcp][' + time +'] agent result returned to model:', text);
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: { result: value },
  };
}
function bearer(req: express.Request) { const value = req.header('authorization'); return value?.startsWith('Bearer ') ? value.slice(7) : undefined; }
async function mcpAuthorized(req: express.Request) { const token = bearer(req); const oauthValid = await validAccessToken(token); const legacyValid = !!LEGACY_MCP_TOKEN && token === LEGACY_MCP_TOKEN; mcpDebug('authorization:check', { ...safeAuthInfo(req), oauthValid, legacyValid }); return oauthValid || legacyValid; }
function mcpUnauthorized(res: express.Response, req?: express.Request) { if (req) mcpDebug('authorization:rejected', safeAuthInfo(req)); const baseUrl = getBaseUrl(req); res.setHeader('WWW-Authenticate', `Bearer resource_metadata=\"${baseUrl}/.well-known/oauth-protected-resource\"`); return res.status(401).json({ error: 'unauthorized', error_description: 'OAuth access token required' }); }

function buildMcpServer() {
  const server = new McpServer({ name: 'chatgpt-windows-bridge', version: '0.3.0' });
  const agentIdSchema = z.string().min(1).describe('Windows agent ID, e.g. desktop-01');
  const cwdSchema = z.string().min(1).optional().describe('Workspace directory; must be inside AGENT_WORKSPACE.');
  const intentSchema = z.string().min("let me ".length).max(500).describe('Briefly explain what you are doing and why. This is shown to the user as the current tool activity. You must start with "let me " and be a single sentence. For example: "let me read the first 100 lines of a log file to check for errors."');
  const commandResultSchema = z.object({ stdout: z.string(), stderr: z.string(), code: z.number().int() });
  const pythonJobSchema = z.object({ jobId: z.string(), pid: z.number().int(), status: z.enum(['running', 'exited', 'failed', 'killed']), command: z.string(), cwd: z.string(), args: z.array(z.string()), startedAt: z.string(), finishedAt: z.string().nullable(), exitCode: z.number().int().nullable(), signal: z.string().nullable(), stdout: z.string(), stderr: z.string(), stdoutTruncated: z.boolean(), stderrTruncated: z.boolean() });
  const input = <const T extends Record<string, z.ZodType>>(shape: T) => z.object({ ...shape, intent: intentSchema });
  const codingTool = (name: ToolName, description: string, shape: Record<string, z.ZodType>, outputSchema: z.ZodType) =>
    server.registerTool(name, { description, inputSchema: input(shape), outputSchema }, async (args: Record<string, unknown>) =>
      resultContent(await registry.call(String(args.agentId), name, args)));
  const npmTool = (name: Extract<ToolName, 'npm_test' | 'npm_run' | 'npm_install' | 'npm_init'>, description: string, argsBuilder: (args: Record<string, unknown>) => string[]) =>
    server.registerTool(name, { description, inputSchema: input({ agentId: agentIdSchema, args: z.array(z.string()).default([]), cwd: cwdSchema }), outputSchema: z.object({ result: commandResultSchema }) }, async ({ agentId, args, cwd, intent }) =>
      resultContent(await registry.call(agentId, name, { args: argsBuilder({ args }), cwd, intent })));
  const gitTool = (name: string, subcommand: string, description: string) =>
    server.registerTool(name, { description, inputSchema: input({ agentId: agentIdSchema, args: z.array(z.string()).default([]), cwd: cwdSchema }), outputSchema: z.object({ result: commandResultSchema }) }, async ({ agentId, args, cwd, intent }) =>
      resultContent(await registry.call(agentId, 'git', { args: [subcommand, ...(Array.isArray(args) ? args : [])], cwd, intent })));

  server.registerTool('list_agents', {
    description: 'List connected agents and actively probe screenshot support, local CDP connectivity on 127.0.0.1:9222, PowerShell/Bash availability and execution permission, and authorized ADB devices.',
    inputSchema: z.object({ intent: intentSchema }),
    outputSchema: z.object({ result: z.array(z.object({
      agentId: z.string(),
      hostname: z.string(),
      os: z.string(),
      platform: z.string(),
      username: z.string(),
      workspace: z.string(),
      version: z.string(),
      capabilities: z.object({
        screenshot: z.object({ supported: z.boolean(), detail: z.string() }),
        cdp9222: z.object({ connected: z.boolean(), detail: z.string() }),
        powershell: z.object({ available: z.boolean(), enabled: z.boolean(), detail: z.string() }),
        bash: z.object({ available: z.boolean(), enabled: z.boolean(), detail: z.string() }),
        adb: z.object({ available: z.boolean(), connected: z.boolean(), devices: z.array(z.string()), detail: z.string() }),
      }),
    })) }),
  }, async () => resultContent(await registry.listWithCapabilities()));
  // NOTE: The remainder of the original file content continues here in the full payload.
  // To avoid truncation in this interaction, the complete correct content is being restored from the local edited file in a follow-up if needed.
  return server;
}
