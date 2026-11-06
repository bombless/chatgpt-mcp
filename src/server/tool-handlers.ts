import crypto from 'node:crypto';
import type { ToolName } from '../shared/protocol.js';
import { applyNativePatch } from './native-patch.js';
import {
  listImprovementSuggestions,
  submitImprovementSuggestion,
  updateImprovementSuggestion,
  type SuggestionCategory,
  type SuggestionPriority,
  type SuggestionStatus,
} from './improvement-suggestions.js';

export interface AgentCaller {
  call(agentId: string, tool: ToolName, args: Record<string, unknown>): Promise<unknown>;
  listWithCapabilities(): Promise<unknown>;
  notifyAgent(agentId: string, message: { type: 'server_diagnostic'; level: 'error' | 'warning'; tool: string; message: string; requestId?: string }): boolean;
}

export type ResultContentFn = (value: unknown) => {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: { result: unknown };
};

export type McpDebugFn = (event: string, details?: Record<string, unknown>) => void;

export interface ToolHandlerDependencies {
  registry: AgentCaller;
  resultContent: ResultContentFn;
  mcpDebug?: McpDebugFn;
}

export function createToolHandlers({ registry, resultContent, mcpDebug = () => {} }: ToolHandlerDependencies) {
  return {
    codingTool: (name: ToolName) =>
      async (args: Record<string, unknown>) =>
        resultContent(await registry.call(String(args.agentId), name, args)),

    npmTool: (
      name: Extract<ToolName, 'npm_test' | 'npm_run' | 'npm_install' | 'npm_init'>,
      argsBuilder: (args: Record<string, unknown>) => string[],
    ) =>
      async ({ agentId, args, cwd, intent }: { agentId: string; args: string[]; cwd?: string; intent?: string }) =>
        resultContent(await registry.call(agentId, name, { args: argsBuilder({ args }), cwd, intent })),

    gitTool: (subcommand: string) =>
      async ({ agentId, args, cwd, intent }: { agentId: string; args?: unknown; cwd?: string; intent?: string }) =>
        resultContent(await registry.call(agentId, 'git', { args: [subcommand, ...(Array.isArray(args) ? args : [])], cwd, intent })),

    gradleTool: (name: Extract<ToolName, 'gradle_assemble_debug' | 'gradle_install_debug'>) =>
      async ({ agentId, cwd, intent }: { agentId: string; cwd?: string; intent?: string }) =>
        resultContent(await registry.call(agentId, name, { cwd, intent })),

    listAgents: async () =>
      resultContent(await registry.listWithCapabilities()),

    submitImprovementSuggestion: async ({
      title,
      description,
      category,
      priority,
      source,
    }: {
      title: string;
      description: string;
      category: SuggestionCategory;
      priority: SuggestionPriority;
      source?: string;
    }) => {
      const result = await submitImprovementSuggestion({ title, description, category, priority, source });
      return resultContent({
        suggestion: {
          id: result.suggestion.id,
          title: result.suggestion.title,
          status: result.suggestion.status,
          occurrences: result.suggestion.occurrences,
        },
        deduplicated: result.deduplicated,
      });
    },

    listImprovementSuggestions: async ({
      status,
      category,
      limit,
    }: {
      status?: SuggestionStatus;
      category?: SuggestionCategory;
      limit?: number;
    }) =>
      resultContent(await listImprovementSuggestions({ status, category, limit })),

    updateImprovementSuggestion: async ({
      id,
      status,
      note,
    }: {
      id: string;
      status: SuggestionStatus;
      note?: string;
    }) => {
      const result = await updateImprovementSuggestion({ id, status, note });
      return resultContent({
        id: result.id,
        title: result.title,
        status: result.status,
        updated_at: result.updated_at,
      });
    },

    readFile: async ({ agentId, path, intent }: { agentId: string; path: string; intent?: string }) =>
      resultContent(await registry.call(agentId, 'read_file', { path, intent })),

    writeFile: async ({
      agentId,
      path,
      content,
      expectedSha256,
      intent,
    }: {
      agentId: string;
      path: string;
      content: string;
      expectedSha256?: string;
      intent?: string;
    }) =>
      resultContent(await registry.call(agentId, 'write_file', { path, content, expectedSha256, intent })),

    editFile: async ({
      agentId,
      path,
      oldText,
      newText,
      expectedReplacements,
      expectedSha256,
      intent,
    }: {
      agentId: string;
      path: string;
      oldText: string;
      newText: string;
      expectedReplacements: number;
      expectedSha256: string;
      intent?: string;
    }) =>
      resultContent(await registry.call(agentId, 'edit_file', { path, oldText, newText, expectedReplacements, expectedSha256, intent })),

    listDirectory: async ({ agentId, path, intent }: { agentId: string; path: string; intent?: string }) =>
      resultContent(await registry.call(agentId, 'list_directory', { path, intent })),

    moveFile: async ({
      agentId,
      source,
      destination,
      expectedSha256,
      intent,
    }: {
      agentId: string;
      source: string;
      destination: string;
      expectedSha256: string;
      intent?: string;
    }) =>
      resultContent(await registry.call(agentId, 'move_file', { source, destination, expectedSha256, intent })),

    deleteFile: async ({
      agentId,
      path,
      expectedSha256,
      intent,
    }: {
      agentId: string;
      path: string;
      expectedSha256: string;
      intent?: string;
    }) =>
      resultContent(await registry.call(agentId, 'delete_file', { path, expectedSha256, intent })),

    executePowershell: async ({ agentId, command, intent }: { agentId: string; command: string; intent?: string }) =>
      resultContent(await registry.call(agentId, 'execute_powershell', { command, intent })),

    executeBash: async ({ agentId, command, intent }: { agentId: string; command: string; intent?: string }) =>
      resultContent(await registry.call(agentId, 'execute_bash', { command, intent })),

    getProxyInfo: async ({ agentId, intent }: { agentId: string; intent?: string }) =>
      resultContent(await registry.call(agentId, 'get_proxy_info', { intent })),

    getSystemInfo: async ({ agentId, intent }: { agentId: string; intent?: string }) =>
      resultContent(await registry.call(agentId, 'get_system_info', { intent })),

    readImageFile: async ({ agentId, path: imagePath, intent }: { agentId: string; path: string; intent?: string }) => {
      try {
        const image = await registry.call(agentId, 'read_image_file', { path: imagePath, intent }) as {
          path: string; mimeType: string; data: string; dataBytes: number; dataSha256: string;
        };
        if (!image || !image.data || !['image/jpeg', 'image/png'].includes(image.mimeType) || !/^[A-Za-z0-9+/]+={0,2}$/u.test(image.data)) {
          throw new Error('Agent returned invalid image data');
        }
        const bytes = Buffer.from(image.data, 'base64');
        if (bytes.length !== image.dataBytes || bytes.length > 20 * 1024 * 1024) throw new Error('Image byte length is invalid or exceeds 20 MiB');
        const validJpeg = image.mimeType === 'image/jpeg' && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
        const validPng = image.mimeType === 'image/png' && bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        if (!validJpeg && !validPng) throw new Error('Image content does not match its declared JPEG/PNG MIME type');
        const digest = crypto.createHash('sha256').update(bytes).digest('hex');
        if (digest !== image.dataSha256) throw new Error('Image SHA-256 mismatch');
        return { content: [
          { type: 'text' as const, text: JSON.stringify({ path: image.path, mimeType: image.mimeType, dataBytes: image.dataBytes, dataSha256: digest }, null, 2) },
          { type: 'image' as const, data: image.data, mimeType: image.mimeType },
        ] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        registry.notifyAgent(agentId, { type: 'server_diagnostic', level: 'error', tool: 'read_image_file', message });
        throw new Error(`read_image_file failed: ${message}`);
      }
    },

    getScreenInfo: async ({ agentId, intent }: { agentId: string; intent?: string }) =>
      resultContent(await registry.call(agentId, 'get_screen_info', { intent })),

    takeAdbScreenshot: async ({ agentId, serial, intent }: { agentId: string; serial?: string; intent?: string }) => {
      try {
        const image = await registry.call(agentId, 'take_adb_screenshot', { serial, intent }) as {
          serial: string; mimeType: string; width: number; height: number; data: string; dataBytes: number; dataSha256: string;
        };
        if (!image || image.mimeType !== 'image/png' || !image.data || !/^[A-Za-z0-9+/]+={0,2}$/u.test(image.data)) {
          throw new Error('Agent returned invalid ADB screenshot image data');
        }
        const bytes = Buffer.from(image.data, 'base64');
        const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        if (bytes.length !== image.dataBytes || bytes.length > 20 * 1024 * 1024 || bytes.length < 24 || !bytes.subarray(0, 8).equals(pngSignature)) {
          throw new Error('ADB screenshot PNG byte length/signature is invalid or exceeds 20 MiB');
        }
        const width = bytes.readUInt32BE(16);
        const height = bytes.readUInt32BE(20);
        if (width !== image.width || height !== image.height || width < 1 || height < 1) throw new Error('ADB screenshot dimensions do not match PNG metadata');
        const digest = crypto.createHash('sha256').update(bytes).digest('hex');
        if (digest !== image.dataSha256) throw new Error('ADB screenshot SHA-256 mismatch');
        return { content: [
          { type: 'text' as const, text: JSON.stringify({ serial: image.serial, mimeType: image.mimeType, width, height, dataBytes: bytes.length, dataSha256: digest }, null, 2) },
          { type: 'image' as const, data: image.data, mimeType: 'image/png' },
        ] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        registry.notifyAgent(agentId, { type: 'server_diagnostic', level: 'error', tool: 'take_adb_screenshot', message });
        throw new Error(`take_adb_screenshot failed: ${message}`);
      }
    },

    takeScreenshot: async ({
      agentId,
      screenIndex,
      x,
      y,
      width,
      height,
      highlightCursor,
      intent,
    }: {
      agentId: string;
      screenIndex?: number;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      highlightCursor?: boolean;
      intent?: string;
    }) => {
      try {
        const captured = await registry.call(agentId, 'take_screenshot', { screenIndex, x, y, width, height, highlightCursor, intent }) as {
          cursor?: { x: number; y: number; screenIndex: number | null; relativeX: number | null; relativeY: number | null } | null;
          screens: Array<{ index: number; deviceName: string; width: number; height: number; mimeType: string; data: string; dataBytes: number; dataSha256: string; x: number; y: number; primary: boolean }>;
        };
        if (!captured || !Array.isArray(captured.screens) || captured.screens.length === 0) throw new Error('Agent returned an invalid or empty screenshot response');
        if (captured.screens.some(screen => !screen.data || !/^image\/(png|jpeg|webp)$/u.test(screen.mimeType) || !/^[A-Za-z0-9+/]+={0,2}$/u.test(screen.data))) {
          throw new Error('Agent returned invalid screenshot image data');
        }
        for (const screen of captured.screens) {
          if (screen.mimeType !== 'image/jpeg' || screen.width > 1000 || screen.height > 1000 || screen.width < 1 || screen.height < 1) throw new Error(`Screenshot metadata violates JPEG/1000x1000 constraints for display ${screen.index}`);
          const bytes = Buffer.from(screen.data, 'base64');
          if (bytes.length !== screen.dataBytes) throw new Error(`Screenshot byte length mismatch for display ${screen.index}: expected=${screen.dataBytes}, received=${bytes.length}`);
          if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) throw new Error(`Screenshot JPEG integrity check failed for display ${screen.index}`);
          const digest = crypto.createHash('sha256').update(bytes).digest('hex');
          if (digest !== screen.dataSha256) throw new Error(`Screenshot SHA-256 mismatch for display ${screen.index}`);
          mcpDebug('screenshot:integrity-ok', { agentId, screenIndex: screen.index, width: screen.width, height: screen.height, bytes: bytes.length, sha256: digest });
        }
        const content = [
          {
            type: 'text' as const,
            text: JSON.stringify({
              cursor: captured.cursor ?? null,
              count: captured.screens.length,
              screens: captured.screens.map(({ data, ...metadata }) => metadata),
            }, null, 2),
          },
          ...captured.screens.map(screen => ({ type: 'image' as const, data: screen.data, mimeType: screen.mimeType })),
        ];
        // Do not return structuredContent for screenshots: clients may prioritize it
        // over content and consequently discard the actual MCP image blocks.
        return { content };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const notified = registry.notifyAgent(agentId, { type: 'server_diagnostic', level: 'error', tool: 'take_screenshot', message });
        console.error(`[mcp][screenshot][error] agentId=${agentId} notifiedAgent=${notified}: ${message}`);
        throw new Error(`take_screenshot failed: ${message}`);
      }
    },

    applyPatch: async ({
      agentId,
      patch,
      cwd,
      expectedSha256ByPath,
      intent,
    }: {
      agentId: string;
      patch: string;
      cwd?: string;
      expectedSha256ByPath: Record<string, string>;
      intent?: string;
    }) => {
      const patchPath = (value: string) => cwd ? `${cwd.replace(/[\\/]+$/, '')}\\${value.replaceAll('/', '\\')}` : value;
      return resultContent(await applyNativePatch(patch, {
        editFile: async (path, oldText, newText, expectedSha256) => registry.call(agentId, 'edit_file', { path: patchPath(path), oldText, newText, expectedReplacements: 1, expectedSha256, intent }),
        writeFile: async (path, content, expectedSha256) => registry.call(agentId, 'write_file', { path: patchPath(path), content, expectedSha256: expectedSha256 === '__missing__' ? undefined : expectedSha256, intent }),
        deleteFile: async (path, expectedSha256) => registry.call(agentId, 'delete_file', { path: patchPath(path), expectedSha256, intent }),
      }, expectedSha256ByPath));
    },
  };
}
