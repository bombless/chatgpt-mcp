import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getProxyInfo } from '../src/agent/coding-tools.js';

test('getProxyInfo reads common proxy environment variables case-insensitively', () => {
  const result = getProxyInfo({
    HTTP_PROXY: 'http://127.0.0.1:7897',
    https_proxy: 'http://127.0.0.1:10808',
    NO_PROXY: 'localhost,127.0.0.1',
  });
  assert.equal(result.configured, true);
  assert.equal(result.proxies.http, 'http://127.0.0.1:7897');
  assert.equal(result.proxies.https, 'http://127.0.0.1:10808');
  assert.equal(result.proxies.all, null);
  assert.equal(result.noProxy, 'localhost,127.0.0.1');
});

test('getProxyInfo reports unconfigured when no proxy variables are set', () => {
  assert.deepEqual(getProxyInfo({}), {
    configured: false,
    proxies: { http: null, https: null, all: null },
    noProxy: null,
  });
});

test('getProxyInfo redacts credentials from proxy URLs', () => {
  const result = getProxyInfo({ ALL_PROXY: 'http://user:secret@proxy.example:1080' });
  assert.equal(result.proxies.all, 'http://proxy.example:1080');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
