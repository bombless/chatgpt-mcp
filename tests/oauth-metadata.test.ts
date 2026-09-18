import assert from 'node:assert/strict';
import test from 'node:test';
import { oauthMetadata, protectedResourceMetadata } from '../src/server/oauth.js';

test('publishes RFC 8414 authorization-server metadata', () => {
  const metadata = oauthMetadata();
  assert.equal(metadata.issuer, 'https://bombless.duckdns.org');
  assert.equal(metadata.authorization_endpoint, 'https://bombless.duckdns.org/oauth/authorize');
  assert.equal(metadata.token_endpoint, 'https://bombless.duckdns.org/oauth/token');
  assert.equal(metadata.registration_endpoint, 'https://bombless.duckdns.org/oauth/register');
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(metadata.token_endpoint_auth_methods_supported, ['none']);
});

test('publishes path-aware RFC 9728 protected-resource metadata', () => {
  const metadata = protectedResourceMetadata('https://bombless.duckdns.org/mcp');
  assert.equal(metadata.resource, 'https://bombless.duckdns.org/mcp');
  assert.deepEqual(metadata.authorization_servers, ['https://bombless.duckdns.org']);
  assert.deepEqual(metadata.bearer_methods_supported, ['header']);
  assert.equal(metadata.resource_name, 'Windows MCP Gateway');
});
