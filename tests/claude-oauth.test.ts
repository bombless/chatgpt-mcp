import assert from 'node:assert/strict';
import test from 'node:test';
import { getBaseUrl, oauthMetadata, protectedResourceMetadata, registerClient } from '../src/server/oauth.js';

test('getBaseUrl extracts host and proto from request headers', () => {
  const req = {
    get(name: string) {
      if (name.toLowerCase() === 'x-forwarded-proto') return 'https';
      if (name.toLowerCase() === 'x-forwarded-host') return 'test-ngrok.ngrok-free.dev';
      return undefined;
    },
    protocol: 'http',
  } as any;

  assert.equal(getBaseUrl(req), 'https://test-ngrok.ngrok-free.dev');
});

test('oauthMetadata generates endpoints matching base URL', () => {
  const metadata = oauthMetadata('https://test-ngrok.ngrok-free.dev');
  assert.equal(metadata.issuer, 'https://test-ngrok.ngrok-free.dev');
  assert.equal(metadata.registration_endpoint, 'https://test-ngrok.ngrok-free.dev/oauth/register');
  assert.equal(metadata.authorization_endpoint, 'https://test-ngrok.ngrok-free.dev/oauth/authorize');
  assert.equal(metadata.token_endpoint, 'https://test-ngrok.ngrok-free.dev/oauth/token');
});

test('protectedResourceMetadata generates resource matching base URL', () => {
  const metadata = protectedResourceMetadata('https://test-ngrok.ngrok-free.dev');
  assert.equal(metadata.resource, 'https://test-ngrok.ngrok-free.dev/mcp');
  assert.deepEqual(metadata.authorization_servers, ['https://test-ngrok.ngrok-free.dev']);
});

test('registerClient accepts Claude redirect_uris and returns standard RFC 7591 fields', async () => {
  const result = await registerClient({
    client_name: 'Claude',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  });
  assert.equal(result.client_name, 'Claude');
  assert.deepEqual(result.redirect_uris, ['https://claude.ai/api/mcp/auth_callback']);
  assert.equal(typeof result.client_id, 'string');
  assert.equal(typeof result.client_id_issued_at, 'number');
  assert.deepEqual(result.grant_types, ['authorization_code', 'refresh_token']);
  assert.deepEqual(result.response_types, ['code']);
});
