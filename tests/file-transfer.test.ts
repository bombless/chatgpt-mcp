import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeFileTransfer, createFileTransfer } from '../src/server/file-transfer.js';

test('file transfer tokens are random, method-bound, and single-use', () => {
  const token = createFileTransfer('agent-a', '/workspace/file.bin', 'GET', 1_000);
  assert.match(token, /^[A-Za-z0-9_-]{40,}$/u);
  assert.deepEqual(consumeFileTransfer(token, 'GET', 1_001), {
    agentId: 'agent-a', path: '/workspace/file.bin', method: 'GET', expiresAt: 301_000,
  });
  assert.equal(consumeFileTransfer(token, 'GET', 1_002), undefined);
});

test('file transfer tokens expire after five minutes', () => {
  const token = createFileTransfer('agent-b', '/workspace/upload.bin', 'POST', 10_000);
  assert.equal(consumeFileTransfer(token, 'POST', 310_001), undefined);
  assert.equal(consumeFileTransfer(token, 'POST', 10_001), undefined);
});

test('a token cannot be used with the wrong HTTP method', () => {
  const token = createFileTransfer('agent-c', '/workspace/file.bin', 'POST', 20_000);
  assert.equal(consumeFileTransfer(token, 'GET', 20_001), undefined);
  assert.equal(consumeFileTransfer(token, 'POST', 20_002), undefined);
});
