import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { causalGraph } from './causal-chain.js';

const continuationSchema = z.object({
  parentCallId: z.string().min(1),
  aftermath: z.unknown(),
}).nullable().default(null).describe('Optional causal continuation. Set null for an independent thought; otherwise reference the earlier call and summarize what its result left you with.');

const causalSchemaFields = {
  callId: z.string().min(1).optional().describe('Optional model/provider tool-call ID. If omitted, the MCP request ID is used.'),
  continuation: continuationSchema,
};

const causalOutputSchema = z.object({
  causal: z.object({
    callId: z.string(),
    executionId: z.string(),
    chainId: z.string(),
    parentCallId: z.string().nullable(),
  }),
});

const originalRegisterTool = McpServer.prototype.registerTool;

McpServer.prototype.registerTool = function(name: string, config: any, callback: any): any {
  const originalSchema = config?.inputSchema;
  const inputSchema = originalSchema && typeof originalSchema.extend === 'function'
    ? originalSchema.extend(causalSchemaFields)
    : originalSchema;
  const originalOutputSchema = config?.outputSchema;
  const outputSchema = originalOutputSchema && typeof originalOutputSchema.extend === 'function'
    ? originalOutputSchema.extend(causalOutputSchema.shape)
    : originalOutputSchema;

  const wrappedCallback = async (args: Record<string, unknown>, ctx: any) => {
    const executionId = String(ctx?.sessionId ?? `stateless:${ctx?.mcpReq?.id ?? crypto.randomUUID()}`);
    const callId = typeof args.callId === 'string' && args.callId.length > 0
      ? args.callId
      : String(ctx?.mcpReq?.id ?? crypto.randomUUID());
    const continuation = (args.continuation ?? null) as z.infer<typeof continuationSchema>;
    const intent = typeof args.intent === 'string' ? args.intent : '';
    const forwardedArgs = { ...args };
    delete forwardedArgs.callId;
    delete forwardedArgs.continuation;

    const record = causalGraph.begin({ executionId, callId, tool: name, arguments: forwardedArgs, intent, continuation });
    try {
      const result = await callback(forwardedArgs, ctx);
      causalGraph.complete(executionId, callId, 'success', result);
      return attachCausalMetadata(result, record);
    } catch (error) {
      causalGraph.complete(executionId, callId, 'error', { error: String(error instanceof Error ? error.message : error) });
      throw error;
    }
  };

  return originalRegisterTool.call(this, name, { ...config, inputSchema, outputSchema }, wrappedCallback);
};

function attachCausalMetadata(result: unknown, record: ReturnType<typeof causalGraph.begin>): unknown {
  const causal = {
    callId: record.callId,
    executionId: record.executionId,
    chainId: record.chainId,
    parentCallId: record.parentCallIds[0] ?? null,
  };
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { causal };
  }
  const value = result as Record<string, unknown>;
  const structuredContent = value.structuredContent;
  return {
    ...value,
    structuredContent: {
      ...(structuredContent && typeof structuredContent === 'object' ? structuredContent : {}),
      causal,
    },
    _meta: {
      ...(value._meta && typeof value._meta === 'object' ? value._meta : {}),
      'chatgpt-mcp/causal': causal,
    },
  };
}
