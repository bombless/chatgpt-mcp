import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import type { AgentRequest, AgentResponse, ToolName } from '../shared/protocol.js';

const execFileAsync = promisify(execFile);
const SERVER_URL = process.env.SERVER_URL ?? 'ws://127.0.0.1:8787/agent';
const AGENT_TOKEN = process.env.AGENT_TOKEN;
const AGENT_ID = process.env.AGENT_ID ?? os.hostname();
const AGENT_VERSION = '0.1.0';
const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_BYTES ?? 1_000_000);
const ALLOW_COMMAND_EXECUTION = process.env.ALLOW_COMMAND_EXECUTION === 'true';

if (!AGENT_TOKEN) throw new Error('AGENT_TOKEN must be set');

// The agent is intentionally restricted to this single Windows workspace.
// All file paths are resolved and checked against this directory before access.
const WORKSPACE_ROOT = path.resolve(process.env.AGENT_WORKSPACE ?? 'D:\\mcp-agent-workspace');

function assertAllowed(target: string, operation: string) {
  const resolved = path.resolve(target);
  // Windows paths are case-insensitive, including the drive letter.
  const normalizedResolved = resolved.toLowerCase();
  const normalizedRoot = WORKSPACE_ROOT.toLowerCase();
  const ok = normalizedResolved === normalizedRoot || normalizedResolved.startsWith(normalizedRoot + path.sep);

  console.log(`[agent] ${operation} path check:`);
  console.log(`[agent]   raw path: ${JSON.stringify(target)}`);
  console.log(`[agent]   resolved: ${JSON.stringify(resolved)}`);
  console.log(`[agent]   workspace: ${JSON.stringify(WORKSPACE_ROOT)}`);
  console.log(`[agent]   normalized resolved: ${JSON.stringify(normalizedResolved)}`);
  console.log(`[agent]   normalized workspace: ${JSON.stringify(normalizedRoot)}`);
  console.log(`[agent]   allowed: ${ok}`);

  if (!ok) {
    console.error(`[agent]   REJECTED: path is outside workspace`);
    throw new Error(`Path is outside agent workspace: ${resolved}`);
  }
  return resolved;
}

async function run(request: AgentRequest): Promise<unknown> {
  console.log(`[agent] request: ${request.tool} (${request.id})`);

  switch (request.tool as ToolName) {
    case 'read_file': {
      const rawPath = String(request.args.path);
      const file = assertAllowed(rawPath, 'read_file');
      console.log(`[agent] read_file: reading ${JSON.stringify(file)}`);
      try {
        const content = await fs.readFile(file, 'utf8');
        console.log(`[agent] read_file: success (${Buffer.byteLength(content, 'utf8')} bytes)`);
        return content;
      } catch (error) {
        console.error('[agent] read_file: fs.readFile failed');
        console.error('[agent]   error:', error);
        throw error;
      }
    }

    case 'write_file': {
      const rawPath = String(request.args.path);
      const file = assertAllowed(rawPath, 'write_file');
      const content = String(request.args.content);
      console.log(`[agent] write_file: target=${JSON.stringify(file)}`);
      console.log(`[agent] write_file: content bytes=${Buffer.byteLength(content, 'utf8')}`);
      console.log('[agent] write_file: writing...');
      try {
        await fs.writeFile(file, content, 'utf8');
        console.log('[agent] write_file: success');
        return { ok: true, path: file };
      } catch (error) {
        console.error('[agent] write_file: fs.writeFile failed');
        console.error('[agent]   error:', error);
        throw error;
      }
    }

    case 'list_directory': {
      const rawPath = String(request.args.path);
      const dir = assertAllowed(rawPath, 'list_directory');
      console.log(`[agent] list_directory: reading ${JSON.stringify(dir)}`);
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        console.log(`[agent] list_directory: success (${entries.length} entries)`);
        return entries.map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }));
      } catch (error) {
        console.error('[agent] list_directory: fs.readdir failed');
        console.error('[agent]   error:', error);
        throw error;
      }
    }

    case 'move_file': {
      const source = assertAllowed(String(request.args.source), 'move_file source');
      const destination = assertAllowed(String(request.args.destination), 'move_file destination');
      console.log(`[agent] move_file: ${JSON.stringify(source)} -> ${JSON.stringify(destination)}`);
      try {
        await fs.rename(source, destination);
        console.log('[agent] move_file: success');
        return { ok: true, source, destination };
      } catch (error) {
        console.error('[agent] move_file: fs.rename failed');
        console.error('[agent]   error:', error);
        throw error;
      }
    }

    case 'delete_file': {
      const target = assertAllowed(String(request.args.path), 'delete_file');
      console.log(`[agent] delete_file: target=${JSON.stringify(target)}`);
      try {
        const stat = await fs.lstat(target);
        if (stat.isDirectory()) await fs.rmdir(target);
        else await fs.unlink(target);
        console.log('[agent] delete_file: success');
        return { ok: true, path: target };
      } catch (error) {
        console.error('[agent] delete_file: filesystem operation failed');
        console.error('[agent]   error:', error);
        throw error;
      }
    }

    case 'execute_powershell': {
      if (!ALLOW_COMMAND_EXECUTION) {
        console.warn('[agent] execute_powershell: rejected because command execution is disabled');
        throw new Error('PowerShell execution is disabled. Set ALLOW_COMMAND_EXECUTION=true on the Windows agent to enable it.');
      }
      const command = String(request.args.command);
      console.log(`[agent] execute_powershell: command=${JSON.stringify(command)}`);
      try {
        const result = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
          windowsHide: true,
          maxBuffer: MAX_OUTPUT_BYTES,
        });
        console.log('[agent] execute_powershell: success');
        return { stdout: result.stdout, stderr: result.stderr, code: 0 };
      } catch (error) {
        console.error('[agent] execute_powershell: failed');
        console.error('[agent]   error:', error);
        throw error;
      }
    }

    case 'get_system_info':
      console.log('[agent] get_system_info');
      return {
        hostname: os.hostname(),
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        workspace: WORKSPACE_ROOT,
        commandExecutionEnabled: ALLOW_COMMAND_EXECUTION,
      };
    default:
      throw new Error(`Unsupported tool: ${request.tool}`);
  }
}

function connect() {
  const ws = new WebSocket(SERVER_URL, {
    headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
  });

  ws.on('open', () => {
    ws.send(JSON.stringify({
      type: 'hello',
      agentId: AGENT_ID,
      hostname: os.hostname(),
      platform: process.platform,
      version: AGENT_VERSION,
    }));
    console.log(`[agent] connected as ${AGENT_ID}`);
  });

  ws.on('message', async raw => {
    let request: AgentRequest;
    try {
      request = JSON.parse(raw.toString()) as AgentRequest;
    } catch (error) {
      console.error('[agent] invalid JSON request:', error);
      return;
    }
    if (request.type !== 'request' || !request.id || !request.tool) return;

    const response: AgentResponse = { type: 'response', id: request.id, ok: false };
    try {
      response.result = await run(request);
      response.ok = true;
    } catch (error) {
      response.error = error instanceof Error ? error.message : String(error);
      console.error(`[agent] request failed: ${request.tool} (${request.id})`);
      console.error(`[agent]   response error: ${response.error}`);
    }

    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
  });

  ws.on('close', () => {
    console.log('[agent] disconnected; reconnecting in 3s');
    setTimeout(connect, 3000);
  });

  ws.on('error', error => console.error('[agent] websocket error:', error.message));
}

console.log(`[agent] workspace: ${WORKSPACE_ROOT}`);
console.log(`[agent] PowerShell execution: ${ALLOW_COMMAND_EXECUTION ? 'ENABLED' : 'DISABLED'}`);
connect();
