import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';

const originalRegisterTool = McpServer.prototype.registerTool;

const commandResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  code: z.number().int(),
});

const pythonJobSchema = z.object({
  jobId: z.string(),
  pid: z.number().int(),
  status: z.enum(['running', 'exited', 'failed', 'killed']),
  command: z.string(),
  cwd: z.string(),
  args: z.array(z.string()),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  stdoutTruncated: z.boolean(),
  stderrTruncated: z.boolean(),
});

const outputSchemas: Record<string, z.ZodTypeAny> = {
  list_agents: z.object({ result: z.array(z.string()) }),
  read_file: z.object({ result: z.string() }),
  write_file: z.object({ result: z.object({ ok: z.literal(true), path: z.string() }) }),
  list_directory: z.object({ result: z.array(z.object({ name: z.string(), type: z.enum(['directory', 'file']) })) }),
  move_file: z.object({ result: z.object({ ok: z.literal(true), source: z.string(), destination: z.string() }) }),
  delete_file: z.object({ result: z.object({ ok: z.literal(true), path: z.string() }) }),
  execute_powershell: z.object({ result: commandResultSchema }),
  get_system_info: z.object({ result: z.object({
    hostname: z.string(),
    platform: z.string(),
    arch: z.string(),
    release: z.string(),
    workspace: z.string(),
    commandExecutionEnabled: z.boolean(),
  }) }),

  fetch_image_block: z.object({ result: z.unknown() }),
  fetch_image_base64: z.object({ result: z.object({ mimeType: z.string(), base64: z.string() }) }),
  fetch_image_url: z.object({ result: z.object({ url: z.string().url() }) }),

  run_npm: z.object({ result: commandResultSchema }),
  run_python: z.object({ result: z.union([commandResultSchema, z.object({
    jobId: z.string(),
    pid: z.number().int(),
    status: z.literal('running'),
    command: z.string(),
    cwd: z.string(),
    startedAt: z.string(),
  })]) }),
  python_job_inspect: z.object({ result: pythonJobSchema }),
  python_job_kill: z.object({ result: pythonJobSchema }),
  python_jobs: z.object({ result: z.array(pythonJobSchema) }),
  run_node: z.object({ result: commandResultSchema }),
  read_file_range: z.object({ result: z.string() }),
  tail_file: z.object({ result: z.string() }),
  get_file_info: z.object({ result: z.object({
    path: z.string(),
    type: z.enum(['directory', 'file', 'other']),
    size: z.number(),
    mtime: z.string(),
    mode: z.number(),
  }) }),
  create_directory: z.object({ result: z.object({ ok: z.literal(true), path: z.string() }) }),
  copy_file: z.object({ result: z.object({ ok: z.literal(true), source: z.string(), destination: z.string() }) }),
  process_list: z.object({ result: commandResultSchema }),
  kill_process: z.object({ result: z.object({ ok: z.literal(true), pid: z.number().int() }) }),
  rg: z.object({ result: z.object({
    stdout: z.string(),
    stderr: z.string(),
    code: z.number().int(),
    matches: z.boolean(),
    truncated: z.boolean(),
  }) }),
  git: z.object({ result: commandResultSchema }),
  apply_patch: z.object({ result: commandResultSchema }),
  find_files: z.object({ result: z.object({ files: z.array(z.string()), truncated: z.boolean(), count: z.number().int() }) }),
  cdp_version: z.object({ result: z.record(z.string(), z.unknown()) }),
  cdp_list_targets: z.object({ result: z.array(z.object({
    id: z.string(),
    type: z.string().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
    webSocketDebuggerUrl: z.string().optional(),
  })) }),
  cdp_call: z.object({ result: z.record(z.string(), z.unknown()) }),
};

const intentSchema = z.string().min(1).max(500).describe('Briefly explain what you are doing and why. This is shown to the user as the current tool activity.');

function withIntentSchema(inputSchema: any) {
  if (inputSchema && typeof inputSchema.extend === 'function') return inputSchema.extend({ intent: intentSchema });
  if (inputSchema && typeof inputSchema === 'object') return { intent: intentSchema, ...inputSchema };
  return z.object({ intent: intentSchema });
}

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
    inputSchema: withIntentSchema(config?.inputSchema),
    outputSchema: config?.outputSchema ?? outputSchemas[name] ?? z.object({ result: z.unknown() }),
  };
  return originalRegisterTool.call(this, name, nextConfig, async (...args: any[]) => {
    const result = await callback(...args);
    return toStructuredResult(result);
  });
};
