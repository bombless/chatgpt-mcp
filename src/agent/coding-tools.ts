import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Sandbox } from 'microsandbox';
import { cdpCall, cdpListTargets, cdpVersion } from './cdp.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_BYTES ?? 1_000_000);
const MAX_SEARCH_RESULTS = Number(process.env.MAX_SEARCH_RESULTS ?? 500);
const COMMAND_TIMEOUT_MS = Number(process.env.COMMAND_TIMEOUT_MS ?? 120_000);
const ALLOW_COMMAND_EXECUTION = process.env.ALLOW_COMMAND_EXECUTION === 'true';
const WORKSPACE_ROOT = path.resolve(process.env.AGENT_WORKSPACE ?? 'D:\\mcp-agent-workspace');
const PYTHON_SANDBOX_IMAGE = process.env.MICROSANDBOX_PYTHON_IMAGE ?? 'python';
const PYTHON_SANDBOX_MEMORY_MIB = Number(process.env.MICROSANDBOX_PYTHON_MEMORY_MIB ?? 512);
const PYTHON_SANDBOX_CPUS = Number(process.env.MICROSANDBOX_PYTHON_CPUS ?? 1);
const PYTHON_SANDBOX_GUEST_ROOT = '/workspace';

type CommandLogger = (command: string, cwd?: string) => void;

export function assertAllowed(target: string): string {
  const resolved = path.resolve(target);
  const root = WORKSPACE_ROOT.toLowerCase();
  const normalized = resolved.toLowerCase();
  if (normalized !== root && !normalized.startsWith(root + path.sep)) throw new Error(`Path is outside agent workspace: ${resolved}`);
  return resolved;
}

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
}

async function exec(command: string, args: string[], cwd?: string, timeout = COMMAND_TIMEOUT_MS, logCommand?: CommandLogger) {
  const workingDirectory = cwd ? assertAllowed(cwd) : WORKSPACE_ROOT;
  logCommand?.([command, ...args].map(arg => /\s|["']/u.test(arg) ? JSON.stringify(arg) : arg).join(' '), workingDirectory);
  const result = await execFileAsync(command, args, { cwd: workingDirectory, windowsHide: true, timeout, maxBuffer: MAX_OUTPUT_BYTES, shell: false });
  return { stdout: result.stdout, stderr: result.stderr, code: 0 };
}

function requireCommandExecution() {
  if (!ALLOW_COMMAND_EXECUTION) throw new Error('Command execution is disabled. Set ALLOW_COMMAND_EXECUTION=true on the Windows agent to enable run_npm, run_python, run_node, git, apply_patch, and kill_process.');
}

function guestPathForHostCwd(cwd?: string): { host: string; guest: string } {
  const host = cwd ? assertAllowed(cwd) : WORKSPACE_ROOT;
  const relative = path.relative(WORKSPACE_ROOT, host);
  if (relative === '' || relative === '.') return { host, guest: PYTHON_SANDBOX_GUEST_ROOT };
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path is outside agent workspace: ${host}`);
  }
  return { host, guest: `${PYTHON_SANDBOX_GUEST_ROOT}/${relative.split(path.sep).join('/')}` };
}

function sandboxName(): string {
  const agentId = (process.env.AGENT_ID ?? 'agent').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'agent';
  return `chatgpt-python-${agentId}-${Date.now().toString(36)}`.slice(0, 128);
}

async function runPythonInMicrosandbox(args: Record<string, unknown>, logCommand?: CommandLogger) {
  requireCommandExecution();
  const { host, guest } = guestPathForHostCwd(args.cwd ? stringArg(args, 'cwd') : undefined);
  const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  logCommand?.(['python3', ...commandArgs].map(arg => /\s|["']/u.test(arg) ? JSON.stringify(arg) : arg).join(' '), host);

  const sandbox = await Sandbox.builder(sandboxName())
    .image(PYTHON_SANDBOX_IMAGE)
    .cpus(PYTHON_SANDBOX_CPUS)
    .memory(PYTHON_SANDBOX_MEMORY_MIB)
    .volume(PYTHON_SANDBOX_GUEST_ROOT, mount => mount.bind(WORKSPACE_ROOT))
    .workdir(guest)
    .create();

  try {
    const result = await sandbox.execWith('python3', exec =>
      exec
        .args(commandArgs)
        .cwd(guest)
        .timeout(COMMAND_TIMEOUT_MS),
    );
    return {
      stdout: result.stdout(),
      stderr: result.stderr(),
      code: result.code,
    };
  } catch (error: any) {
    return {
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: String(error?.stderr ?? error?.message ?? error),
      code: typeof error?.code === 'number' ? error.code : typeof error?.status === 'number' ? error.status : 1,
    };
  } finally {
    await sandbox.stop();
  }
}

async function command(name: 'npm' | 'node', args: Record<string, unknown>, logCommand?: CommandLogger) {
  requireCommandExecution();
  const cwd = args.cwd ? stringArg(args, 'cwd') : WORKSPACE_ROOT;
  const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  const executable = process.platform === 'win32' && name === 'npm' ? 'npm.cmd' : name;
  try { return await exec(executable, commandArgs, cwd, COMMAND_TIMEOUT_MS, logCommand); }
  catch (error: any) { return { stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message ?? error), code: typeof error.status === 'number' ? error.status : 1 }; }
}

async function rg(args: Record<string, unknown>, logCommand?: CommandLogger) {
  const query = stringArg(args, 'query');
  const cwd = args.cwd ? assertAllowed(stringArg(args, 'cwd')) : WORKSPACE_ROOT;
  const limit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Number(args.maxResults ?? MAX_SEARCH_RESULTS)));
  const rgArgs = ['--line-number', '--column', '--color', 'never', '--no-heading', '--hidden', '--glob', '!.git/**', '--max-count', String(limit)];
  if (args.ignoreCase === true) rgArgs.push('--ignore-case');
  if (typeof args.glob === 'string' && args.glob) rgArgs.push('--glob', args.glob);
  rgArgs.push(query, '.');
  try { return { ...(await exec('rg', rgArgs, cwd, COMMAND_TIMEOUT_MS, logCommand)), matches: true, truncated: false }; }
  catch (error: any) {
    const code = typeof error.code === 'number' ? error.code : 1;
    if (code === 1) return { stdout: '', stderr: '', code: 1, matches: false, truncated: false };
    throw new Error(String(error.stderr ?? error.message ?? error));
  }
}

async function findFiles(args: Record<string, unknown>, logCommand?: CommandLogger) {
  const root = args.cwd ? assertAllowed(stringArg(args, 'cwd')) : WORKSPACE_ROOT;
  const pattern = typeof args.pattern === 'string' && args.pattern ? args.pattern : '**/*';
  const maxResults = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Number(args.maxResults ?? MAX_SEARCH_RESULTS)));
  const result = await exec('rg', ['--files', '--hidden', '--glob', '!.git/**', '--glob', pattern], root, COMMAND_TIMEOUT_MS, logCommand);
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

async function processList(logCommand?: CommandLogger) {
  if (process.platform === 'win32') return await exec('tasklist', ['/FO', 'CSV', '/NH'], WORKSPACE_ROOT, COMMAND_TIMEOUT_MS, logCommand);
  return await exec('ps', ['-eo', 'pid,ppid,comm,args'], WORKSPACE_ROOT, COMMAND_TIMEOUT_MS, logCommand);
}

async function killProcess(args: Record<string, unknown>, logCommand?: CommandLogger) {
  requireCommandExecution();
  const pid = Number(args.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('pid must be a positive integer');
  if (pid === process.pid) throw new Error('Refusing to terminate the agent process');
  if (process.platform === 'win32') await exec('taskkill', ['/PID', String(pid), '/T', '/F'], WORKSPACE_ROOT, COMMAND_TIMEOUT_MS, logCommand); else await exec('kill', ['-TERM', String(pid)], WORKSPACE_ROOT, COMMAND_TIMEOUT_MS, logCommand);
  return { ok: true, pid };
}

async function git(args: Record<string, unknown>, logCommand?: CommandLogger) {
  requireCommandExecution();
  const cwd = args.cwd ? stringArg(args, 'cwd') : WORKSPACE_ROOT;
  const gitArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  if (!gitArgs.length) throw new Error('args must contain a git subcommand');
  return await exec(process.platform === 'win32' ? 'git.exe' : 'git', gitArgs, cwd, COMMAND_TIMEOUT_MS, logCommand);
}

async function applyPatch(args: Record<string, unknown>, logCommand?: CommandLogger) {
  requireCommandExecution();
  const patch = stringArg(args, 'patch');
  const cwd = args.cwd ? stringArg(args, 'cwd') : WORKSPACE_ROOT;
  const temp = path.join(WORKSPACE_ROOT, `.mcp-patch-${Date.now()}-${Math.random().toString(16).slice(2)}.patch`);
  try {
    await fs.writeFile(temp, patch, 'utf8');
    return await exec(process.platform === 'win32' ? 'git.exe' : 'git', ['apply', '--whitespace=nowarn', temp], cwd, COMMAND_TIMEOUT_MS, logCommand);
  } finally { await fs.rm(temp, { force: true }); }
}

export async function runCodingTool(tool: string, args: Record<string, unknown>, logCommand?: CommandLogger): Promise<unknown> {
  switch (tool) {
    case 'run_npm': return command('npm', args, logCommand);
    case 'run_python': return runPythonInMicrosandbox(args, logCommand);
    case 'run_node': return command('node', args, logCommand);
    case 'read_file_range': return readFileRange(args);
    case 'tail_file': return tailFile(args);
    case 'get_file_info': return fileInfo(args);
    case 'create_directory': return createDirectory(args);
    case 'copy_file': return copyFile(args);
    case 'process_list': return processList(logCommand);
    case 'kill_process': return killProcess(args, logCommand);
    case 'rg': return rg(args, logCommand);
    case 'git': return git(args, logCommand);
    case 'apply_patch': return applyPatch(args, logCommand);
    case 'find_files': return findFiles(args, logCommand);
    case 'cdp_version': return cdpVersion();
    case 'cdp_list_targets': return cdpListTargets();
    case 'cdp_call': return cdpCall(args);
    default: throw new Error(`Unsupported coding tool: ${tool}`);
  }
}
