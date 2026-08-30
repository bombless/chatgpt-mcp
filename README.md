# chatgpt-mcp

Remote MCP gateway for controlling a Windows machine through a Node.js agent.

```text
ChatGPT
   |
   | MCP / HTTPS
   v
Red Hat gateway
   |
   | WSS (outbound from Windows)
   v
Windows Node.js agent
   |
   +-- filesystem
   +-- PowerShell (explicitly enabled)
   +-- system information
```

The Windows machine does **not** need an inbound port. It opens the WebSocket connection to the Red Hat server.

## Status

This repository is an MVP. It provides the bridge and MCP tools first. Put the gateway behind HTTPS/WSS (for example nginx or Caddy) before exposing it to the Internet.

The current MCP HTTP endpoint uses the official TypeScript MCP v2 server packages and Streamable HTTP. The gateway creates a fresh MCP server per request and keeps the Windows-agent registry at process scope.

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

## 1. Red Hat server

Requirements: Node.js 20+.

```bash
git clone https://github.com/bombless/chatgpt-mcp.git
cd chatgpt-mcp
npm install
npm run build

export MCP_TOKEN="$(openssl rand -hex 32)"
export AGENT_TOKEN="$(openssl rand -hex 32)"
npm start
```

The server listens on `:8787` by default:

- MCP: `http://127.0.0.1:8787/mcp` locally, or your HTTPS URL after reverse proxying
- Agent: `ws://127.0.0.1:8787/agent` locally, or `wss://.../agent` after reverse proxying
- Health: `/healthz`

For production, store the tokens in a systemd environment file or a secret manager instead of shell history.

## 2. Windows agent

On Windows, install Node.js 20+ and clone this repository.

PowerShell example:

```powershell
cd C:\path\to\chatgpt-mcp
npm install
$env:SERVER_URL="wss://your-domain.example.com/agent"
$env:AGENT_ID="desktop-01"
$env:AGENT_TOKEN="the-agent-token-from-red-hat"
$env:ALLOWED_ROOTS="C:\Users\YourName\Documents,C:\Users\YourName\Desktop,D:\Projects"
$env:ALLOW_COMMAND_EXECUTION="false"
npm run agent
```

The agent reconnects automatically after a dropped connection.

## 3. Reverse proxy

Use TLS for both the MCP HTTP endpoint and the WebSocket endpoint. The reverse proxy must support WebSocket upgrades for `/agent`.

Example nginx shape:

```nginx
location /mcp {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
}

location /agent {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

## 4. Connect ChatGPT

Use your public MCP URL:

```text
https://your-domain.example.com/mcp
```

The gateway currently authenticates MCP requests with:

```text
Authorization: Bearer <MCP_TOKEN>
```

The exact authentication flow available to your ChatGPT account/client can vary. If the ChatGPT MCP client requires OAuth rather than a static bearer token, add an OAuth layer at the reverse proxy/gateway; do not expose an unauthenticated `/mcp` endpoint.

## Security model

This project deliberately has multiple boundaries:

1. `MCP_TOKEN` protects the MCP endpoint.
2. `AGENT_TOKEN` protects the Windows WebSocket endpoint.
3. `ALLOWED_ROOTS` restricts Windows filesystem access.
4. PowerShell is disabled unless `ALLOW_COMMAND_EXECUTION=true`.
5. The Windows agent should run as a normal user, not Administrator.
6. Do not expose port 8787 directly when deploying to the Internet; terminate TLS and restrict inbound access with a firewall/reverse proxy.

Even with these protections, remote command execution is powerful. Review commands and start with `ALLOW_COMMAND_EXECUTION=false`.

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

## Next steps

- OAuth for the MCP endpoint
- Per-agent credentials instead of one shared agent token
- Per-tool permission policies
- Interactive approval for destructive operations
- Agent heartbeat/status metadata
- Windows Service installation
- Command allowlists and audit logging
- Multiple Windows agents with explicit targeting
- End-to-end integration tests
