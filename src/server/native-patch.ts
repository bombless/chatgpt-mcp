import path from 'node:path';

type PatchFile = {
  path: string;
  oldText?: string;
  newText?: string;
  kind: 'update' | 'add' | 'delete';
};

function normalizePatchPath(value: string): string {
  const raw = value.trim().replace(/^a\//, '').replace(/^b\//, '');
  if (!raw || raw === '/dev/null') throw new Error(`Invalid patch path: ${value}`);
  const normalized = path.posix.normalize(raw.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`Patch path escapes workspace: ${value}`);
  }
  return normalized;
}

function parseHeaderPath(line: string, prefix: '---' | '+++'): string {
  const value = line.slice(prefix.length).trim();
  const first = value.split(/\s+/, 1)[0] ?? '';
  return first;
}

function parseUnifiedPatch(patch: string): PatchFile[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const files: PatchFile[] = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i] === '*** Begin Patch') {
      i += 1;
      while (i < lines.length && lines[i] !== '*** End Patch') {
        const marker = lines[i];
        if (!marker.startsWith('*** ')) throw new Error(`Unsupported patch line: ${marker}`);
        const match = /^(?:\*\*\* )?(Update|Add|Delete) File: (.+)$/.exec(marker);
        if (!match) throw new Error(`Unsupported patch directive: ${marker}`);
        const kind = match[1].toLowerCase() as PatchFile['kind'];
        const patchPath = normalizePatchPath(match[2]);
        i += 1;
        const body: string[] = [];
        while (i < lines.length && !lines[i].startsWith('*** ')) {
          body.push(lines[i]);
          i += 1;
        }
        if (kind === 'add') {
          const content = body.filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n');
          files.push({ path: patchPath, kind, newText: content.endsWith('\n') ? content : `${content}\n` });
        } else if (kind === 'delete') {
          files.push({ path: patchPath, kind, oldText: body.filter(line => line.startsWith('-')).map(line => line.slice(1)).join('\n') });
        } else {
          files.push({ path: patchPath, kind, oldText: body.filter(line => line.startsWith('-')).map(line => line.slice(1)).join('\n'), newText: body.filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n') });
        }
      }
      if (lines[i] !== '*** End Patch') throw new Error('Patch is missing *** End Patch');
      i += 1;
      continue;
    }

    if (lines[i].startsWith('--- ')) {
      const oldPath = parseHeaderPath(lines[i], '---');
      if (i + 1 >= lines.length || !lines[i + 1].startsWith('+++ ')) throw new Error('Unified patch is missing +++ header');
      const newPath = parseHeaderPath(lines[i + 1], '+++');
      const oldFile = oldPath === '/dev/null' ? undefined : normalizePatchPath(oldPath);
      const newFile = newPath === '/dev/null' ? undefined : normalizePatchPath(newPath);
      if (!oldFile && !newFile) throw new Error('Patch cannot target /dev/null on both sides');
      i += 2;
      const oldLines: string[] = [];
      const newLines: string[] = [];
      while (i < lines.length && !lines[i].startsWith('--- ')) {
        const line = lines[i];
        if (line.startsWith('@@')) { i += 1; continue; }
        if (line === '\\ No newline at end of file') { i += 1; continue; }
        if (line.startsWith(' ')) { oldLines.push(line.slice(1)); newLines.push(line.slice(1)); }
        else if (line.startsWith('-')) oldLines.push(line.slice(1));
        else if (line.startsWith('+')) newLines.push(line.slice(1));
        else if (line === '') { oldLines.push(''); newLines.push(''); }
        else break;
        i += 1;
      }
      if (!oldFile) files.push({ path: newFile!, kind: 'add', newText: newLines.join('\n') });
      else if (!newFile) files.push({ path: oldFile, kind: 'delete', oldText: oldLines.join('\n') });
      else files.push({ path: newFile, kind: 'update', oldText: oldLines.join('\n'), newText: newLines.join('\n') });
      continue;
    }
    if (!lines[i].trim()) { i += 1; continue; }
    throw new Error(`Unsupported patch format near: ${lines[i]}`);
  }

  if (!files.length) throw new Error('Patch did not contain any file changes');
  return files;
}

export type NativePatchExecutor = {
  editFile: (path: string, oldText: string, newText: string) => Promise<unknown>;
  writeFile: (path: string, content: string) => Promise<unknown>;
  deleteFile: (path: string) => Promise<unknown>;
};

export async function applyNativePatch(patch: string, executor: NativePatchExecutor) {
  const files = parseUnifiedPatch(patch);
  const results: unknown[] = [];
  for (const file of files) {
    if (file.kind === 'add') results.push(await executor.writeFile(file.path, file.newText ?? ''));
    else if (file.kind === 'delete') results.push(await executor.deleteFile(file.path));
    else results.push(await executor.editFile(file.path, file.oldText ?? '', file.newText ?? ''));
  }
  return { ok: true, files: files.map(file => ({ path: file.path, kind: file.kind })), results };
}
