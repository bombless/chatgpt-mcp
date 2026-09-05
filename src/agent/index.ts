import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import type { AgentRequest, AgentResponse, ToolName } from '../shared/protocol.js';
import { runCodingTool } from './coding-tools.js';

const execFileAsync = promisify(execFile);
const SERVER_URL = process.env.SERVER_URL ?? 'ws://127.0.0.1:8787/agent';
const AGENT_TOKEN = process.env.AGENT_TOKEN;
const AGENT_VERSION = '0.2.0';
const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_BYTES ?? 1_000_000);
const ALLOW_COMMAND_EXECUTION = process.env.ALLOW_COMMAND_EXECUTION === 'true';
const AGENT_CONFIG = path.resolve(process.env.AGENT_CONFIG ?? path.join(os.homedir(), '.chatgpt-mcp-agent.json'));
if (!AGENT_TOKEN) throw new Error('AGENT_TOKEN must be set');
const WORKSPACE_ROOT = path.resolve(process.env.AGENT_WORKSPACE ?? 'D:\\mcp-agent-workspace');

async function loadIdentity() {
  try { const parsed = JSON.parse(await fs.readFile(AGENT_CONFIG, 'utf8')) as { agentId?: string; displayName?: string }; if (parsed.agentId) return parsed; } catch {}
  const identity = { agentId: crypto.randomUUID(), displayName: `${os.hostname()} / ${os.userInfo().username}` };
  await fs.mkdir(path.dirname(AGENT_CONFIG), { recursive: true });
  await fs.writeFile(AGENT_CONFIG, JSON.stringify(identity, null, 2) + '\n', 'utf8');
  return identity;
}
function assertAllowed(target: string, operation: string) { const resolved = path.resolve(target); const normalizedResolved = resolved.toLowerCase(); const normalizedRoot = WORKSPACE_ROOT.toLowerCase(); const ok = normalizedResolved === normalizedRoot || normalizedResolved.startsWith(normalizedRoot + path.sep); if (!ok) throw new Error(`Path is outside agent workspace: ${resolved}`); return resolved; }
function logCommand(command: string, cwd?: string) { console.log(`[agent] $ ${command}${cwd ? ` (cwd: ${cwd})` : ''}`); }
async function run(request: AgentRequest): Promise<unknown> {
  switch (request.tool as ToolName) {
    case 'read_file': { const file = assertAllowed(String(request.args.path), 'read_file'); return await fs.readFile(file, 'utf8'); }
    case 'write_file': { const file = assertAllowed(String(request.args.path), 'write_file'); await fs.writeFile(file, String(request.args.content), 'utf8'); return { ok: true, path: file }; }
    case 'list_directory': { const dir = assertAllowed(String(request.args.path), 'list_directory'); return (await fs.readdir(dir, { withFileTypes: true })).map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' })); }
    case 'move_file': { const source = assertAllowed(String(request.args.source), 'move_file source'); const destination = assertAllowed(String(request.args.destination), 'move_file destination'); await fs.rename(source, destination); return { ok: true, source, destination }; }
    case 'delete_file': { const target = assertAllowed(String(request.args.path), 'delete_file'); const stat = await fs.lstat(target); if (stat.isDirectory()) await fs.rmdir(target); else await fs.unlink(target); return { ok: true, path: target }; }
    case 'execute_powershell': { if (!ALLOW_COMMAND_EXECUTION) throw new Error('PowerShell execution is disabled. Set ALLOW_COMMAND_EXECUTION=true on the Windows agent to enable it.'); const command = String(request.args.command); logCommand(`pwsh.exe -NoLogo -NoProfile -NonInteractive -Command ${command}`); try { const result = await execFileAsync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, maxBuffer: MAX_OUTPUT_BYTES }); return { stdout: result.stdout, stderr: result.stderr, code: 0 }; } catch (error: any) { return { stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message ?? error), code: typeof error.status === 'number' ? error.status : 1 }; } }
    case 'get_system_info': return { hostname: os.hostname(), username: os.userInfo().username, platform: process.platform, arch: process.arch, release: os.release(), workspace: WORKSPACE_ROOT, commandExecutionEnabled: ALLOW_COMMAND_EXECUTION };
    default: return runCodingTool(request.tool, request.args, logCommand);
  }
}
async function connect() {
  const identity = await loadIdentity();
  const ws = new WebSocket(SERVER_URL, { headers: { Authorization: `Bearer ${AGENT_TOKEN}` } });
  ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', agentId: identity.agentId, hostname: os.hostname(), username: os.userInfo().username, displayName: identity.displayName, platform: process.platform, version: AGENT_VERSION })); console.log(`[agent] connected as ${identity.agentId}`); });
  ws.on('message', async raw => { let request: AgentRequest; try { request = JSON.parse(raw.toString()) as AgentRequest; } catch { console.error('[agent] invalid JSON request'); return; } if (request.type !== 'request' || !request.id || !request.tool) return; const response: AgentResponse = { type: 'response', id: request.id, ok: false }; try { response.result = await run(request); response.ok = true; } catch (error) { response.error = error instanceof Error ? error.message : String(error); } if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response)); });
  ws.on('close', () => { console.log('[agent] disconnected; reconnecting in 3s'); setTimeout(connect, 3000); }); ws.on('error', error => console.error('[agent] websocket error:', error.message));
}
console.log(`[agent] workspace: ${WORKSPACE_ROOT}`); console.log(`[agent] PowerShell execution: ${ALLOW_COMMAND_EXECUTION ? 'ENABLED' : 'DISABLED'}`); void connect();
