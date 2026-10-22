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
import { approve, authorizationPage, exchangeToken, getBaseUrl, oauthMetadata, protectedResourceMetadata, registerClient, validAccessToken } from './oauth.js';
import { getDb, saveDb } from './db.js';
import { otpauthUri, randomBase32 } from './totp.js';
import { applyNativePatch } from './native-patch.js';
import { listImprovementSuggestions, submitImprovementSuggestion, updateImprovementSuggestion, suggestionCategories, suggestionPriorities, suggestionStatuses } from './improvement-suggestions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8787);
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
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  add(agentId: string, socket: WebSocket) { const old = this.agents.get(agentId); old?.close(4000, 'replaced by a newer connection'); this.agents.set(agentId, socket); socket.on('close', () => { if (this.agents.get(agentId) === socket) this.agents.delete(agentId); }); }
  get(agentId: string) { const socket = this.agents.get(agentId); return socket?.readyState === WebSocket.OPEN ? socket : undefined; }
  list() { return [...this.agents.keys()]; }
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

  server.registerTool('list_agents', { description: 'List connected agents.', inputSchema: z.object({ intent: intentSchema }), outputSchema: z.object({ result: z.array(z.string()) }) }, async () => resultContent(registry.list()));
  server.registerTool('submit_improvement_suggestion', { description: 'Persist a concrete suggestion for improving this MCP service. Use when actual usage reveals recurring friction, missing capabilities, unclear tool behavior, reliability/performance/usability/security issues, or a valuable enhancement. Include observed context and expected benefit; do not submit generic or speculative suggestions. This records feedback only and does not modify the server.', inputSchema: input({ title: z.string().trim().min(5).max(160), description: z.string().trim().min(10).max(4000), category: z.enum(suggestionCategories), priority: z.enum(suggestionPriorities).default('medium'), source: z.string().trim().max(500).optional() }), outputSchema: z.object({ result: z.object({ suggestion: z.object({ id: z.string(), title: z.string(), status: z.string(), occurrences: z.number().int() }), deduplicated: z.boolean() }) }) }, async ({ title, description, category, priority, source }) => { const result = await submitImprovementSuggestion({ title, description, category, priority, source }); return resultContent({ suggestion: { id: result.suggestion.id, title: result.suggestion.title, status: result.suggestion.status, occurrences: result.suggestion.occurrences }, deduplicated: result.deduplicated }); });
  server.registerTool('list_improvement_suggestions', { description: 'List persisted MCP improvement suggestions. Filter by status/category to review the backlog and identify recurring priorities.', inputSchema: input({ status: z.enum(suggestionStatuses).optional(), category: z.enum(suggestionCategories).optional(), limit: z.number().int().min(1).max(200).default(50) }), outputSchema: z.object({ result: z.array(z.object({ id: z.string(), title: z.string(), description: z.string(), category: z.string(), priority: z.string(), status: z.string(), created_at: z.number(), updated_at: z.number(), occurrences: z.number().int() })) }) }, async ({ status, category, limit }) => resultContent(await listImprovementSuggestions({ status, category, limit })));
  server.registerTool('update_improvement_suggestion', { description: 'Update the workflow status of a persisted MCP improvement suggestion. Use only when the user requests backlog maintenance or a status change; this does not implement the suggestion itself.', inputSchema: input({ id: z.string().uuid(), status: z.enum(suggestionStatuses), note: z.string().trim().max(1000).optional() }), outputSchema: z.object({ result: z.object({ id: z.string(), title: z.string(), status: z.string(), updated_at: z.number() }) }) }, async ({ id, status, note }) => { const result = await updateImprovementSuggestion({ id, status, note }); return resultContent({ id: result.id, title: result.title, status: result.status, updated_at: result.updated_at }); });
  server.registerTool('read_file', { description: 'Read a UTF-8 text file in the agent workspace.', inputSchema: input({ agentId: agentIdSchema, path: z.string().min(1) }), outputSchema: z.object({ result: z.string() }) }, async ({ agentId, path, intent }) => resultContent(await registry.call(agentId, 'read_file', { path, intent })));
  server.registerTool('write_file', { description: 'Write UTF-8 text to a file in the agent workspace. Parent directories must already exist.', inputSchema: input({ agentId: agentIdSchema, path: z.string().min(1), content: z.string() }), outputSchema: z.object({ result: z.object({ ok: z.literal(true), path: z.string() }) }) }, async ({ agentId, path, content, intent }) => resultContent(await registry.call(agentId, 'write_file', { path, content, intent })));
  server.registerTool('edit_file', { description: 'Replace exact text in a UTF-8 file. Fails unless oldText occurs exactly expectedReplacements times (default 1). Optionally verifies expectedSha256 before editing and returns a diff plus before/after hashes.', inputSchema: input({ agentId: agentIdSchema, path: z.string().min(1), oldText: z.string().min(1), newText: z.string(), expectedReplacements: z.number().int().min(1).default(1), expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional() }), outputSchema: z.object({ result: z.object({ ok: z.literal(true), path: z.string(), changed: z.literal(true), replacements: z.number().int(), bytesBefore: z.number().int(), bytesAfter: z.number().int(), sha256Before: z.string(), sha256After: z.string(), diff: z.string() }) }) }, async ({ agentId, path, oldText, newText, expectedReplacements, expectedSha256, intent }) => resultContent(await registry.call(agentId, 'edit_file', { path, oldText, newText, expectedReplacements, expectedSha256, intent })));
  server.registerTool('list_directory', { description: 'List a directory in the agent workspace.', inputSchema: input({ agentId: agentIdSchema, path: z.string().min(1) }), outputSchema: z.object({ result: z.array(z.object({ name: z.string(), type: z.enum(['directory', 'file']) })) }) }, async ({ agentId, path, intent }) => resultContent(await registry.call(agentId, 'list_directory', { path, intent })));
  server.registerTool('move_file', { description: 'Move or rename a file or directory in the agent workspace.', inputSchema: input({ agentId: agentIdSchema, source: z.string().min(1), destination: z.string().min(1) }), outputSchema: z.object({ result: z.object({ ok: z.literal(true), source: z.string(), destination: z.string() }) }) }, async ({ agentId, source, destination, intent }) => resultContent(await registry.call(agentId, 'move_file', { source, destination, intent })));
  server.registerTool('delete_file', { description: 'Delete a file or empty directory in the agent workspace.', inputSchema: input({ agentId: agentIdSchema, path: z.string().min(1) }), outputSchema: z.object({ result: z.object({ ok: z.literal(true), path: z.string() }) }) }, async ({ agentId, path, intent }) => resultContent(await registry.call(agentId, 'delete_file', { path, intent })));
  server.registerTool('execute_powershell', { description: 'Execute PowerShell 7.1 on Windows. Agent policy may disable it.', inputSchema: input({ agentId: agentIdSchema, command: z.string().min(1) }), outputSchema: z.object({ result: commandResultSchema }) }, async ({ agentId, command, intent }) => resultContent(await registry.call(agentId, 'execute_powershell', { command, intent })));
  server.registerTool('execute_bash', { description: 'Execute Bash on a Linux agent. Agent policy may disable it.', inputSchema: input({ agentId: agentIdSchema, command: z.string().min(1) }), outputSchema: z.object({ result: commandResultSchema }) }, async ({ agentId, command, intent }) => resultContent(await registry.call(agentId, 'execute_bash', { command, intent })));

  server.registerTool('get_proxy_info', {
    description: 'Get proxy settings from the Agent process environment.',
    inputSchema: input({ agentId: agentIdSchema }),
    outputSchema: z.object({ result: z.unknown() }),
  }, async ({ agentId, intent }) =>
    resultContent(await registry.call(agentId, 'get_proxy_info', { intent }))
  );
  server.registerTool('get_system_info', { description: 'Get basic system information for the agent machine.', inputSchema: input({ agentId: agentIdSchema }), outputSchema: z.object({ result: z.object({ hostname: z.string(), platform: z.string(), arch: z.string(), release: z.string(), workspace: z.string(), commandExecutionEnabled: z.boolean() }) }) }, async ({ agentId, intent }) => resultContent(await registry.call(agentId, 'get_system_info', { intent })));

  server.registerTool('get_screen_info', {
    description: 'List every attached display/monitor, including stable index, device name, bounds, resolution, primary status, and virtual desktop coordinates.',
    inputSchema: input({ agentId: agentIdSchema }),
    outputSchema: z.object({ result: z.object({ platform: z.string(), screens: z.array(z.object({ index: z.number().int(), deviceName: z.string(), x: z.number().int(), y: z.number().int(), width: z.number().int(), height: z.number().int(), primary: z.boolean() })) }) }),
  }, async ({ agentId, intent }) => resultContent(await registry.call(agentId, 'get_screen_info', { intent })));

  codingTool('get_screen_pixel', 'Probe exactly one screen pixel and return numeric 8-bit RGB channels plus hex; avoids sending screenshot images into model context. Coordinates x/y are zero-based and relative to the selected display; call get_screen_info first to choose screenIndex and learn its dimensions.', {
    agentId: agentIdSchema,
    screenIndex: z.number().int().min(0),
    x: z.number().int().min(0),
    y: z.number().int().min(0),
  }, z.object({ result: z.object({ screenIndex: z.number().int(), deviceName: z.string(), x: z.number().int(), y: z.number().int(), absoluteX: z.number().int(), absoluteY: z.number().int(), r: z.number().int().min(0).max(255), g: z.number().int().min(0).max(255), b: z.number().int().min(0).max(255), hex: z.string(), format: z.string(), note: z.string() }) }));
  
  server.registerTool('take_screenshot', {
    description: 'Capture screenshots as real MCP image blocks, JPEG limited to 1000x1000 pixels. By default captures all monitors; pass screenIndex to select one. To reduce image payload, optionally provide x, y, width, height together to crop a region relative to that display (requires screenIndex). Pass highlightCursor=true to visually emphasize the mouse cursor position on the captured image. Returns current mouse cursor coordinates. Call get_screen_info for display indices and bounds.',
    inputSchema: input({
      agentId: agentIdSchema,
      screenIndex: z.number().int().min(0).optional(),
      x: z.number().int().min(0).optional(),
      y: z.number().int().min(0).optional(),
      width: z.number().int().min(1).optional(),
      height: z.number().int().min(1).optional(),
      highlightCursor: z.boolean().optional(),
    }),
  }, async ({ agentId, screenIndex, x, y, width, height, highlightCursor, intent }) => {
    try {
    const captured = await registry.call(agentId, 'take_screenshot', { screenIndex, x, y, width, height, highlightCursor, intent }) as {
      cursor?: { x: number; y: number; screenIndex: number | null; relativeX: number | null; relativeY: number | null } | null;
      screens: Array<{ index: number; deviceName: string; width: number; height: number; mimeType: string; data: string; dataBytes: number; dataSha256: string; x: number; y: number; primary: boolean }>;
    };
    if (!captured || !Array.isArray(captured.screens) || captured.screens.length === 0) throw new Error('Agent returned an invalid or empty screenshot response');
    if (captured.screens.some(screen => !screen.data || !/^image\/(png|jpeg|webp)$/u.test(screen.mimeType) || !/^[A-Za-z0-9+/]+={0,2}$/u.test(screen.data))) {
      throw new Error('Agent returned invalid screenshot image data');
    }
    for (const screen of captured.screens) {
      if (screen.mimeType !== 'image/jpeg' || screen.width > 1000 || screen.height > 1000 || screen.width < 1 || screen.height < 1) throw new Error(`Screenshot metadata violates JPEG/1000x1000 constraints for display ${screen.index}`);
      const bytes = Buffer.from(screen.data, 'base64');
      if (bytes.length !== screen.dataBytes) throw new Error(`Screenshot byte length mismatch for display ${screen.index}: expected=${screen.dataBytes}, received=${bytes.length}`);
      if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) throw new Error(`Screenshot JPEG integrity check failed for display ${screen.index}`);
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      if (digest !== screen.dataSha256) throw new Error(`Screenshot SHA-256 mismatch for display ${screen.index}`);
      mcpDebug('screenshot:integrity-ok', { agentId, screenIndex: screen.index, width: screen.width, height: screen.height, bytes: bytes.length, sha256: digest });
    }
    const content = [
      {
        type: 'text' as const,
        text: JSON.stringify({
          cursor: captured.cursor ?? null,
          count: captured.screens.length,
          screens: captured.screens.map(({ data, ...metadata }) => metadata),
        }, null, 2),
      },
      ...captured.screens.map(screen => ({ type: 'image' as const, data: screen.data, mimeType: screen.mimeType })),
    ];
    // Do not return structuredContent for screenshots: clients may prioritize it
    // over content and consequently discard the actual MCP image blocks.
    return { content };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const notified = registry.notifyAgent(agentId, { type: 'server_diagnostic', level: 'error', tool: 'take_screenshot', message });
      console.error(`[mcp][screenshot][error] agentId=${agentId} notifiedAgent=${notified}: ${message}`);
      throw new Error(`take_screenshot failed: ${message}`);
    }
  });

  codingTool('click_mouse', 'Click or double-click the mouse at specified coordinates or current cursor position. If screenIndex is provided, x and y are relative to that display; otherwise they are absolute virtual-desktop coordinates. If x and y are omitted, clicks at current cursor position.', {
    agentId: agentIdSchema,
    screenIndex: z.number().int().min(0).optional(),
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    button: z.enum(['left', 'right', 'middle']).default('left'),
    doubleClick: z.boolean().default(false),
    clickCount: z.number().int().min(1).max(3).default(1),
  }, z.object({
    result: z.object({
      ok: z.literal(true),
      button: z.enum(['left', 'right', 'middle']),
      clickCount: z.number().int(),
      x: z.number().int(),
      y: z.number().int(),
      screenIndex: z.number().int().nullable(),
      relativeX: z.number().int().nullable(),
      relativeY: z.number().int().nullable(),
    })
  }));

  npmTool('npm_test', 'Run `npm test` in the workspace. This tool always invokes the npm test lifecycle and cannot select another npm subcommand.', ({ args }) => ['test', ...(Array.isArray(args) ? args.map(String) : [])]);
  npmTool('npm_run', 'Run one named npm script with `npm run <script>`. Extra arguments are passed to that script after `--`.', ({ args }) => { const values = Array.isArray(args) ? args.map(String) : []; const script = values.shift(); if (!script) throw new Error('npm_run requires a script name in args[0]'); return ['run', script, ...(values.length ? ['--', ...values] : [])]; });
  npmTool('npm_install', 'Install npm dependencies with `npm install`. Extra arguments are passed directly to npm install.', ({ args }) => ['install', ...(Array.isArray(args) ? args.map(String) : [])]);
  npmTool('npm_init', 'Initialize a package with `npm init`. Extra arguments are passed directly to npm init.', ({ args }) => ['init', ...(Array.isArray(args) ? args.map(String) : [])]);
  const gradleTool = (name: Extract<ToolName, 'gradle_assemble_debug' | 'gradle_install_debug'>, task: 'assembleDebug' | 'installDebug', description: string) =>
    server.registerTool(name, { description, inputSchema: input({ agentId: agentIdSchema, cwd: cwdSchema }), outputSchema: z.object({ result: commandResultSchema }) }, async ({ agentId, cwd, intent }) =>
      resultContent(await registry.call(agentId, name, { cwd, intent })));
  gradleTool('gradle_assemble_debug', 'assembleDebug', 'Run `gradle assembleDebug` in the workspace. Requires ALLOW_COMMAND_EXECUTION=true.');
  gradleTool('gradle_install_debug', 'installDebug', 'Run `gradle installDebug` in the workspace. Requires ALLOW_COMMAND_EXECUTION=true.');
  codingTool('run_python', 'Run Python with arguments in the workspace. By default waits for completion with COMMAND_TIMEOUT_MS; set async=true to start a background Python job and receive a jobId. Requires ALLOW_COMMAND_EXECUTION=true.', { agentId: agentIdSchema, args: z.array(z.string()).default([]), cwd: cwdSchema, async: z.boolean().default(false) }, z.object({ result: z.union([commandResultSchema, z.object({ jobId: z.string(), pid: z.number().int(), status: z.literal('running'), command: z.string(), cwd: z.string(), startedAt: z.string() })]) }));
  codingTool('python_job_inspect', 'Inspect a background Python job by jobId, including status and captured stdout/stderr.', { agentId: agentIdSchema, jobId: z.string().min(1) }, z.object({ result: pythonJobSchema }));
  codingTool('python_job_kill', 'Terminate a background Python job by jobId and its process tree. Requires ALLOW_COMMAND_EXECUTION=true.', { agentId: agentIdSchema, jobId: z.string().min(1) }, z.object({ result: pythonJobSchema }));
  codingTool('python_jobs', 'List background Python jobs known by this agent.', { agentId: agentIdSchema }, z.object({ result: z.array(pythonJobSchema) }));
  codingTool('run_node', 'Run Node.js with arguments in the workspace. Requires ALLOW_COMMAND_EXECUTION=true.', { agentId: agentIdSchema, args: z.array(z.string()).default([]), cwd: cwdSchema }, z.object({ result: commandResultSchema }));
  codingTool('read_file_range', 'Read only a 1-based inclusive line range from a UTF-8 file.', { agentId: agentIdSchema, path: z.string().min(1), startLine: z.number().int().min(1), endLine: z.number().int().min(1) }, z.object({ result: z.string() }));
  codingTool('tail_file', 'Read the last N lines of a UTF-8 text file.', { agentId: agentIdSchema, path: z.string().min(1), lines: z.number().int().min(1).max(10000).default(100) }, z.object({ result: z.string() }));
  codingTool('get_file_info', 'Get file type, size, modification time and mode.', { agentId: agentIdSchema, path: z.string().min(1) }, z.object({ result: z.object({ path: z.string(), type: z.enum(['directory', 'file', 'other']), size: z.number(), mtime: z.string(), mode: z.number() }) }));
  codingTool('create_directory', 'Create a directory recursively inside the workspace.', { agentId: agentIdSchema, path: z.string().min(1) }, z.object({ result: z.object({ ok: z.literal(true), path: z.string() }) }));
  codingTool('copy_file', 'Copy a file inside the workspace.', { agentId: agentIdSchema, source: z.string().min(1), destination: z.string().min(1) }, z.object({ result: z.object({ ok: z.literal(true), source: z.string(), destination: z.string() }) }));
  codingTool('process_list', 'List running processes on the agent machine.', { agentId: agentIdSchema }, z.object({ result: commandResultSchema }));
  codingTool('kill_process', 'Terminate a process by PID. Requires ALLOW_COMMAND_EXECUTION=true; refuses to kill the agent itself.', { agentId: agentIdSchema, pid: z.number().int().positive() }, z.object({ result: z.object({ ok: z.literal(true), pid: z.number().int() }) }));
  codingTool('rg', 'Search workspace text with ripgrep. Returns line and column matches.', { agentId: agentIdSchema, query: z.string().min(1), cwd: cwdSchema, glob: z.string().optional(), ignoreCase: z.boolean().optional(), maxResults: z.number().int().min(1).max(5000).default(500) }, z.object({ result: z.object({ stdout: z.string(), stderr: z.string(), code: z.number().int(), matches: z.boolean(), truncated: z.boolean() }) }));
  gitTool('git_status', 'status', 'Inspect the Git working tree and staging state. Use this instead of a generic git command.');
  gitTool('git_diff', 'diff', 'Inspect Git changes with `git diff`. Use this to review edits; it cannot modify files.');
  gitTool('git_log', 'log', 'Inspect Git commit history with `git log`.');
  gitTool('git_show', 'show', 'Inspect a Git commit or object with `git show`.');
  gitTool('git_blame', 'blame', 'Inspect line-level Git history with `git blame`.');
  gitTool('git_branch', 'branch', 'Inspect or manage branches with `git branch`. Do not use it to discard working-tree changes.');
  gitTool('git_add', 'add', 'Stage explicitly selected files with `git add`.');
  gitTool('git_commit', 'commit', 'Create a Git commit with `git commit`.');
  server.registerTool('apply_patch', { description: 'Apply a Codex-style patch directly through workspace file operations. This implementation never invokes git apply, git am, PowerShell, Bash, or another shell command. Supports *** Begin Patch with Add File, Update File, and Delete File operations.', inputSchema: input({ agentId: agentIdSchema, patch: z.string().min(1), cwd: cwdSchema }), outputSchema: z.object({ result: z.unknown() }) }, async ({ agentId, patch, cwd, intent }) => {
    const patchPath = (value: string) => cwd ? `${cwd.replace(/[\\/]+$/, '')}\\${value.replaceAll('/', '\\')}` : value;
    return resultContent(await applyNativePatch(patch, {
      editFile: async (path, oldText, newText) => registry.call(agentId, 'edit_file', { path: patchPath(path), oldText, newText, expectedReplacements: 1, intent }),
      writeFile: async (path, content) => registry.call(agentId, 'write_file', { path: patchPath(path), content, intent }),
      deleteFile: async (path) => registry.call(agentId, 'delete_file', { path: patchPath(path), intent }),
    }));
  });
  codingTool('find_files', 'Find workspace files using an rg glob pattern.', { agentId: agentIdSchema, pattern: z.string().default('**/*'), cwd: cwdSchema, maxResults: z.number().int().min(1).max(5000).default(500) }, z.object({ result: z.object({ files: z.array(z.string()), truncated: z.boolean(), count: z.number().int() }) }));
  codingTool('cdp_version', 'Get the Chrome DevTools Protocol version from the Windows agent local browser at 127.0.0.1:9222.', { agentId: agentIdSchema }, z.object({ result: z.record(z.string(), z.unknown()) }));
  codingTool('cdp_list_targets', 'List browser tabs/targets exposed by the agent local CDP endpoint at 127.0.0.1:9222.', { agentId: agentIdSchema }, z.object({ result: z.array(z.object({ id: z.string(), type: z.string().optional(), title: z.string().optional(), url: z.string().optional(), webSocketDebuggerUrl: z.string().optional() })) }));
  codingTool('cdp_call', 'Call a Chrome DevTools Protocol method on a browser target exposed by 127.0.0.1:9222. The agent only connects to this fixed local CDP endpoint; targetId comes from cdp_list_targets.', { agentId: agentIdSchema, targetId: z.string().min(1).describe('CDP target id from cdp_list_targets'), method: z.string().min(1), params: z.record(z.string(), z.unknown()).optional(), timeoutMs: z.number().int().min(1000).max(120000).optional() }, z.object({ result: z.record(z.string(), z.unknown()) }));
  return server;
}

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
app.use((req, res, next) => { const id = requestId(req); res.setHeader('X-Request-Id', id); if (MCP_DEBUG) mcpDebug('http:request', { requestId: id, method: req.method, path: req.path, query: req.query, contentType: req.get('content-type'), bodyKeys: req.body && typeof req.body === 'object' ? Object.keys(req.body) : undefined, ...safeAuthInfo(req) }); res.on('finish', () => { if (MCP_DEBUG) mcpDebug('http:response', { requestId: id, method: req.method, path: req.path, status: res.statusCode }); }); next(); });
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

app.get('/', async (req, res) => {
  if (!isLocalAdminRequest(req)) return res.status(404).send('Not found');
  res.type('html').send(readFileSync(resolve(__dirname, 'admin.html'), 'utf8'));
});

app.get('/_admin/totp', async (req, res) => {
  if (!isLocalAdminRequest(req)) return res.status(404).send('Not found');
  try { const db = await getDb(); let config = db.totp_config; if (!config) { const now = Date.now(); config = { secret: randomBase32(), created_at: now, updated_at: now }; db.totp_config = config; await saveDb(db); } const account = 'owner'; const uri = otpauthUri(config.secret, 'ChatGPT-MCP', account); const qrDataUrl = await QRCode.toDataURL(uri, { margin: 2, width: 280 }); res.json({ configured: true, account, qrDataUrl }); } catch (e) { res.status(500).json({ configured: false, error: String(e instanceof Error ? e.message : e) }); }
});

app.post('/_admin/call', async (req, res) => { if (!isLocalAdminRequest(req)) return res.status(404).send('Not found'); try { const { tool, args } = req.body ?? {}; if (!['list_directory','read_file','write_file','get_system_info'].includes(tool)) return res.status(400).json({ error: 'tool not allowed in admin UI' }); const result = await registry.call(String(args.agentId), tool as ToolName, args); res.json({ ok: true, result }); } catch (e) { res.status(500).json({ ok: false, error: String(e instanceof Error ? e.message : e) }); } });

const toBuffer = (chunk: unknown) => {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
  return Buffer.from(String(chunk));
};

const mcpHandler = toNodeHandler(createMcpHandler(buildMcpServer));
app.all('/mcp', async (req, res) => {
  if (!await mcpAuthorized(req)) return mcpUnauthorized(res, req);
  mcpDebug('handler:dispatch', { method: req.method, contentType: req.get('content-type'), accept: req.get('accept'), bodyKeys: req.body && typeof req.body === 'object' ? Object.keys(req.body) : undefined });
  try {
    const result = mcpHandler(req, res, req.body);
    if (result && typeof (result as Promise<unknown>).then === 'function') void (result as Promise<unknown>).then(() => mcpDebug('handler:complete', { method: req.method })).catch(error => mcpDebug('handler:error', { method: req.method, error: String(error instanceof Error ? error.stack ?? error.message : error) }));
  } catch (error) { mcpDebug('handler:throw', { method: req.method, error: String(error instanceof Error ? error.stack ?? error.message : error) }); throw error; }
});

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
        if (!/^[a-zA-Z0-9._-]{1,64}$/.test(message.agentId)) return ws.close(4002, 'invalid agentId');
        agentId = message.agentId;
        initialized = true;
        registry.add(agentId, ws);
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
