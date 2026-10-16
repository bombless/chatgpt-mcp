import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

test('agent-server heartbeat and ping-pong lifecycle', async () => {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });

  let serverPingsReceived = 0;
  let serverWs: WebSocket | null = null;

  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => {
      serverWs = ws;
      ws.on('ping', () => {
        serverPingsReceived++;
      });
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;

  const client = new WebSocket(`ws://127.0.0.1:${port}`);

  let pongsReceived = 0;
  client.on('pong', () => {
    pongsReceived++;
  });

  await new Promise<void>(resolve => client.on('open', resolve));

  // Send ping from client
  client.ping();

  // Wait for pong
  await new Promise(resolve => setTimeout(resolve, 100));

  assert.equal(pongsReceived, 1, 'Client should receive pong from server');
  assert.equal(serverPingsReceived, 1, 'Server should receive ping from client');

  client.terminate();
  serverWs?.terminate();
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test('dead connection detection when ping does not receive pong', async () => {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  let serverWs: WebSocket | null = null;

  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, ws => {
      serverWs = ws;
      // In ws, auto pong is handled internally; prevent pong by monkeypatching pong
      ws.pong = () => {};
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port;

  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>(resolve => client.on('open', resolve));

  let timedOut = false;
  let closed = false;

  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    client.terminate();
  }, 100);

  client.on('pong', () => {
    clearTimeout(timeoutTimer);
  });

  client.on('close', () => {
    closed = true;
  });

  client.ping();

  await new Promise(resolve => setTimeout(resolve, 200));

  assert.equal(timedOut, true, 'Should detect heartbeat timeout when server is unresponsive');
  assert.equal(closed, true, 'Client should be terminated/closed after heartbeat timeout');

  client.terminate();
  serverWs?.terminate();
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
});
