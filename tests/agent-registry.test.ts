import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';
import { AgentRegistry } from '../src/server/agent-registry.js';

function createSocket() {
  const socket = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN,
    sent: [] as string[],
    send(data: string) { this.sent.push(data); },
    close() { this.readyState = WebSocket.CLOSED; },
  });
  return socket as unknown as WebSocket & { sent: string[] };
}

test('registers connected agents and removes only the active socket on close', () => {
  const registry = new AgentRegistry(1000, () => undefined);
  const first = createSocket();
  const second = createSocket();
  const metadata = { hostname: 'host-a', platform: 'linux', username: 'user', workspace: '/workspace', version: '1.0' };

  registry.add('agent-a', first, metadata);
  registry.add('agent-a', second, { ...metadata, hostname: 'host-b' });
  first.emit('close');

  assert.equal(registry.get('agent-a'), second);
  assert.equal(registry.list()[0]?.hostname, 'host-b');
  second.emit('close');
  assert.deepEqual(registry.list(), []);
});

test('correlates Agent responses with pending calls', async () => {
  const registry = new AgentRegistry(1000, () => undefined);
  const socket = createSocket();
  registry.add('agent-a', socket, { hostname: 'host', platform: 'linux', username: 'user', workspace: '/workspace', version: '1.0' });

  const pending = registry.call('agent-a', 'read_file', { path: '/workspace/file.txt' });
  const request = JSON.parse(socket.sent[0]!) as { id: string; type: string; tool: string };
  assert.equal(request.type, 'request');
  assert.equal(request.tool, 'read_file');
  registry.handleMessage({ type: 'response', id: request.id, ok: true, result: { content: 'hello' } });

  assert.deepEqual(await pending, { content: 'hello' });
});