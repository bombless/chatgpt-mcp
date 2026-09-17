import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolUsageTracker } from '../src/server/tool-usage.js';

test('aggregates success and failure counts per session', () => {
  const tracker = new ToolUsageTracker();

  tracker.recordStart('session-a', 'read_file');
  tracker.recordSuccess('session-a', 'read_file');
  tracker.recordStart('session-a', 'read_file');
  tracker.recordSuccess('session-a', 'read_file');
  tracker.recordStart('session-a', 'npm_test');
  tracker.recordFailure('session-a', 'npm_test');

  assert.deepEqual(tracker.get('session-a').tools, [
    { name: 'read_file', count: 2, success: 2, failed: 0 },
    { name: 'npm_test', count: 1, success: 0, failed: 1 },
  ]);
});

test('isolates sessions', () => {
  const tracker = new ToolUsageTracker();
  tracker.recordStart('session-a', 'read_file');
  tracker.recordSuccess('session-a', 'read_file');
  tracker.recordStart('session-b', 'read_file');
  tracker.recordFailure('session-b', 'read_file');

  assert.deepEqual(tracker.get('session-a').tools, [
    { name: 'read_file', count: 1, success: 1, failed: 0 },
  ]);
  assert.deepEqual(tracker.get('session-b').tools, [
    { name: 'read_file', count: 1, success: 0, failed: 1 },
  ]);
});

test('does not retain arguments', () => {
  const tracker = new ToolUsageTracker();
  tracker.recordStart('session-a', 'execute_powershell');
  tracker.recordSuccess('session-a', 'execute_powershell');

  const serialized = JSON.stringify(tracker.get('session-a'));
  assert.equal(serialized.includes('password'), false);
  assert.equal(serialized.includes('secret-token'), false);
  assert.equal(serialized.includes('args'), false);
});

test('cleanup removes only expired sessions', () => {
  const tracker = new ToolUsageTracker();
  tracker.recordStart('session-a', 'read_file');
  tracker.recordSuccess('session-a', 'read_file');
  assert.equal(tracker.cleanup(Number.MAX_SAFE_INTEGER), 1);
  assert.deepEqual(tracker.get('session-a').tools, []);
});
