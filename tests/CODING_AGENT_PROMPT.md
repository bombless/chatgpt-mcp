# Reusable coding-agent test prompt

Paste the following prompt into a fresh coding-agent session connected to chatgpt-mcp. Set `TEST_ROOT` to a directory inside `AGENT_WORKSPACE` before starting.

```text
You are testing chatgpt-mcp as a Windows coding agent. Do not skip tools. Use the exact sequence below and report the result of every step.

TEST_ROOT = <a fresh directory inside AGENT_WORKSPACE>

Rules:
- Never access anything outside TEST_ROOT except the MCP repository's normal runtime dependencies.
- Do not expose secrets.
- Do not claim success without observing the tool result.
- For destructive actions, only touch files/processes created by this test.

1. FILE DISCOVERY
   - create_directory TEST_ROOT/work
   - create_directory TEST_ROOT/work/nested/deeper
   - create_file is not a tool, so use write_file to create TEST_ROOT/work/sample.txt with 5 lines:
     one
     two
     three
     needle here
     five
   - use get_file_info on sample.txt
   - use find_files with pattern **/*.txt

2. SEARCH + PARTIAL READ
   - use rg with query "needle" and glob "*.txt"
   - use read_file_range for lines 2 through 4
   - use tail_file for the last 2 lines
   - verify line numbers and exact content

3. FILE COPY
   - use copy_file from sample.txt to sample-copy.txt
   - use get_file_info on the copy
   - use read_file_range on the copy to verify identical content

4. NODE / PYTHON / NPM
   - run_node with args that print 42
   - run_python with args that print 42
   - run_npm with args ["--version"]
   - verify successful exit codes and expected output

5. GIT
   - initialize a Git repository in TEST_ROOT/work using git args ["init"]
   - configure a test identity
   - git add the files
   - run git status --short
   - verify status output is non-empty

6. PATCH
   - use apply_patch to change a test file from `answer = 41` to `answer = 42`
   - use read_file_range to verify the new value
   - run git diff and verify the diff contains the expected change

7. PROCESS MANAGEMENT
   - use run_node to start a harmless long-running child only if the tool can return/manage a PID; otherwise state that this step requires an externally started test process
   - use process_list and verify the process list is returned
   - use kill_process only on the process created by this test
   - verify it exits

8. SAFETY
   - attempt read_file_range on a path outside AGENT_WORKSPACE and verify rejection
   - do NOT actually kill the agent process; instead verify the tool rejects its own PID if exposed by the environment

9. FINAL REPORT
Return a table with columns:
Tool | Input | Result | Pass/Fail

Then provide:
- tools exercised
- any skipped step and why
- exact validation commands/results
- any security concern discovered
```

## Automated equivalent

From the repository root:

```powershell
$env:ALLOW_COMMAND_EXECUTION="true"
npm run typecheck
npm run test:coding
```

The automated test creates its own temporary workspace, so it is safe to repeat. It tests all requested tools and two negative safety cases.
