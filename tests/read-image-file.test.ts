import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCodingTool } from '../src/agent/coding-tools.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-mcp-image-workspace-'));
test.after(async () => fs.rm(workspace, { recursive: true, force: true }));

test('read_image_file returns PNG bytes and MIME type', async () => {
  const directory = path.join(workspace, '.image-file-tests');
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'fixture.bin');
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  try {
    await fs.writeFile(file, bytes);
    const result = await runCodingTool('read_image_file', { path: file }, workspace) as any;
    assert.equal(result.mimeType, 'image/png');
    assert.equal(result.path, file);
    assert.equal(Buffer.from(result.data, 'base64').compare(bytes), 0);
    assert.equal(result.dataBytes, bytes.length);
    assert.equal(result.dataSha256.length, 64);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('read_image_file identifies JPEG bytes by signature', async () => {
  const directory = path.join(workspace, '.image-file-tests');
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'fixture.dat');
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  try {
    await fs.writeFile(file, bytes);
    const result = await runCodingTool('read_image_file', { path: file }, workspace) as any;
    assert.equal(result.mimeType, 'image/jpeg');
    assert.equal(Buffer.from(result.data, 'base64').compare(bytes), 0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('read_image_file rejects non-absolute paths and unsupported formats', async () => {
  await assert.rejects(() => runCodingTool('read_image_file', { path: 'relative.png' }, workspace), /absolute file path/);
  const directory = path.join(workspace, '.image-file-tests');
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'not-an-image.bin');
  try {
    await fs.writeFile(file, Buffer.from('not an image'));
    await assert.rejects(() => runCodingTool('read_image_file', { path: file }, workspace), /only JPEG and PNG/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('read_image_file rejects paths outside AGENT_WORKSPACE', async () => {
  const outside = path.join(os.tmpdir(), 'mcp-outside-image.png');
  await fs.writeFile(outside, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  try {
    await assert.rejects(() => runCodingTool('read_image_file', { path: outside }, workspace), /outside agent workspace/);
  } finally {
    await fs.rm(outside, { force: true });
  }
});
