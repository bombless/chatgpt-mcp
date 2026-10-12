import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const projectRoot = resolve(import.meta.dirname, '..');
const serverSource = readFileSync(resolve(projectRoot, 'src/server/index.ts'), 'utf8');
const adminHtml = readFileSync(resolve(projectRoot, 'src/server/admin.html'), 'utf8');

const routes = [
  ['GET', '/'],
  ['GET', '/healthz'],
  ['GET', '/.well-known/oauth-authorization-server'],
  ['GET', '/.well-known/oauth-protected-resource'],
  ['POST', '/oauth/register'],
  ['GET', '/oauth/authorize'],
  ['POST', '/oauth/authorize/approve'],
  ['POST', '/oauth/token'],
  ['GET', '/agents'],
  ['GET', '/_admin/totp'],
  ['POST', '/_admin/call'],
  ['ALL', '/mcp'],
] as const;

for (const [method, path] of routes) {
  test(`route exists: ${method} ${path}`, () => {
    const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declaration = new RegExp(`app\\.${method.toLowerCase()}\\(['\"]${escapedPath}['\"]`);
    assert.match(serverSource, declaration, `Missing ${method} ${path} route in src/server/index.ts`);
  });
}

test('root route serves the standalone admin HTML file', () => {
  assert.match(serverSource, /app\.get\(['"]\/['"],\s*async\s*\(req,\s*res\)/);
  assert.match(serverSource, /readFileSync\(resolve\(__dirname,\s*['"]admin\.html['"]\),\s*['"]utf8['"]\)\)/);
  assert.match(adminHtml, /<title>ChatGPT MCP Gateway<\/title>/);
});

test('admin HTML calls the required admin and health endpoints', () => {
  assert.match(adminHtml, /fetch\(['"]\/_admin\/totp['"]\)/);
  assert.match(adminHtml, /fetch\(['"]\/healthz['"]\)/);
  assert.match(adminHtml, /fetch\(['"]\/_admin\/call['"],/);
});

test('local admin endpoints keep the loopback-only guard', () => {
  assert.match(serverSource, /function isLocalAdminRequest[\s\S]*?return loopback && !fromCaddy/);
  assert.match(serverSource, /app\.get\(['"]\/_admin\/totp['"],[\s\S]*?if \(!isLocalAdminRequest\(req\)\)/);
  assert.match(serverSource, /app\.post\(['"]\/_admin\/call['"],[\s\S]*?if \(!isLocalAdminRequest\(req\)\)/);
});
