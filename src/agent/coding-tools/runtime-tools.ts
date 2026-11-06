import { spawn, type ChildProcess } from 'node:child_process';
import {
  assertAllowed,
  stringArg,
  requireCommandExecution,
  exec,
  command,
  COMMAND_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  type CommandLogger,
} from './common.js';

type PythonJobStatus = 'running' | 'exited' | 'failed' | 'killed';

type PythonJob = {
  jobId: string;
  pid: number;
  command: string;
  cwd: string;
  args: string[];
  startedAt: string;
  finishedAt?: string;
  status: PythonJobStatus;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  child: ChildProcess;
};

const pythonJobs = new Map<string, PythonJob>();

function appendLimited(current: string, chunk: Buffer | string): { value: string; truncated: boolean } {
  const remaining = Math.max(0, MAX_OUTPUT_BYTES - Buffer.byteLength(current, 'utf8'));
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
  if (Buffer.byteLength(text, 'utf8') <= remaining) return { value: current + text, truncated: false };
  return { value: current + Buffer.from(text, 'utf8').subarray(0, remaining).toString('utf8'), truncated: true };
}

function pythonExecutable() {
  return process.platform === 'win32' ? 'python.exe' : 'python';
}

function cryptoRandomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function publicJob(job: PythonJob) {
  return {
    jobId: job.jobId,
    pid: job.pid,
    status: job.status,
    command: job.command,
    cwd: job.cwd,
    args: job.args,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
    exitCode: job.exitCode,
    signal: job.signal,
    stdout: job.stdout,
    stderr: job.stderr,
    stdoutTruncated: job.stdoutTruncated,
    stderrTruncated: job.stderrTruncated,
  };
}

function spawnPythonJob(args: Record<string, unknown>, workspaceRoot: string, logCommand?: CommandLogger) {
  requireCommandExecution();
  const cwd = args.cwd ? stringArg(args, 'cwd') : workspaceRoot;
  const workingDirectory = assertAllowed(cwd, workspaceRoot);
  const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  const executable = pythonExecutable();
  const commandLine = [executable, ...commandArgs].map(arg => /\s|["']/u.test(arg) ? JSON.stringify(arg) : arg).join(' ');
  logCommand?.(commandLine, workingDirectory);

  const child = spawn(executable, commandArgs, { cwd: workingDirectory, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const jobId = cryptoRandomId();
  const job: PythonJob = {
    jobId,
    pid: child.pid ?? -1,
    command: commandLine,
    cwd: workingDirectory,
    args: commandArgs,
    startedAt: new Date().toISOString(),
    status: 'running',
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    child,
  };
  pythonJobs.set(jobId, job);

  child.stdout?.on('data', chunk => {
    const result = appendLimited(job.stdout, chunk);
    job.stdout = result.value;
    job.stdoutTruncated ||= result.truncated;
  });
  child.stderr?.on('data', chunk => {
    const result = appendLimited(job.stderr, chunk);
    job.stderr = result.value;
    job.stderrTruncated ||= result.truncated;
  });
  child.once('error', error => {
    job.stderr = appendLimited(job.stderr, error.message).value;
    if (job.status === 'running') job.status = 'failed';
  });
  child.once('close', (code, signal) => {
    job.finishedAt = new Date().toISOString();
    job.exitCode = code;
    job.signal = signal;
    if (job.status === 'running') job.status = code === 0 ? 'exited' : 'failed';
  });

  return {
    jobId,
    pid: job.pid,
    status: job.status,
    command: job.command,
    cwd: job.cwd,
    startedAt: job.startedAt,
  };
}

export function inspectPythonJob(args: Record<string, unknown>) {
  const jobId = stringArg(args, 'jobId');
  const job = pythonJobs.get(jobId);
  if (!job) throw new Error(`Python job '${jobId}' was not found`);
  return publicJob(job);
}

export async function killPythonJob(args: Record<string, unknown>, workspaceRoot: string) {
  requireCommandExecution();
  const jobId = stringArg(args, 'jobId');
  const job = pythonJobs.get(jobId);
  if (!job) throw new Error(`Python job '${jobId}' was not found`);
  if (job.status !== 'running') return publicJob(job);

  if (process.platform === 'win32') {
    await exec('taskkill.exe', ['/PID', String(job.pid), '/T', '/F'], workspaceRoot, workspaceRoot, COMMAND_TIMEOUT_MS);
  } else {
    job.child.kill('SIGTERM');
  }
  job.status = 'killed';
  return publicJob(job);
}

export function listPythonJobs() {
  return [...pythonJobs.values()].map(publicJob).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export async function runPython(args: Record<string, unknown>, workspaceRoot: string, logCommand?: CommandLogger) {
  if (args.async === true) return spawnPythonJob(args, workspaceRoot, logCommand);
  return command('python', args, workspaceRoot, logCommand);
}

export async function runNpmTool(tool: 'npm_test' | 'npm_run' | 'npm_install' | 'npm_init', args: Record<string, unknown>, workspaceRoot: string, logCommand?: CommandLogger) {
  const supplied = Array.isArray(args.args) ? args.args.map(String) : [];
  let commandArgs: string[];
  switch (tool) {
    case 'npm_test':
      commandArgs = ['test', ...supplied];
      break;
    case 'npm_run': {
      const script = supplied.shift();
      if (!script) throw new Error('npm_run requires a script name in args[0]');
      commandArgs = ['run', script, ...(supplied.length ? ['--', ...supplied] : [])];
      break;
    }
    case 'npm_install':
      commandArgs = ['install', ...supplied];
      break;
    case 'npm_init':
      commandArgs = ['init', ...supplied];
      break;
  }
  return command('npm', { ...args, args: commandArgs }, workspaceRoot, logCommand);
}

export async function runGradleTool(tool: 'gradle_assemble_debug' | 'gradle_install_debug', args: Record<string, unknown>, workspaceRoot: string, logCommand?: CommandLogger) {
  requireCommandExecution();
  const task = tool === 'gradle_assemble_debug' ? 'assembleDebug' : 'installDebug';
  const cwd = args.cwd ? stringArg(args, 'cwd') : workspaceRoot;
  if (process.platform === 'win32') {
    return await exec('cmd.exe', ['/d', '/s', '/c', `gradle.bat ${task}`], workspaceRoot, cwd, COMMAND_TIMEOUT_MS, logCommand);
  }
  return await exec('gradle', [task], workspaceRoot, cwd, COMMAND_TIMEOUT_MS, logCommand);
}

export async function processList(workspaceRoot: string, logCommand?: CommandLogger) {
  if (process.platform === 'win32') return await exec('tasklist', ['/FO', 'CSV', '/NH'], workspaceRoot, workspaceRoot, COMMAND_TIMEOUT_MS, logCommand);
  return await exec('ps', ['-eo', 'pid,ppid,comm,args'], workspaceRoot, workspaceRoot, COMMAND_TIMEOUT_MS, logCommand);
}

export async function killProcess(args: Record<string, unknown>, workspaceRoot: string, logCommand?: CommandLogger) {
  requireCommandExecution();
  const pid = Number(args.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('pid must be a positive integer');
  if (pid === process.pid) throw new Error('Refusing to terminate the agent process');
  if (process.platform === 'win32') await exec('taskkill', ['/PID', String(pid), '/T', '/F'], workspaceRoot, workspaceRoot, COMMAND_TIMEOUT_MS, logCommand); else await exec('kill', ['-TERM', String(pid)], workspaceRoot, workspaceRoot, COMMAND_TIMEOUT_MS, logCommand);
  return { ok: true, pid };
}
