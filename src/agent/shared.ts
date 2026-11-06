import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

export const execFileAsync = promisify(execFile);
export const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_BYTES ?? 1_000_000);
export const MAX_SEARCH_RESULTS = Number(process.env.MAX_SEARCH_RESULTS ?? 500);
export const COMMAND_TIMEOUT_MS = Number(process.env.COMMAND_TIMEOUT_MS ?? 120_000);
let allowCommandExecution = process.env.ALLOW_COMMAND_EXECUTION === 'true';
export const ALLOW_NPM_EXECUTION = process.env.ALLOW_NPM_EXECUTION === 'true';

/** Set the resolved agent permission (environment or secure configuration). */
export function setCommandExecutionEnabled(enabled: boolean): void {
  allowCommandExecution = enabled;
}

export type CommandLogger = (command: string, cwd?: string) => void;

export function assertAllowed(target: string, workspaceRoot: string): string {
  const resolved = path.resolve(target);
  const root = process.platform === 'win32' ? workspaceRoot.toLowerCase() : workspaceRoot;
  const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  if (normalized !== root && !normalized.startsWith(root + path.sep)) throw new Error(`Path is outside agent workspace: ${resolved}`);
  return resolved;
}
export type ProxyInfo = {
  configured: boolean;
  proxies: { http: string | null; https: string | null; all: string | null };
  noProxy: string | null;
};

function safeProxyUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const raw = value.trim();
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(raw) ? raw : `http://${raw}`);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString().replace(/\/$/u, parsed.pathname === '/' && !parsed.search && !parsed.hash ? '' : '/');
  } catch {
    return '[configured; unable to parse proxy URL]';
  }
}

export function getProxyInfo(env: NodeJS.ProcessEnv = process.env): ProxyInfo {
  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(env)) {
    if (value) values.set(key.toLowerCase(), value);
  }
  const http = safeProxyUrl(values.get('http_proxy'));
  const https = safeProxyUrl(values.get('https_proxy'));
  const all = safeProxyUrl(values.get('all_proxy'));
  const noProxy = values.get('no_proxy')?.trim() || null;
  return { configured: Boolean(http || https || all), proxies: { http, https, all }, noProxy };
}
export function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
}

export async function writeFileAtomic(file: string, content: string, expectedSha256: string) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.mcp-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await fs.writeFile(temporary, content, 'utf8');
    const latest = await fs.readFile(file);
    const latestSha256 = sha256(latest);
    if (latestSha256 !== expectedSha256) throw new Error(`File changed while the edit was being prepared: expected sha256 ${expectedSha256}, current sha256 ${latestSha256}`);
    try {
      await fs.rename(temporary, file);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
      const immediatelyBeforeReplace = await fs.readFile(file);
      if (sha256(immediatelyBeforeReplace) !== expectedSha256) throw new Error('File changed before replacement; refusing to overwrite it');
      await fs.rm(file, { force: true });
      await fs.rename(temporary, file);
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export function sha256(content: Buffer | string) {
  return crypto.createHash('sha256').update(content).digest('hex');
}
export async function exec(command: string, args: string[], workspaceRoot: string, cwd?: string, timeout = COMMAND_TIMEOUT_MS, logCommand?: CommandLogger) {
  const workingDirectory = cwd ? assertAllowed(cwd, workspaceRoot) : workspaceRoot;
  logCommand?.([command, ...args].map(arg => /\s|["']/u.test(arg) ? JSON.stringify(arg) : arg).join(' '), workingDirectory);
  const result = await execFileAsync(command, args, { cwd: workingDirectory, windowsHide: true, timeout, maxBuffer: MAX_OUTPUT_BYTES, shell: false });
  return { stdout: result.stdout, stderr: result.stderr, code: 0 };
}

export function requireCommandExecution() {
  if (!allowCommandExecution) throw new Error('Command execution is disabled. Set ALLOW_COMMAND_EXECUTION=true on the agent to enable npm tools, run_python, run_node, git, apply_patch, and kill_process.');
}

export function requireNpmExecution() {
  if (!allowCommandExecution && !ALLOW_NPM_EXECUTION) throw new Error('Npm execution is disabled. Set ALLOW_NPM_EXECUTION=true (or ALLOW_COMMAND_EXECUTION=true) on the agent to enable npm tools.');
}

export function appendLimited(current: string, chunk: Buffer | string): { value: string; truncated: boolean } {
  const remaining = Math.max(0, MAX_OUTPUT_BYTES - Buffer.byteLength(current, 'utf8'));
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
  if (Buffer.byteLength(text, 'utf8') <= remaining) return { value: current + text, truncated: false };
  return { value: current + Buffer.from(text, 'utf8').subarray(0, remaining).toString('utf8'), truncated: true };
}

function pythonExecutable() {
  return process.platform === 'win32' ? 'python.exe' : 'python';
}
