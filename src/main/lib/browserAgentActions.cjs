/**
 * browserAgentActions.cjs — pure mapping logic for the on-demand single-
 * action browser-agent API (PRD 535). Extracted out of browserView.cjs so
 * the action -> input-event/scale mapping can be unit-tested without
 * booting Electron — mirrors how lib/schedulerBatch.cjs was pulled out of
 * scheduler.cjs for the same reason. Anything that actually touches a live
 * WebContentsView (sendInputEvent, capturePage, executeJavaScript) stays in
 * browserView.cjs; this module only computes the values passed to those
 * calls.
 */

'use strict';

// Anthropic's computer_use tool scrolls in "clicks"; one click here maps to
// this many CSS pixels of wheel delta.
const SCROLL_UNIT_PX = 100;

// Anthropic-tool-use-style key names -> Electron's sendInputEvent keyCode
// strings. Anything not in this table is passed through as-is (covers plain
// single characters like "a" or "s").
const SPECIAL_KEY_MAP = {
  return: 'Enter',
  enter: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  esc: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  space: ' ',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  page_up: 'PageUp',
  pageup: 'PageUp',
  page_down: 'PageDown',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
};

const MODIFIER_MAP = {
  ctrl: 'control',
  control: 'control',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  cmd: 'meta',
  meta: 'meta',
  super: 'meta',
};

// Parses a computer-use-style key combo ("ctrl+s", "Return", "a") into the
// { keyCode, modifiers } shape Electron's webContents.sendInputEvent wants.
function parseKeyCombo(keyStr) {
  const parts = String(keyStr || '')
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error('empty key');
  const last = parts.pop();
  const modifiers = parts.map((p) => {
    const mapped = MODIFIER_MAP[p.toLowerCase()];
    if (!mapped) throw new Error(`unknown modifier: ${p}`);
    return mapped;
  });
  const lowerLast = last.toLowerCase();
  const keyCode = SPECIAL_KEY_MAP[lowerLast] || last;
  return { keyCode, modifiers };
}

// Maps a computer-use-style scroll action to a mouseWheel delta.
function computeScrollDelta({ scroll_direction, scroll_amount }) {
  const amount = Number.isFinite(scroll_amount) ? scroll_amount : 1;
  switch (scroll_direction) {
    case 'up':
      return { deltaX: 0, deltaY: amount * SCROLL_UNIT_PX };
    case 'down':
      return { deltaX: 0, deltaY: -amount * SCROLL_UNIT_PX };
    case 'left':
      return { deltaX: amount * SCROLL_UNIT_PX, deltaY: 0 };
    case 'right':
      return { deltaX: -amount * SCROLL_UNIT_PX, deltaY: 0 };
    default:
      throw new Error(`unsupported scroll_direction: ${scroll_direction}`);
  }
}

// Fixed max long-edge a screenshot is resized to before being returned.
// Anthropic's computer-use API silently downscales oversized images
// server-side, which breaks coordinate mapping unless caller and model agree
// on one fixed logical resolution up front — this is that fixed point.
const AGENT_SCREENSHOT_MAX_DIM = 1280;

// Given a captured screenshot's real pixel size, returns the target size to
// resize to plus the scale factor a caller must divide a clicked coordinate
// on the resized image by to recover the real-page coordinate.
function computeScreenshotScale(width, height) {
  const longEdge = Math.max(width, height);
  const scale = longEdge > AGENT_SCREENSHOT_MAX_DIM ? AGENT_SCREENSHOT_MAX_DIM / longEdge : 1;
  return {
    scale,
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

module.exports = {
  parseKeyCombo,
  computeScrollDelta,
  computeScreenshotScale,
  AGENT_SCREENSHOT_MAX_DIM,
  SCROLL_UNIT_PX,
};
