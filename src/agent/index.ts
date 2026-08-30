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

// Comma-separated absolute directories. Example:
// ALLOWED_ROOTS="C:\\Users\\alice\\Documents,D:\\Projects"
const allowedRoots = (process.env.ALLOWED_ROOTS ?? `${path.join(os.homedir(), 'Documents')},${path.join(os.homedir(), 'Desktop')}`)
  .split(',')
  .map(x => path.resolve(x.trim()))
  .filter(Boolean);

function assertAllowed(target: string) {
  const resolved = path.resolve(target);
  const ok = allowedRoots.some(root => resolved === root || resolved.startsWith(root + path.sep));
  if (!ok) throw new Error(`Path is outside ALLOWED_ROOTS: ${resolved}`);
  return resolved;
}

async function run(request: AgentRequest): Promise<unknown> {
  switch (request.tool as ToolName) {
    case 'read_file': {
      const file = assertAllowed(String(request.args.path));
      return await fs.readFile(file, 'utf8');
    }
    case 'write_file': {
      const file = assertAllowed(String(request.args.path));
      await fs.writeFile(file, String(request.args.content), 'utf8');
      return { ok: true, path: file };
    }
    case 'list_directory': {
      const dir = assertAllowed(String(request.args.path));
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' }));
    }
    case 'move_file': {
      const source = assertAllowed(String(request.args.source));
      const destination = assertAllowed(String(request.args.destination));
      await fs.rename(source, destination);
      return { ok: true, source, destination };
    }
    case 'delete_file': {
      const target = assertAllowed(String(request.args.path));
      const stat = await fs.lstat(target);
      if (stat.isDirectory()) await fs.rmdir(target);
      else await fs.unlink(target);
      return { ok: true, path: target };
    }
    case 'execute_powershell': {
      if (!ALLOW_COMMAND_EXECUTION) {
        throw new Error('PowerShell execution is disabled. Set ALLOW_COMMAND_EXECUTION=true on the Windows agent to enable it.');
      }
      const command = String(request.args.command);
      const result = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true,
        maxBuffer: MAX_OUTPUT_BYTES,
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    }
    case 'get_system_info':
      return {
        hostname: os.hostname(),
        platform: process.platform,
        arch: process.arch,
        release: os.release(),
        home: os.homedir(),
        allowedRoots,
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
    } catch {
      return;
    }
    if (request.type !== 'request' || !request.id || !request.tool) return;

    const response: AgentResponse = { type: 'response', id: request.id, ok: false };
    try {
      response.result = await run(request);
      response.ok = true;
    } catch (error) {
      response.error = error instanceof Error ? error.message : String(error);
    }

    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
  });

  ws.on('close', () => {
    console.log('[agent] disconnected; reconnecting in 3s');
    setTimeout(connect, 3000);
  });

  ws.on('error', error => console.error('[agent] websocket error:', error.message));
}

console.log(`[agent] allowed roots: ${allowedRoots.join(', ')}`);
console.log(`[agent] PowerShell execution: ${ALLOW_COMMAND_EXECUTION ? 'ENABLED' : 'DISABLED'}`);
connect();
