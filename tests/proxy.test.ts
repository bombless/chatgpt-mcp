import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { testHttpProxy } from '../src/agent/coding-tools.js';

test('testHttpProxy sends HTTP requests through an HTTP proxy', async () => {
  const target = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  await new Promise<void>((resolve, reject) => {
    target.listen(0, '127.0.0.1', () => resolve());
    target.once('error', reject);
  });
  const targetAddress = target.address();
  assert.ok(targetAddress && typeof targetAddress === 'object');

  const proxy = http.createServer((req, res) => {
    assert.equal(req.url, `http://127.0.0.1:${targetAddress.port}/health`);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('proxied');
  });
  await new Promise<void>((resolve, reject) => {
    proxy.listen(0, '127.0.0.1', () => resolve());
    proxy.once('error', reject);
  });
  const proxyAddress = proxy.address();
  assert.ok(proxyAddress && typeof proxyAddress === 'object');

  try {
    const result = await testHttpProxy(
      `http://127.0.0.1:${targetAddress.port}/health`,
      '127.0.0.1',
      proxyAddress.port,
    );
    assert.equal(result.ok, true);
    assert.equal(result.proxyConnected, true);
    assert.equal(result.status, 200);
    assert.ok(result.elapsedMs >= 0);
  } finally {
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await new Promise<void>(resolve => target.close(() => resolve()));
  }
});

test('testHttpProxy rejects unsupported URLs without connecting', async () => {
  const result = await testHttpProxy('ftp://example.com/resource', '127.0.0.1', 1);
  assert.equal(result.ok, false);
  assert.equal(result.proxyConnected, false);
  assert.match(result.error ?? '', /http:\/\/ or https:\/\//);
});
