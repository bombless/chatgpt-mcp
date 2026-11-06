import { createServer as createHttpServer } from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { AgentMessage, AgentRequest, AgentResponse, ToolName } from '../shared/protocol.js';
import { isValidAgentId } from '../shared/agent-id.js';
import { suggestionCategories, suggestionPriorities, suggestionStatuses } from './improvement-suggestions.js';
import { createToolHandlers } from './tool-handlers.js';
import { createMcpApp } from './mcp-app.js';
import { createAdminApp } from './admin-app.js';

const PORT = Number(process.env.PORT ?? 8787);
const ADMIN_PORT = Number(process.env.ADMIN_PORT ?? 8788);
const AGENT_TOKEN = process.env.AGENT_TOKEN;
const LEGACY_MCP_TOKEN = process.env.MCP_TOKEN;
const PUBLIC_URL = process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') : undefined;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 60_000);
const MCP_DEBUG = process.env.MCP_DEBUG === '1' || process.env.DEBUG_MCP === '1';
if (!AGENT_TOKEN) throw new Error('AGENT_TOKEN must be set');

function mcpDebug(event: string, details: Record<string, unknown> = {}) { if (MCP_DEBUG) console.log(`[mcp] ${event} ${JSON.stringify(details)}`); }

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
function resultContent(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const time = `${new Date().getHours().toString().padStart(2, '0')}:${new Date().getMinutes().toString().padStart(2, '0')}`;
  console.log('[mcp][' + time +'] agent result returned to model:', text);
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: { result: value },
  };
}


function buildMcpServer() {
  const server = new McpServer({ name: 'chatgpt-windows-bridge', version: '0.3.0' });
  const agentIdSchema = z.string().min(1).describe('Windows agent ID, e.g. desktop-01');
  const cwdSchema = z.string().min(1).optional().describe('Workspace directory; must be inside AGENT_WORKSPACE.');
  const intentSchema = z.string().min("let me ".length).max(500).describe('Briefly explain what you are doing and why. This is shown to the user as the current tool activity. You must start with "let me " and be a single sentence. For example: "let me read the first 100 lines of a log file to check for errors."');
  const commandResultSchema = z.object({ stdout: z.string(), stderr: z.string(), code: z.number().int() });
  const pythonJobSchema = z.object({ jobId: z.string(), pid: z.number().int(), status: z.enum(['running', 'exited', 'failed', 'killed']), command: z.string(), cwd: z.string(), args: z.array(z.string()), startedAt: z.string(), finishedAt: z.string().nullable(), exitCode: z.number().int().nullable(), signal: z.string().nullable(), stdout: z.string(), stderr: z.string(), stdoutTruncated: z.boolean(), stderrTruncated: z.boolean() });
  const input = <const T extends Record<string, z.ZodType>>(shape: T) => z.object({ ...shape, intent: intentSchema });
  const handlers = createToolHandlers({ registry, resultContent, mcpDebug });
  const codingTool = (name: ToolName, description: string, shape: Record<string, z.ZodType>, outputSchema: z.ZodType) =>
    server.registerTool(name, { description, inputSchema: input(shape), outputSchema }, handlers.codingTool(name));
  const npmTool = (name: Extract<ToolName, 'npm_test' | 'npm_run' | 'npm_install' | 'npm_init'>, description: string, argsBuilder: (args: Record<string, unknown>) => string[]) =>
    server.registerTool(name, { description, inputSchema: input({ agentId: agentIdSchema, args: z.array(z.string()).default([]), cwd: cwdSchema }), outputSchema: z.object({ result: commandResultSchema }) }, handlers.npmTool(name, argsBuilder));
  const gitTool = (name: string, subcommand: string, description: string) =>
    server.registerTool(name, { description, inputSchema: input({ agentId: agentIdSchema, args: z.array(z.string()).default([]), cwd: cwdSchema }), outputSchema: z.object({ result: commandResultSchema }) }, handlers.gitTool(subcommand));

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
  }, handlers.listAgents);
  server.registerTool('submit_improvement_suggestion', { description: 'Persist a concrete suggestion for improving this MCP service. Use when actual usage reveals recurring friction, missing capabilities, unclear tool behavior, reliability/performance/usability/security issues, or a valuable enhancement. Include observed context and expected benefit; do not submit generic or speculative suggestions. This records feedback only and does not modify the server.', inputSchema: input({ title: z.string().trim().min(5).max(160), description: z.string().trim().min(10).max(4000), category: z.enum(suggestionCategories), priority: z.enum(suggestionPriorities).default('medium'), source: z.string().trim().max(500).optional() }), outputSchema: z.object({ result: z.object({ suggestion: z.object({ id: z.string(), title: z.string(), status: z.string(), occurrences: z.number().int() }), deduplicated: z.boolean() }) }) }, handlers.submitImprovementSuggestion);
  server.registerTool('list_improvement_suggestions', { description: 'List persisted MCP improvement suggestions. Filter by status/category to review the backlog and identify recurring priorities.', inputSchema: input({ status: z.enum(suggestionStatuses).optional(), category: z.enum(suggestionCategories).optional(), limit: z.number().int().min(1).max(200).default(50) }), outputSchema: z.object({ result: z.array(z.object({ id: z.string(), title: z.string(), description: z.string(), category: z.string(), priority: z.string(), status: z.string(), created_at: z.number(), updated_at: z.number(), occurrences: z.number().int() })) }) }, handlers.listImprovementSuggestions);
  server.registerTool('update_improvement_suggestion', { description: 'Update the workflow status of a persisted MCP improvement suggestion. Use only when the user requests backlog maintenance or a status change; this does not implement the suggestion itself.', inputSchema: input({ id: z.string().uuid(), status: z.enum(suggestionStatuses), note: z.string().trim().max(1000).optional() }), outputSchema: z.object({ result: z.object({ id: z.string(), title: z.string(), status: z.string(), updated_at: z.number() }) }) }, handlers.updateImprovementSuggestion);
  server.registerTool('read_file', { description: 'Read a UTF-8 text file and return its full-content SHA-256. Pass that hash to every subsequent file mutation.', inputSchema: input({ agentId: agentIdSchema, path: z.string().min(1) }), outputSchema: z.object({ result: z.object({ path: z.string(), content: z.string(), sha256: z.string().length(64), bytes: z.number().int() }) }) }, handlers.readFile);
  server.registerTool('write_file', { description: 'Create a new UTF-8 file, or overwrite an existing file only when expectedSha256 matches the version returned by read_file.', inputSchema: input({ agentId: agentIdSchema, path: z.string().min(1), content: z.string(), expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional() }), outputSchema: z.object({ result: z.object({ ok: z.literal(true), path: z.string(), sha256Before: z.string().nullable(), sha256After: z.string(), bytesAfter: z.number().int() }) }) }, handlers.writeFile);
  server.registerTool('edit_file', { description: 'Replace exact text in a UTF-8 file. expectedSha256 is REQUIRED and must be the full-file hash returned by read_file/read_file_range/tail_file. Fails on stale versions and returns the new hash.', inputSchema: input({ agentId: agentIdSchema, path: z.string().min(1), oldText: z.string().min(1), newText: z.string(), expectedReplacements: z.number().int().min(1).default(1), expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/) }), outputSchema: z.object({ result: z.object({ ok: z.literal(true), path: z.string(), changed: z.literal(true), replacements: z.number().int(), bytesBefore: z.number().int(), bytesAfter: z.number().int(), sha256Before: z.string(), sha256After: z.string(), diff: z.string() }) }) }, handlers.editFile);
  server.registerTool('list_directory', { description: 'List a directory in the agent workspace.', inputSchema: input({ agentId: agentIdSchema, path: z.string().min(1) }), outputSchema: z.object({ result: z.array(z.object({ name: z.string(), type: z.enum(['directory', 'file']) })) }) }, handlers.listDirectory);
  server.registerTool('move_file', { description: 'Move or rename a file only when expectedSha256 matches the source file version returned by a read tool. Destination must not exist.', inputSchema: input({ agentId: agentIdSchema, source: z.string().min(1), destination: z.string().min(1), expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/) }), outputSchema: z.object({ result: z.object({ ok: z.literal(true), source: z.string(), destination: z.string(), sha256: z.string() }) }) }, handlers.moveFile);
  server.registerTool('delete_file', { description: 'Delete a file only when expectedSha256 matches the file version returned by a read tool.', inputSchema: input({ agentId: agentIdSchema, path: z.string().min(1), expectedSha256: z.string().regex(/^[a-fA-F0-9]{64}$/) }), outputSchema: z.object({ result: z.object({ ok: z.literal(true), path: z.string(), sha256Before: z.string() }) }) }, handlers.deleteFile);
  server.registerTool('execute_powershell', { description: 'Execute PowerShell 7.1 on Windows. Agent policy may disable it.', inputSchema: input({ agentId: agentIdSchema, command: z.string().min(1) }), outputSchema: z.object({ result: commandResultSchema }) }, handlers.executePowershell);
  server.registerTool('execute_bash', { description: 'Execute Bash on a Linux agent. Agent policy may disable it.', inputSchema: input({ agentId: agentIdSchema, command: z.string().min(1) }), outputSchema: z.object({ result: commandResultSchema }) }, handlers.executeBash);

  server.registerTool('get_proxy_info', {
    description: 'Get proxy settings from the Agent process environment.',
    inputSchema: input({ agentId: agentIdSchema }),
    outputSchema: z.object({ result: z.unknown() }),
  }, handlers.getProxyInfo);
  server.registerTool('get_system_info', { description: 'Get basic system information for the agent machine.', inputSchema: input({ agentId: agentIdSchema }), outputSchema: z.object({ result: z.object({ hostname: z.string(), platform: z.string(), arch: z.string(), release: z.string(), workspace: z.string(), commandExecutionEnabled: z.boolean() }) }) }, handlers.getSystemInfo);

  server.registerTool('read_image_file', {
    description: 'Read a JPEG or PNG image from an absolute path on the connected agent and return it as a native MCP image block. The resolved file must be inside AGENT_WORKSPACE; maximum size is 20 MiB.',
    inputSchema: input({ agentId: agentIdSchema, path: z.string().min(1) }),
  }, handlers.readImageFile);

  server.registerTool('get_screen_info', {
    description: 'List every attached display/monitor, including stable index, device name, bounds, resolution, primary status, and virtual desktop coordinates.',
    inputSchema: input({ agentId: agentIdSchema }),
    outputSchema: z.object({ result: z.object({ platform: z.string(), screens: z.array(z.object({ index: z.number().int(), deviceName: z.string(), x: z.number().int(), y: z.number().int(), width: z.number().int(), height: z.number().int(), primary: z.boolean() })) }) }),
  }, handlers.getScreenInfo);

  codingTool('get_screen_pixel', 'Probe exactly one screen pixel and return numeric 8-bit RGB channels plus hex; avoids sending screenshot images into model context. Coordinates x/y are zero-based and relative to the selected display; call get_screen_info first to choose screenIndex and learn its dimensions.', {
    agentId: agentIdSchema,
    screenIndex: z.number().int().min(0),
    x: z.number().int().min(0),
    y: z.number().int().min(0),
  }, z.object({ result: z.object({ screenIndex: z.number().int(), deviceName: z.string(), x: z.number().int(), y: z.number().int(), absoluteX: z.number().int(), absoluteY: z.number().int(), r: z.number().int().min(0).max(255), g: z.number().int().min(0).max(255), b: z.number().int().min(0).max(255), hex: z.string(), format: z.string(), note: z.string() }) }));
  
  server.registerTool('take_adb_screenshot', {
    description: 'Capture the connected Android phone screen through Android Debug Bridge (ADB) and return the PNG as a native MCP image block. If exactly one authorized device is connected, serial may be omitted; when multiple devices are connected, specify serial from adb devices. Requires adb installed and USB debugging enabled/authorized on the phone.',
    inputSchema: input({ agentId: agentIdSchema, serial: z.string().trim().min(1).optional() }),
  }, handlers.takeAdbScreenshot);

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
  }, handlers.takeScreenshot);

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

  codingTool('move_mouse', 'Move the mouse cursor to specified coordinates. If screenIndex is provided, x and y are relative to that display; otherwise they are absolute virtual-desktop coordinates.', {
    agentId: agentIdSchema,
    screenIndex: z.number().int().min(0).optional(),
    x: z.number().int(),
    y: z.number().int(),
  }, z.object({
    result: z.object({
      ok: z.literal(true),
      x: z.number().int(),
      y: z.number().int(),
      screenIndex: z.number().int().nullable(),
      relativeX: z.number().int().nullable(),
      relativeY: z.number().int().nullable(),
    })
  }));

  codingTool('scroll_mouse', 'Scroll the mouse wheel up, down, left, or right by a specified amount (ticks/clicks). IMPORTANT: Before scrolling a page, list, table, or panel, inspect the latest screenshot and move the pointer to a point INSIDE the intended scrollable content (for example, over a list item, not the header, blank margin, or another window), then scroll using explicit x, y, and screenIndex. Do not assume scrolling worked: take another screenshot and verify the target content moved; if it did not, try a different point inside the content or a smaller scroll amount, then verify again. If x and y are provided, moves the cursor there before scrolling; otherwise scrolls at the current cursor position. If screenIndex is provided, x and y are relative to that display.', {
    agentId: agentIdSchema,
    screenIndex: z.number().int().min(0).optional(),
    x: z.number().int().optional(),
    y: z.number().int().optional(),
    direction: z.enum(['up', 'down', 'left', 'right']).default('down'),
    amount: z.number().int().min(1).default(1),
    deltaY: z.number().int().optional(),
    deltaX: z.number().int().optional(),
  }, z.object({
    result: z.object({
      ok: z.literal(true),
      direction: z.enum(['up', 'down', 'left', 'right']),
      amount: z.number().int(),
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
    server.registerTool(name, { description, inputSchema: input({ agentId: agentIdSchema, cwd: cwdSchema }), outputSchema: z.object({ result: commandResultSchema }) }, handlers.gradleTool(name));
  gradleTool('gradle_assemble_debug', 'assembleDebug', 'Run `gradle assembleDebug` in the workspace. Requires ALLOW_COMMAND_EXECUTION=true.');
  gradleTool('gradle_install_debug', 'installDebug', 'Run `gradle installDebug` in the workspace. Requires ALLOW_COMMAND_EXECUTION=true.');
  codingTool('run_python', 'Run Python with arguments in the workspace. By default waits for completion with COMMAND_TIMEOUT_MS; set async=true to start a background Python job and receive a jobId. Requires ALLOW_COMMAND_EXECUTION=true.', { agentId: agentIdSchema, args: z.array(z.string()).default([]), cwd: cwdSchema, async: z.boolean().default(false) }, z.object({ result: z.union([commandResultSchema, z.object({ jobId: z.string(), pid: z.number().int(), status: z.literal('running'), command: z.string(), cwd: z.string(), startedAt: z.string() })]) }));
  codingTool('python_job_inspect', 'Inspect a background Python job by jobId, including status and captured stdout/stderr.', { agentId: agentIdSchema, jobId: z.string().min(1) }, z.object({ result: pythonJobSchema }));
  codingTool('python_job_kill', 'Terminate a background Python job by jobId and its process tree. Requires ALLOW_COMMAND_EXECUTION=true.', { agentId: agentIdSchema, jobId: z.string().min(1) }, z.object({ result: pythonJobSchema }));
  codingTool('python_jobs', 'List background Python jobs known by this agent.', { agentId: agentIdSchema }, z.object({ result: z.array(pythonJobSchema) }));
  codingTool('run_node', 'Run Node.js with arguments in the workspace. Requires ALLOW_COMMAND_EXECUTION=true.', { agentId: agentIdSchema, args: z.array(z.string()).default([]), cwd: cwdSchema }, z.object({ result: commandResultSchema }));
  const fileReadResultSchema = z.object({ path: z.string(), content: z.string(), sha256: z.string().length(64), bytes: z.number().int() });
  codingTool('read_file_range', 'Read a 1-based inclusive line range and return the SHA-256 of the entire original file. Use that hash for subsequent edits.', { agentId: agentIdSchema, path: z.string().min(1), startLine: z.number().int().min(1), endLine: z.number().int().min(1) }, z.object({ result: fileReadResultSchema }));
  codingTool('tail_file', 'Read the last N lines and return the SHA-256 of the entire original file. Use that hash for subsequent edits.', { agentId: agentIdSchema, path: z.string().min(1), lines: z.number().int().min(1).max(10000).default(100) }, z.object({ result: fileReadResultSchema }));
  codingTool('get_file_info', 'Get file type, size, modification time and mode.', { agentId: agentIdSchema, path: z.string().min(1) }, z.object({ result: z.object({ path: z.string(), type: z.enum(['directory', 'file', 'other']), size: z.number(), mtime: z.string(), mode: z.number() }) }));
  codingTool('create_directory', 'Create a directory recursively inside the workspace.', { agentId: agentIdSchema, path: z.string().min(1) }, z.object({ result: z.object({ ok: z.literal(true), path: z.string() }) }));
  codingTool('copy_file', 'Copy a file only when expectedSourceSha256 matches the source version. If the destination exists, expectedDestinationSha256 is also required and must match its current version.', { agentId: agentIdSchema, source: z.string().min(1), destination: z.string().min(1), expectedSourceSha256: z.string().regex(/^[a-fA-F0-9]{64}$/), expectedDestinationSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional() }, z.object({ result: z.object({ ok: z.literal(true), source: z.string(), destination: z.string(), sha256Source: z.string(), sha256Before: z.string().nullable(), sha256After: z.string() }) }));
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
  server.registerTool('apply_patch', { description: 'Apply a Codex-style patch with mandatory expectedSha256ByPath entries for every changed file. Use full-file hashes from read tools; use __missing__ only for Add File operations.', inputSchema: input({ agentId: agentIdSchema, patch: z.string().min(1), cwd: cwdSchema, expectedSha256ByPath: z.record(z.string(), z.string().regex(/^(?:[a-fA-F0-9]{64}|__missing__)$/)) }), outputSchema: z.object({ result: z.unknown() }) }, handlers.applyPatch);
  codingTool('find_files', 'Find workspace files using an rg glob pattern.', { agentId: agentIdSchema, pattern: z.string().default('**/*'), cwd: cwdSchema, maxResults: z.number().int().min(1).max(5000).default(500) }, z.object({ result: z.object({ files: z.array(z.string()), truncated: z.boolean(), count: z.number().int() }) }));
  codingTool('cdp_version', 'Get the Chrome DevTools Protocol version from the Windows agent local browser at 127.0.0.1:9222.', { agentId: agentIdSchema }, z.object({ result: z.record(z.string(), z.unknown()) }));
  codingTool('cdp_list_targets', 'List browser tabs/targets exposed by the agent local CDP endpoint at 127.0.0.1:9222.', { agentId: agentIdSchema }, z.object({ result: z.array(z.object({ id: z.string(), type: z.string().optional(), title: z.string().optional(), url: z.string().optional(), webSocketDebuggerUrl: z.string().optional() })) }));
  codingTool('cdp_call', 'Call a Chrome DevTools Protocol method on a browser target exposed by 127.0.0.1:9222. The agent only connects to this fixed local CDP endpoint; targetId comes from cdp_list_targets.', { agentId: agentIdSchema, targetId: z.string().min(1).describe('CDP target id from cdp_list_targets'), method: z.string().min(1), params: z.record(z.string(), z.unknown()).optional(), timeoutMs: z.number().int().min(1000).max(120000).optional() }, z.object({ result: z.record(z.string(), z.unknown()) }));
  return server;
}

const app = createMcpApp({ registry, buildMcpServer, legacyMcpToken: LEGACY_MCP_TOKEN, mcpDebug });
const adminApp = createAdminApp({ registry, buildMcpServer });

const adminServer = createHttpServer(adminApp);
adminServer.listen(ADMIN_PORT, '127.0.0.1', () => {
  console.log(`Admin console listening on http://127.0.0.1:${ADMIN_PORT}`);
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
        if (!isValidAgentId(message.agentId)) return ws.close(4002, 'invalid agentId');
        agentId = message.agentId;
        initialized = true;
        registry.add(agentId, ws, {
          hostname: typeof message.hostname === 'string' ? message.hostname : agentId,
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
