import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertAllowed, stringArg, writeFileAtomic, sha256, exec, MAX_SEARCH_RESULTS, COMMAND_TIMEOUT_MS, type CommandLogger } from './shared.js';
export async function readImageFile(args: Record<string, unknown>, workspaceRoot: string) {
  const requestedPath = stringArg(args, 'path');
  if (!path.isAbsolute(requestedPath)) throw new Error('path must be an absolute file path');
  const file = assertAllowed(await fs.realpath(requestedPath), workspaceRoot);
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`Path is not a regular file: ${file}`);
  const maxBytes = 20 * 1024 * 1024;
  if (stat.size > maxBytes) throw new Error(`Image exceeds the 20 MiB size limit: ${stat.size} bytes`);
  const bytes = await fs.readFile(file);
  let mimeType: 'image/jpeg' | 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    mimeType = 'image/jpeg';
  } else if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    mimeType = 'image/png';
  } else {
    throw new Error('Unsupported image format: only JPEG and PNG files are supported');
  }
  return {
    path: file,
    mimeType,
    data: bytes.toString('base64'),
    dataBytes: bytes.length,
    dataSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

export async function editFile(args: Record<string, unknown>, workspaceRoot: string) {
  const file = assertAllowed(stringArg(args, 'path'), workspaceRoot);
  const oldText = stringArg(args, 'oldText');
  const newText = typeof args.newText === 'string' ? args.newText : undefined;
  if (newText === undefined) throw new Error('newText must be a string');
  if (oldText === newText) throw new Error('oldText and newText must be different');

  const expectedSha256 = stringArg(args, 'expectedSha256').toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new Error('expectedSha256 must be a 64-character SHA-256 hex string');
  const originalBytes = await fs.readFile(file);
  const content = originalBytes.toString('utf8');
  const beforeSha256 = sha256(originalBytes);
  if (beforeSha256 !== expectedSha256) {
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
  await writeFileAtomic(file, updated, beforeSha256);
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
export async function rg(args: Record<string, unknown>, workspaceRoot: string, logCommand?: CommandLogger) {
  const query = stringArg(args, 'query');
  const cwd = args.cwd ? assertAllowed(stringArg(args, 'cwd'), workspaceRoot) : workspaceRoot;
  const limit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Number(args.maxResults ?? MAX_SEARCH_RESULTS)));
  const rgArgs = ['--line-number', '--column', '--color', 'never', '--no-heading', '--hidden', '--glob', '!.git/**', '--max-count', String(limit)];
  if (args.ignoreCase === true) rgArgs.push('--ignore-case');
  if (typeof args.glob === 'string' && args.glob) rgArgs.push('--glob', args.glob);
  rgArgs.push(query, '.');
  try { return { ...(await exec('rg', rgArgs, workspaceRoot, cwd, COMMAND_TIMEOUT_MS, logCommand)), matches: true, truncated: false }; }
  catch (error: any) {
    const code = typeof error.code === 'number' ? error.code : 1;
    if (code === 1) return { stdout: '', stderr: '', code: 1, matches: false, truncated: false };
    throw new Error(String(error.stderr ?? error.message ?? error));
  }
}

export async function findFiles(args: Record<string, unknown>, workspaceRoot: string, logCommand?: CommandLogger) {
  const root = args.cwd ? assertAllowed(stringArg(args, 'cwd'), workspaceRoot) : workspaceRoot;
  const pattern = typeof args.pattern === 'string' && args.pattern ? args.pattern : '**/*';
  const maxResults = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Number(args.maxResults ?? MAX_SEARCH_RESULTS)));
  const result = await exec('rg', ['--files', '--hidden', '--glob', '!.git/**', '--glob', pattern], workspaceRoot, root, COMMAND_TIMEOUT_MS, logCommand);
  const files = result.stdout.split(/\r?\n/).filter(Boolean).slice(0, maxResults);
  return { files, truncated: files.length >= maxResults, count: files.length };
}

export async function readFileRange(args: Record<string, unknown>, workspaceRoot: string) {
  const file = assertAllowed(stringArg(args, 'path'), workspaceRoot);
  const start = Math.max(1, Number(args.startLine ?? 1));
  const end = Math.max(start, Number(args.endLine ?? start + 199));
  const bytes = await fs.readFile(file);
  const content = bytes.toString('utf8');
  const lines = content.split(/\r?\n/).slice(start - 1, end);
  return { path: file, content: lines.map((line, i) => `${start + i}: ${line}`).join('\n'), sha256: sha256(bytes), bytes: bytes.length };
}

export async function tailFile(args: Record<string, unknown>, workspaceRoot: string) {
  const file = assertAllowed(stringArg(args, 'path'), workspaceRoot);
  const lines = Math.max(1, Number(args.lines ?? 100));
  const bytes = await fs.readFile(file);
  const content = bytes.toString('utf8');
  return { path: file, content: content.split(/\r?\n/).slice(-lines).join('\n'), sha256: sha256(bytes), bytes: bytes.length };
}

export async function fileInfo(args: Record<string, unknown>, workspaceRoot: string) {
  const file = assertAllowed(stringArg(args, 'path'), workspaceRoot);
  const stat = await fs.stat(file);
  return { path: file, type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', size: stat.size, mtime: stat.mtime.toISOString(), mode: stat.mode };
}

export async function createDirectory(args: Record<string, unknown>, workspaceRoot: string) {
  const directory = assertAllowed(stringArg(args, 'path'), workspaceRoot);
  await fs.mkdir(directory, { recursive: true });
  return { ok: true, path: directory };
}

export async function copyFile(args: Record<string, unknown>, workspaceRoot: string) {
  const source = assertAllowed(stringArg(args, 'source'), workspaceRoot);
  const destination = assertAllowed(stringArg(args, 'destination'), workspaceRoot);
  const expectedSourceSha256 = stringArg(args, 'expectedSourceSha256').toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(expectedSourceSha256)) throw new Error('expectedSourceSha256 must be a 64-character SHA-256 hex string');
  const sourceBytes = await fs.readFile(source);
  const sourceSha256 = sha256(sourceBytes);
  if (sourceSha256 !== expectedSourceSha256) throw new Error(`Source file changed since it was read: expected sha256 ${expectedSourceSha256}, current sha256 ${sourceSha256}`);
  const expectedDestinationSha256 = typeof args.expectedDestinationSha256 === 'string' ? args.expectedDestinationSha256.toLowerCase() : undefined;
  let destinationBytes: Buffer | undefined;
  try { destinationBytes = await fs.readFile(destination); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  if (destinationBytes && !expectedDestinationSha256) throw new Error('expectedDestinationSha256 is required when overwriting an existing destination file');
  if (!destinationBytes && expectedDestinationSha256) throw new Error('Destination changed since it was read: destination no longer exists');
  const beforeDestinationSha256 = destinationBytes ? sha256(destinationBytes) : null;
  if (expectedDestinationSha256 && beforeDestinationSha256 !== expectedDestinationSha256) throw new Error(`Destination file changed: expected sha256 ${expectedDestinationSha256}, current sha256 ${beforeDestinationSha256}`);
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.mcp-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await fs.writeFile(temporary, sourceBytes);
    if (sha256(await fs.readFile(source)) !== expectedSourceSha256) throw new Error('Source file changed while the copy was being prepared');
    let latestDestination: Buffer | undefined;
    try { latestDestination = await fs.readFile(destination); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    const latestHash = latestDestination ? sha256(latestDestination) : null;
    if (latestHash !== beforeDestinationSha256) throw new Error('Destination file changed while the copy was being prepared');
    await fs.rename(temporary, destination);
  } finally { await fs.rm(temporary, { force: true }); }
  return { ok: true, source, destination, sha256Source: sourceSha256, sha256Before: beforeDestinationSha256, sha256After: sourceSha256 };
}

