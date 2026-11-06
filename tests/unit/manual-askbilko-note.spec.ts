import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error plain .mjs module
import { askBilkoNoteHtml } from '../../web/manual/askBilkoNote.mjs';

const copy = JSON.parse(
  readFileSync(join(process.cwd(), 'session-manager-operations/design-mocks/landing-v2/copy.json'), 'utf-8'),
);
const askBilko = copy.book.askBilko;

function hrefOf(html: string): string {
  const m = /<a class="manual-askbilko__link" href="([^"]*)"/.exec(html);
  expect(m).not.toBeNull();
  return m![1].replaceAll('&amp;', '&');
}

describe('askBilkoNoteHtml', () => {
  it('builds the offline and pdf hrefs', () => {
    expect(hrefOf(askBilkoNoteHtml(askBilko, 'offline'))).toBe(
      'https://bilko.run/book?utm_source=session-manager&utm_medium=manual&utm_content=offline',
    );
    expect(hrefOf(askBilkoNoteHtml(askBilko, 'pdf')).endsWith('&utm_content=pdf')).toBe(true);
    expect(askBilkoNoteHtml(askBilko, 'pdf')).toContain('<aside class="manual-askbilko">');
  });

  it('escapes < and & in the title', () => {
    const html = askBilkoNoteHtml({ ...askBilko, title: 'A <b> & C' }, 'offline');
    expect(html).toContain('<h2>A &lt;b&gt; &amp; C</h2>');
  });

  it('throws on a bad href or edition', () => {
    expect(() => askBilkoNoteHtml({ ...askBilko, href: '/other?x=1' }, 'offline')).toThrow(Error);
    expect(() => askBilkoNoteHtml(askBilko, 'web')).toThrow(Error);
  });

  it('carries no price', () => {
    expect(askBilkoNoteHtml(askBilko, 'offline')).not.toMatch(/\$\s?\d/);
    expect(askBilkoNoteHtml(askBilko, 'pdf')).not.toMatch(/\$\s?\d/);
  });
});
