import { createServer, request as httpRequest } from 'node:http';
import { McpServer } from '@modelcontextprotocol/server';
import { installToolUsageTracking, startToolUsageCleanup } from './tool-usage.js';

installToolUsageTracking(McpServer);
startToolUsageCleanup();

const args = process.argv.slice(2);
const localMode = args.includes('--local');
const embeddedAgentMode = args.includes('--agent');

async function waitForServer(port: number) {
  const url = `http://127.0.0.1:${port}/healthz`;
  const deadline = Date.now() + 30_000;
  let lastError = 'server did not become healthy';

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastError = `health endpoint returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for MCP server on port ${port}: ${lastError}`);
}

if (!localMode && !embeddedAgentMode) {
  await import('./index.js');
} else {
  const publicPort = Number(process.env.PORT ?? 8787);
  const internalPort = localMode
    ? Number(process.env.LOCAL_INTERNAL_PORT ?? publicPort + 1)
    : publicPort;
  const localToken = process.env.LOCAL_MCP_TOKEN ?? 'chatgpt-mcp-local';

  // The gateway owns all MCP and agent WebSocket logic. In local mode, move
  // its listener behind the loopback proxy to avoid binding the same port.
  process.env.PORT = String(internalPort);
  await import('./index.js');

  if (embeddedAgentMode) {
    // True in-process agent: register a local handler on the gateway registry.
    // Tool calls invoke the agent directly — no WebSocket, no JSON hop, no IPC.
    await waitForServer(internalPort);
    process.env.EMBEDDED_AGENT = '1';
    console.log('[launcher] starting embedded agent in this process (zero-IPC)');
    const { registry } = await import('./index.js');
    const { startLocalAgent } = await import('../agent/index.js');
    await startLocalAgent(registry);
  }

  if (localMode) {
    // Local mode adds a loopback-facing shim that injects a private bearer
    // token, so an MCP client can call /mcp without completing OAuth.
    const proxy = createServer((req, res) => {
      if (req.url !== '/mcp' && req.url !== '/mcp/') {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }

      const headers = { ...req.headers };
      headers.host = `127.0.0.1:${internalPort}`;
      headers.authorization = `Bearer ${localToken}`;
      delete headers['x-forwarded-for'];
      delete headers['x-forwarded-host'];
      delete headers['x-forwarded-proto'];

      const upstream = httpRequest({
        hostname: '127.0.0.1',
        port: internalPort,
        method: req.method,
        path: '/mcp',
        headers,
      }, upstreamRes => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      });

      upstream.on('error', error => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(`Local MCP proxy error: ${error.message}`);
      });
      req.pipe(upstream);
    });

    // Keep the agent endpoint usable from local mode as well. Agent auth is
    // unchanged; only the MCP client authentication is bypassed.
    proxy.on('upgrade', (req, socket, head) => {
      if (req.url !== '/agent') {
        socket.destroy();
        return;
      }

      const headers = { ...req.headers, host: `127.0.0.1:${internalPort}` };
      const upstream = httpRequest({
        hostname: '127.0.0.1',
        port: internalPort,
        method: req.method,
        path: '/agent',
        headers,
      });

      upstream.once('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
        const lines = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage ?? ''}`];
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`);
          else if (value !== undefined) lines.push(`${name}: ${value}`);
        }
        lines.push('', '');
        socket.write(lines.join('\r\n'));
        if (upstreamHead.length) upstreamSocket.write(upstreamHead);
        if (head.length) upstreamSocket.write(head);
        socket.pipe(upstreamSocket);
        upstreamSocket.pipe(socket);
      });

      upstream.on('response', response => {
        response.resume();
        socket.destroy();
      });
      upstream.on('error', () => socket.destroy());
      upstream.end();
    });

    proxy.listen(publicPort, '127.0.0.1', () => {
      console.log(`Local MCP mode enabled: http://127.0.0.1:${publicPort}/mcp`);
      console.log(`Internal MCP server: http://127.0.0.1:${internalPort}/mcp`);
      console.log('OAuth is bypassed for local MCP requests; agent authentication remains enabled.');
    });
  }
}
