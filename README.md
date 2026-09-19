# chatgpt-mcp

Remote MCP gateway for controlling a Windows machine through a Node.js coding agent.

## Tools

### Filesystem

File editing is intentionally reduced to two deterministic primitives:

- `read_file(path, startLine?, endLine?)`
- `replace_lines(path, startLine, endLine, oldText, newText)`

`read_file` always returns physical 1-based line numbers in `numberedContent`. When no range is supplied it reads the whole file unless the file exceeds the configured size/line limits; large files return `lineCount`/`size` and ask the model to read a range. `replace_lines` requires an inclusive line range and an exact `oldText` match. A mismatch never modifies the file. Writes are atomic and preserve the existing LF/CRLF style.

Other filesystem inspection/management tools remain available:

- `list_agents`
- `list_directory`
- `find_files`
- `rg`
- `get_file_info`
- `create_directory`
- `copy_file`
- `move_file`
- `delete_file`

There is deliberately no `write_file`, `edit_file`, `read_file_range`, `tail_file`, `apply_patch`, unified-diff, fuzzy-match, or generic file replacement tool.

### Development runtimes

- `npm_test`
- `npm_run`
- `npm_install`
- `npm_init`
- `run_python`
- `run_node`
- `git_status`
- `git_diff`
- `git_log`
- `git_show`
- `git_blame`
- `git_branch`
- `git_add`
- `git_commit`
- `process_list`
- `kill_process`
- `execute_powershell`
- `get_system_info`

Git is intentionally exposed as separate, operation-specific tools. File contents are not modified through Git; `replace_lines` is the only file-editing primitive.

npm is intentionally exposed as separate, semantic tools. Use `npm_test` for `npm test`, `npm_run` for an existing npm script, `npm_install` for `npm install`, and `npm_init` for `npm init`.

`rg`, `find_files`, and filesystem inspection do not require command execution. The npm tools, `run_python`, `run_node`, the Git tools, and `kill_process` require `ALLOW_COMMAND_EXECUTION=true` on the Windows agent.

### Browser / CDP

- `cdp_version`
- `cdp_list_targets`
- `cdp_call`

The CDP tools run inside the Windows agent and connect **only** to `http://127.0.0.1:9222`, so ChatGPT can reach a browser's local Chrome DevTools Protocol endpoint without exposing port 9222 to the network. `cdp_list_targets` returns the available browser targets; pass a target's `id` to `cdp_call` and use the normal CDP method name and parameters, for example `Runtime.evaluate` or `Page.navigate`.

All paths are restricted to `AGENT_WORKSPACE`. Keep the agent running as a normal user, not Administrator.

## Coding-agent prompt

Use the following as a system/developer prompt when connecting an LLM to this MCP:

```text
You are a coding agent operating on a Windows development workspace through chatgpt-mcp.

WORKING RULES
1. Work only inside the configured agent workspace. Never attempt to access paths outside it.
2. Before editing, discover the project with find_files and inspect relevant files with rg/read_file.
3. Prefer rg for code search. Do not enumerate large directories or read whole large files when a range is enough.
4. Always use read_file before replace_lines. read_file provides authoritative 1-based line numbers and exact current content.
5. Use replace_lines for every file content modification. Pass startLine/endLine plus oldText copied exactly from the current file; never include line-number prefixes in oldText.
6. Treat CONTENT_MISMATCH as an optimistic-concurrency failure. Do not retry with fuzzy matching or nearby search; re-read the exact range and regenerate oldText.
7. NEVER use git apply, git am, unified diffs, patch parsers, regex replacement, or shell commands to modify file contents.
8. Treat Git tools as version-control tools, not file-editing tools. Use git_status and git_diff before and after meaningful changes. Use git_add/git_commit only when the user asks for a commit or the workflow explicitly requires one.
9. Do not use Git tools to overwrite or discard working-tree changes. In particular, do not use checkout, restore, reset, or clean as a way to edit files or discard changes unless the user explicitly asks.
10. After changing code, run the smallest relevant validation: npm_test, npm_run, or run_python/run_node. If it is a Git project, use git_diff to verify the final change.
11. Do not claim a test/build passed unless you actually ran it and received a successful exit code.
12. Never expose secrets, tokens, .env contents, private keys, credentials, or unrelated personal files in the response.
13. For long-running commands, use a bounded command where possible. Use process_list to inspect processes and kill_process only for a process you intentionally started.
14. When a command fails, inspect the error, search for the relevant code, make the smallest fix, and rerun the validation.

FILE EDITING PROTOCOL
- read_file({ path }) -> full file with 1-based line numbers.
- read_file({ path, startLine, endLine }) -> exact current range with 1-based line numbers.
- replace_lines({ path, startLine, endLine, oldText, newText }) -> exact inclusive replacement.
- oldText contains file contents only, never the displayed line-number prefixes.
- A CONTENT_MISMATCH, LINE_OUT_OF_RANGE, INVALID_ARGUMENT, or PATH_OUTSIDE_WORKSPACE result does not modify the file.
- Successful writes are atomic.
- LF/CRLF style is preserved; whitespace is not trimmed or fuzzy-normalized.

BROWSER / CDP
15. When browser automation is needed, call cdp_list_targets first and choose the intended target by id.
16. Use cdp_call for standard Chrome DevTools Protocol methods. The agent connects only to its local 127.0.0.1:9222 endpoint; do not try to access another host or port.
17. Prefer Runtime.evaluate for small page-level inspections/interactions when a DOM automation library is not otherwise available.

PREFERRED CODING LOOP
find_files -> rg -> read_file -> replace_lines -> git_diff -> npm_test/npm_run/run_* -> git_diff

TOOL GUIDANCE
- rg: search text/regex in the workspace; use glob to narrow by language.
- find_files: discover files by glob, e.g. **/*.ts.
- read_file: inspect the whole file or an exact line range. Use the returned line numbers for edits.
- replace_lines: make an exact line-range replacement. oldText must exactly match the current file contents for that range.
- npm_test: run the npm test lifecycle. Do not use it to select another npm subcommand.
- npm_run: run one existing npm script; put the script name in args[0] and pass script arguments after `--`.
- npm_install: install npm dependencies; extra arguments are passed directly to npm install.
- npm_init: initialize an npm package; extra arguments are passed directly to npm init.
- run_node: use for Node scripts or quick runtime checks.
- run_python: use for Python scripts/tests.
- git_status: inspect working-tree and staging state.
- git_diff: inspect and verify working-tree or staged changes.
- git_log: inspect commit history.
- git_show: inspect a commit or Git object.
- git_blame: inspect line-level file history.
- git_branch: inspect or manage branches; do not use it to discard working-tree changes.
- git_add: stage explicitly selected files when the workflow requires staging.
- git_commit: create a Git commit when the user asks for one or the workflow explicitly requires one.
- process_list / kill_process: manage processes started for development/testing.
- cdp_version: verify that the local browser CDP endpoint is reachable.
- cdp_list_targets: enumerate tabs/pages exposed by the local browser CDP endpoint.
- cdp_call: invoke a CDP method on a selected target.
```

## Repeatable coding-tool test

`tests/coding-tools.test.ts` now focuses on the deterministic file-editing protocol. It covers whole-file reads with line numbers, ranged reads, exact-content mismatch protection, line-range errors, path safety, deletion, insertion, LF/CRLF preservation, large-file range reads, and empty files.

Run on the Windows agent after installing dependencies:

```powershell
npm install
npm run typecheck
npm run test:coding
npm run test:tool-usage
```

Expected final output from the file-tool test:

```text
PASS: read_file + replace_lines
```

## MCP session tool usage tracking

The gateway keeps an in-memory aggregate of MCP tool usage. Each call records only the tool name and whether the call succeeded or failed; tool arguments are never stored. `get_session_tool_usage` exposes the authoritative aggregate to the LLM.

Usage state is intentionally not written to `db.ts`, so normal tool calls do not cause persistent JSON database writes. Stale usage sessions are removed from memory after the configured TTL.

Configure the TTL with:

```bash
SESSION_TOOL_USAGE_TTL_MS=21600000
```

The default is 6 hours.

The tracker resolves the MCP session from the SDK handler context first and falls back to the inbound `Mcp-Session-Id` HTTP header. If a deployment is using the SDK's stateless per-request HTTP mode and supplies neither, the tracker cannot safely invent a cross-request session identity; those calls are reported under an `unidentified` bucket rather than being attributed to a guessed session.

## Current status and persistence

The repository contains an OAuth-enabled MVP. The gateway exposes MCP at `/mcp`, OAuth authorization/token endpoints, OAuth metadata, and the Windows agent WebSocket at `/agent`.

The public MCP endpoint supports both OAuth and an optional static API key. OAuth remains the preferred choice when the client can open an authorization page and complete the Authenticator approval. OAuth approval needs a TOTP secret in the JSON state or the `TOTP_SECRET` environment variable. For clients such as Gemini Spark that only expose a key field, set `MCP_API_KEY` to a long random value in the gateway environment. The same value can be sent as `X-MCP-API-Key`, `X-API-Key`, `X-Goog-Api-Key`, `Authorization: ApiKey <value>`, or (for clients that only support bearer credentials) `Authorization: Bearer <value>`. The older `MCP_TOKEN` variable is still accepted as a bearer credential for compatibility.

Set `MCP_LOG=1` on the gateway to diagnose connection failures. It logs timestamps, request paths, MCP protocol headers, authentication presence/result, OAuth events, response status, and latency, but never logs credential values or request bodies. `MCP_DEBUG`/`DEBUG_MCP` and `OAUTH_DEBUG`/`DEBUG_OAUTH` remain accepted aliases.

OAuth discovery is available at both the host-level protected-resource document and the path-aware RFC 9728 URL:

```text
https://bombless.duckdns.org/.well-known/oauth-protected-resource
https://bombless.duckdns.org/.well-known/oauth-protected-resource/mcp
```

The second form is important for clients that derive the metadata URL from the `/mcp` resource path.

OAuth/TOTP state is persisted in a small local JSON file. No native database or native Node addon is required, so the gateway only needs Node.js 20+ on Windows or Red Hat.

By default the gateway stores state in `./chatgpt-mcp.json`. Override the location with `DB_PATH` if desired:

```bash
export DB_PATH="/var/lib/chatgpt-mcp/chatgpt-mcp.json"
```

The file contains the TOTP secret and OAuth client/token state, so **protect it like a credential**. Do not commit it to Git or expose it over HTTP. For a single gateway instance this is deliberately simple and portable; for multiple replicas or higher-concurrency production use, move the persistence layer to PostgreSQL or another shared transactional store.

## Configuration

Important Windows-agent environment variables:

```powershell
$env:SERVER_URL="wss://your-gateway.example/agent"
$env:AGENT_ID="desktop-01"
$env:AGENT_TOKEN="..."
$env:AGENT_WORKSPACE="D:\Projects"
$env:ALLOW_COMMAND_EXECUTION="true"
$env:MAX_OUTPUT_BYTES="1000000"
$env:MAX_SEARCH_RESULTS="500"
$env:COMMAND_TIMEOUT_MS="120000"
$env:MAX_READ_FILE_BYTES="512000"
$env:MAX_READ_FILE_LINES="4000"
npm run agent
```

For the gateway, a minimal static-key configuration looks like this:

```powershell
$env:PUBLIC_URL="https://bombless.duckdns.org"
$env:AGENT_TOKEN="replace-with-a-long-random-agent-token"
$env:MCP_API_KEY="replace-with-a-different-long-random-mcp-key"
npm start
```

Do not put the key in a URL query string or commit it to the repository. If a client offers both OAuth and API-key modes, use only one mode for a given connection so it does not cache credentials from a failed flow.

`ALLOW_COMMAND_EXECUTION` defaults to `false`. `AGENT_WORKSPACE` defaults to `D:\mcp-agent-workspace`. `MAX_READ_FILE_BYTES` and `MAX_READ_FILE_LINES` control when an unbounded `read_file` call returns metadata instead of a large payload. CDP is enabled by default and uses the fixed local endpoint `127.0.0.1:9222`; `CDP_TIMEOUT_MS` controls the per-call WebSocket timeout.

### Request logging and connection troubleshooting

Transport-level logging is **always on** (silence it with `MCP_QUIET=1`). Every request to `/mcp`, `/.well-known/*`, and `/oauth/*` emits one `http:incoming` line plus one `http:response` line, including method, path, `user-agent`, `accept`, `content-type`, `mcp-protocol-version`, `mcp-session-id`, and whether an `Authorization` header was present. Auth decisions (`authorization:check`, `mcp:unauthorized`), MCP dispatch/result (`mcp:dispatch`, `mcp:complete`, `mcp:error`), body-parse failures (`http:error`, with a raw-body snippet), and the full OAuth lifecycle (`register:*`, `authorize:*`, `token:*`, `access-token:*`) are logged the same way.

Set `MCP_LOG=1` for verbose diagnostics on top of that: per-tool agent calls, tool results, and orphan agent responses.

When a client (e.g. ChatGPT or Gemini) cannot connect, reproduce the attempt and then read the gateway logs (`docker logs`, `journalctl`, or the terminal running `npm start`). Interpretation guide:

- **No `http:incoming` line at all** — the request never reached the gateway. Check DNS/TLS for your public URL and any reverse proxy in front (it must forward `Authorization`, `MCP-Session-Id`, and `MCP-Protocol-Version` headers, and answer CORS preflights).
- **`http:incoming` on a `/.well-known/*` path but nothing after** — OAuth discovery failed; compare the returned metadata with what the client expects (`resource` must exactly equal the MCP URL the client was configured with).
- **`oauth:register:rejected` / `oauth:token:rejected`** — dynamic registration or token exchange was rejected; the `error` field says why (e.g. `invalid_grant` from a PKCE or `redirect_uri` mismatch).
- **`authorization:check` with all of `oauthValid`/`legacyValid`/`apiKeyValid` false** — the client sent no credential the gateway accepts; note the `scheme`/`tokenLength` fields to see what it actually sent.
- **`http:error` with `SyntaxError ... is not valid JSON`** — the client posted a non-JSON or malformed body; the raw snippet shows exactly what arrived.

For Chrome/Chromium, start the browser with remote debugging enabled on port 9222, for example:

```powershell
chrome.exe --remote-debugging-port=9222
```

Do not bind or expose the browser debugging port publicly; the MCP agent deliberately connects to loopback only.

## Architecture

```text
ChatGPT
   | OAuth 2.0 + MCP / HTTPS
   v
Gateway
   | WSS
   v
Windows Node.js agent
   +-- read_file -> numbered current content
   +-- replace_lines -> exact oldText check -> atomic write
   +-- filesystem inspection
   +-- rg
   +-- git
   +-- npm / Python / Node
   +-- process management
   +-- CDP -> 127.0.0.1:9222
```

The Windows machine does not need an inbound port. It opens the WebSocket connection to the gateway and reconnects after a dropped connection. The browser's CDP port is local to the Windows machine and is not proxied as a listening network port by the agent.

## Development

```bash
npm install
npm run typecheck
npm run build
npm run test:coding
npm run test:tool-usage
```

Run the gateway with `npm run dev` and the Windows agent with `npm run agent`.

## Security notes

1. OAuth or the explicitly configured `MCP_API_KEY` protects the public MCP endpoint.
2. `AGENT_TOKEN` protects the Windows WebSocket endpoint.
3. `AGENT_WORKSPACE` confines filesystem operations.
4. Command execution is disabled by default.
5. Command tools use argument arrays and `shell: false`; they do not concatenate a shell command.
6. `kill_process` refuses to terminate the agent itself.
7. CDP access is hard-coded to `127.0.0.1:9222` to avoid turning the agent into an arbitrary network proxy.
8. Do not expose the gateway's application port directly to the Internet; put it behind TLS/reverse proxy and firewall it appropriately.
9. Before enabling command execution on an untrusted setup, add command allowlists, per-tool permissions, approvals, and audit logging.
10. Do not expose the browser's remote debugging port to the Internet; CDP provides powerful browser control and has no general-purpose authentication by default.
11. Keep `chatgpt-mcp.json` private because it contains the TOTP secret and OAuth state.
12. Never commit `.env` or JSON state files.
13. Tool usage tracking stores only aggregate tool names and outcome counts in memory; it does not persist tool arguments.

Remote command execution is powerful. Start with PowerShell disabled and add an approval/allowlist layer before enabling it.

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
- MCP integration/end-to-end tests
