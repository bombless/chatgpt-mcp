import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_BYTES ?? 1_000_000);
const MAX_SEARCH_RESULTS = Number(process.env.MAX_SEARCH_RESULTS ?? 500);
const COMMAND_TIMEOUT_MS = Number(process.env.COMMAND_TIMEOUT_MS ?? 120_000);

const WORKSPACE_ROOT = path.resolve(process.env.AGENT_WORKSPACE ?? 'D:\\mcp-agent-workspace');

export function assertAllowed(target: string): string {
  const resolved = path.resolve(target);
  const root = WORKSPACE_ROOT.toLowerCase();
  const normalized = resolved.toLowerCase();
  if (normalized !== root && !normalized.startsWith(root + path.sep)) {
    throw new Error(`Path is outside agent workspace: ${resolved}`);
  }
  return resolved;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
}

async function exec(command: string, args: string[], cwd?: string, timeout = COMMAND_TIMEOUT_MS) {
  const result = await execFileAsync(command, args, {
    cwd: cwd ? assertAllowed(cwd) : WORKSPACE_ROOT,
    windowsHide: true,
    timeout,
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: false,
  });
  return { stdout: result.stdout, stderr: result.stderr, code: 0 };
}

async function command(name: 'npm' | 'python' | 'node', args: Record<string, unknown>) {
  const cwd = args.cwd ? stringArg(args, 'cwd') : WORKSPACE_ROOT;
  const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  const executable = process.platform === 'win32' && name === 'npm' ? 'npm.cmd' : name;
  try {
    return await exec(executable, commandArgs, cwd);
  } catch (error: any) {
    return { stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message ?? error), code: typeof error.code === 'number' ? error.code : 1 };
  }
}

async function rg(args: Record<string, unknown>) {
  const query = stringArg(args, 'query');
  const cwd = args.cwd ? assertAllowed(stringArg(args, 'cwd')) : WORKSPACE_ROOT;
  const rgArgs = ['--line-number', '--column', '--color', 'never', '--no-heading', '--hidden', '--glob', '!.git/**'];
  if (args.ignoreCase === true) rgArgs.push('--ignore-case');
  if (typeof args.glob === 'string' && args.glob) rgArgs.push('--glob', args.glob);
  rgArgs.push('--max-count', String(Math.max(1, Math.min(MAX_SEARCH_RESULTS, Number(args.maxResults ?? MAX_SEARCH_RESULTS))), query);
  rgArgs.pop();
  rgArgs.push(query, '.');
  try {
    const result = await exec('rg', rgArgs, cwd);
    return { ...result, truncated: false };
  } catch (error: any) {
    const code = typeof error.code === 'number' ? error.code : 1;
    if (code === 1) return { stdout: '', stderr: '', code: 1, matches: false, truncated: false };
    if (code === 2) throw new Error(String(error.stderr ?? error.message ?? error));
    return { stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? ''), code, truncated: true };
  }
}

async function findFiles(args: Record<string, unknown>) {
  const root = args.cwd ? assertAllowed(stringArg(args, 'cwd')) : WORKSPACE_ROOT;
  const pattern = typeof args.pattern === 'string' && args.pattern ? args.pattern : '**/*';
  const maxResults = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Number(args.maxResults ?? MAX_SEARCH_RESULTS)));
  const result = await exec('rg', ['--files', '--hidden', '--glob', '!.git/**', '--glob', pattern], root);
  const files = result.stdout.split(/\r?\n/).filter(Boolean).slice(0, maxResults);
  return { files, truncated: files.length >= maxResults, count: files.length };
}

async function readFileRange(args: Record<string, unknown>) {
  const file = assertAllowed(stringArg(args, 'path'));
  const start = Math.max(1, Number(args.startLine ?? 1));
  const end = Math.max(start, Number(args.endLine ?? start + 199));
  const content = await fs.readFile(file, 'utf8');
  const lines = content.split(/\r?\n/).slice(start - 1, end);
  return lines.map((line, i) => `${start + i}: ${line}`).join('\n');
}

async function tailFile(args: Record<string, unknown>) {
  const file = assertAllowed(stringArg(args, 'path'));
  const lines = Math.max(1, Number(args.lines ?? 100));
  const content = await fs.readFile(file, 'utf8');
  return content.split(/\r?\n/).slice(-lines).join('\n');
}

async function fileInfo(args: Record<string, unknown>) {
  const file = assertAllowed(stringArg(args, 'path'));
  const stat = await fs.stat(file);
  return { path: file, type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', size: stat.size, mtime: stat.mtime.toISOString(), mode: stat.mode };
}

async function createDirectory(args: Record<string, unknown>) {
  const directory = assertAllowed(stringArg(args, 'path'));
  await fs.mkdir(directory, { recursive: true });
  return { ok: true, path: directory };
}

async function copyFile(args: Record<string, unknown>) {
  const source = assertAllowed(stringArg(args, 'source'));
  const destination = assertAllowed(stringArg(args, 'destination'));
  await fs.copyFile(source, destination);
  return { ok: true, source, destination };
}

async function processList() {
  if (process.platform === 'win32') {
    try { return await exec('tasklist', ['/FO', 'CSV', '/NH']); } catch (error: any) { return { stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error), code: 1 }; }
  }
  try { return await exec('ps', ['-eo', 'pid,ppid,comm,args']); } catch (error: any) { return { stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error), code: 1 }; }
}

async function killProcess(args: Record<string, unknown>) {
  const pid = Number(args.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('pid must be a positive integer');
  if (pid === process.pid) throw new Error('Refusing to terminate the agent process');
  if (process.platform === 'win32') await exec('taskkill', ['/PID', String(pid), '/T', '/F']);
  else await exec('kill', ['-TERM', String(pid)]);
  return { ok: true, pid };
}

async function git(args: Record<string, unknown>) {
  const cwd = args.cwd ? stringArg(args, 'cwd') : WORKSPACE_ROOT;
  const gitArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  if (!gitArgs.length) throw new Error('args must contain a git subcommand');
  return await exec('git.exe', gitArgs, cwd);
}

async function applyPatch(args: Record<string, unknown>) {
  const patch = stringArg(args, 'patch');
  const cwd = args.cwd ? stringArg(args, 'cwd') : WORKSPACE_ROOT;
  const temp = path.join(WORKSPACE_ROOT, `.mcp-patch-${Date.now()}-${Math.random().toString(16).slice(2)}.patch`);
  assertAllowed(temp);
  try {
    await fs.writeFile(temp, patch, 'utf8');
    return await exec('git.exe', ['apply', '--whitespace=nowarn', temp], cwd);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

export async function runCodingTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
  switch (tool) {
    case 'run_npm': return command('npm', args);
    case 'run_python': return command('python', args);
    case 'run_node': return command('node', args);
    case 'read_file_range': return readFileRange(args);
    case 'tail_file': return tailFile(args);
    case 'get_file_info': return fileInfo(args);
    case 'create_directory': return createDirectory(args);
    case 'copy_file': return copyFile(args);
    case 'process_list': return processList();
    case 'kill_process': return killProcess(args);
    case 'rg': return rg(args);
    case 'git': return git(args);
    case 'apply_patch': return applyPatch(args);
    case 'find_files': return findFiles(args);
    default: throw new Error(`Unsupported coding tool: ${tool}`);
  }
}
