import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-mcp-file-tools-'));
process.env.AGENT_WORKSPACE = root;
process.env.MAX_READ_FILE_BYTES = '64';
process.env.MAX_READ_FILE_LINES = '3';

const { readFile, replaceLines } = await import('../src/agent/file-tools.js');

try {
  const file = path.join(root, 'sample.txt');
  await fs.writeFile(file, 'one\r\ntwo\r\nthree\r\nfour\r\n', 'utf8');

  const whole = await readFile({ path: file }) as any;
  assert.equal(whole.path, file);
  assert.equal(whole.startLine, 1);
  assert.equal(whole.endLine, 4);
  assert.equal(whole.lineCount, 4);
  assert.match(whole.numberedContent, /^1 \| one\n2 \| two\n3 \| three\n4 \| four$/);

  const range = await readFile({ path: file, startLine: 2, endLine: 3 }) as any;
  assert.equal(range.content, 'two\r\nthree');
  assert.equal(range.numberedContent, '2 | two\n3 | three');

  const beforeMismatch = await fs.readFile(file, 'utf8');
  const mismatch = await replaceLines({ path: file, startLine: 2, endLine: 3, oldText: 'two\nthree', newText: 'x\ny' }) as any;
  assert.equal(mismatch.success, false);
  assert.equal(mismatch.error.code, 'CONTENT_MISMATCH');
  assert.equal(await fs.readFile(file, 'utf8'), beforeMismatch);

  const replaced = await replaceLines({ path: file, startLine: 2, endLine: 3, oldText: 'two\r\nthree', newText: 'TWO\nTHREE' }) as any;
  assert.deepEqual(replaced, { success: true, path: file, startLine: 2, endLine: 3, linesReplaced: 2 });
  assert.equal(await fs.readFile(file, 'utf8'), 'one\r\nTWO\r\nTHREE\r\nfour\r\n');

  const deleted = await replaceLines({ path: file, startLine: 2, endLine: 3, oldText: 'TWO\r\nTHREE', newText: '' }) as any;
  assert.equal(deleted.success, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'one\r\nfour\r\n');

  const inserted = await replaceLines({ path: file, startLine: 2, endLine: 2, oldText: 'four', newText: 'inserted\nfour' }) as any;
  assert.equal(inserted.success, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'one\r\ninserted\r\nfour\r\n');

  const outOfRange = await replaceLines({ path: file, startLine: 10, endLine: 10, oldText: 'x', newText: 'y' }) as any;
  assert.equal(outOfRange.success, false);
  assert.equal(outOfRange.error.code, 'LINE_OUT_OF_RANGE');

  const invalid = await replaceLines({ path: file, startLine: 2, endLine: 1, oldText: '', newText: '' }) as any;
  assert.equal(invalid.success, false);
  assert.equal(invalid.error.code, 'INVALID_ARGUMENT');

  const outside = await replaceLines({ path: path.join(root, '..', 'outside.txt'), startLine: 1, endLine: 1, oldText: 'x', newText: 'y' }) as any;
  assert.equal(outside.success, false);
  assert.equal(outside.error.code, 'PATH_OUTSIDE_WORKSPACE');

  const large = path.join(root, 'large.txt');
  await fs.writeFile(large, 'a\nb\nc\nd\n', 'utf8');
  const largeResult = await readFile({ path: large }) as any;
  assert.equal(largeResult.message !== undefined, true);
  assert.equal(largeResult.lineCount, 4);
  const largeRange = await readFile({ path: large, startLine: 3, endLine: 4 }) as any;
  assert.equal(largeRange.numberedContent, '3 | c\n4 | d');

  const empty = path.join(root, 'empty.txt');
  await fs.writeFile(empty, '', 'utf8');
  const emptyResult = await readFile({ path: empty }) as any;
  assert.equal(emptyResult.lineCount, 0);
  assert.equal(emptyResult.numberedContent, '');

  console.log('PASS: read_file + replace_lines');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
