import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { AgentRequestSchema, type AgentResponse, runAgentTool } from '@bombless/agent-lib';

const execFileAsync = promisify(execFile);
const SERVER_URL = process.env.SERVER_URL ?? 'ws://127.0.0.1:8787/agent';
const AGENT_TOKEN = process.env.AGENT_TOKEN;
const AGENT_ID = process.env.AGENT_ID ?? os.hostname();
const AGENT_VERSION = '0.3.0';
const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_BYTES ?? 1_000_000);
const ALLOW_COMMAND_EXECUTION = process.env.ALLOW_COMMAND_EXECUTION === 'true';
const LINUX_MODE = process.argv.includes('--linux');
if (!AGENT_TOKEN) throw new Error('AGENT_TOKEN must be set');
if (LINUX_MODE && process.platform !== 'linux') throw new Error('--linux can only be used on Linux');
const WORKSPACE_ROOT = path.resolve(process.env.AGENT_WORKSPACE ?? (LINUX_MODE ? '/tmp/mcp-agent-workspace' : 'D:\\\\mcp-agent-workspace'));
function logCommand(command: string, cwd?: string) { console.log(`[agent] $ ${command}${cwd ? ` (cwd: ${cwd})` : ''}`); }
async function run(tool: string, args: Record<string, unknown>): Promise<unknown> {
  if (tool === 'execute_powershell') {
    if (LINUX_MODE) throw new Error('execute_powershell is only available on Windows; use execute_bash on Linux.');
    if (!ALLOW_COMMAND_EXECUTION) throw new Error('PowerShell execution is disabled. Set ALLOW_COMMAND_EXECUTION=true on the Windows agent to enable it.');
    const command = String(args.command ?? ''); logCommand(`pwsh.exe -NoLogo -NoProfile -NonInteractive -Command ${command}`);
    try { const result = await execFileAsync('pwsh.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command',command], { windowsHide:true, maxBuffer:MAX_OUTPUT_BYTES }); return { stdout:result.stdout, stderr:result.stderr, code:0 }; }
    catch (error: any) { return { stdout:String(error.stdout ?? ''), stderr:String(error.stderr ?? error.message ?? error), code:typeof error.status === 'number' ? error.status : 1 }; }
  }
  if (tool === 'execute_bash') {
    if (!LINUX_MODE) throw new Error('execute_bash is only available in Linux mode; start the agent with --linux.');
    if (!ALLOW_COMMAND_EXECUTION) throw new Error('Bash execution is disabled. Set ALLOW_COMMAND_EXECUTION=true on the Linux agent to enable it.');
    const command = String(args.command ?? ''); logCommand(`bash -lc ${JSON.stringify(command)}`);
    try { const result = await execFileAsync('/bin/bash', ['-lc',command], { maxBuffer:MAX_OUTPUT_BYTES }); return { stdout:result.stdout, stderr:result.stderr, code:0 }; }
    catch (error: any) { return { stdout:String(error.stdout ?? ''), stderr:String(error.stderr ?? error.message ?? error), code:typeof error.status === 'number' ? error.status : 1 }; }
  }
  return await runAgentTool(tool, args, { logCommand });
}
function connect() {
  const ws = new WebSocket(SERVER_URL, { headers: { Authorization: `Bearer ${AGENT_TOKEN}` } });
  ws.on('open', () => { ws.send(JSON.stringify({ type:'hello', agentId:AGENT_ID, hostname:os.hostname(), platform:process.platform, version:AGENT_VERSION })); console.log(`[agent] connected as ${AGENT_ID}`); });
  ws.on('message', async raw => {
    let parsed: unknown; try { parsed = JSON.parse(raw.toString()); } catch { console.error('[agent] invalid JSON request'); return; }
    const checked = AgentRequestSchema.safeParse(parsed);
    if (!checked.success) { console.error('[agent] invalid request:', checked.error.message); return; }
    const request = checked.data;
    const intent = typeof request.args?.intent === 'string' ? request.args.intent.trim() : '';
    const time = `${new Date().getHours().toString().padStart(2,'0')}:${new Date().getMinutes().toString().padStart(2,'0')}`;
    console.log(`[agent][${time}] intent: ${intent || `(missing) tool=${request.tool}`}`);
    const response: AgentResponse = { type:'response', id:request.id, ok:false };
    try { response.result = await run(request.tool, request.args); response.ok = true; }
    catch (error) { response.error = error instanceof Error ? error.message : String(error); }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
  });
  ws.on('close', () => { console.log('[agent] disconnected; reconnecting in 3s'); setTimeout(connect,3000); });
  ws.on('error', error => console.error('[agent] websocket error:',error.message));
}
console.log(`[agent] mode: ${LINUX_MODE ? 'linux/bash' : 'windows/powershell'}`);
console.log(`[agent] workspace: ${WORKSPACE_ROOT}`);
console.log(`[agent] command execution: ${ALLOW_COMMAND_EXECUTION ? 'ENABLED' : 'DISABLED'}`);
connect();
