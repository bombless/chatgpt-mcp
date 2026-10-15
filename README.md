# chatgpt-mcp

Remote MCP gateway for controlling a Windows or Linux machine through a Node.js coding agent.

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
- `gradle_assemble_debug`
- `gradle_install_debug`
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

Gradle is exposed as separate, fixed-task tools. Use `gradle_assemble_debug` for `gradle assembleDebug` and `gradle_install_debug` for `gradle installDebug`. These tools do not accept arbitrary Gradle arguments.

`rg`, `find_files`, and filesystem inspection do not require command execution. The npm tools, Gradle tools, `run_python`, `run_node`, the Git tools, `apply_patch`, and `kill_process` require `ALLOW_COMMAND_EXECUTION=true` on the Windows agent.

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
15. CONTINUOUS IMPROVEMENT: During normal MCP use, watch for concrete, recurring friction or capability gaps: repeated manual work, unclear or misleading tool descriptions, missing parameters/tools, confusing errors, slow or redundant workflows, and reliability or safety issues.
16. When you identify a meaningful improvement, tell the user in the final response under a short "MCP improvement suggestion" section. State the observed evidence/context, the proposed change, and the expected benefit; keep it specific and actionable. Do not invent issues or offer generic suggestions just to fill this section.
17. Mention suggestions only when relevant and useful; do not interrupt the user's task for minor observations. If there is no well-supported suggestion, explicitly say there are no concrete MCP improvement suggestions from this session, or omit the section when it would add no value.
18. Suggestions are feedback, not permission to modify the MCP server. Never edit this MCP project's code, configuration, prompts, or deployment merely because you noticed an improvement while using it. Only implement such changes when the user explicitly asks you to do so. Continue to respect the configured workspace boundary.
19. Never send usage data, file contents, credentials, or telemetry to an external service to report a suggestion. Share the recommendation with the user in the conversation only, unless the user explicitly authorizes another reporting channel.
20. When a concrete MCP improvement is supported by observed use, submit it with `submit_improvement_suggestion` so it enters the persistent backlog. Before adding a new item, check `list_improvement_suggestions` to avoid duplicates when practical. Periodically review open items when the user asks about improving the service; use `update_improvement_suggestion` only for user-authorized status changes. Do not store secrets or unrelated personal data in suggestions.

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
- gradle_assemble_debug: run `gradle assembleDebug`.
- gradle_install_debug: run `gradle installDebug`.
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
Node.js agent (Windows or Linux)
   +-- filesystem
   +-- rg
   +-- git
   +-- npm / Python / Node
   +-- process management
   +-- CDP -> 127.0.0.1:9222
```

The agent machine does not need an inbound port. It opens the WebSocket connection to the gateway and reconnects after a dropped connection. The browser's CDP port is local to the Windows machine and is not proxied as a listening network port by the agent.

## Development

```bash
npm install
npm run typecheck
npm run build
npm run test:coding
npm run test:tool-usage
```

Run the gateway with `npm run dev` and the agent with `npm run agent`. The agent detects the operating system automatically; no `--linux` flag is needed.

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

### Displays and screenshots

- `get_screen_info`: lists all detected displays with index, device name, resolution, virtual-desktop coordinates, and primary-display status.
- `take_screenshot`: returns screenshots as native MCP image content blocks (not Base64 text). By default it captures each detected display separately; pass `screenIndex` from `get_screen_info` to capture one display. The result includes display metadata alongside the images.
- Windows capture uses .NET/System.Windows.Forms. Linux requires an X11 session plus `xrandr` and ImageMagick's `import` command. Wayland-only sessions are not supported by this implementation.


## Automate OAuth with Bash and curl

The authorization flow still requires a **fresh six-digit code from your own Authenticator app**. This script automates the HTTP requests around that user confirmation; it does not bypass TOTP. It uses PKCE (S256), registers a local public OAuth client, submits the code to the approval endpoint, exchanges the authorization code, and saves the token response to a private file.

Requirements: `bash`, `curl`, `jq`, and `openssl`.

Save as `oauth-curl.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
umask 077

BASE_URL="${BASE_URL:-https://your-gateway.example}"
REDIRECT_URI="${REDIRECT_URI:-http://127.0.0.1:8765/oauth/callback}"
TOKEN_FILE="${TOKEN_FILE:-oauth-tokens.json}"
BASE_URL="${BASE_URL%/}"

for cmd in curl jq openssl; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Missing dependency: $cmd" >&2
    exit 1
  }
done

# PKCE verifier must be URL-safe and between 43 and 128 characters.
VERIFIER="$(openssl rand -hex 32)"
CHALLENGE="$(printf %s "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=' )"
STATE="$(openssl rand -hex 16)"

echo "Registering a public OAuth client..."
CLIENT_JSON="$(curl --fail-with-body --silent --show-error \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg uri "$REDIRECT_URI" '{client_name:"curl CLI",redirect_uris:[$uri]}')" \
  "$BASE_URL/oauth/register")"
CLIENT_ID="$(jq -er '.client_id' <<<"$CLIENT_JSON")"

AUTH_QUERY="$(jq -rn --arg client "$CLIENT_ID" --arg redirect "$REDIRECT_URI" \
  --arg state "$STATE" --arg challenge "$CHALLENGE" \
  ' "client_id=" + ($client|@uri)
  + "&redirect_uri=" + ($redirect|@uri)
  + "&response_type=code&code_challenge_method=S256"
  + "&code_challenge=" + ($challenge|@uri)
  + "&state=" + ($state|@uri) + "&scope=mcp" ')"
AUTH_URL="$BASE_URL/oauth/authorize?$AUTH_QUERY"

# Fetch the authorization page first so configuration/request errors are visible.
curl --fail-with-body --silent --show-error "$AUTH_URL" -o /dev/null

read -r -s -p "Enter the six-digit Authenticator code: " TOTP
printf '\n'
if [[ ! "$TOTP" =~ ^[0-9]{6}$ ]]; then
  echo "Expected exactly six digits." >&2
  exit 1
fi

# The approval endpoint returns a 302 whose Location contains the authorization code.
HEADERS="$(mktemp)"
trap 'rm -f "$HEADERS"' EXIT
HTTP_CODE="$(curl --silent --show-error -o /dev/null -D "$HEADERS" -w '%{http_code}' \
  -X POST \
  --data-urlencode "totp=$TOTP" \
  "$BASE_URL/oauth/authorize/approve?client_id=$(jq -rn --arg v "$CLIENT_ID" '$v|@uri')&redirect_uri=$(jq -rn --arg v "$REDIRECT_URI" '$v|@uri')&state=$(jq -rn --arg v "$STATE" '$v|@uri')&code_challenge=$(jq -rn --arg v "$CHALLENGE" '$v|@uri')")"
unset TOTP

if [[ "$HTTP_CODE" != "302" ]]; then
  echo "Authorization failed (HTTP $HTTP_CODE). Check the code and gateway logs." >&2
  exit 1
fi

LOCATION="$(awk 'BEGIN{IGNORECASE=1} /^Location:/ {sub(/\r$/, ""); sub(/^[^:]*:[[:space:]]*/, ""); print; exit}' "$HEADERS")"
CODE="$(jq -rn --arg url "$LOCATION" '$url | capture("[?&]code=(?<code>[^&]+)").code // empty')"
RETURNED_STATE="$(jq -rn --arg url "$LOCATION" '$url | capture("[?&]state=(?<state>[^&]+)").state // empty')"

if [[ -z "$CODE" || "$RETURNED_STATE" != "$STATE" ]]; then
  echo "Redirect did not contain the expected authorization code/state." >&2
  exit 1
fi

echo "Exchanging authorization code for tokens..."
curl --fail-with-body --silent --show-error \
  -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg code "$CODE" --arg client "$CLIENT_ID" \
    --arg redirect "$REDIRECT_URI" --arg verifier "$VERIFIER" \
    '{grant_type:"authorization_code",code:$code,client_id:$client,redirect_uri:$redirect,code_verifier:$verifier}')" \
  "$BASE_URL/oauth/token" > "$TOKEN_FILE"

jq -e '.access_token and .refresh_token' "$TOKEN_FILE" >/dev/null
chmod 600 "$TOKEN_FILE"
echo "OAuth complete. Tokens saved to $TOKEN_FILE (permissions restricted)."
echo "Use the access token as: Authorization: Bearer <access_token>"
```

Run it with your gateway URL:

```bash
chmod +x oauth-curl.sh
BASE_URL="https://your-gateway.example" ./oauth-curl.sh
```

The redirect URI is only used to receive the OAuth redirect URL; this script reads the redirect from the response headers and does not need to start a local callback server. Keep the token file private, do not commit it, and delete it when no longer needed. The refresh token can be exchanged at `/oauth/token` with `grant_type=refresh_token` and the same `client_id`.
