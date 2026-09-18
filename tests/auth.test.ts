import assert from 'node:assert/strict';
import test from 'node:test';
import { authCredentials, secretMatches } from '../src/server/auth.js';

function headers(values: Record<string, string>) {
  return { header: (name: string) => values[name.toLowerCase()] };
}

test('accepts standard MCP API-key header aliases', () => {
  assert.deepEqual(authCredentials(headers({ 'x-mcp-api-key': 'secret' })), { scheme: 'x-mcp-api-key', apiKey: 'secret' });
  assert.deepEqual(authCredentials(headers({ 'x-api-key': 'secret' })), { scheme: 'x-api-key', apiKey: 'secret' });
  assert.deepEqual(authCredentials(headers({ 'x-goog-api-key': 'secret' })), { scheme: 'x-goog-api-key', apiKey: 'secret' });
});

test('accepts bearer, ApiKey, and case-insensitive schemes', () => {
  assert.deepEqual(authCredentials(headers({ authorization: 'Bearer oauth-token' })), { scheme: 'Bearer', bearerToken: 'oauth-token' });
  assert.deepEqual(authCredentials(headers({ authorization: 'apikey static-key' })), { scheme: 'apikey', apiKey: 'static-key' });
  assert.deepEqual(authCredentials(headers({ authorization: 'bEaReR oauth-token' })), { scheme: 'bEaReR', bearerToken: 'oauth-token' });
  assert.deepEqual(authCredentials(headers({ authorization: 'malformed', 'x-api-key': 'static-key' })), { scheme: 'malformed', apiKey: 'static-key' });
});

test('compares secrets safely and rejects empty or different values', () => {
  assert.equal(secretMatches('same-secret', 'same-secret'), true);
  assert.equal(secretMatches('same-secret', 'different-secret'), false);
  assert.equal(secretMatches('', 'same-secret'), false);
  assert.equal(secretMatches(undefined, 'same-secret'), false);
});
