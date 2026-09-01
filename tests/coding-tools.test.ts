import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-mcp-coding-'));
process.env.AGENT_WORKSPACE = root;
process.env.ALLOW_COMMAND_EXECUTION = 'true';

const { runCodingTool } = await import('../src/agent/coding-tools.js');

const call = (tool: string, args: Record<string, unknown> = {}) => runCodingTool(tool, args);
const file = path.join(root, 'sample.txt');
const copy = path.join(root, 'sample-copy.txt');
const nested = path.join(root, 'nested');
const patchFile = path.join(root, 'patch.txt');

try {
  await fs.writeFile(file, ['one', 'two', 'three', 'needle here', 'five'].join('\n'), 'utf8');
  await fs.writeFile(path.join(root, 'app.ts'), 'export const answer = 41;\n', 'utf8');

  const found = await call('find_files', { pattern: '*.ts' }) as any;
  assert.ok(found.files.some((x: string) => x.endsWith('app.ts')));

  const search = await call('rg', { query: 'needle' }) as any;
  assert.match(search.stdout, /needle here/);

  const range = await call('read_file_range', { path: file, startLine: 2, endLine: 4 }) as string;
  assert.match(range, /2: two/);
  assert.match(range, /4: needle here/);

  const tail = await call('tail_file', { path: file, lines: 2 }) as string;
  assert.equal(tail, 'needle here\nfive');

  const info = await call('get_file_info', { path: file }) as any;
  assert.equal(info.type, 'file');
  assert.ok(info.size > 0);

  await call('create_directory', { path: nested });
  assert.equal((await fs.stat(nested)).isDirectory(), true);

  await call('copy_file', { source: file, destination: copy });
  assert.equal(await fs.readFile(copy, 'utf8'), await fs.readFile(file, 'utf8'));

  const node = await call('run_node', { args: ['-e', 'console.log(6 * 7)'] }) as any;
  assert.match(node.stdout, /42/);

  const python = await call('run_python', { args: ['-c', 'print(6 * 7)'] }) as any;
  assert.match(python.stdout, /42/);

  const asyncJob = await call('run_python', {
    args: ['-c', 'import time; print("started", flush=True); time.sleep(2); print("done", flush=True)'],
    async: true,
  }) as any;
  assert.ok(asyncJob.jobId);
  assert.equal(asyncJob.status, 'running');
  assert.ok(asyncJob.pid > 0);

  const inspectedWhileRunning = await call('python_job_inspect', { jobId: asyncJob.jobId }) as any;
  assert.equal(inspectedWhileRunning.jobId, asyncJob.jobId);
  assert.equal(inspectedWhileRunning.status, 'running');

  const listed = await call('python_jobs') as any[];
  assert.ok(listed.some(job => job.jobId === asyncJob.jobId));

  await new Promise(resolve => setTimeout(resolve, 2600));
  const inspectedAfterExit = await call('python_job_inspect', { jobId: asyncJob.jobId }) as any;
  assert.equal(inspectedAfterExit.status, 'exited');
  assert.equal(inspectedAfterExit.exitCode, 0);
  assert.match(inspectedAfterExit.stdout, /started/);
  assert.match(inspectedAfterExit.stdout, /done/);

  const killJob = await call('run_python', {
    args: ['-c', 'import time; time.sleep(60)'],
    async: true,
  }) as any;
  assert.equal(killJob.status, 'running');
  const killed = await call('python_job_kill', { jobId: killJob.jobId }) as any;
  assert.equal(killed.jobId, killJob.jobId);
  await new Promise(resolve => setTimeout(resolve, 300));
  const inspectedKilled = await call('python_job_inspect', { jobId: killJob.jobId }) as any;
  assert.equal(inspectedKilled.status, 'killed');

  await assert.rejects(() => call('python_job_inspect', { jobId: 'missing-job' }), /was not found/);

  const npm = await call('run_npm', { args: ['--version'] }) as any;
  assert.equal(npm.code, 0);
  assert.match(npm.stdout, /\d+\.\d+/);

  const gitInit = await call('git', { args: ['init'] }) as any;
  assert.equal(gitInit.code, 0);
  await call('git', { args: ['config', 'user.email', 'test@example.invalid'] });
  await call('git', { args: ['config', 'user.name', 'Coding Tool Test'] });
  await call('git', { args: ['add', '.'] });
  const status = await call('git', { args: ['status', '--short'] }) as any;
  assert.equal(status.code, 0);

  const patch = [
    'diff --git a/app.ts b/app.ts',
    '--- a/app.ts',
    '+++ b/app.ts',
    '@@ -1 +1 @@',
    '-export const answer = 41;',
    '+export const answer = 42;',
    '',
  ].join('\n');
  await call('apply_patch', { patch });
  assert.equal(await fs.readFile(path.join(root, 'app.ts'), 'utf8'), 'export const answer = 42;\n');

  const processes = await call('process_list') as any;
  assert.equal(processes.code, 0);
  assert.ok(processes.stdout.length > 0);

  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: root, windowsHide: true });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.ok(child.pid);
  await call('kill_process', { pid: child.pid });
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.notEqual(child.exitCode, null);

  await assert.rejects(() => call('read_file_range', { path: path.join(root, '..', 'outside.txt'), startLine: 1, endLine: 1 }), /outside agent workspace/);
  await assert.rejects(() => call('kill_process', { pid: process.pid }), /Refusing to terminate/);

  console.log('PASS: all coding tools');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
