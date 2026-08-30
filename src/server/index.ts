import { createServer as createHttpServer } from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { AgentMessage, AgentRequest, AgentResponse, ToolName } from '../shared/protocol.js';

const PORT = Number(process.env.PORT ?? 8787);
const MCP_TOKEN = process.env.MCP_TOKEN;
const AGENT_TOKEN = process.env.AGENT_TOKEN;
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 60_000);

if (!MCP_TOKEN || !AGENT_TOKEN) {
  throw new Error('MCP_TOKEN and AGENT_TOKEN must be set');
}

class AgentRegistry {
  private readonly agents = new Map<string, WebSocket>();

  add(agentId: string, socket: WebSocket) {
    const old = this.agents.get(agentId);
    old?.close(4000, 'replaced by a newer connection');
    this.agents.set(agentId, socket);
    socket.on('close', () => {
      if (this.agents.get(agentId) === socket) this.agents.delete(agentId);
    });
  }

  get(agentId: string) {
    const socket = this.agents.get(agentId);
    if (!socket || socket.readyState !== WebSocket.OPEN) return undefined;
    return socket;
  }

  list() {
    return [...this.agents.keys()];
  }

  async call(agentId: string, tool: ToolName, args: Record<string, unknown>) {
    const socket = this.get(agentId);
    if (!socket) throw new Error(`Windows agent '${agentId}' is not connected`);

    const id = crypto.randomUUID();
    const request: AgentRequest = { type: 'request', id, tool, args };

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Agent request timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      const pending = this.pending;
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });

      try {
        socket.send(JSON.stringify(request));
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  handleMessage(message: AgentMessage) {
    if (message.type !== 'response') return;
    const response = message as AgentResponse;
    const item = this.pending.get(response.id);
    if (!item) return;
    this.pending.delete(response.id);
    if (response.ok) item.resolve(response.result);
    else item.reject(new Error(response.error ?? 'Agent request failed'));
  }
}

const registry = new AgentRegistry();

function authHeader(req: express.Request, expected: string) {
  const value = req.header('authorization');
  return value === `Bearer ${expected}`;
}

function buildMcpServer() {
  const server = new McpServer({ name: 'chatgpt-windows-bridge', version: '0.1.0' });

  const agentIdSchema = z.string().min(1).describe('The Windows agent ID, e.g. desktop-01');

  server.registerTool('list_agents', {
    description: 'List connected Windows computers that can be controlled through the bridge.',
    inputSchema: z.object({}),
  }, async () => ({
    content: [{ type: 'text', text: JSON.stringify(registry.list(), null, 2) }],
  }));

  server.registerTool('read_file', {
    description: 'Read a UTF-8 text file from a connected Windows computer.',
    inputSchema: z.object({ agentId: agentIdSchema, path: z.string().min(1) }),
  }, async ({ agentId, path }) => resultContent(await registry.call(agentId, 'read_file', { path })));

  server.registerTool('write_file', {
    description: 'Write UTF-8 text to a file on a connected Windows computer. Parent directories must already exist.',
    inputSchema: z.object({ agentId: agentIdSchema, path: z.string().min(1), content: z.string() }),
  }, async ({ agentId, path, content }) => resultContent(await registry.call(agentId, 'write_file', { path, content })));

  server.registerTool('list_directory', {
    description: 'List files and directories on a connected Windows computer.',
    inputSchema: z.object({ agentId: agentIdSchema, path: z.string().min(1) }),
  }, async ({ agentId, path }) => resultContent(await registry.call(agentId, 'list_directory', { path })));

  server.registerTool('move_file', {
    description: 'Move or rename a file or directory on a connected Windows computer.',
    inputSchema: z.object({ agentId: agentIdSchema, source: z.string().min(1), destination: z.string().min(1) }),
  }, async ({ agentId, source, destination }) => resultContent(await registry.call(agentId, 'move_file', { source, destination })));

  server.registerTool('delete_file', {
    description: 'Delete a file or empty directory on a connected Windows computer. The agent may require local confirmation depending on its policy.',
    inputSchema: z.object({ agentId: agentIdSchema, path: z.string().min(1) }),
  }, async ({ agentId, path }) => resultContent(await registry.call(agentId, 'delete_file', { path })));

  server.registerTool('execute_powershell', {
    description: 'Execute a PowerShell command on a connected Windows computer. Enable command execution explicitly on the agent; do not use for destructive operations unless intended.',
    inputSchema: z.object({ agentId: agentIdSchema, command: z.string().min(1) }),
  }, async ({ agentId, command }) => resultContent(await registry.call(agentId, 'execute_powershell', { command })));

  server.registerTool('get_system_info', {
    description: 'Get basic operating-system information from a connected Windows computer.',
    inputSchema: z.object({ agentId: agentIdSchema }),
  }, async ({ agentId }) => resultContent(await registry.call(agentId, 'get_system_info', {})));

  return server;
}

function resultContent(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

const app = express();
app.disable('x-powered-by');
app.get('/healthz', (_req, res) => res.json({ ok: true, agents: registry.list() }));
app.get('/agents', (req, res) => {
  if (!authHeader(req, MCP_TOKEN!)) return res.status(401).json({ error: 'unauthorized' });
  res.json({ agents: registry.list() });
});

const mcpHandler = toNodeHandler(createMcpHandler(buildMcpServer));
app.all('/mcp', (req, res, next) => {
  if (!authHeader(req, MCP_TOKEN!)) return res.status(401).json({ error: 'unauthorized' });
  return mcpHandler(req, res, next);
});

const httpServer = createHttpServer(app);
const wss = new WebSocketServer({ noServer: true });

httpServer.on('upgrade', (req, socket, head) => {
  if (req.url !== '/agent') {
    socket.destroy();
    return;
  }

  const auth = req.headers.authorization;
  if (auth !== `Bearer ${AGENT_TOKEN}`) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  let agentId: string | undefined;
  let initialized = false;

  ws.on('message', raw => {
    try {
      const message = JSON.parse(raw.toString()) as AgentMessage;
      if (message.type === 'hello') {
        if (!/^[a-zA-Z0-9._-]{1,64}$/.test(message.agentId)) {
          ws.close(4002, 'invalid agentId');
          return;
        }
        agentId = message.agentId;
        initialized = true;
        registry.add(agentId, ws);
        console.log(`[agent] connected ${agentId} (${message.hostname})`);
        return;
      }
      if (!initialized) {
        ws.close(4003, 'hello required');
        return;
      }
      registry.handleMessage(message);
    } catch {
      ws.close(4004, 'invalid message');
    }
  });

  ws.on('close', () => {
    if (agentId) console.log(`[agent] disconnected ${agentId}`);
  });
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`MCP gateway listening on :${PORT}`);
  console.log(`MCP endpoint: http://0.0.0.0:${PORT}/mcp`);
  console.log(`Agent endpoint: ws://0.0.0.0:${PORT}/agent`);
});
