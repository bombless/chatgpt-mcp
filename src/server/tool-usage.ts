import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

export type ToolUsageEntry = { name: string; count: number; success: number; failed: number };
export type SessionToolUsage = { sessionId: string; createdAt: number; lastActivityAt: number; tools: Map<string, ToolUsageEntry> };
export type SessionToolUsageResult = { sessionId: string; createdAt?: number; lastActivityAt?: number; tools: ToolUsageEntry[] };

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export class ToolUsageTracker {
  private readonly sessions = new Map<string, SessionToolUsage>();

  start(sessionId: string): SessionToolUsage {
    const now = Date.now();
    const existing = this.sessions.get(sessionId);
    if (existing) { existing.lastActivityAt = now; return existing; }
    const session: SessionToolUsage = { sessionId, createdAt: now, lastActivityAt: now, tools: new Map() };
    this.sessions.set(sessionId, session);
    return session;
  }

  recordStart(sessionId: string, toolName: string): ToolUsageEntry {
    const session = this.start(sessionId);
    const entry = session.tools.get(toolName) ?? { name: toolName, count: 0, success: 0, failed: 0 };
    entry.count += 1;
    session.lastActivityAt = Date.now();
    session.tools.set(toolName, entry);
    return entry;
  }

  recordSuccess(sessionId: string, toolName: string): void {
    const session = this.start(sessionId);
    const entry = session.tools.get(toolName) ?? { name: toolName, count: 0, success: 0, failed: 0 };
    entry.success += 1;
    session.lastActivityAt = Date.now();
    session.tools.set(toolName, entry);
  }

  recordFailure(sessionId: string, toolName: string): void {
    const session = this.start(sessionId);
    const entry = session.tools.get(toolName) ?? { name: toolName, count: 0, success: 0, failed: 0 };
    entry.failed += 1;
    session.lastActivityAt = Date.now();
    session.tools.set(toolName, entry);
  }

  get(sessionId: string): SessionToolUsageResult {
    const session = this.sessions.get(sessionId);
    if (!session) return { sessionId, tools: [] };
    return { sessionId, createdAt: session.createdAt, lastActivityAt: session.lastActivityAt, tools: [...session.tools.values()].map(entry => ({ ...entry })) };
  }

  delete(sessionId: string): void { this.sessions.delete(sessionId); }

  cleanup(ttlMs: number = DEFAULT_TTL_MS): number {
    const cutoff = Date.now() - ttlMs;
    let deleted = 0;
    for (const [sessionId, session] of this.sessions) {
      if (session.lastActivityAt < cutoff) { this.sessions.delete(sessionId); deleted += 1; }
    }
    return deleted;
  }

  size(): number { return this.sessions.size; }
}

export const toolUsage = new ToolUsageTracker();
export const SESSION_TOOL_USAGE_TTL_MS = Number(process.env.SESSION_TOOL_USAGE_TTL_MS ?? DEFAULT_TTL_MS);

export function getSessionIdFromToolContext(ctx: { sessionId?: string; http?: { req?: Request } } | undefined): string | undefined {
  if (ctx?.sessionId) return ctx.sessionId;
  return ctx?.http?.req?.headers.get('mcp-session-id') ?? undefined;
}

/** Installs server-wide instrumentation; only tool name/outcome are retained. */
export function installToolUsageTracking(McpServerClass: typeof McpServer): void {
  type RegisterTool = (this: object, name: string, config: Record<string, unknown>, handler: (...args: any[]) => unknown) => unknown;
  const prototype = McpServerClass.prototype as unknown as { registerTool: RegisterTool } & Record<PropertyKey, unknown>;
  const marker = Symbol.for('chatgpt-mcp.tool-usage-installed');
  if (prototype[marker]) return;
  prototype[marker] = true;

  const originalRegisterTool = prototype.registerTool;
  const usageToolServers = new WeakSet<object>();
  const usageOutputSchema = z.object({
    sessionId: z.string(),
    createdAt: z.number().optional(),
    lastActivityAt: z.number().optional(),
    tools: z.array(z.object({ name: z.string(), count: z.number().int(), success: z.number().int(), failed: z.number().int() })),
  });

  prototype.registerTool = function trackedRegisterTool(this: object, name: string, config: Record<string, unknown>, handler: (...args: any[]) => unknown): unknown {
    if (!usageToolServers.has(this)) {
      usageToolServers.add(this);
      originalRegisterTool.call(this, 'get_session_tool_usage', {
        description: 'Get the MCP tools actually used during this MCP session. The server-side report is authoritative; do not infer or guess tool usage.',
        inputSchema: z.object({ intent: z.string().min(7).max(500).describe('Briefly explain what you are doing and why. Start with "let me " and use one sentence.') }),
        outputSchema: usageOutputSchema,
      }, async (_args: unknown, ctx: any) => {
        const sessionId = getSessionIdFromToolContext(ctx) ?? 'unidentified';
        const usage = toolUsage.get(sessionId);
        return { content: [{ type: 'text', text: JSON.stringify(usage, null, 2) }], structuredContent: usage };
      });
    }

    if (name === 'get_session_tool_usage') return originalRegisterTool.call(this, name, config, handler);

    const trackedHandler = async (args: unknown, ctx: any) => {
      const sessionId = getSessionIdFromToolContext(ctx) ?? 'unidentified';
      toolUsage.recordStart(sessionId, name);
      try {
        const result = await handler(args, ctx);
        toolUsage.recordSuccess(sessionId, name);
        return result;
      } catch (error) {
        toolUsage.recordFailure(sessionId, name);
        throw error;
      }
    };
    return originalRegisterTool.call(this, name, config, trackedHandler);
  };
}

let cleanupTimer: NodeJS.Timeout | undefined;
export function startToolUsageCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => toolUsage.cleanup(SESSION_TOOL_USAGE_TTL_MS), 60_000);
  cleanupTimer.unref();
}
