import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidAgentId } from '../src/shared/agent-id.js';

test('accepts ASCII agent IDs', () => {
  assert.equal(isValidAgentId('desktop-01'), true);
});

test('accepts Chinese and other Unicode letters and numbers', () => {
  assert.equal(isValidAgentId('我的电脑-01'), true);
  assert.equal(isValidAgentId('東京PC_２'), true);
});

test('rejects empty, oversized, whitespace, and path-like IDs', () => {
  assert.equal(isValidAgentId(''), false);
  assert.equal(isValidAgentId('a'.repeat(65)), false);
  assert.equal(isValidAgentId('my agent'), false);
  assert.equal(isValidAgentId('../agent'), false);
});
