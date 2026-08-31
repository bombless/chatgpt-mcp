import WebSocket from 'ws';

const CDP_HOST = '127.0.0.1';
const CDP_PORT = 9222;
const CDP_BASE_URL = `http://${CDP_HOST}:${CDP_PORT}`;
const CDP_TIMEOUT_MS = Number(process.env.CDP_TIMEOUT_MS ?? 30_000);

type CdpTarget = {
  id: string;
  type?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${CDP_BASE_URL}${path}`);
  if (!response.ok) throw new Error(`CDP HTTP ${response.status}: ${await response.text()}`);
  return await response.json() as T;
}

export async function cdpVersion() {
  return await getJson<Record<string, unknown>>('/json/version');
}

export async function cdpListTargets() {
  return await getJson<CdpTarget[]>('/json/list');
}

export async function cdpCall(args: Record<string, unknown>) {
  const targetId = typeof args.targetId === 'string' ? args.targetId : '';
  const method = typeof args.method === 'string' ? args.method : '';
  if (!targetId) throw new Error('targetId must be a non-empty string');
  if (!method) throw new Error('method must be a non-empty string');

  const targets = await cdpListTargets();
  const target = targets.find(item => item.id === targetId);
  if (!target) throw new Error(`CDP target '${targetId}' was not found on ${CDP_HOST}:${CDP_PORT}`);
  if (!target.webSocketDebuggerUrl) throw new Error(`CDP target '${targetId}' has no WebSocket debugger URL`);

  const params = args.params && typeof args.params === 'object' && !Array.isArray(args.params)
    ? args.params
    : {};
  const timeoutMs = Math.max(1_000, Number(args.timeoutMs ?? CDP_TIMEOUT_MS));

  return await new Promise<unknown>((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl!);
    const id = 1;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* best effort */ }
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error(`CDP request '${method}' timed out after ${timeoutMs}ms`))), timeoutMs);

    ws.on('open', () => {
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString()) as { id?: number; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
        if (message.id !== id) return;
        if (message.error) {
          finish(() => reject(new Error(`CDP ${method} failed (${message.error?.code ?? 'unknown'}): ${message.error?.message ?? 'unknown error'}${message.error?.data ? ` ${JSON.stringify(message.error.data)}` : ''}`)));
          return;
        }
        finish(() => resolve(message.result ?? {}));
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
    ws.on('error', error => finish(() => reject(new Error(`CDP WebSocket error: ${error.message}`))));
    ws.on('close', () => {
      if (!settled) finish(() => reject(new Error(`CDP WebSocket closed before receiving a response to '${method}'`)));
    });
  });
}
