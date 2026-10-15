import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { cdpCall, cdpListTargets, cdpVersion } from './cdp.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = Number(process.env.MAX_OUTPUT_BYTES ?? 1_000_000);
const MAX_SEARCH_RESULTS = Number(process.env.MAX_SEARCH_RESULTS ?? 500);
const COMMAND_TIMEOUT_MS = Number(process.env.COMMAND_TIMEOUT_MS ?? 120_000);
const ALLOW_COMMAND_EXECUTION = process.env.ALLOW_COMMAND_EXECUTION === 'true';
const ALLOW_NPM_EXECUTION = process.env.ALLOW_NPM_EXECUTION === 'true';
const WORKSPACE_ROOT = path.resolve(process.env.AGENT_WORKSPACE ?? (process.platform === 'linux' ? '/tmp/mcp-agent-workspace' : 'D:\\mcp-agent-workspace'));

type CommandLogger = (command: string, cwd?: string) => void;
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

export function assertAllowed(target: string): string {
  const resolved = path.resolve(target);
  const root = process.platform === 'win32' ? WORKSPACE_ROOT.toLowerCase() : WORKSPACE_ROOT;
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

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
}

async function writeFileAtomic(file: string, content: string) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.mcp-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await fs.writeFile(temporary, content, 'utf8');
    try {
      await fs.rename(temporary, file);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
      await fs.rm(file, { force: true });
      await fs.rename(temporary, file);
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function sha256(content: string) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

async function editFile(args: Record<string, unknown>) {
  const file = assertAllowed(stringArg(args, 'path'));
  const oldText = stringArg(args, 'oldText');
  const newText = typeof args.newText === 'string' ? args.newText : undefined;
  if (newText === undefined) throw new Error('newText must be a string');
  if (oldText === newText) throw new Error('oldText and newText must be different');

  const content = await fs.readFile(file, 'utf8');
  const expectedSha256 = typeof args.expectedSha256 === 'string' && args.expectedSha256 ? args.expectedSha256.toLowerCase() : undefined;
  const beforeSha256 = sha256(content);
  if (expectedSha256 && beforeSha256 !== expectedSha256) {
    throw new Error(`File changed since it was read: expected sha256 ${expectedSha256}, current sha256 ${beforeSha256}`);
  }

  let replacements = 0;
  let cursor = 0;
  while (true) {
    const index = content.indexOf(oldText, cursor);
    if (index === -1) break;
    replacements += 1;
    cursor = index + oldText.length;
  }

  const expectedReplacements = args.expectedReplacements === undefined ? 1 : Number(args.expectedReplacements);
  if (!Number.isInteger(expectedReplacements) || expectedReplacements < 1) throw new Error('expectedReplacements must be a positive integer');
  if (replacements !== expectedReplacements) {
    throw new Error(`Expected ${expectedReplacements} replacement${expectedReplacements === 1 ? '' : 's'}, but found ${replacements}`);
  }

  const updated = content.split(oldText).join(newText);
  await writeFileAtomic(file, updated);
  const afterSha256 = sha256(updated);
  const beforeLines = oldText.split(/\r?\n/);
  const afterLines = newText.split(/\r?\n/);
  const firstLine = content.slice(0, content.indexOf(oldText)).split(/\r?\n/).length;
  const diff = [
    `@@ -${firstLine},${beforeLines.length} +${firstLine},${afterLines.length} @@`,
    ...beforeLines.map(line => `-${line}`),
    ...afterLines.map(line => `+${line}`),
  ].join('\n');

  return {
    ok: true,
    path: file,
    changed: true,
    replacements,
    bytesBefore: Buffer.byteLength(content, 'utf8'),
    bytesAfter: Buffer.byteLength(updated, 'utf8'),
    sha256Before: beforeSha256,
    sha256After: afterSha256,
    diff,
  };
}

async function exec(command: string, args: string[], cwd?: string, timeout = COMMAND_TIMEOUT_MS, logCommand?: CommandLogger) {
  const workingDirectory = cwd ? assertAllowed(cwd) : WORKSPACE_ROOT;
  logCommand?.([command, ...args].map(arg => /\s|["']/u.test(arg) ? JSON.stringify(arg) : arg).join(' '), workingDirectory);
  const result = await execFileAsync(command, args, { cwd: workingDirectory, windowsHide: true, timeout, maxBuffer: MAX_OUTPUT_BYTES, shell: false });
  return { stdout: result.stdout, stderr: result.stderr, code: 0 };
}

function requireCommandExecution() {
  if (!ALLOW_COMMAND_EXECUTION) throw new Error('Command execution is disabled. Set ALLOW_COMMAND_EXECUTION=true on the agent to enable npm tools, run_python, run_node, git, apply_patch, and kill_process.');
}

function requireNpmExecution() {
  if (!ALLOW_COMMAND_EXECUTION && !ALLOW_NPM_EXECUTION) throw new Error('Npm execution is disabled. Set ALLOW_NPM_EXECUTION=true (or ALLOW_COMMAND_EXECUTION=true) on the agent to enable npm tools.');
}

function appendLimited(current: string, chunk: Buffer | string): { value: string; truncated: boolean } {
  const remaining = Math.max(0, MAX_OUTPUT_BYTES - Buffer.byteLength(current, 'utf8'));
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
  if (Buffer.byteLength(text, 'utf8') <= remaining) return { value: current + text, truncated: false };
  return { value: current + Buffer.from(text, 'utf8').subarray(0, remaining).toString('utf8'), truncated: true };
}

function pythonExecutable() {
  return process.platform === 'win32' ? 'python.exe' : 'python';
}

function spawnPythonJob(args: Record<string, unknown>, logCommand?: CommandLogger) {
  requireCommandExecution();
  const cwd = args.cwd ? stringArg(args, 'cwd') : WORKSPACE_ROOT;
  const workingDirectory = assertAllowed(cwd);
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

function inspectPythonJob(args: Record<string, unknown>) {
  const jobId = stringArg(args, 'jobId');
  const job = pythonJobs.get(jobId);
  if (!job) throw new Error(`Python job '${jobId}' was not found`);
  return publicJob(job);
}

async function killPythonJob(args: Record<string, unknown>) {
  requireCommandExecution();
  const jobId = stringArg(args, 'jobId');
  const job = pythonJobs.get(jobId);
  if (!job) throw new Error(`Python job '${jobId}' was not found`);
  if (job.status !== 'running') return publicJob(job);

  if (process.platform === 'win32') {
    await exec('taskkill.exe', ['/PID', String(job.pid), '/T', '/F'], WORKSPACE_ROOT, COMMAND_TIMEOUT_MS);
  } else {
    job.child.kill('SIGTERM');
  }
  job.status = 'killed';
  return publicJob(job);
}

function listPythonJobs() {
  return [...pythonJobs.values()].map(publicJob).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

async function command(name: 'npm' | 'python' | 'node', args: Record<string, unknown>, logCommand?: CommandLogger) {
  if (name === 'npm') requireNpmExecution(); else requireCommandExecution();
  const cwd = args.cwd ? stringArg(args, 'cwd') : WORKSPACE_ROOT;
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

  try { return await exec(executable, executableArgs, cwd, COMMAND_TIMEOUT_MS, logCommand); }
  catch (error: any) { return { stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? error.message ?? error), code: typeof error.status === 'number' ? error.status : 1 }; }
}

async function runNpmTool(tool: 'npm_test' | 'npm_run' | 'npm_install' | 'npm_init', args: Record<string, unknown>, logCommand?: CommandLogger) {
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
  return command('npm', { ...args, args: commandArgs }, logCommand);
}

async function runGradleTool(tool: 'gradle_assemble_debug' | 'gradle_install_debug', args: Record<string, unknown>, logCommand?: CommandLogger) {
  requireCommandExecution();
  const task = tool === 'gradle_assemble_debug' ? 'assembleDebug' : 'installDebug';
  const cwd = args.cwd ? stringArg(args, 'cwd') : WORKSPACE_ROOT;
  if (process.platform === 'win32') {
    return await exec('cmd.exe', ['/d', '/s', '/c', `gradle.bat ${task}`], cwd, COMMAND_TIMEOUT_MS, logCommand);
  }
  return await exec('gradle', [task], cwd, COMMAND_TIMEOUT_MS, logCommand);
}

async function runPython(args: Record<string, unknown>, logCommand?: CommandLogger) {
  if (args.async === true) return spawnPythonJob(args, logCommand);
  return command('python', args, logCommand);
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

async function getScreenInfo() {
  if (process.platform === 'win32') {
    const script = "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class DpiAwareness { [DllImport(\"shcore.dll\")] public static extern int SetProcessDpiAwareness(int awareness); }'; try { [void][DpiAwareness]::SetProcessDpiAwareness(2) } catch {}; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { $b=$_.Bounds; [PSCustomObject]@{ deviceName=$_.DeviceName; x=$b.X; y=$b.Y; width=$b.Width; height=$b.Height; primary=$_.Primary } } | ConvertTo-Json -Compress";
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command', script], { windowsHide: true, timeout: 15000, maxBuffer: MAX_OUTPUT_BYTES });
    const parsed = JSON.parse(stdout.trim() || '[]');
    const screens = (Array.isArray(parsed) ? parsed : [parsed]).map((s: any, index: number) => ({ index, deviceName: String(s.deviceName), x: Number(s.x), y: Number(s.y), width: Number(s.width), height: Number(s.height), primary: Boolean(s.primary) }));
    return { platform: process.platform, screens };
  }
  if (process.platform === 'linux') {
    const { stdout } = await execFileAsync('xrandr', ['--listmonitors'], { timeout: 10000, maxBuffer: MAX_OUTPUT_BYTES });
    const screens = stdout.split(/\r?\n/u).slice(1).filter(Boolean).map((line, index) => {
      const m = line.match(/(\d+)\/\d+x(\d+)\/\d+\+(-?\d+)\+(-?\d+)/u);
      if (!m) return null;
      return { index, deviceName: line.trim().split(/\s+/u).slice(1).join(' ').replace(/^\+?\*?/u, ''), x: Number(m[3]), y: Number(m[4]), width: Number(m[1]), height: Number(m[2]), primary: line.includes('*') };
    }).filter((s): s is NonNullable<typeof s> => s !== null);
    return { platform: process.platform, screens };
  }
  throw new Error('Screen capture is supported on Windows and Linux/X11 only.');
}

async function getScreenPixel(args: Record<string, unknown>) {
  const info = await getScreenInfo();
  const screenIndex = Number(args.screenIndex);
  const screen = info.screens.find(s => s.index === screenIndex);
  if (!screen) throw new Error(`No display found for screenIndex=${String(args.screenIndex)}`);
  const x = Number(args.x);
  const y = Number(args.y);
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= screen.width || y >= screen.height) {
    throw new Error(`Pixel coordinates must be integers within display ${screen.index} bounds: x=0..${screen.width - 1}, y=0..${screen.height - 1}`);
  }
  const absoluteX = screen.x + x;
  const absoluteY = screen.y + y;
  let rgb: { r: number; g: number; b: number };
  if (process.platform === 'win32') {
    const script = "Add-Type -AssemblyName System.Drawing; $bmp = New-Object System.Drawing.Bitmap(1,1); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(" + absoluteX + "," + absoluteY + ",0,0,[System.Drawing.Size]::new(1,1)); $c = $bmp.GetPixel(0,0); [PSCustomObject]@{r=$c.R;g=$c.G;b=$c.B} | ConvertTo-Json -Compress; $g.Dispose(); $bmp.Dispose()";
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command', script], { windowsHide: true, timeout: 15000, maxBuffer: MAX_OUTPUT_BYTES });
    const pixel = JSON.parse(stdout.trim());
    rgb = { r: Number(pixel.r), g: Number(pixel.g), b: Number(pixel.b) };
  } else if (process.platform === 'linux') {
    const minX = Math.min(...info.screens.map(s => s.x));
    const minY = Math.min(...info.screens.map(s => s.y));
    const { stdout } = await execFileAsync('import', ['-window','root','-crop',`1x1+${absoluteX - minX}+${absoluteY - minY}`,'+repage','txt:-'], { encoding: 'utf8', timeout: 15000, maxBuffer: MAX_OUTPUT_BYTES });
    const match = stdout.match(/#([0-9A-Fa-f]{6})/u);
    if (!match) throw new Error(`Unable to parse pixel color from ImageMagick: ${stdout.trim().slice(0, 200)}`);
    const hex = match[1];
    rgb = { r: parseInt(hex.slice(0,2),16), g: parseInt(hex.slice(2,4),16), b: parseInt(hex.slice(4,6),16) };
  } else {
    throw new Error('Screen pixel probing is supported on Windows and Linux/X11 only.');
  }
  const hex = '#' + [rgb.r, rgb.g, rgb.b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  return { screenIndex: screen.index, deviceName: screen.deviceName, x, y, absoluteX, absoluteY, ...rgb, hex, format: 'RGB 8-bit/channel', note: 'Coordinates x/y are relative to the selected display; absoluteX/absoluteY are virtual-desktop coordinates.' };
}

async function takeScreenshot(args: Record<string, unknown>) {
  const info = await getScreenInfo();
  const hasCrop = ['x', 'y', 'width', 'height'].some(key => args[key] !== undefined);
  if (hasCrop && (args.screenIndex === undefined || !['x', 'y', 'width', 'height'].every(key => args[key] !== undefined))) {
    throw new Error('A cropped screenshot requires screenIndex plus all four values: x, y, width, height (x/y are zero-based display-relative coordinates).');
  }
  const wanted = args.screenIndex === undefined ? info.screens : info.screens.filter(s => s.index === Number(args.screenIndex));
  if (!wanted.length) throw new Error(`No display found for screenIndex=${String(args.screenIndex)}`);
  if (hasCrop && wanted.length !== 1) throw new Error('A cropped screenshot must target exactly one display.');
  const screens = [];
  for (const screen of wanted) {
    const cropX = hasCrop ? Number(args.x) : 0;
    const cropY = hasCrop ? Number(args.y) : 0;
    const captureWidth = hasCrop ? Number(args.width) : screen.width;
    const captureHeight = hasCrop ? Number(args.height) : screen.height;
    if (![cropX, cropY, captureWidth, captureHeight].every(Number.isInteger) || cropX < 0 || cropY < 0 || captureWidth < 1 || captureHeight < 1 || cropX + captureWidth > screen.width || cropY + captureHeight > screen.height) {
      throw new Error(`Screenshot crop is outside display ${screen.index}; display size is ${screen.width}x${screen.height}.`);
    }
    const captureX = screen.x + cropX;
    const captureY = screen.y + cropY;
    let data: string;
    const mimeType = 'image/jpeg';
    if (process.platform === 'win32') {
      const scriptPath = path.resolve(process.cwd(), 'scripts', 'test-screenshot-jpeg.ps1');
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath,
        '-X', String(captureX), '-Y', String(captureY),
        '-CaptureWidth', String(captureWidth), '-CaptureHeight', String(captureHeight),
      ], { windowsHide: true, timeout: 30000, maxBuffer: Math.max(MAX_OUTPUT_BYTES, 100_000_000) });
      const match = stdout.match(/^SCREENSHOT_BASE64:([A-Za-z0-9+/]+={0,2})$/mu);
      if (!match) throw new Error('PowerShell screenshot script did not return a valid Base64 payload');
      data = match[1];
    } else if (process.platform === 'linux') {
      const minX = Math.min(...info.screens.map(s => s.x));
      const minY = Math.min(...info.screens.map(s => s.y));
      const { stdout } = await execFileAsync('import', ['-window', 'root', '-crop', `${captureWidth}x${captureHeight}+${captureX - minX}+${captureY - minY}`, '+repage', '-resize', '1000x1000>', '-quality', '82', 'jpeg:-'], { encoding: 'buffer', timeout: 30000, maxBuffer: Math.max(MAX_OUTPUT_BYTES, 20_000_000) }) as any;
      data = Buffer.from(stdout).toString('base64');
    } else throw new Error('Screen capture is supported on Windows and Linux/X11 only.');
    if (!data || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) throw new Error(`Screenshot capture returned invalid JPEG base64 for display ${screen.index}`);
    const imageBytes = Buffer.from(data, 'base64');
    if (imageBytes.length < 4 || imageBytes[0] !== 0xff || imageBytes[1] !== 0xd8 || imageBytes[imageBytes.length - 2] !== 0xff || imageBytes[imageBytes.length - 1] !== 0xd9) throw new Error(`Screenshot JPEG integrity check failed for display ${screen.index}; base64Chars=${data.length}, bytes=${imageBytes.length}`);
    const scale = Math.min(1, 1000 / captureWidth, 1000 / captureHeight);
    const outputWidth = Math.max(1, Math.round(captureWidth * scale));
    const outputHeight = Math.max(1, Math.round(captureHeight * scale));
    const dataSha256 = crypto.createHash('sha256').update(imageBytes).digest('hex');
    console.log(`[agent][screenshot] captured display=${screen.index} region=${cropX},${cropY},${captureWidth}x${captureHeight} output=${outputWidth}x${outputHeight} bytes=${imageBytes.length} sha256=${dataSha256}`);
    screens.push({ ...screen, x: captureX, y: captureY, width: outputWidth, height: outputHeight, captureX: cropX, captureY: cropY, captureWidth, captureHeight, mimeType, data, dataBytes: imageBytes.length, dataSha256 });
  }
  return { screens };
}

export async function runCodingTool(tool: string, args: Record<string, unknown>, logCommand?: CommandLogger): Promise<unknown> {
  switch (tool) {
    case 'get_screen_info': return getScreenInfo();
    case 'take_screenshot': return takeScreenshot(args);
    case 'get_screen_pixel': return getScreenPixel(args);
    case 'npm_test': return runNpmTool('npm_test', args, logCommand);
    case 'npm_run': return runNpmTool('npm_run', args, logCommand);
    case 'npm_install': return runNpmTool('npm_install', args, logCommand);
    case 'npm_init': return runNpmTool('npm_init', args, logCommand);
    case 'gradle_assemble_debug': return runGradleTool('gradle_assemble_debug', args, logCommand);
    case 'gradle_install_debug': return runGradleTool('gradle_install_debug', args, logCommand);
    case 'run_python': return runPython(args, logCommand);
    case 'python_job_inspect': return inspectPythonJob(args);
    case 'python_job_kill': return killPythonJob(args);
    case 'python_jobs': return listPythonJobs();
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
    case 'edit_file': return editFile(args);
    case 'find_files': return findFiles(args, logCommand);
    case 'get_proxy_info': return getProxyInfo();
    case 'cdp_version': return cdpVersion();
    case 'cdp_list_targets': return cdpListTargets();
    case 'cdp_call': return cdpCall(args);
    default: throw new Error(`Unsupported coding tool: ${tool}`);
  }
}
