# chatgpt-mcp

Remote MCP gateway for controlling a Windows machine through a Node.js agent.

```text
ChatGPT
   | OAuth 2.0 + MCP / HTTPS
   v
https://bombless.duckdns.org
   | Caddy -> 127.0.0.1:8787
   v
Red Hat gateway
   | WSS (outbound from Windows)
   v
Windows Node.js agent
   +-- filesystem
   +-- PowerShell (explicitly enabled)
   +-- system information
```

The Windows machine does **not** need an inbound port. It opens the WebSocket connection to the Red Hat server.

## Current status

The repository now contains an OAuth-enabled MVP. The gateway exposes MCP at `/mcp`, OAuth authorization/token endpoints, OAuth metadata, and the Windows agent WebSocket at `/agent`.

OAuth state is intentionally in memory for this MVP. Use a persistent/session-backed authorization service before running multiple gateway replicas.

## Public endpoints

With the supplied Caddy configuration:

- MCP: `https://bombless.duckdns.org/mcp`
- OAuth authorization: `https://bombless.duckdns.org/oauth/authorize`
- OAuth token: `https://bombless.duckdns.org/oauth/token`
- Dynamic client registration: `https://bombless.duckdns.org/oauth/register`
- Authorization server metadata: `https://bombless.duckdns.org/.well-known/oauth-authorization-server`
- Protected resource metadata: `https://bombless.duckdns.org/.well-known/oauth-protected-resource`
- Windows agent: `wss://bombless.duckdns.org/agent`
- Health: `https://bombless.duckdns.org/healthz`

Your Caddy configuration can remain:

```caddy
bombless.duckdns.org {
    reverse_proxy 127.0.0.1:8787
}
```

Caddy terminates TLS and proxies both normal HTTP requests and WebSocket upgrades.

## Tools

- `list_agents`
- `read_file`
- `write_file`
- `list_directory`
- `move_file`
- `delete_file`
- `execute_powershell`
- `get_system_info`

All filesystem operations are restricted by the Windows agent's `ALLOWED_ROOTS` setting.

PowerShell execution is disabled by default and requires `ALLOW_COMMAND_EXECUTION=true`.

## 1. Red Hat gateway

Requirements: Node.js 20+.

```bash
git clone https://github.com/bombless/chatgpt-mcp.git
cd chatgpt-mcp
npm install
npm run build

export PUBLIC_URL="https://bombless.duckdns.org"
export AGENT_TOKEN="$(openssl rand -hex 32)"
npm start
```

Keep `AGENT_TOKEN` secret and reuse the same value in the Windows agent. `MCP_TOKEN` is optional and is retained only as a legacy/local-testing bearer token; ChatGPT should use OAuth.

The gateway listens on `127.0.0.1:8787`/`0.0.0.0:8787` by default. Do not expose port 8787 directly to the Internet; let Caddy be the public TLS endpoint.

## 2. Windows agent

Install Node.js 20+ and clone this repository on Windows.

PowerShell example:

```powershell
cd C:\path\to\chatgpt-mcp
npm install
$env:SERVER_URL="wss://bombless.duckdns.org/agent"
$env:AGENT_ID="desktop-01"
$env:AGENT_TOKEN="the-agent-token-from-red-hat"
$env:ALLOWED_ROOTS="C:\Users\YourName\Documents,C:\Users\YourName\Desktop,D:\Projects"
$env:ALLOW_COMMAND_EXECUTION="false"
npm run agent
```

The agent reconnects automatically after a dropped connection.

## 3. Test the public OAuth metadata

After the gateway is running and Caddy is active:

```bash
curl https://bombless.duckdns.org/.well-known/oauth-authorization-server
curl https://bombless.duckdns.org/.well-known/oauth-protected-resource
curl https://bombless.duckdns.org/healthz
```

The metadata endpoints should return JSON, and `/healthz` should report `ok: true`.

## 4. Connect ChatGPT

Use this MCP endpoint in the ChatGPT client that supports remote MCP connectors:

```text
https://bombless.duckdns.org/mcp
```

When the client discovers the protected resource metadata, it can use the OAuth endpoints exposed by this gateway. The first authorization displays a small approval page; after approval, the client exchanges the authorization code for an access token and uses that bearer token for `/mcp`.

For the MVP, the OAuth authorization page is intentionally a single-user approval screen with no separate username/password database. **Do not treat this as production-grade identity management.** Anyone who can reach the authorization page and complete the client flow can authorize that client. Before exposing this to untrusted users, add real user authentication and persistent OAuth state.

## Security model

1. OAuth protects the public MCP endpoint.
2. `AGENT_TOKEN` separately protects the Windows WebSocket endpoint.
3. `ALLOWED_ROOTS` restricts Windows filesystem access.
4. PowerShell is disabled unless `ALLOW_COMMAND_EXECUTION=true`.
5. Run the Windows agent as a normal user, not Administrator.
6. Keep port 8787 private behind Caddy/firewall.
7. Use a long random `AGENT_TOKEN` and never commit `.env` files.

Remote command execution is powerful. Start with PowerShell disabled and add an approval/allowlist layer before enabling it.

## Development

```bash
npm run typecheck
npm run build
npm run dev
```

For the Windows agent:

```bash
npm run agent
```

## Roadmap

- Persistent OAuth sessions/state
- Real user login / OIDC integration
- Per-agent credentials instead of a shared agent token
- Per-tool permission policies
- Interactive approval for destructive operations
- Agent heartbeat/status metadata
- Windows Service installation
- Command allowlists and audit logging
- Multiple Windows agents with explicit targeting
- End-to-end integration tests
