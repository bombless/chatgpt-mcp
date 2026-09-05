# Per-agent permissions

The `agent-perm` branch adds authorization at the individual Windows-agent level.

## Agent identity

On first startup the Windows agent creates `%USERPROFILE%/.chatgpt-mcp-agent.json` unless `AGENT_CONFIG` is set. It stores a random UUID and a display name in the form `hostname / username`. The UUID is stable across restarts and should be treated as the agent's identity, not as a secret.

The WebSocket hello message sends the UUID plus hostname, username, display name, platform, and agent version. The gateway persists this metadata and shows it in `list_agents`.

## Authorization flow

1. ChatGPT completes the normal MCP OAuth flow and receives an access token.
2. ChatGPT calls an agent tool with a specific `agentId`.
3. If that OAuth client has no grant for the selected agent, the MCP tool returns a one-time authorization URL.
4. The user opens the URL and sees the computer name, username, and persistent agent UUID before clicking **Authorize this computer**.
5. The URL can be used once and expires after five minutes.
6. The resulting grant is bound to both the OAuth client and the agent UUID and lasts for 30 days by default.
7. ChatGPT retries the original operation and the gateway forwards it to that exact agent.

Environment variables:

- `AGENT_CONFIG`: optional path for the agent identity file.
- `AGENT_APPROVAL_TTL_MS`: one-time link lifetime; default 5 minutes.
- `AGENT_GRANT_TTL_MS`: per-agent grant lifetime; default 30 days.

The existing `AGENT_TOKEN` still authenticates the agent-to-gateway WebSocket connection. It is separate from the per-ChatGPT-client authorization grant.
