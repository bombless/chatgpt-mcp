# Embedded server + agent mode

Start the MCP gateway and a local coding agent in one Node.js process:

```bash
npm start -- --agent
```

The launcher starts the normal gateway first, waits for its `/healthz` endpoint to become healthy, then starts the existing agent module in the same process. The embedded agent connects to `ws://127.0.0.1:${PORT:-8787}/agent` and authenticates with the same `AGENT_TOKEN` as the gateway. No child process is spawned.

Required configuration:

```bash
AGENT_TOKEN=<shared-long-random-token>
AGENT_WORKSPACE=/path/to/workspace
# Optional: allow command tools; disabled by default
ALLOW_COMMAND_EXECUTION=false
```

`PORT` controls the gateway listener. `AGENT_ID`, `AGENT_WORKSPACE`, command permissions, CDP settings, and other agent options keep their existing meanings. In `--agent` mode, `SERVER_URL` is deliberately set by the launcher to the local gateway endpoint so the embedded agent cannot accidentally connect to a different server.

The regular modes remain available:

- `npm start` — gateway only
- `npm start -- --agent` — gateway and local agent in one process
- `npm start -- --local` — gateway behind the loopback local-MCP proxy
- `npm run agent` — standalone agent connecting to `SERVER_URL`

The gateway and agent still use the existing WebSocket protocol and tool registry. The embedded mode changes process topology only; it does not bypass agent authentication, workspace restrictions, or command-execution policy.
