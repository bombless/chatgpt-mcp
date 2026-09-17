import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_READ_FILE_BYTES = Number(process.env.MAX_READ_FILE_BYTES ?? 512_000);
const MAX_READ_FILE_LINES = Number(process.env.MAX_READ_FILE_LINES ?? 4_000);
const WORKSPACE_ROOT = path.resolve(process.env.AGENT_WORKSPACE ?? (process.platform === 'linux' ? '/tmp/mcp-agent-workspace' : 'D:\\mcp-agent-workspace'));

function assertWorkspace(target: string): string {
  const resolved = path.resolve(target);
  const root = process.platform === 'win32' ? WORKSPACE_ROOT.toLowerCase() : WORKSPACE_ROOT;
  const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  if (normalized !== root && !normalized.startsWith(root + path.sep)) throw new Error(`Path is outside agent workspace: ${resolved}`);
  return resolved;
}

function splitPhysicalLines(content: string) {
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = content.endsWith('\r\n') || content.endsWith('\n');
  let lines = content.split(/\r\n|\n/);
  if (trailingNewline) lines = lines.slice(0, -1);
  return { lines, newline, trailingNewline };
}

function numbered(lines: string[], startLine: number) { return lines.map((line, i) => `${startLine + i} | ${line}`).join('\n'); }
function invalidArgument(message: string) { return { success: false, error: { code: 'INVALID_ARGUMENT', message } }; }

async function atomicWrite(file: string, content: string) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.mcp-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await fs.writeFile(temporary, content, 'utf8');
    try { await fs.rename(temporary, file); }
    catch (error) { if (process.platform !== 'win32') throw error; await fs.rm(file, { force: true }); await fs.rename(temporary, file); }
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function readFile(args: Record<string, unknown>) {
  const pathArg = args.path;
  if (typeof pathArg !== 'string' || !pathArg) return invalidArgument('path must be a non-empty string');
  if (args.startLine !== undefined && (!Number.isInteger(args.startLine) || Number(args.startLine) < 1)) return invalidArgument('startLine must be a positive integer');
  if (args.endLine !== undefined && (!Number.isInteger(args.endLine) || Number(args.endLine) < 1)) return invalidArgument('endLine must be a positive integer');
  const startLine = args.startLine === undefined ? undefined : Number(args.startLine);
  const endLine = args.endLine === undefined ? undefined : Number(args.endLine);
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) return invalidArgument('endLine must be greater than or equal to startLine');

  let file: string;
  try { file = assertWorkspace(pathArg); } catch { return { success: false, error: { code: 'PATH_OUTSIDE_WORKSPACE', path: pathArg } }; }
  const content = await fs.readFile(file, 'utf8');
  const stat = await fs.stat(file);
  const parsed = splitPhysicalLines(content);
  const totalLines = parsed.lines.length;
  const requestedStart = startLine ?? 1;
  const requestedEnd = endLine ?? totalLines;
  if (startLine === undefined && (stat.size > MAX_READ_FILE_BYTES || totalLines > MAX_READ_FILE_LINES)) return { path: file, lineCount: totalLines, size: stat.size, message: `File has ${totalLines} lines and is ${stat.size} bytes. Full file output is too large. Please specify startLine and endLine.` };
  if (totalLines === 0) return { path: file, startLine: 1, endLine: 0, lineCount: 0, content: '', numberedContent: '' };
  if (requestedStart < 1 || requestedEnd > totalLines) return { success: false, error: { code: 'LINE_OUT_OF_RANGE', path: file, startLine: requestedStart, endLine: requestedEnd, lineCount: totalLines } };
  const selected = parsed.lines.slice(requestedStart - 1, requestedEnd);
  return { path: file, startLine: requestedStart, endLine: requestedEnd, lineCount: totalLines, content: selected.join(parsed.newline), numberedContent: numbered(selected, requestedStart) };
}

export async function replaceLines(args: Record<string, unknown>) {
  const pathArg = args.path;
  const startLine = args.startLine;
  const endLine = args.endLine;
  const oldText = args.oldText;
  const newText = args.newText;
  if (typeof pathArg !== 'string' || !pathArg) return invalidArgument('path must be a non-empty string');
  if (!Number.isInteger(startLine) || Number(startLine) < 1) return invalidArgument('startLine must be a positive integer');
  if (!Number.isInteger(endLine) || Number(endLine) < 1) return invalidArgument('endLine must be a positive integer');
  if (Number(endLine) < Number(startLine)) return invalidArgument('endLine must be greater than or equal to startLine');
  if (typeof oldText !== 'string') return invalidArgument('oldText must be a string');
  if (typeof newText !== 'string') return invalidArgument('newText must be a string');

  let file: string;
  try { file = assertWorkspace(pathArg); } catch { return { success: false, error: { code: 'PATH_OUTSIDE_WORKSPACE', path: pathArg } }; }
  const content = await fs.readFile(file, 'utf8');
  const parsed = splitPhysicalLines(content);
  const first = Number(startLine);
  const last = Number(endLine);
  if (last > parsed.lines.length) return { success: false, error: { code: 'LINE_OUT_OF_RANGE', path: file, startLine: first, endLine: last, lineCount: parsed.lines.length } };
  const actualText = parsed.lines.slice(first - 1, last).join(parsed.newline);
  if (actualText !== oldText) return { success: false, error: { code: 'CONTENT_MISMATCH', path: file, startLine: first, endLine: last, expected: oldText, actual: actualText } };
  const normalizedNewText = newText.replace(/\r\n|\n/g, parsed.newline);
  const replacementLines = normalizedNewText === '' ? [] : normalizedNewText.split(parsed.newline);
  const updatedLines = [...parsed.lines.slice(0, first - 1), ...replacementLines, ...parsed.lines.slice(last)];
  const updated = updatedLines.join(parsed.newline) + (parsed.trailingNewline && updatedLines.length > 0 ? parsed.newline : '');
  await atomicWrite(file, updated);
  return { success: true, path: file, startLine: first, endLine: last, linesReplaced: last - first + 1 };
}
