import assert from 'node:assert/strict';
import { CausalExecutionGraph } from '../src/server/causal-chain.js';

const graph = new CausalExecutionGraph();

const root = graph.begin({
  executionId: 'execution-a',
  callId: 'call_001',
  tool: 'list_directory',
  arguments: { path: 'D:/workspace' },
  intent: 'let me inspect the project structure',
  continuation: null,
});
graph.complete('execution-a', 'call_001', 'success', { entries: ['package.json'] });

const child = graph.begin({
  executionId: 'execution-a',
  callId: 'call_002',
  tool: 'read_file',
  arguments: { path: 'package.json' },
  intent: 'let me inspect package.json',
  continuation: {
    parentCallId: 'call_001',
    aftermath: { summary: 'The previous result showed package.json at the project root.' },
  },
});
assert.equal(child.chainId, root.chainId);
assert.deepEqual(child.parentCallIds, ['call_001']);

graph.begin({
  executionId: 'execution-a',
  callId: 'call_003',
  tool: 'get_system_info',
  arguments: {},
  intent: 'let me check the current system information',
  continuation: null,
});
assert.equal(graph.chains('execution-a').size, 2);

const grandchild = graph.begin({
  executionId: 'execution-a',
  callId: 'call_004',
  tool: 'rg',
  arguments: { query: 'express' },
  intent: 'let me inspect the dependency mentioned in package.json',
  continuation: {
    parentCallId: 'call_002',
    aftermath: { summary: 'package.json declares express as a dependency.' },
  },
});
assert.equal(grandchild.chainId, root.chainId);
assert.deepEqual(grandchild.parentCallIds, ['call_002']);

assert.throws(() => graph.begin({
  executionId: 'execution-b',
  callId: 'call_005',
  tool: 'read_file',
  arguments: { path: 'package.json' },
  intent: 'let me read a file from another execution',
  continuation: {
    parentCallId: 'call_001',
    aftermath: { summary: 'cross-execution parent must be rejected' },
  },
}), /does not exist in execution 'execution-b'/);

assert.throws(() => graph.begin({
  executionId: 'execution-a',
  callId: 'call_002',
  tool: 'read_file',
  arguments: { path: 'package.json' },
  intent: 'let me retry with a duplicate call identity',
  continuation: null,
}), /already exists in execution 'execution-a'/);

console.log('PASS: causal execution graph');
