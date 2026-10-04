// Claude often writes URLs in backticks; `marked` renders those as <code>, not
// <a>, so handleChatLinkClick's <a> branch never sees them. This post-processes
// the rendered DOM (next to linkifyFilePaths) to wrap a code span whose whole
// text is one http(s) URL in an <a>, so the click opens the OS browser.
const CODE_URL_RE = /^https?:\/\/[^\s<>"']+$/i

/** Marker attribute on anchors this module creates. */
export const CODE_URL_ATTR = 'data-chat-code-url'

/**
 * Wraps each inline <code> (not in <pre> or <a>) whose trimmed text is a single
 * http(s) URL in `<a href data-chat-code-url>`. Idempotent: wrapped code sits
 * inside an <a>, so a re-run skips it. href is set via setAttribute only.
 */
export function linkifyCodeUrls(root: HTMLElement): void {
  for (const code of Array.from(root.querySelectorAll('code'))) {
    if (code.closest('pre, a')) continue
    const url = (code.textContent ?? '').trim()
    if (!CODE_URL_RE.test(url)) continue
    const a = document.createElement('a')
    a.setAttribute('href', url)
    a.setAttribute(CODE_URL_ATTR, '')
    code.replaceWith(a)
    a.appendChild(code)
  }
}
