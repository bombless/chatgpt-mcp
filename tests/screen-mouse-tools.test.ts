import assert from 'node:assert/strict';
import test from 'node:test';
import { runCodingTool } from '../src/agent/coding-tools.js';

test('take_screenshot returns cursor coordinates and supports highlightCursor', async () => {
  const result = await runCodingTool('take_screenshot', {
    screenIndex: 0,
    highlightCursor: true,
  }) as any;

  assert.ok(result);
  assert.ok(Array.isArray(result.screens));
  assert.ok(result.screens.length >= 1);

  const screen = result.screens[0];
  assert.equal(screen.index, 0);
  assert.equal(screen.mimeType, 'image/jpeg');
  assert.ok(screen.data && screen.data.length > 0);
  assert.ok(screen.dataBytes > 0);
  assert.ok(screen.dataSha256 && screen.dataSha256.length === 64);

  // Check cursor coordinates in screenshot response
  assert.ok(result.cursor !== undefined);
  if (result.cursor) {
    assert.equal(typeof result.cursor.x, 'number');
    assert.equal(typeof result.cursor.y, 'number');
  }
});

test('click_mouse clicks without moving when x and y are omitted', async () => {
  const result = await runCodingTool('click_mouse', {
    button: 'left',
  }) as any;

  assert.ok(result);
  assert.equal(result.ok, true);
  assert.equal(result.button, 'left');
  assert.equal(result.clickCount, 1);
  assert.equal(typeof result.x, 'number');
  assert.equal(typeof result.y, 'number');
});

test('click_mouse validates coordinate parameters', async () => {
  // Only x provided, y missing
  await assert.rejects(
    () => runCodingTool('click_mouse', { x: 100 }),
    /Both x and y must be provided, or both omitted/
  );

  // Out of bounds screenIndex
  await assert.rejects(
    () => runCodingTool('click_mouse', { screenIndex: 999 }),
    /No display found for screenIndex=999/
  );
});
