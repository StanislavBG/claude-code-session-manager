'use strict';

// Bounded text accumulator: keeps the first HEAD chars (for error-detail
// previews) plus a ring of the last `tailMax` chars (for regex matching).
// Same trim-oldest idiom as pty.cjs `#appendReplay`. Memory is O(head + tailMax)
// regardless of input size; append is O(tailMax) per chunk.

const HEAD_PREVIEW_CHARS = 300;
// One extra char lets preview() tell "exactly 300" from "longer than 300".
const HEAD_KEEP = HEAD_PREVIEW_CHARS + 1;

function createHeadTailBuffer(tailMax) {
  let head = '';
  let tail = '';
  let truncated = false;
  return {
    append(str) {
      if (!str) return;
      if (head.length < HEAD_KEEP) {
        // Skip leading whitespace so the head equals `text.trim().slice(0, …)`.
        const s = head.length === 0 ? str.replace(/^\s+/, '') : str;
        head += s.slice(0, HEAD_KEEP - head.length);
      }
      tail += str;
      if (tail.length > tailMax) {
        tail = tail.slice(tail.length - tailMax);
        truncated = true;
      }
    },
    /** Text to run regexes over: the tail, plus the head once the middle was dropped. */
    matchText() {
      return truncated ? `${head}\n${tail}` : tail;
    },
    /** Equivalent to `fullText.trim().slice(0, 300)`. */
    preview() {
      return head.length > HEAD_PREVIEW_CHARS ? head.slice(0, HEAD_PREVIEW_CHARS) : head.trimEnd();
    },
    /** Retained char count (head + tail). */
    get size() { return head.length + tail.length; },
  };
}

module.exports = { createHeadTailBuffer, HEAD_PREVIEW_CHARS };
