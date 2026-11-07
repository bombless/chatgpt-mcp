# Embedded server + agent mode

Start the MCP gateway and a local coding agent in **one Node.js process** with **zero IPC**:

```bash
npm start -- --agent
```

## How it works

The launcher starts the normal gateway, waits for `/healthz`, then registers the coding agent as an **in-process local handler** on the same `AgentRegistry` the MCP tools use.

Tool calls go:

```
MCP tool → registry.call() → agent handler function → result
```

There is **no WebSocket**, no JSON serialization hop, and no loopback network between gateway and agent. The remote-agent path (`npm run agent` + `SERVER_URL`) is unchanged and still uses WebSocket.

Required configuration:

```bash
AGENT_TOKEN=<shared-long-random-token>
AGENT_WORKSPACE=/path/to/workspace
# Optional: allow command tools; disabled by default
ALLOW_COMMAND_EXECUTION=false
```

`PORT` controls the gateway listener. `AGENT_ID`, `AGENT_WORKSPACE`, command permissions, CDP settings, and other agent options keep their existing meanings.

`SERVER_URL` is **not** used in `--agent` mode (the agent never opens a socket).

## Modes

| Command | Behavior |
|--------|----------|
| `npm start` | Gateway only |
| `npm start -- --agent` | Gateway + local agent, **same process, direct calls** |
| `npm start -- --local` | Gateway behind loopback MCP proxy (OAuth bypass for local clients) |
| `npm start -- --local --agent` | Local proxy + in-process agent |
| `npm run agent` | Standalone agent connecting to `SERVER_URL` over WebSocket |

Authentication, workspace sandboxing, and command-execution policy are unchanged. Only the transport between gateway and agent differs in embedded mode (`transport: "local"` appears in `/agents` listings).
