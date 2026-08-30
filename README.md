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

- `run_npm`
- `run_python`
- `run_node`
- `git`
- `process_list`
- `kill_process`
- `execute_powershell`
- `get_system_info`

`rg`, `find_files`, and filesystem inspection do not require command execution. `run_npm`, `run_python`, `run_node`, `git`, `apply_patch`, and `kill_process` require `ALLOW_COMMAND_EXECUTION=true` on the Windows agent.

All paths are restricted to `AGENT_WORKSPACE`. Keep the agent running as a normal user, not Administrator.

## Coding-agent prompt

Use the following as a system/developer prompt when connecting an LLM to this MCP:

```text
You are a coding agent operating on a Windows development workspace through chatgpt-mcp.

WORKING RULES
1. Work only inside the configured agent workspace. Never attempt to access paths outside it.
2. Before editing, discover the project with find_files and inspect relevant files with rg/read_file_range.
3. Prefer rg for code search. Do not enumerate large directories or read whole large files when a range is enough.
4. Prefer apply_patch for source changes. Keep patches small and reviewable.
5. Use git status and git diff before and after meaningful changes.
6. After changing code, run the smallest relevant validation: run_npm, run_node, or run_python. If it is a Git project, use git diff to verify the final change.
7. Do not run destructive commands, delete unrelated files, reset/clean a repository, force-push, or kill unrelated processes unless the user explicitly asks.
8. Never expose secrets, tokens, .env contents, private keys, credentials, or unrelated personal files in the response.
9. For long-running commands, use a bounded command where possible. Use process_list to inspect processes and kill_process only for a process you intentionally started.
10. When a command fails, inspect the error, search for the relevant code, make the smallest fix, and rerun the validation.
11. Do not claim a test/build passed unless you actually ran it and received a successful exit code.
12. At the end, summarize: files changed, behavior changed, validation performed, and any remaining issue.

PREFERRED CODING LOOP
find_files -> rg -> read_file_range -> apply_patch -> git diff -> run_* -> git diff

TOOL GUIDANCE
- rg: search text/regex in the workspace; use glob to narrow by language.
- find_files: discover files by glob, e.g. **/*.ts.
- read_file_range: inspect only the relevant lines.
- apply_patch: apply a unified git patch; do not rewrite an entire file for a small change.
- run_npm: use for npm commands such as test, build, lint, install when appropriate.
- run_node: use for Node scripts or quick runtime checks.
- run_python: use for Python scripts/tests.
- git: use status, diff, log, branch, show, and other commands only when needed.
- process_list / kill_process: manage processes started for development/testing.
- tail_file: inspect the end of application/log files.
```

## Repeatable coding-tool test

The repository includes `tests/coding-tools.test.ts`, which creates an isolated temporary workspace and exercises every newly added coding tool. It covers successful operations plus path and process safety checks.

Run on the Windows agent after installing dependencies and ensuring `rg`, Node.js, npm, Python, and git are available:

```powershell
$env:ALLOW_COMMAND_EXECUTION="true"
npm install
npm run typecheck
npm run test:coding
```

Expected final output:

```text
PASS: all coding tools
```

### Test matrix

| Tool | Scenario | Expected result |
|---|---|---|
| `run_npm` | `npm --version` | exit code 0 and semver output |
| `run_python` | print `6 * 7` | stdout contains `42` |
| `run_node` | print `6 * 7` | stdout contains `42` |
| `read_file_range` | read lines 2-4 | exact numbered range returned |
| `tail_file` | read last 2 lines | exact final lines returned |
| `get_file_info` | inspect sample file | type=file and size > 0 |
| `create_directory` | create nested directory | directory exists |
| `copy_file` | copy sample file | destination contents equal source |
| `process_list` | list processes | exit code 0 and non-empty output |
| `kill_process` | terminate a temporary child process | child exits |
| `rg` | search `needle` | matching line is returned |
| `git` | init/config/add/status | git commands succeed |
| `apply_patch` | change `answer = 41` to `42` | file contains `answer = 42` |
| `find_files` | glob `*.ts` | test TypeScript file is found |

The test also verifies that a path outside `AGENT_WORKSPACE` is rejected and that the agent refuses to kill its own process.

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
npm run agent
```

`ALLOW_COMMAND_EXECUTION` defaults to `false`. `AGENT_WORKSPACE` defaults to `D:\mcp-agent-workspace`.

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
```

The Windows machine does not need an inbound port. It opens the WebSocket connection to the gateway and reconnects after a dropped connection.

## Development

```bash
npm install
npm run typecheck
npm run build
npm run test:coding
```

Run the gateway with `npm run dev` and the Windows agent with `npm run agent`.

## Security notes

1. OAuth protects the public MCP endpoint.
2. `AGENT_TOKEN` protects the Windows WebSocket endpoint.
3. `AGENT_WORKSPACE` confines filesystem operations.
4. Command execution is disabled by default.
5. Command tools use argument arrays and `shell: false`; they do not concatenate a shell command.
6. `kill_process` refuses to terminate the agent itself.
7. Do not expose the gateway's application port directly to the Internet; put it behind TLS/reverse proxy and firewall it appropriately.
8. Before enabling command execution on an untrusted setup, add command allowlists, per-tool permissions, approvals, and audit logging.

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
