# Tool Call Causal Chain

The gateway now models tool execution as a lightweight causal execution graph.

## Model-facing contract

Every registered MCP tool accepts two gateway-added fields:

```json
{
  "callId": "optional-model-tool-call-id",
  "continuation": null
}
```

For a continuation:

```json
{
  "continuation": {
    "parentCallId": "call_001",
    "aftermath": {
      "summary": "The previous result showed package.json at the project root."
    }
  }
}
```

`continuation: null` means the tool call starts a new causal chain.

The model does not provide `executionId` or `chainId`.

## Gateway responsibilities

The gateway validates the parent against the current MCP execution/session, allocates a chain ID, records the call, and records the final result/status. A continuation can never cross an execution boundary.

The current implementation uses the MCP `sessionId` as the execution boundary. Stateless requests fall back to a request-scoped execution identity.

## Call identity

When `callId` is supplied, the gateway preserves it. This is intended for a model/provider tool-call ID when the MCP host makes that ID available. When it is omitted, the gateway falls back to the MCP JSON-RPC request ID and finally a UUID.

The resulting causal metadata is returned in `structuredContent.causal` and in MCP `_meta`:

```json
{
  "causal": {
    "callId": "call_001",
    "executionId": "...",
    "chainId": "...",
    "parentCallId": null
  }
}
```

This gives the model a compact call identity to reference in a later continuation without replaying the full trace.

## Internal graph

The first version stores one parent per call:

```text
Execution
├── Chain A
│   ├── call_001
│   ├── call_002
│   └── call_004
└── Chain B
    └── call_003
```

Internally `parentCallIds` is already an array so a future DAG extension does not require changing the persisted call shape.

## Design boundary

The graph records the model's causal declaration separately from the authoritative tool result. `aftermath` is the model's understanding of the parent result; `CallRecord.result` is the gateway's execution result.

The gateway never sends the full trace back to the model. Each call only carries its own intent and optional parent reference, keeping model-to-gateway causal metadata O(1) per call rather than O(N) for the entire history.
