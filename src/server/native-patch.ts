import path from 'node:path';

type PatchOperation =
  | { kind: 'add'; path: string; content: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; hunks: Array<{ oldText: string; newText: string }> };

function normalizePatchPath(value: string): string {
  const raw = value.trim().replace(/^a\//, '').replace(/^b\//, '');
  if (!raw || raw === '/dev/null') throw new Error(`Invalid patch path: ${value}`);
  if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) throw new Error(`Patch path must be relative: ${value}`);
  const normalized = path.posix.normalize(raw.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) throw new Error(`Patch path escapes workspace: ${value}`);
  return normalized;
}

function parsePatch(patch: string): PatchOperation[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const operations: PatchOperation[] = [];
  let i = 0;
  if (lines[i] !== '*** Begin Patch') throw new Error('apply_patch expects a patch starting with *** Begin Patch');
  i += 1;

  while (i < lines.length && lines[i] !== '*** End Patch') {
    const header = lines[i];
    const match = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(header);
    if (!match) throw new Error(`Unsupported patch directive: ${header}`);
    const kind = match[1];
    const patchPath = normalizePatchPath(match[2]);
    i += 1;

    if (kind === 'Add') {
      const added: string[] = [];
      while (i < lines.length && !lines[i].startsWith('*** ')) {
        if (!lines[i].startsWith('+')) throw new Error(`Added file ${patchPath} contains a non-addition line`);
        added.push(lines[i].slice(1));
        i += 1;
      }
      operations.push({ kind: 'add', path: patchPath, content: added.join('\n') });
      continue;
    }

    if (kind === 'Delete') {
      while (i < lines.length && !lines[i].startsWith('*** ')) i += 1;
      operations.push({ kind: 'delete', path: patchPath });
      continue;
    }

    const hunks: Array<{ oldText: string; newText: string }> = [];
    while (i < lines.length && !lines[i].startsWith('*** ')) {
      if (!lines[i].startsWith('@@')) throw new Error(`Update for ${patchPath} is missing a @@ hunk header`);
      i += 1;
      const oldLines: string[] = [];
      const newLines: string[] = [];
      while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('*** ')) {
        const line = lines[i];
        if (line === '\\ No newline at end of file') { i += 1; continue; }
        if (line.startsWith(' ')) { oldLines.push(line.slice(1)); newLines.push(line.slice(1)); }
        else if (line.startsWith('-')) oldLines.push(line.slice(1));
        else if (line.startsWith('+')) newLines.push(line.slice(1));
        else throw new Error(`Unsupported hunk line in ${patchPath}: ${line}`);
        i += 1;
      }
      const oldText = oldLines.join('\n');
      const newText = newLines.join('\n');
      if (!oldText) throw new Error(`Update hunk for ${patchPath} has no context or removed text`);
      if (oldText === newText) throw new Error(`Update hunk for ${patchPath} makes no change`);
      hunks.push({ oldText, newText });
    }
    if (!hunks.length) throw new Error(`Update for ${patchPath} contains no hunks`);
    operations.push({ kind: 'update', path: patchPath, hunks });
  }

  if (lines[i] !== '*** End Patch') throw new Error('Patch is missing *** End Patch');
  if (!operations.length) throw new Error('Patch did not contain any file changes');
  return operations;
}

export type NativePatchExecutor = {
  editFile: (path: string, oldText: string, newText: string, expectedSha256: string) => Promise<unknown>;
  writeFile: (path: string, content: string, expectedSha256: string) => Promise<unknown>;
  deleteFile: (path: string, expectedSha256: string) => Promise<unknown>;
};

export async function applyNativePatch(patch: string, executor: NativePatchExecutor, expectedSha256ByPath: Record<string, string>) {
  const operations = parsePatch(patch);
  const results: unknown[] = [];
  for (const operation of operations) {
    const expected = expectedSha256ByPath[operation.path];
    if (!expected) throw new Error(`Missing expectedSha256ByPath entry for ${operation.path}`);
    if (operation.kind === 'add') {
      if (expected !== '__missing__') throw new Error(`Add File ${operation.path} requires expected hash __missing__`);
      results.push(await executor.writeFile(operation.path, operation.content, expected));
    } else if (operation.kind === 'delete') {
      if (!/^[a-fA-F0-9]{64}$/u.test(expected)) throw new Error(`Delete File ${operation.path} requires its current SHA-256`);
      results.push(await executor.deleteFile(operation.path, expected));
    } else {
      if (!/^[a-fA-F0-9]{64}$/u.test(expected)) throw new Error(`Update File ${operation.path} requires its current SHA-256`);
      let currentHash = expected;
      for (const hunk of operation.hunks) {
        const result = await executor.editFile(operation.path, hunk.oldText, hunk.newText, currentHash) as { sha256After?: string };
        if (!result || typeof result.sha256After !== 'string') throw new Error(`Update File ${operation.path} did not return a new SHA-256`);
        currentHash = result.sha256After;
        results.push(result);
      }
    }
  }
  return { ok: true, files: operations.map(operation => ({ path: operation.path, kind: operation.kind })), results };
}
