import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

const originalRegisterTool = McpServer.prototype.registerTool;
const genericOutputSchema = z.object({ result: z.unknown() });

function toStructuredResult(result: any) {
  if (!result || typeof result !== 'object' || result.isError === true || result.structuredContent !== undefined) return result;

  const textBlocks = Array.isArray(result.content)
    ? result.content.filter((item: any) => item?.type === 'text' && typeof item.text === 'string')
    : [];

  let value: unknown;
  if (textBlocks.length === 1) {
    const text = textBlocks[0].text;
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
  } else if (textBlocks.length > 1) {
    value = textBlocks.map((item: any) => item.text).join('\n');
  } else {
    value = result.content ?? null;
  }

  return { ...result, structuredContent: { result: value } };
}

(McpServer.prototype as any).registerTool = function (name: string, config: any, callback: any) {
  const nextConfig = {
    ...config,
    outputSchema: config?.outputSchema ?? genericOutputSchema,
  };
  return originalRegisterTool.call(this, name, nextConfig, async (...args: any[]) => {
    const result = await callback(...args);
    return toStructuredResult(result);
  });
};
