import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export type Aftermath = { summary: string; [key: string]: unknown } | string | Record<string, unknown>;
export type Continuation = { parentCallId: string; aftermath: Aftermath } | null;
export type CallStatus = 'running' | 'success' | 'error';

export interface CallRecord {
  callId: string;
  executionId: string;
  chainId: string;
  parentCallIds: string[];
  tool: string;
  arguments: unknown;
  intent: string;
  continuation: Exclude<Continuation, null> | undefined;
  result?: unknown;
  status: CallStatus;
  createdAt: number;
  completedAt?: number;
}

export interface CausalRequestContext {
  executionId: string;
  callId?: string;
}

const context = new AsyncLocalStorage<CausalRequestContext>();

export function runWithCausalContext<T>(value: CausalRequestContext, fn: () => T): T {
  return context.run(value, fn);
}

export function getCausalRequestContext(): CausalRequestContext | undefined {
  return context.getStore();
}

export class CausalExecutionGraph {
  private readonly executions = new Map<string, Map<string, CallRecord>>();

  begin(input: {
    executionId: string;
    callId?: string;
    tool: string;
    arguments: unknown;
    intent: string;
    continuation?: Continuation;
  }): CallRecord {
    const calls = this.executions.get(input.executionId) ?? new Map<string, CallRecord>();
    this.executions.set(input.executionId, calls);

    const callId = input.callId?.trim() || crypto.randomUUID();
    if (calls.has(callId)) throw new Error(`Causal call '${callId}' already exists in execution '${input.executionId}'`);

    const continuation = input.continuation ?? null;
    let chainId = crypto.randomUUID();
    let parentCallIds: string[] = [];

    if (continuation) {
      const parent = calls.get(continuation.parentCallId);
      if (!parent) throw new Error(`Causal parent '${continuation.parentCallId}' does not exist in execution '${input.executionId}'`);
      chainId = parent.chainId;
      parentCallIds = [parent.callId];
    }

    const record: CallRecord = {
      callId,
      executionId: input.executionId,
      chainId,
      parentCallIds,
      tool: input.tool,
      arguments: input.arguments,
      intent: input.intent,
      continuation: continuation ?? undefined,
      status: 'running',
      createdAt: Date.now(),
    };
    calls.set(callId, record);
    return record;
  }

  complete(executionId: string, callId: string, status: Exclude<CallStatus, 'running'>, result?: unknown): CallRecord {
    const record = this.get(executionId, callId);
    if (!record) throw new Error(`Causal call '${callId}' does not exist in execution '${executionId}'`);
    record.status = status;
    record.result = result;
    record.completedAt = Date.now();
    return record;
  }

  get(executionId: string, callId: string): CallRecord | undefined {
    return this.executions.get(executionId)?.get(callId);
  }

  list(executionId: string): CallRecord[] {
    return [...(this.executions.get(executionId)?.values() ?? [])];
  }

  chains(executionId: string): Map<string, CallRecord[]> {
    const result = new Map<string, CallRecord[]>();
    for (const call of this.list(executionId)) {
      const chain = result.get(call.chainId) ?? [];
      chain.push(call);
      result.set(call.chainId, chain);
    }
    for (const chain of result.values()) chain.sort((a, b) => a.createdAt - b.createdAt);
    return result;
  }
}

export const causalGraph = new CausalExecutionGraph();
