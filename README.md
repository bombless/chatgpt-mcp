# chatgpt-mcp

Remote MCP gateway for controlling a Windows machine through a Node.js coding agent.

## Tools

### Filesystem

- `list_agents`
- `read_file`
- `read_file_range`
- `write_file`
- `list_directory`
- `find_files`
- `rg`
- `get_file_info`
- `create_directory`
- `copy_file`
- `move_file`
- `delete_file`
- `tail_file`
- `apply_patch`

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

Git is intentionally exposed as separate, operation-specific tools. There is no generic `git` MCP tool, so the model cannot select a Git subcommand such as `git apply`. File contents must be changed with `apply_patch`, `edit_file`, or `write_file`; Git tools are for repository inspection and version-control operations.

npm is intentionally exposed as separate, semantic tools. Use `npm_test` for `npm test`, `npm_run` for an existing npm script, `npm_install` for `npm install`, and `npm_init` for `npm init`. There is no generic npm command tool, so the model cannot select an arbitrary npm subcommand.

`rg`, `find_files`, and filesystem inspection do not require command execution. The npm tools, `run_python`, `run_node`, the Git tools, `apply_patch`, and `kill_process` require `ALLOW_COMMAND_EXECUTION=true` on the Windows agent.

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
2. Before editing, discover the project with find_files and inspect relevant files with rg/read_file_range.
3. Prefer rg for code search. Do not enumerate large directories or read whole large files when a range is enough.
4. Use the dedicated file-editing tools for file contents. Prefer apply_patch for normal source changes and multi-file edits; use edit_file for a small exact text replacement; use write_file only when creating or intentionally replacing an entire file.
5. NEVER use git apply or git am to modify files. NEVER construct a patch and pass it to git, PowerShell, Bash, or another shell command to apply it.
6. Treat Git tools as version-control tools, not file-editing tools. Use git_status and git_diff before and after meaningful changes. Use git_add/git_commit only when the user asks for a commit or the workflow explicitly requires one.
7. Do not use Git tools to overwrite or discard working-tree changes. In particular, do not use checkout, restore, reset, or clean as a way to edit files or discard changes unless the user explicitly asks.
8. After changing code, run the smallest relevant validation: npm_test, npm_run, or run_python/run_node. If it is a Git project, use git_diff to verify the final change.
9. Do not run destructive commands, delete unrelated files, reset/clean a repository, force-push, or kill unrelated processes unless the user explicitly asks.
10. Never expose secrets, tokens, .env contents, private keys, credentials, or unrelated personal files in the response.
11. For long-running commands, use a bounded command where possible. Use process_list to inspect processes and kill_process only for a process you intentionally started.
12. When a command fails, inspect the error, search for the relevant code, make the smallest fix, and rerun the validation.
13. Do not claim a test/build passed unless you actually ran it and received a successful exit code.
14. At the end, summarize: files changed, behavior changed, validation performed, and any remaining issue.

MCP SESSION TOOL USAGE
15. Tool usage is tracked by the MCP server, not by your memory.
16. When the final response should report tool usage, call get_session_tool_usage immediately before the final response.
17. Report only tools returned by get_session_tool_usage; use the server-provided counts and success/failure values.
18. Never infer, guess, or reconstruct tool usage from your own conversation memory.
19. Do not include get_session_tool_usage itself in the usage summary.
20. Do not expose MCP session IDs, request IDs, tool arguments, command strings, file contents, credentials, tokens, or other sensitive data in the usage summary.

BROWSER / CDP
21. When browser automation is needed, call cdp_list_targets first and choose the intended target by id.
22. Use cdp_call for standard Chrome DevTools Protocol methods. The agent connects only to its local 127.0.0.1:9222 endpoint; do not try to access another host or port.
23. Prefer Runtime.evaluate for small page-level inspections/interactions when a DOM automation library is not otherwise available.

PREFERRED CODING LOOP
find_files -> rg -> read_file_range -> apply_patch/edit_file -> git_diff -> npm_test/npm_run/run_* -> git_diff

TOOL GUIDANCE
- rg: search text/regex in the workspace; use glob to narrow by language.
- find_files: discover files by glob, e.g. **/*.ts.
- read_file_range: inspect only the relevant lines.
- edit_file: make a small exact text replacement. Prefer this when the intended change is localized and you know the exact old text.
- apply_patch: apply a patch directly to workspace files. Prefer this for normal source edits and multi-file changes. Do not invoke git apply, git am, or a shell command to apply the patch.
- write_file: create or intentionally replace a complete file; do not use it when a small edit or patch is sufficient.
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
- tail_file: inspect the end of application/log files.
```

## Repeatable coding-tool test

The repository includes `tests/coding-tools.test.ts`, which creates an isolated temporary workspace and exercises every newly added coding tool. It covers successful operations plus path and process safety checks, including the four semantic npm tools.

Run on the Windows agent after installing dependencies and ensuring `rg`, Node.js, npm, Python, and git are available:

```powershell
$env:ALLOW_COMMAND_EXECUTION="true"
npm install
npm run typecheck
npm run test:coding
npm run test:tool-usage
```

Expected final output:

```text
PASS: all coding tools
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
$env:CDP_TIMEOUT_MS="30000"
npm run agent
```

`ALLOW_COMMAND_EXECUTION` defaults to `false`. `AGENT_WORKSPACE` defaults to `D:\mcp-agent-workspace`. CDP is enabled by default and uses the fixed local endpoint `127.0.0.1:9222`; `CDP_TIMEOUT_MS` controls the per-call WebSocket timeout.

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
   +-- filesystem
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

1. OAuth protects the public MCP endpoint.
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
