/**
 * The "Ask Bilko" closing note for the Field Manual's offline HTML + PDF editions.
 * Words come from book.askBilko in landing-v2/copy.json (one source of copy);
 * the web reader renders its own note, so this never goes into chapter sources.
 */

const HREF_PREFIX = '/book?utm_source=session-manager';
const EDITIONS = new Set(['offline', 'pdf']);

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function askBilkoNoteHtml(askBilko, edition) {
  if (!askBilko || typeof askBilko.href !== 'string' || !askBilko.href.startsWith(HREF_PREFIX)) {
    throw new Error(`askBilko.href must start with ${HREF_PREFIX}`);
  }
  if (!EDITIONS.has(edition)) {
    throw new Error(`edition must be 'offline' or 'pdf', got ${JSON.stringify(edition)}`);
  }
  const href = `https://bilko.run${askBilko.href}&utm_content=${edition}`;
  return `<aside class="manual-askbilko">
<h2>${escapeHtml(askBilko.title)}</h2>
<p>${escapeHtml(askBilko.body)}</p>
<a class="manual-askbilko__link" href="${escapeHtml(href)}">${escapeHtml(askBilko.link)}</a>
</aside>`;
}
