import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import type { AgentMessage, AgentRequest, AgentResponse, ToolName } from '../shared/protocol.js';
export type AgentMetadata = { hostname: string; platform: string; username: string; workspace: string; version: string };
export type AgentDiagnostic = { type: 'server_diagnostic'; level: 'error' | 'warning'; tool: string; message: string; requestId?: string };
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void };
/** Owns Agent WebSocket connections and correlates request/response messages. */
export class AgentRegistry {
  private readonly agents = new Map<string, WebSocket>();
  private readonly metadata = new Map<string, AgentMetadata>();
  private readonly pending = new Map<string, PendingRequest>();
  constructor(private readonly requestTimeoutMs: number, private readonly debug: (event: string, details?: Record<string, unknown>) => void) {}
  add(agentId: string, socket: WebSocket, metadata: AgentMetadata): void {
    const old = this.agents.get(agentId); old?.close(4000, 'replaced by a newer connection');
    this.agents.set(agentId, socket); this.metadata.set(agentId, metadata);
    socket.on('close', () => { if (this.agents.get(agentId) === socket) { this.agents.delete(agentId); this.metadata.delete(agentId); } });
  }
  get(agentId: string): WebSocket | undefined { const socket = this.agents.get(agentId); return socket?.readyState === WebSocket.OPEN ? socket : undefined; }
  list() {
    return [...this.agents.keys()].map(agentId => {
      const metadata = this.metadata.get(agentId);
      return { agentId, hostname: metadata?.hostname ?? agentId, os: metadata?.platform === 'win32' ? 'windows' : metadata?.platform === 'linux' ? 'linux' : metadata?.platform ?? 'unknown', platform: metadata?.platform ?? 'unknown', username: metadata?.username ?? 'unknown', workspace: metadata?.workspace ?? 'unknown', version: metadata?.version ?? 'unknown' };
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
  notifyAgent(agentId: string, message: AgentDiagnostic): boolean {
    const socket = this.get(agentId);
    if (!socket) { this.debug('agent-diagnostic:unavailable', { agentId, tool: message.tool, message: message.message }); return false; }
    try { socket.send(JSON.stringify(message)); return true; }
    catch (error) { this.debug('agent-diagnostic:send-error', { agentId, tool: message.tool, error: String(error) }); return false; }
  }
  async call(agentId: string, tool: ToolName, args: Record<string, unknown>): Promise<unknown> {
    const socket = this.get(agentId);
    if (!socket) { this.debug('agent-call:missing', { agentId, tool }); throw new Error(`Windows agent '${agentId}' is not connected`); }
    const id = crypto.randomUUID(); const request: AgentRequest = { type: 'request', id, tool, args };
    this.debug('agent-call:start', { requestId: id, agentId, tool });
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); this.debug('agent-call:timeout', { requestId: id, agentId, tool, timeoutMs: this.requestTimeoutMs }); reject(new Error(`Agent request timed out after ${this.requestTimeoutMs}ms`)); }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); this.debug('agent-call:success', { requestId: id, agentId, tool }); resolve(value); }, reject: error => { clearTimeout(timer); this.debug('agent-call:error', { requestId: id, agentId, tool, error: error.message }); reject(error); } });
      try { socket.send(JSON.stringify(request)); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); this.debug('agent-call:send-error', { requestId: id, agentId, tool, error: String(error) }); reject(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  handleMessage(message: AgentMessage): void {
    if (message.type !== 'response') return;
    const response = message as AgentResponse; const item = this.pending.get(response.id);
    if (!item) { this.debug('agent-response:orphan', { requestId: response.id }); return; }
    this.pending.delete(response.id);
    if (response.ok) item.resolve(response.result); else item.reject(new Error(response.error ?? 'Agent request failed'));
  }
}