'use strict';

// unifiedDiff.cjs — pure parser: `git diff` unified text → per-file hunks and
// numbered lines, for the Epic Changes view. Never runs git; the caller
// (epic/epicChanges.cjs) runs it and hands the text here.

const { unquotePorcelainPath } = require('./gitWorktree.cjs');

const DEFAULT_MAX_LINES_PER_FILE = 3000;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * @typedef {{ kind: 'add' | 'del' | 'ctx', oldNo: number | null, newNo: number | null, text: string }} DiffLine
 * @typedef {{ header: string, oldStart: number, oldLines: number, newStart: number, newLines: number, lines: DiffLine[] }} DiffHunk
 * @typedef {{ path: string, oldPath: string | null, status: 'added' | 'deleted' | 'modified' | 'renamed', binary: boolean, additions: number, deletions: number, hunks: DiffHunk[], truncated: boolean }} DiffFile
 */

/**
 * Decode a path token as git prints it: optional C-style quoting, then an
 * optional `a/` or `b/` prefix, then git's trailing tab (added after a name
 * that contains a space).
 * @param {string} raw
 * @param {string | null} prefix
 */
function decodePath(raw, prefix) {
  const p = unquotePorcelainPath(raw.replace(/\t+$/, ''));
  if (prefix && p.startsWith(prefix)) return p.slice(prefix.length);
  return p;
}

/**
 * Split the `diff --git <a> <b>` header into its two raw paths. Quoted tokens
 * are exact; for unquoted ones (which may contain spaces) the split relies on
 * both sides naming the same path, which holds for every non-rename entry —
 * renames carry `rename from`/`rename to` lines that override this.
 * @param {string} rest text after `diff --git `
 * @returns {{ a: string, b: string } | null}
 */
function splitGitHeader(rest) {
  /** @param {string} s */
  const readQuoted = (s) => {
    for (let i = 1; i < s.length; i += 1) {
      if (s[i] === '\\') i += 1;
      else if (s[i] === '"') return s.slice(0, i + 1);
    }
    return null;
  };
  if (rest.startsWith('"')) {
    const a = readQuoted(rest);
    if (!a) return null;
    const tail = rest.slice(a.length).replace(/^ /, '');
    return { a: decodePath(a, 'a/'), b: decodePath(tail, 'b/') };
  }
  const qi = rest.indexOf(' "b/');
  if (qi >= 0) return { a: decodePath(rest.slice(0, qi), 'a/'), b: decodePath(rest.slice(qi + 1), 'b/') };
  // Unquoted: "a/P b/P" — try the midpoint first, then any " b/" separator.
  if ((rest.length - 1) % 2 === 0) {
    const half = (rest.length - 1) / 2;
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (rest[half] === ' ' && a.startsWith('a/') && b.startsWith('b/') && a.slice(2) === b.slice(2)) {
      return { a: a.slice(2), b: b.slice(2) };
    }
  }
  const si = rest.indexOf(' b/');
  if (si >= 0) return { a: decodePath(rest.slice(0, si), 'a/'), b: decodePath(rest.slice(si + 1), 'b/') };
  return null;
}

/**
 * Parse `git diff` unified output into structured files.
 *
 * Input contract: callers run git with `--no-color --no-ext-diff -M` and the
 * default `a/` `b/` prefixes (no --no-prefix / --src-prefix). Combined
 * (merge) diffs are not supported.
 *
 * @param {unknown} text
 * @param {{ maxLinesPerFile?: number }} [opts] lines past the cap are dropped
 *   (the file gets `truncated: true`); additions/deletions still count all.
 * @returns {DiffFile[]}
 */
function parseUnifiedDiff(text, opts) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const maxRaw = opts && opts.maxLinesPerFile;
  const maxLines = typeof maxRaw === 'number' && maxRaw >= 0 ? maxRaw : DEFAULT_MAX_LINES_PER_FILE;

  /** @type {DiffFile[]} */
  const files = [];
  /** @type {(DiffFile & { _kept: number, _headerA: string | null, _headerB: string | null, _minus: string | null, _plus: string | null, _renameFrom: string | null, _renameTo: string | null, _created: boolean, _deleted: boolean }) | null} */
  let cur = null;
  /** @type {DiffHunk | null} */
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  let inBinaryPatch = false;

  const finish = () => {
    if (!cur) return;
    const c = cur;
    let status = /** @type {DiffFile['status']} */ ('modified');
    if (c._created || c._minus === '/dev/null') status = 'added';
    else if (c._deleted || c._plus === '/dev/null') status = 'deleted';
    else if (c._renameFrom !== null || c._renameTo !== null) status = 'renamed';

    const newSide = c._renameTo ?? (c._plus && c._plus !== '/dev/null' ? c._plus : null) ?? c._headerB;
    const oldSide = c._renameFrom ?? (c._minus && c._minus !== '/dev/null' ? c._minus : null) ?? c._headerA;
    const filePath = status === 'deleted' ? (oldSide ?? newSide ?? '') : (newSide ?? oldSide ?? '');
    files.push({
      path: filePath,
      oldPath: status === 'renamed' ? (oldSide ?? null) : null,
      status,
      binary: c.binary,
      additions: c.additions,
      deletions: c.deletions,
      // A hunk that starts past the cap keeps no lines; drop it entirely.
      hunks: c.truncated ? c.hunks.filter((h) => h.lines.length > 0) : c.hunks,
      truncated: c.truncated,
    });
    cur = null;
    hunk = null;
  };

  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  for (const line of lines) {
    // Inside a hunk the remaining counts decide what a line is, so a deleted
    // line like "--- a/x" is never mistaken for a file header.
    if (cur && hunk && (oldLeft > 0 || newLeft > 0)) {
      const c0 = line[0];
      /** @type {DiffLine | null} */
      let entry = null;
      if (c0 === '+') {
        entry = { kind: 'add', oldNo: null, newNo: newNo, text: line.slice(1) };
        newNo += 1; newLeft -= 1; cur.additions += 1;
      } else if (c0 === '-') {
        entry = { kind: 'del', oldNo: oldNo, newNo: null, text: line.slice(1) };
        oldNo += 1; oldLeft -= 1; cur.deletions += 1;
      } else if (c0 === ' ' || line === '') {
        entry = { kind: 'ctx', oldNo: oldNo, newNo: newNo, text: line.slice(1) };
        oldNo += 1; newNo += 1; oldLeft -= 1; newLeft -= 1;
      } else if (c0 === '\\') {
        continue;
      }
      if (entry) {
        if (cur._kept < maxLines) {
          hunk.lines.push(entry);
          cur._kept += 1;
        } else {
          cur.truncated = true;
        }
        continue;
      }
      // Malformed counts: fall through and treat the line as structure.
      oldLeft = 0;
      newLeft = 0;
    }

    if (line.startsWith('diff --git ')) {
      finish();
      const hdr = splitGitHeader(line.slice('diff --git '.length));
      cur = {
        path: '', oldPath: null, status: 'modified', binary: false, additions: 0, deletions: 0, hunks: [], truncated: false,
        _kept: 0, _headerA: hdr ? hdr.a : null, _headerB: hdr ? hdr.b : null, _minus: null, _plus: null,
        _renameFrom: null, _renameTo: null, _created: false, _deleted: false,
      };
      hunk = null;
      inBinaryPatch = false;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('\\')) continue;

    const m = HUNK_RE.exec(line);
    if (m && !inBinaryPatch) {
      hunk = {
        header: line,
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      cur.hunks.push(hunk);
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      oldLeft = hunk.oldLines;
      newLeft = hunk.newLines;
      continue;
    }
    if (inBinaryPatch) continue;
    if (line.startsWith('--- ')) cur._minus = decodePath(line.slice(4), 'a/');
    else if (line.startsWith('+++ ')) cur._plus = decodePath(line.slice(4), 'b/');
    else if (line.startsWith('new file mode')) cur._created = true;
    else if (line.startsWith('deleted file mode')) cur._deleted = true;
    else if (line.startsWith('rename from ')) cur._renameFrom = decodePath(line.slice(12), null);
    else if (line.startsWith('rename to ')) cur._renameTo = decodePath(line.slice(10), null);
    else if (line.startsWith('Binary files ') && line.endsWith(' differ')) cur.binary = true;
    else if (line === 'GIT binary patch') { cur.binary = true; inBinaryPatch = true; }
  }
  finish();
  return files;
}

module.exports = { parseUnifiedDiff };
