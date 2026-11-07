import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import type { AgentMessage, AgentRequest, AgentResponse, ToolName, AgentMetadata, LocalAgentHandler } from '../shared/protocol.js';

const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 60_000);
const MCP_DEBUG = process.env.MCP_DEBUG === '1' || process.env.DEBUG_MCP === '1';
function mcpDebug(event: string, details: Record<string, unknown> = {}) { if (MCP_DEBUG) console.log(`[mcp] ${event} ${JSON.stringify(details)}`); }

type AgentEntry =
  | { kind: 'ws'; socket: WebSocket; metadata: AgentMetadata }
  | { kind: 'local'; handler: LocalAgentHandler; metadata: AgentMetadata };

class AgentRegistry {
  private readonly agents = new Map<string, AgentEntry>();
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  add(agentId: string, socket: WebSocket, metadata: AgentMetadata) {
    const old = this.agents.get(agentId);
    if (old?.kind === 'ws') old.socket.close(4000, 'replaced by a newer connection');
    this.agents.set(agentId, { kind: 'ws', socket, metadata });
    socket.on('close', () => {
      const current = this.agents.get(agentId);
      if (current?.kind === 'ws' && current.socket === socket) this.agents.delete(agentId);
    });
  }

  /** Register an in-process agent. Tool calls invoke handler directly — no WebSocket / IPC. */
  addLocal(agentId: string, metadata: AgentMetadata, handler: LocalAgentHandler) {
    const old = this.agents.get(agentId);
    if (old?.kind === 'ws') old.socket.close(4000, 'replaced by local agent');
    this.agents.set(agentId, { kind: 'local', handler, metadata });
    console.log(`[agent] local in-process agent registered: ${agentId}`);
  }

  removeLocal(agentId: string) {
    const current = this.agents.get(agentId);
    if (current?.kind === 'local') this.agents.delete(agentId);
  }

  get(agentId: string) {
    const entry = this.agents.get(agentId);
    if (!entry) return undefined;
    if (entry.kind === 'ws') return entry.socket.readyState === WebSocket.OPEN ? entry.socket : undefined;
    return entry;
  }

  isConnected(agentId: string) {
    const entry = this.agents.get(agentId);
    if (!entry) return false;
    if (entry.kind === 'local') return true;
    return entry.socket.readyState === WebSocket.OPEN;
  }

  list() {
    return [...this.agents.keys()].map(agentId => {
      const entry = this.agents.get(agentId);
      const metadata = entry?.metadata;
      return {
        agentId,
        hostname: metadata?.hostname ?? agentId,
        os: metadata?.platform === 'win32' ? 'windows' : metadata?.platform === 'linux' ? 'linux' : metadata?.platform ?? 'unknown',
        platform: metadata?.platform ?? 'unknown',
        username: metadata?.username ?? 'unknown',
        workspace: metadata?.workspace ?? 'unknown',
        version: metadata?.version ?? 'unknown',
        transport: entry?.kind ?? 'unknown',
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
    const entry = this.agents.get(agentId);
    if (!entry) { mcpDebug('agent-diagnostic:unavailable', { agentId, tool: message.tool, message: message.message }); return false; }
    if (entry.kind === 'local') {
      console.error(`[agent][local][${message.level}] tool=${message.tool}${message.requestId ? ` requestId=${message.requestId}` : ''}: ${message.message}`);
      return true;
    }
    try { entry.socket.send(JSON.stringify(message)); return true; } catch (error) { mcpDebug('agent-diagnostic:send-error', { agentId, tool: message.tool, error: String(error) }); return false; }
  }

  async call(agentId: string, tool: ToolName, args: Record<string, unknown>) {
    const entry = this.agents.get(agentId);
    if (!entry || (entry.kind === 'ws' && entry.socket.readyState !== WebSocket.OPEN)) {
      mcpDebug('agent-call:missing', { agentId, tool });
      throw new Error(`Windows agent '${agentId}' is not connected`);
    }
    const id = crypto.randomUUID();
    const request: AgentRequest = { type: 'request', id, tool, args };
    mcpDebug('agent-call:start', { requestId: id, agentId, tool, transport: entry.kind });

    if (entry.kind === 'local') {
      return await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          mcpDebug('agent-call:timeout', { requestId: id, agentId, tool, timeoutMs: REQUEST_TIMEOUT_MS, transport: 'local' });
          reject(new Error(`Agent request timed out after ${REQUEST_TIMEOUT_MS}ms`));
        }, REQUEST_TIMEOUT_MS);
        entry.handler(request)
          .then(value => {
            clearTimeout(timer);
            mcpDebug('agent-call:success', { requestId: id, agentId, tool, transport: 'local' });
            resolve(value);
          })
          .catch(error => {
            clearTimeout(timer);
            const err = error instanceof Error ? error : new Error(String(error));
            mcpDebug('agent-call:error', { requestId: id, agentId, tool, error: err.message, transport: 'local' });
            reject(err);
          });
      });
    }

    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); mcpDebug('agent-call:timeout', { requestId: id, agentId, tool, timeoutMs: REQUEST_TIMEOUT_MS }); reject(new Error(`Agent request timed out after ${REQUEST_TIMEOUT_MS}ms`)); }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); mcpDebug('agent-call:success', { requestId: id, agentId, tool }); resolve(value); }, reject: error => { clearTimeout(timer); mcpDebug('agent-call:error', { requestId: id, agentId, tool, error: error.message }); reject(error); } });
      try { entry.socket.send(JSON.stringify(request)); } catch (error) { this.pending.delete(id); clearTimeout(timer); mcpDebug('agent-call:send-error', { requestId: id, agentId, tool, error: String(error) }); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  handleMessage(message: AgentMessage) { if (message.type !== 'response') return; const response = message as AgentResponse; const item = this.pending.get(response.id); if (!item) { mcpDebug('agent-response:orphan', { requestId: response.id }); return; } this.pending.delete(response.id); if (response.ok) item.resolve(response.result); else item.reject(new Error(response.error ?? 'Agent request failed')); }
}
export const registry = new AgentRegistry();
