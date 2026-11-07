import crypto from 'node:crypto';

export type FileTransfer = { agentId: string; path: string; method: 'GET' | 'POST'; expiresAt: number };
const TTL_MS = 5 * 60 * 1000;
const transfers = new Map<string, FileTransfer>();

/** Issues high-entropy, short-lived, single-use capabilities for one file operation. */
export function createFileTransfer(agentId: string, filePath: string, method: 'GET' | 'POST', now = Date.now()) {
  for (const [key, transfer] of transfers) if (transfer.expiresAt < now) transfers.delete(key);
  const token = crypto.randomBytes(32).toString('base64url');
  transfers.set(token, { agentId, path: filePath, method, expiresAt: now + TTL_MS });
  return token;
}

/** Consumes a token before doing I/O, so concurrent requests cannot reuse it. */
export function consumeFileTransfer(token: string, method: 'GET' | 'POST', now = Date.now()): FileTransfer | undefined {
  const transfer = transfers.get(token);
  if (!transfer) return undefined;
  transfers.delete(token);
  return transfer.expiresAt >= now && transfer.method === method ? transfer : undefined;
}
