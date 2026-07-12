/**
 * browserAgentActions.test.cjs — unit tests for the pure action-mapping
 * logic behind the on-demand browser-agent API (PRD 535).
 *
 * Run: timeout 120 node --test src/main/lib/__tests__/browserAgentActions.test.cjs
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseKeyCombo,
  computeScrollDelta,
  computeScreenshotScale,
  AGENT_SCREENSHOT_MAX_DIM,
} = require('../browserAgentActions.cjs');

test('parseKeyCombo: plain special key', () => {
  assert.deepEqual(parseKeyCombo('Return'), { keyCode: 'Enter', modifiers: [] });
});

test('parseKeyCombo: single modifier + letter', () => {
  assert.deepEqual(parseKeyCombo('ctrl+s'), { keyCode: 's', modifiers: ['control'] });
});

test('parseKeyCombo: multiple modifiers', () => {
  assert.deepEqual(parseKeyCombo('ctrl+shift+p'), { keyCode: 'p', modifiers: ['control', 'shift'] });
});

test('parseKeyCombo: cmd/meta/option aliases normalize', () => {
  assert.deepEqual(parseKeyCombo('cmd+option+Escape'), { keyCode: 'Escape', modifiers: ['meta', 'alt'] });
});

test('parseKeyCombo: unknown modifier throws', () => {
  assert.throws(() => parseKeyCombo('foo+a'), /unknown modifier/);
});

test('parseKeyCombo: empty string throws', () => {
  assert.throws(() => parseKeyCombo(''), /empty key/);
});

test('computeScrollDelta: up/down/left/right map to signed deltas', () => {
  assert.deepEqual(computeScrollDelta({ scroll_direction: 'up', scroll_amount: 2 }), { deltaX: 0, deltaY: 200 });
  assert.deepEqual(computeScrollDelta({ scroll_direction: 'down', scroll_amount: 2 }), { deltaX: 0, deltaY: -200 });
  assert.deepEqual(computeScrollDelta({ scroll_direction: 'left', scroll_amount: 1 }), { deltaX: 100, deltaY: 0 });
  assert.deepEqual(computeScrollDelta({ scroll_direction: 'right', scroll_amount: 1 }), { deltaX: -100, deltaY: 0 });
});

test('computeScrollDelta: defaults scroll_amount to 1 when not finite', () => {
  assert.deepEqual(computeScrollDelta({ scroll_direction: 'up' }), { deltaX: 0, deltaY: 100 });
});

test('computeScrollDelta: unsupported direction throws', () => {
  assert.throws(() => computeScrollDelta({ scroll_direction: 'diagonal' }), /unsupported scroll_direction/);
});

test('computeScreenshotScale: leaves small images untouched', () => {
  const result = computeScreenshotScale(800, 600);
  assert.equal(result.scale, 1);
  assert.equal(result.width, 800);
  assert.equal(result.height, 600);
});

test('computeScreenshotScale: downscales long edge to the fixed max', () => {
  const result = computeScreenshotScale(2560, 1440);
  assert.equal(result.width, AGENT_SCREENSHOT_MAX_DIM);
  assert.ok(result.scale < 1);
  assert.equal(result.height, Math.round(1440 * result.scale));
});

test('computeScreenshotScale: portrait image scales on height', () => {
  const result = computeScreenshotScale(900, 3000);
  assert.equal(result.height, AGENT_SCREENSHOT_MAX_DIM);
  assert.ok(result.width < 900);
});
