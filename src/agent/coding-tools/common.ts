import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const execFileAsync = promisify(execFile);
export const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_BYTES ?? 1_000_000);
export const MAX_SEARCH_RESULTS = Number(process.env.MAX_SEARCH_RESULTS ?? 500);
export const COMMAND_TIMEOUT_MS = Number(process.env.COMMAND_TIMEOUT_MS ?? 120_000);
export let allowCommandExecution = process.env.ALLOW_COMMAND_EXECUTION === 'true';
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

export function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
}

export function sha256(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function requireCommandExecution(): void {
  if (!allowCommandExecution) throw new Error('Command execution is disabled. Set ALLOW_COMMAND_EXECUTION=true on the agent to enable npm tools, run_python, run_node, git, apply_patch, and kill_process.');
}

export function requireNpmExecution(): void {
  if (!allowCommandExecution && !ALLOW_NPM_EXECUTION) throw new Error('Npm execution is disabled. Set ALLOW_NPM_EXECUTION=true (or ALLOW_COMMAND_EXECUTION=true) on the agent to enable npm tools.');
}

export async function exec(
  cmd: string,
  args: string[],
  workspaceRoot: string,
  cwd?: string,
  timeout = COMMAND_TIMEOUT_MS,
  logCommand?: CommandLogger
) {
  const workingDirectory = cwd ? assertAllowed(cwd, workspaceRoot) : workspaceRoot;
  logCommand?.([cmd, ...args].map(arg => /\s|["']/u.test(arg) ? JSON.stringify(arg) : arg).join(' '), workingDirectory);
  const result = await execFileAsync(cmd, args, { cwd: workingDirectory, windowsHide: true, timeout, maxBuffer: MAX_OUTPUT_BYTES, shell: false });
  return { stdout: result.stdout, stderr: result.stderr, code: 0 };
}

export async function command(
  name: 'npm' | 'python' | 'node',
  args: Record<string, unknown>,
  workspaceRoot: string,
  logCommand?: CommandLogger
) {
  if (name === 'npm') requireNpmExecution(); else requireCommandExecution();
  const cwd = args.cwd ? stringArg(args, 'cwd') : workspaceRoot;
  const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];

  // npm is a .cmd wrapper on Windows. Node's execFile/spawn cannot execute
  // .cmd files directly with shell:false and reports `spawn EINVAL` on
  // current Node releases. Do not switch to shell:true here: npm arguments
  // are model/user input and must not become shell syntax. Launch npm's JS
  // entry point directly with the current Node executable instead.
  const executable = process.platform === 'win32' && name === 'npm'
    ? process.execPath
    : name;
  const executableArgs = process.platform === 'win32' && name === 'npm'
    ? [path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...commandArgs]
    : commandArgs;

  try { return await exec(executable, executableArgs, workspaceRoot, cwd, COMMAND_TIMEOUT_MS, logCommand); }
  catch (error: any) { return { stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message ?? error), code: typeof error.status === 'number' ? error.status : 1 }; }
}
