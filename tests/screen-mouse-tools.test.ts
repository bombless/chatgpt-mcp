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

test('move_mouse moves cursor to specified coordinates', async () => {
  const result = await runCodingTool('move_mouse', {
    screenIndex: 0,
    x: 120,
    y: 140,
  }) as any;

  assert.ok(result);
  assert.equal(result.ok, true);
  assert.equal(result.screenIndex, 0);
  assert.equal(result.relativeX, 120);
  assert.equal(result.relativeY, 140);
  assert.equal(typeof result.x, 'number');
  assert.equal(typeof result.y, 'number');
});

test('move_mouse validates coordinate parameters', async () => {
  // Missing y
  await assert.rejects(
    () => runCodingTool('move_mouse', { x: 100 }),
    /Both x and y must be provided to move the mouse cursor/
  );

  // Missing both x and y
  await assert.rejects(
    () => runCodingTool('move_mouse', {}),
    /Both x and y must be provided to move the mouse cursor/
  );

  // Out of bounds screenIndex
  await assert.rejects(
    () => runCodingTool('move_mouse', { screenIndex: 999, x: 10, y: 10 }),
    /No display found for screenIndex=999/
  );

  // Negative coordinates with screenIndex
  await assert.rejects(
    () => runCodingTool('move_mouse', { screenIndex: 0, x: -5, y: 10 }),
    /must be within display 0 bounds/
  );
});

test('scroll_mouse scrolls without moving when x and y are omitted', async () => {
  const result = await runCodingTool('scroll_mouse', {
    direction: 'down',
    amount: 2,
  }) as any;

  assert.ok(result);
  assert.equal(result.ok, true);
  assert.equal(result.direction, 'down');
  assert.equal(result.amount, 2);
  assert.equal(typeof result.x, 'number');
  assert.equal(typeof result.y, 'number');
});

test('scroll_mouse moves and scrolls when coordinates are provided', async () => {
  const result = await runCodingTool('scroll_mouse', {
    screenIndex: 0,
    x: 160,
    y: 180,
    direction: 'up',
    amount: 1,
  }) as any;

  assert.ok(result);
  assert.equal(result.ok, true);
  assert.equal(result.direction, 'up');
  assert.equal(result.amount, 1);
  assert.equal(result.screenIndex, 0);
  assert.equal(result.relativeX, 160);
  assert.equal(result.relativeY, 180);
});

test('scroll_mouse handles deltaY and deltaX', async () => {
  const resultY = await runCodingTool('scroll_mouse', {
    deltaY: -3,
  }) as any;
  assert.ok(resultY);
  assert.equal(resultY.direction, 'up');
  assert.equal(resultY.amount, 3);

  const resultX = await runCodingTool('scroll_mouse', {
    deltaX: 4,
  }) as any;
  assert.ok(resultX);
  assert.equal(resultX.direction, 'right');
  assert.equal(resultX.amount, 4);
});

test('scroll_mouse validates coordinate parameters', async () => {
  // Only x provided, y missing
  await assert.rejects(
    () => runCodingTool('scroll_mouse', { x: 100 }),
    /Both x and y must be provided, or both omitted/
  );

  // Out of bounds screenIndex
  await assert.rejects(
    () => runCodingTool('scroll_mouse', { screenIndex: 999 }),
    /No display found for screenIndex=999/
  );
});
