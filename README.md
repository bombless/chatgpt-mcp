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

The repository contains an OAuth-enabled remote MCP gateway with a Windows Node.js agent. The gateway exposes MCP at `/mcp`, OAuth authorization/token endpoints, OAuth metadata, and the Windows agent WebSocket at `/agent`.

The active branches currently represent several parallel development lines: the main/develop line, a coding-tools line, a causal tool-call line, local/stable packaging variants, an OAuth logging experiment, a microsandbox variant, and an agent-permission line. See [Branch landscape](#branch-landscape) below for the current snapshot and ancestry.

## Branch landscape

> Snapshot taken from the repository refs on **2026-09-11**. “Latest update” means the tip commit currently pointed to by that branch. Commit counts in the ancestry notes are GitHub compare results, not a claim that every commit was authored as part of the feature named by the branch.

| Branch | Tip | Latest update | Relationship / purpose |
|---|---|---|---|
| `main` | `90797dc` | 2026-08-31 — `fix: use npm install in update workflow` | Default branch; current production-ish baseline. |
| `develop` | `7e14159` | 2026-08-31 — `Merge main into develop` | **29 commits ahead of `main`, 0 behind**; current integration/development line. |
| `stable` | `972b3d6` | 2026-09-02 — `去掉代码中的z.ZodTypeAny` | Forked from the pre-main-merge lineage; adds the coding-tools/OAuth/TOTP work. It is the direct ancestor of `stable-local` and `agent-perm`. |
| `stable-local` | `7e5a1bd` | 2026-09-03 — `feat: support npm start -- --local` | **3 commits ahead of `stable`**; adds the launcher/local-mode entry point. |
| `agent-perm` | `36c7cb7` | 2026-09-05 — `feat: retain local TOTP bootstrap for agent-perm gateway` | **11 commits ahead of `stable`**; adds per-agent authorization/permissions and keeps local TOTP bootstrap. |
| `feature/causal-tool-call-chain` | `5a8b9e8` | 2026-09-03 — `docs: document causal execution graph protocol` | **7 commits ahead of `stable`**; adds causal-chain tracking/bootstrap and tests/docs. |
| `feat/coding-tools` | `2fcd8c8` | 2026-09-01 — `修改接口地址` | Coding-tools branch with Windows coding/agent tooling; changes the OAuth approval endpoint to `POST /oauth/authorize/approve`. |
| `local` | `5894552` | 2026-09-03 — `chore: keep start script compatible with --local` | A separate local-oriented line; diverges from `stable-local` rather than simply extending it. |
| `microsandbox` | `46555ae` | 2026-08-31 — `fix(microsandbox): use SDK memory units for Python sandbox` | Coding-tools variant focused on Python execution through microsandbox. |
| `debug/oauth-mcp-logging` | `c949968` | 2026-08-30 — `fix: preserve parsed MCP request body for node handler` | Small OAuth/MCP diagnostics line; adds detailed HTTP/OAuth/MCP logging and fixes passing the parsed request body to the Node MCP handler. |
| `opencode/log` | `1fc5a73` | 2026-08-31 — `加入oauth日志` | Small logging experiment; adds OAuth request/flow diagnostics. |
| `totp-sqlite-oauth` | `6c2ed63` | 2026-08-31 — `Merge debug/oauth-mcp-logging into totp-sqlite-oauth` | OAuth/TOTP persistence experiment; explicitly merges the `debug/oauth-mcp-logging` line. |

### Recent work by branch

- **`main`** — The newest change fixes the update workflow to use `npm install`.
- **`develop`** — Its tip is a merge of `main`, so it is currently the integration line that already contains the latest `main` history plus 29 additional commits.
- **`stable`** — Its newest change removes `z.ZodTypeAny` in favor of `z.ZodType` in the coding-tool schemas, a TypeScript/Zod compatibility cleanup.
- **`stable-local`** — Adds `npm start -- --local` support by routing `start` through `dist/server/launcher.js`.
- **`agent-perm`** — Retains the local TOTP bootstrap for the agent-permission gateway; this line contains the per-agent authorization model and is the newest branch tip in the repository.
- **`feature/causal-tool-call-chain`** — Documents the causal execution graph protocol. Tool calls can carry a `callId` and a `continuation.parentCallId`; the gateway assigns execution/chain identity and returns causal metadata without replaying the whole trace.
- **`feat/coding-tools`** — Its latest commit changes the OAuth approval route from `GET /oauth/approve` to `POST /oauth/authorize/approve`.
- **`local`** — Keeps the `npm start -- --local` invocation compatible with the local launcher workflow.
- **`microsandbox`** — Updates the Python sandbox to use the microsandbox SDK's `MiB(...)` memory-unit helper and recreates the sandbox with `.replace()`.
- **`debug/oauth-mcp-logging`** — Its latest fix preserves the parsed Express request body when invoking the Node MCP handler; the preceding work adds verbose HTTP/OAuth/MCP diagnostics.
- **`opencode/log`** — Adds detailed OAuth request/registration/authorization/token logging and MCP authorization diagnostics.
- **`totp-sqlite-oauth`** — Merges the OAuth logging branch into the TOTP/SQLite-oriented line.

### Git ancestry at a glance

The repository has a common fork point at **`4ae7efa`** for the older parallel lines below. Compared with the current `main`, those lines are generally **7 commits behind** because `main` advanced after that fork point.

```text
4ae7efa  (common fork point for the parallel feature lines)
│
├── main  ── 90797dc  (current default branch)
│    └── develop  ── 7e14159  (+29 commits beyond main)
│
└── parallel feature family
    ├── stable  ── 972b3d6
    │   ├── stable-local  ── 7e5a1bd  (+3)
    │   ├── feature/causal-tool-call-chain  ── 5a8b9e8  (+7)
    │   └── agent-perm  ── 36c7cb7  (+11)
    │
    ├── feat/coding-tools  ── 2fcd8c8
    ├── microsandbox  ── 46555ae
    ├── local  ── 5894552
    └── logging / OAuth experiments
        ├── debug/oauth-mcp-logging  ── c949968
        ├── opencode/log  ── 1fc5a73
        └── totp-sqlite-oauth  ── 6c2ed63
```

The strongest verified relationships are:

1. **`develop` contains `main` exactly**: GitHub reports `develop` as 29 commits ahead and 0 behind `main`, with the `main` tip as the merge base.
2. **`stable-local`, `feature/causal-tool-call-chain`, and `agent-perm` are direct descendants of `stable`**: they are respectively 3, 7, and 11 commits ahead of `stable`, with no commits behind it.
3. **`agent-perm` is therefore newer than `stable-local` and `feature/causal-tool-call-chain` only in the sense of branch depth from `stable`; they are sibling branches, not a linear sequence.**
4. **`totp-sqlite-oauth` explicitly contains `debug/oauth-mcp-logging`** because its tip is a merge commit named `Merge debug/oauth-mcp-logging into totp-sqlite-oauth`.
5. **`local` is not simply `stable-local` plus a few commits**: comparing them shows they diverged from an earlier common commit (`3d99d7f`), with `local` 13 commits ahead and 9 behind `stable-local`.
6. The feature branches such as `agent-perm`, `feat/coding-tools`, `feature/causal-tool-call-chain`, `local`, `microsandbox`, `stable`, `stable-local`, and `totp-sqlite-oauth` all currently diverge from `main` at `4ae7efa`; each is behind `main` by the seven commits that landed on `main` after that fork point.

## Persistence

The gateway stores state in a small local JSON file on the persistence-oriented branches. By default the gateway uses `./chatgpt-mcp.json`; override the location with `DB_PATH` if desired:

```bash
export DB_PATH="/var/lib/chatgpt-mcp/chatgpt-mcp.json"
```

The file contains the TOTP secret and OAuth client/token state, so **protect it like a credential**. Do not commit it to Git or expose it over HTTP. For a single gateway instance this is deliberately simple and portable; for multiple replicas or higher-concurrency production use, move the persistence layer to PostgreSQL or another shared transactional store.

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

On agent-permission/coding-tool branches, additional coding/agent tools are available, including file-range/tail operations, process control, Python/Node jobs, ripgrep, git, patch application, file discovery, and CDP operations.

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
# Optional: export DB_PATH="/var/lib/chatgpt-mcp/chatgpt-mcp.json"
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
7. Keep `chatgpt-mcp.json` private because it contains the TOTP secret and OAuth state.
8. Use a long random `AGENT_TOKEN` and never commit `.env` or JSON state files.

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
