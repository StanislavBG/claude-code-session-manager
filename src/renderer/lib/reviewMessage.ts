// Composes an Epic's diff-review line comments (plus an optional overall note)
// into ONE follow-up chat message the agent can act on. Pure — no stores, no
// window.api; the send path and the draft store live elsewhere.

export type ReviewSide = 'old' | 'new';

export interface ReviewComment {
  id: string;
  sectionKey: string;
  sectionLabel: string;
  commit: string | null;
  path: string;
  side: ReviewSide;
  startLine: number;
  endLine: number;
  lineText: string;
  body: string;
  createdAt: number;
}

export interface ComposeReviewInput {
  comments: readonly ReviewComment[];
  note?: string | null;
}

/** chat:run refuses prompts over 100 KiB; stay well under it. */
export const REVIEW_MESSAGE_MAX_BYTES = 90000;
export const REVIEW_LINE_TEXT_MAX_CHARS = 500;
export const LIVE_SECTION_KEY = 'session:live';

const encoder = new TextEncoder();
const byteLength = (s: string): number => encoder.encode(s).length;

function clampChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max - 1).join('') + '…';
}

/** Longest prefix of `text` (by code point) whose UTF-8 size is ≤ maxBytes. */
function clampBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (byteLength(text) <= maxBytes) return text;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const b = byteLength(ch);
    if (used + b > maxBytes) break;
    out += ch;
    used += b;
  }
  return out;
}

function fenceFor(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function lineLabel(c: ReviewComment): string {
  const start = Math.min(c.startLine, c.endLine);
  const end = Math.max(c.startLine, c.endLine);
  const range = start === end ? `line ${start}` : `lines ${start}-${end}`;
  return c.side === 'old' ? `old ${range} (removed code)` : range;
}

function sectionHeading(c: ReviewComment): string {
  if (c.sectionKey === LIVE_SECTION_KEY) {
    return `## ${c.sectionLabel} — in your worktree (not yet merged)`;
  }
  const at = c.commit ? ` at ${c.commit.slice(0, 8)}` : '';
  return `## ${c.sectionLabel} — landed on the base branch${at} (that code may not exist in your worktree)`;
}

function renderEntry(c: ReviewComment, withQuote: boolean): string {
  const parts = [`**${lineLabel(c)}**`];
  if (withQuote && c.lineText.length > 0) {
    const quoted = clampChars(c.lineText, REVIEW_LINE_TEXT_MAX_CHARS);
    const fence = fenceFor(quoted);
    parts.push(`${fence}\n${quoted}\n${fence}`);
  }
  parts.push(c.body.trim());
  return parts.join('\n');
}

/** Sections by first appearance, then path, then startLine (stable). */
function orderComments(comments: readonly ReviewComment[]): ReviewComment[] {
  const sectionRank = new Map<string, number>();
  comments.forEach((c) => {
    if (!sectionRank.has(c.sectionKey)) sectionRank.set(c.sectionKey, sectionRank.size);
  });
  return comments
    .map((c, i) => ({ c, i }))
    .sort((a, b) =>
      (sectionRank.get(a.c.sectionKey)! - sectionRank.get(b.c.sectionKey)!)
      || (a.c.path < b.c.path ? -1 : a.c.path > b.c.path ? 1 : 0)
      || (a.c.startLine - b.c.startLine)
      || (a.i - b.i))
    .map(({ c }) => c);
}

function renderComments(ordered: readonly ReviewComment[], withQuotes: boolean): string[] {
  const blocks: string[] = [];
  let section: string | null = null;
  let path: string | null = null;
  for (const c of ordered) {
    if (c.sectionKey !== section) {
      section = c.sectionKey;
      path = null;
      blocks.push(sectionHeading(c));
    }
    if (c.path !== path) {
      path = c.path;
      blocks.push(`### ${c.path}`);
    }
    blocks.push(renderEntry(c, withQuotes));
  }
  return blocks;
}

export function composeReviewMessage({ comments, note }: ComposeReviewInput): string {
  const live = comments.filter((c) => c.body.trim().length > 0);
  const trimmedNote = (note ?? '').trim();
  if (live.length === 0 && trimmedNote.length === 0) return '';

  const fileCount = new Set(live.map((c) => c.path)).size;
  const header = `Review comments on this session's changes: ${live.length} comment(s) on ${fileCount} file(s). Address each one, then reply with what you changed.`;
  const ordered = orderComments(live);

  const build = (kept: number, withQuotes: boolean, noteText: string): string => {
    const blocks = [header];
    if (noteText) blocks.push(noteText);
    blocks.push(...renderComments(ordered.slice(0, kept), withQuotes));
    const omitted = ordered.length - kept;
    if (omitted > 0) {
      blocks.push(`_${omitted} more comment(s) omitted to fit the message size limit._`);
    }
    return blocks.join('\n\n');
  };
  const fits = (s: string): boolean => byteLength(s) <= REVIEW_MESSAGE_MAX_BYTES;

  const full = build(ordered.length, true, trimmedNote);
  if (fits(full)) return full;
  const noQuotes = build(ordered.length, false, trimmedNote);
  if (fits(noQuotes)) return noQuotes;

  // Largest number of leading comments (quotes dropped) that still fits.
  let lo = 0;
  let hi = ordered.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(build(mid, false, trimmedNote))) lo = mid;
    else hi = mid - 1;
  }
  const trimmed = build(lo, false, trimmedNote);
  if (fits(trimmed)) return trimmed;

  // Even with every comment omitted the note is too large: shorten the note.
  const withoutNote = build(0, false, '');
  const room = REVIEW_MESSAGE_MAX_BYTES - byteLength(withoutNote) - byteLength('\n\n…') - 1;
  const shortNote = room > 0 ? clampBytes(trimmedNote, room) + '…' : '';
  const last = build(0, false, shortNote);
  return fits(last) ? last : clampBytes(last, REVIEW_MESSAGE_MAX_BYTES);
}
