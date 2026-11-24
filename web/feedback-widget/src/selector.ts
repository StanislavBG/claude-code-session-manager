// Element selector for Element marks (handoff README §5.4 "Element selector").
// Pure DOM functions, no framework: given a page element, produce a CSS selector that
// matches exactly that one node, plus the descriptive record the report carries in
// `marks[].element` (schema/report.v1.json).

import { HOST_ID } from './host';

/** The `element` record of an Element mark (schema/report.v1.json). */
export interface ElementDescription {
  selector: string;
  /** UI label: `tag.firstClass` (first non-hashed class), or just `tag`. */
  label: string;
  tag: string;
  id?: string;
  classes: string[];
  /** Trimmed, whitespace-collapsed text content, at most 80 characters. */
  text: string;
  role?: string;
  ariaLabel?: string;
  xpath: string;
}

export const TEXT_MAX = 80;
export const MIN_SIZE = 4;
/** Ancestors the class/nth-of-type walk may climb before falling back to a full path. */
export const MAX_ANCESTORS = 4;
const TEST_ATTRS = ['data-testid', 'data-test', 'data-cy'] as const;

/** An id is auto-generated when it contains a run of 4+ digits. */
export function isAutoId(id: string): boolean {
  return /\d{4,}/.test(id);
}

/** css-xxxx, sc-xxxx, or any run of 5+ alphanumerics mixing letters and digits. */
export function isHashedClass(cls: string): boolean {
  if (/^(css|sc)-/.test(cls)) return true;
  const runs = cls.match(/[A-Za-z0-9]{5,}/g) ?? [];
  return runs.some((r) => /\d/.test(r) && /[A-Za-z]/.test(r));
}

/** CSS.escape when available (browsers), else a spec-faithful fallback (jsdom). */
export function cssEscape(value: string): string {
  const native = (globalThis as { CSS?: { escape?: (v: string) => string } }).CSS?.escape;
  if (native) return native(value);
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value.charAt(i);
    const code = value.charCodeAt(i);
    if (code === 0) out += '�';
    else if (
      (code >= 0x1 && code <= 0x1f) ||
      code === 0x7f ||
      (i === 0 && code >= 0x30 && code <= 0x39) ||
      (i === 1 && code >= 0x30 && code <= 0x39 && value.charCodeAt(0) === 0x2d)
    )
      out += `\\${code.toString(16)} `;
    else if (i === 0 && value.length === 1 && code === 0x2d) out += `\\${ch}`;
    else if (code >= 0x80 || code === 0x2d || code === 0x5f || /[0-9A-Za-z]/.test(ch)) out += ch;
    else out += `\\${ch}`;
  }
  return out;
}

function tagOf(el: Element): string {
  return el.tagName.toLowerCase();
}

function stableClasses(el: Element): string[] {
  return Array.from(el.classList).filter((c) => !isHashedClass(c));
}

function isUnique(doc: Document, sel: string, el: Element): boolean {
  try {
    const hits = doc.querySelectorAll(sel);
    return hits.length === 1 && hits[0] === el;
  } catch {
    return false;
  }
}

/** 1-based index among same-tag siblings, and whether any such sibling exists. */
function typeIndex(el: Element): { k: number; shared: boolean } {
  const parent = el.parentElement;
  if (!parent) return { k: 1, shared: false };
  const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
  return { k: same.indexOf(el) + 1, shared: same.length > 1 };
}

function plainSegment(el: Element): string {
  return tagOf(el) + stableClasses(el).map((c) => `.${cssEscape(c)}`).join('');
}

function nthSegment(el: Element): string {
  return `${plainSegment(el)}:nth-of-type(${typeIndex(el).k})`;
}

/** Last resort: html > body > … with :nth-of-type at every step — unique by construction. */
function fullPath(el: Element): string {
  const parts: string[] = [];
  for (let n: Element | null = el; n; n = n.parentElement) {
    parts.unshift(n.parentElement && typeIndex(n).shared ? `${tagOf(n)}:nth-of-type(${typeIndex(n).k})` : tagOf(n));
  }
  return parts.join(' > ');
}

/**
 * A CSS selector matching exactly `el` in its document, tried in order:
 * 1. `#id` — when unique and not auto-generated;
 * 2. `[data-testid|data-test|data-cy="…"]` — when unique;
 * 3. `tag.class1.class2[:nth-of-type(k)]` segments joined by ` > `, walking up at most
 *    {@link MAX_ANCESTORS} ancestors until the selector matches one node (hashed classes skipped).
 * If none of those is unique, falls back to a full `html > body > …` path.
 */
export function uniqueSelector(el: Element): string {
  const doc = el.ownerDocument;

  if (el.id && !isAutoId(el.id)) {
    const sel = `#${cssEscape(el.id)}`;
    if (isUnique(doc, sel, el)) return sel;
  }

  for (const attr of TEST_ATTRS) {
    const v = el.getAttribute(attr);
    if (v === null || v === '') continue;
    const sel = `[${attr}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
    if (isUnique(doc, sel, el)) return sel;
  }

  let chain = '';
  let node: Element | null = el;
  for (let depth = 0; node && depth <= MAX_ANCESTORS; depth++) {
    const tag = tagOf(node);
    if (tag === 'html') break;
    const join = (seg: string) => (chain ? `${seg} > ${chain}` : seg);
    const plain = join(plainSegment(node));
    if (isUnique(doc, plain, el)) return plain;
    const { shared } = typeIndex(node);
    if (shared) {
      const nth = join(nthSegment(node));
      if (isUnique(doc, nth, el)) return nth;
      chain = nth;
    } else {
      chain = plain;
    }
    if (tag === 'body') break;
    node = node.parentElement;
  }

  return fullPath(el);
}

/** Absolute XPath, e.g. `/html/body/main/section[2]/button` (index only among same-tag siblings). */
export function xpathOf(el: Element): string {
  const parts: string[] = [];
  for (let n: Element | null = el; n; n = n.parentElement) {
    const { k, shared } = typeIndex(n);
    parts.unshift(shared ? `${tagOf(n)}[${k}]` : tagOf(n));
  }
  return `/${parts.join('/')}`;
}

function isWidget(el: Element): boolean {
  if (el.id === HOST_ID) return true;
  return el.closest(`#${cssEscape(HOST_ID)}`) !== null;
}

/**
 * The report record for an Element mark, or null for elements that cannot be marked:
 * the widget host (and anything inside it), `html`, `body`, and elements under 4×4.
 */
export function describeElement(el: Element): ElementDescription | null {
  const tag = tagOf(el);
  if (tag === 'html' || tag === 'body' || isWidget(el)) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) return null;

  const classes = Array.from(el.classList);
  const first = stableClasses(el)[0];
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX).trim();

  const out: ElementDescription = {
    selector: uniqueSelector(el),
    label: first ? `${tag}.${first}` : tag,
    tag,
    classes,
    text,
    xpath: xpathOf(el),
  };
  if (el.id) out.id = el.id;
  const role = el.getAttribute('role');
  if (role) out.role = role;
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) out.ariaLabel = ariaLabel;
  return out;
}
