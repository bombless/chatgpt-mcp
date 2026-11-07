import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const projectRoot = resolve(import.meta.dirname, '..');
const serverSource = [
  'src/server/index.ts',
  'src/server/express-app.ts',
].map(file => readFileSync(resolve(projectRoot, file), 'utf8')).join('\n');
const adminHtml = readFileSync(resolve(projectRoot, 'src/server/admin.html'), 'utf8');
const adminApp = readFileSync(resolve(projectRoot, 'src/server/admin/App.vue'), 'utf8');

const mcpRoutes = [
  ['GET', '/healthz'], ['GET', '/.well-known/oauth-authorization-server'],
  ['GET', '/.well-known/oauth-protected-resource'], ['POST', '/oauth/register'],
  ['GET', '/oauth/authorize'], ['POST', '/oauth/authorize/approve'], ['POST', '/oauth/token'],
  ['GET', '/agents'], ['ALL', '/mcp'],
] as const;

const adminRoutes = [
  ['GET', '/'], ['GET', '/healthz'], ['GET', '/_admin/totp'], ['GET', '/_admin/tools'], ['POST', '/_admin/call'],
] as const;

for (const [method, path] of mcpRoutes) {
  test(`MCP route exists: ${method} ${path}`, () => {
    const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declaration = new RegExp(`app\\.${method.toLowerCase()}\\(['"]${escapedPath}['"]`);
    assert.match(serverSource, declaration, `Missing app.${method} ${path} route in src/server/index.ts`);
  });
}

for (const [method, path] of adminRoutes) {
  test(`Admin route exists: ${method} ${path}`, () => {
    const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declaration = new RegExp(`adminApp\\.${method.toLowerCase()}\\(['"]${escapedPath}['"]`);
    assert.match(serverSource, declaration, `Missing adminApp.${method} ${path} route in src/server/index.ts`);
  });
}

test('root route serves the Vite-built Vue admin entry on adminApp', () => {
  assert.match(serverSource, /adminApp\.get\(['"]\/['"],\s*async\s*\(req,\s*res\)/);
  assert.match(serverSource, /readFileSync\(resolve\(__dirname,\s*['"]admin-ui\/admin\.html['"]\),\s*['"]utf8['"]\)\)/);
  assert.match(serverSource, /express\.static\(resolve\(__dirname,\s*['"]admin-ui\/assets['"]\),\s*\{/);
  assert.match(adminHtml, /<title>ChatGPT MCP · Gateway Console<\/title>/);
  assert.match(adminHtml, /type="module" src="\/admin\/main\.ts"/);
});

test('Vue admin component calls the required admin and health endpoints', () => {
  assert.match(adminApp, /requestJson\('\/_admin\/totp'\)/);
  assert.match(adminApp, /requestJson<\{agents:Agent\[\]\}>\('\/_admin\/agents'\)/);
  assert.match(adminApp, /requestJson<\{tools:ToolDefinition\[\]\}>\('\/_admin\/tools'\)/);
  assert.match(adminApp, /requestJson<\{result:unknown\}>\('\/_admin\/call'/);
});

test('admin workspace metadata is loaded for the selected agent', () => {
  assert.match(adminApp, /tool:'get_system_info',args:\{agentId:selectedAgent\.value/);
  assert.match(adminApp, /workspace\.value=r\.result\.workspace/);
  assert.match(adminApp, /watch\(selectedAgent/);
});

test('local admin endpoints keep the loopback-only guard', () => {
  assert.match(serverSource, /function isLocalAdminRequest[\s\S]*?return loopback && !fromCaddy/);
  assert.match(serverSource, /adminApp\.get\(['"]\/_admin\/totp['"],[\s\S]*?if \(!isLocalAdminRequest\(req\)\)/);
  assert.match(serverSource, /adminApp\.post\(['"]\/_admin\/call['"],[\s\S]*?if \(!isLocalAdminRequest\(req\)\)/);
  assert.match(serverSource, /adminApp\.use\(['"]\/assets['"],[\s\S]*?express\.static\(resolve\(__dirname,\s*['"]admin-ui\/assets['"]\)/);
});

test('admin runner registers and validates Git subcommand aliases', () => {
  for (const name of ['git_status', 'git_diff', 'git_log', 'git_show', 'git_blame', 'git_branch', 'git_add', 'git_commit']) {
    assert.ok(serverSource.includes(`${name}: { tool: 'git'`), `Missing ${name} alias`);
  }
  assert.match(serverSource, /const git = definitions\.find\(tool => tool\.name === 'git'\)/);
  assert.match(serverSource, /getAdminToolRegistry\(\)\[alias \? 'git' : tool\]\?\.inputSchema/);
});

test('one-time binary transfer routes are registered before body parsers', () => {
  assert.match(serverSource, /app\.get\(['"]\/mcp\/file\/:token['"]/);
  assert.match(serverSource, /app\.post\(['"]\/mcp\/file\/:token['"],\s*express\.raw\(\{ type: ['"]\*\/\*['"], limit: ['"]32mb['"] \}\)/);
  assert.ok(serverSource.indexOf("app.get('/mcp/file/:token'") < serverSource.indexOf('app.use(express.json'));
  const tools = readFileSync(resolve(projectRoot, 'src/server/mcp-server.ts'), 'utf8');
  assert.match(tools, /registerTool\('create_file_download_url'/);
  assert.match(tools, /registerTool\('create_file_upload_url'/);
  assert.match(tools, /\$\{getBaseUrl\(\)\}\/mcp\/file\//);
  const oauth = readFileSync(resolve(projectRoot, 'src/server/oauth.ts'), 'utf8');
  assert.match(oauth, /const PUBLIC_URL = \(process\.env\.PUBLIC_URL \?\? 'https:\/\/bombless\.duckdns\.org'\)/);
  assert.match(oauth, /return PUBLIC_URL;/);
});

test('npm test includes the route regression suite', () => {
  const packageJson = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  assert.match(packageJson.scripts?.test ?? '', /tests\/routes\.test\.ts/);
});
