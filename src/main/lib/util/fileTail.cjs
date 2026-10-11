/**
 * fileTail.cjs — read the last N bytes of a file as UTF-8.
 *
 * Three near-identical copies existed before: scheduler.cjs readTail (1011),
 * supervisor.cjs readTailBytes (104), and an inline copy in scheduler's
 * post-result watchdog (~792). Unified here. Callers MUST be in a synchronous
 * context; intentionally sync because callers are inside polling intervals or
 * exit handlers where async would add an unnecessary event-loop hop.
 *
 * Returns '' on any I/O error (missing file, permission denied, etc.) — the
 * tail readers are best-effort log scanners, not data paths.
 */
'use strict';

const fs = require('node:fs');

function readTail(filePath, bytes) {
  try {
    const stat = fs.statSync(filePath);
    const n = Math.min(stat.size, bytes);
    if (n <= 0) return '';
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, stat.size - n);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

module.exports = { readTail };
