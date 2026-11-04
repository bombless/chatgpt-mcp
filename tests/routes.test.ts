import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const projectRoot = resolve(import.meta.dirname, '..');
const serverSource = readFileSync(resolve(projectRoot, 'src/server/index.ts'), 'utf8');
const adminHtml = readFileSync(resolve(projectRoot, 'src/server/admin.html'), 'utf8');
const adminApp = readFileSync(resolve(projectRoot, 'src/server/admin/App.vue'), 'utf8');

const routes = [
  ['GET', '/'], ['GET', '/healthz'], ['GET', '/.well-known/oauth-authorization-server'],
  ['GET', '/.well-known/oauth-protected-resource'], ['POST', '/oauth/register'],
  ['GET', '/oauth/authorize'], ['POST', '/oauth/authorize/approve'], ['POST', '/oauth/token'],
  ['GET', '/agents'], ['GET', '/_admin/totp'], ['POST', '/_admin/call'], ['ALL', '/mcp'],
] as const;

for (const [method, path] of routes) {
  test(`route exists: ${method} ${path}`, () => {
    const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declaration = new RegExp(`app\\.${method.toLowerCase()}\\(['"]${escapedPath}['"]`);
    assert.match(serverSource, declaration, `Missing ${method} ${path} route in src/server/index.ts`);
  });
}

test('root route serves the Vite-built Vue admin entry', () => {
  assert.match(serverSource, /app\.get\(['"]\/['"],\s*async\s*\(req,\s*res\)/);
  assert.match(serverSource, /readFileSync\(resolve\(__dirname,\s*['"]admin-ui\/admin\.html['"]\),\s*['"]utf8['"]\)\)/);
  assert.match(serverSource, /express\.static\(resolve\(__dirname,\s*['"]admin-ui\/assets['"]\)/);
  assert.match(adminHtml, /<title>ChatGPT MCP · Gateway Console<\/title>/);
  assert.match(adminHtml, /type="module" src="\/admin\/main\.ts"/);
});

test('Vue admin component calls the required admin and health endpoints', () => {
  assert.match(adminApp, /requestJson\('\/_admin\/totp'\)/);
  assert.ok(adminApp.includes("('/healthz')"));
  assert.match(adminApp, /requestJson<\{result:unknown\}>\('\/_admin\/call'/);
  assert.match(adminApp, /runTool\('list_directory'\)/);
  assert.match(adminApp, /runTool\('read_file'\)/);
  assert.match(adminApp, /runTool\('write_file'\)/);
});

test('admin test-tool defaults are derived from the selected agent workspace', () => {
  assert.match(adminApp, /tool:'get_system_info',args:\{agentId\}/);
  assert.match(adminApp, /workspace\.value=r\.result\.workspace/);
  assert.match(adminApp, /readPath\.value=`\$\{root\}\$\{separator\}mcp-test\.txt`/);
  assert.match(adminApp, /writePath\.value=`\$\{root\}\$\{separator\}mcp-created\.txt`/);
  assert.doesNotMatch(adminApp, /C:\\\\Users\\\\bombl\\\\Desktop/);
  assert.match(adminApp, /watch\(selectedAgent/);
});

test('local admin endpoints keep the loopback-only guard', () => {
  assert.match(serverSource, /function isLocalAdminRequest[\s\S]*?return loopback && !fromCaddy/);
  assert.match(serverSource, /app\.get\(['"]\/_admin\/totp['"],[\s\S]*?if \(!isLocalAdminRequest\(req\)\)/);
  assert.match(serverSource, /app\.post\(['"]\/_admin\/call['"],[\s\S]*?if \(!isLocalAdminRequest\(req\)\)/);
});
