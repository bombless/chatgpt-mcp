import fs from 'node:fs/promises';
import path from 'node:path';
import { stringArg, exec, requireCommandExecution, COMMAND_TIMEOUT_MS, type CommandLogger } from './shared.js';
export async function git(args: Record<string, unknown>, workspaceRoot: string, logCommand?: CommandLogger) {
  requireCommandExecution();
  const cwd = args.cwd ? stringArg(args, 'cwd') : workspaceRoot;
  const gitArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  if (!gitArgs.length) throw new Error('args must contain a git subcommand');
  return await exec(process.platform === 'win32' ? 'git.exe' : 'git', gitArgs, workspaceRoot, cwd, COMMAND_TIMEOUT_MS, logCommand);
}

export async function applyPatch(args: Record<string, unknown>, workspaceRoot: string, logCommand?: CommandLogger) {
  requireCommandExecution();
  const patch = stringArg(args, 'patch');
  const cwd = args.cwd ? stringArg(args, 'cwd') : workspaceRoot;
  const temp = path.join(workspaceRoot, `.mcp-patch-${Date.now()}-${Math.random().toString(16).slice(2)}.patch`);
  try {
    await fs.writeFile(temp, patch, 'utf8');
    return await exec(process.platform === 'win32' ? 'git.exe' : 'git', ['apply', '--whitespace=nowarn', temp], workspaceRoot, cwd, COMMAND_TIMEOUT_MS, logCommand);
  } finally { await fs.rm(temp, { force: true }); }
}
