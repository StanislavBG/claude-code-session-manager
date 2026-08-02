import { describe, expect, it } from 'vitest';
import { renderProjectPages } from '../render';
import { LENS_LIBRARY, LENS_ORDER } from '../library';
import type { ProjectPageSummary, ProjectPagePicks } from '../summaryType';

const SUMMARY: ProjectPageSummary = {
  identity: {
    name: 'Acme Widgets',
    tag: 'acme-widgets',
    version: 'v1.0.0',
    oneLine: 'Widgets, but faster.',
    claim: 'Ship widgets without the wait.',
    sub: 'Acme Widgets automates the boring parts of widget assembly.',
    audience: 'For widget teams',
    install: 'npx acme-widgets',
  },
  stats: [
    { v: '42', k: 'widgets/day', n: 'across all lines' },
    { v: '0', k: 'downtime incidents', n: 'this quarter' },
  ],
  pillars: [
    { t: 'One line, four stations', d: 'Every widget passes through the same four stations.', k: 'Assembly' },
    { t: 'Traceable by default', d: 'Every widget carries its build history.', k: 'Traceability' },
  ],
  quotes: [{ q: 'Widgets ship on time now.', a: 'Jamie L.', r: 'plant manager' }],
  feature: {
    name: 'Auto-QA',
    kicker: 'Feature',
    status: 'Shipping · v1.0',
    owner: 'Core',
    oneLine: 'Every widget is inspected before it leaves the line.',
    problem: 'Manual inspection missed defects under load.',
    solution: 'A camera station scores each widget against spec automatically.',
    steps: [
      { t: 'Capture', d: 'A camera captures the widget at station 4.' },
      { t: 'Score', d: 'The model scores it against spec.' },
    ],
    rules: [
      { t: 'No silent pass', d: 'Every widget gets a recorded score.' },
      { t: 'Escalate on doubt', d: 'Borderline scores route to a human.' },
    ],
    specs: [['Throughput', '120/min', 'per station']],
    faq: [{ q: 'What if the camera fails?', a: 'The line halts and the station flags itself.' }],
    timeline: [
      { w: 'v0.9', t: 'Camera station shipped', s: 'done' },
      { w: 'v1.1', t: 'Multi-station scoring', s: 'next' },
    ],
  },
  architecture: {
    summary: 'A line controller coordinating four stations and a scoring service.',
    principles: [{ t: 'Fail loud', d: 'A station that cannot score halts rather than guesses.' }],
    layers: [{ n: 'Controller', d: 'Coordinates stations', f: '6 files', tone: 'accent' }],
    modules: [{ n: 'scoring', d: 'Scores captures against spec', f: 4, dep: [], heat: 0.6 }],
    flow: [{ a: 'Station', b: 'Controller', t: 'capture()', n: 'sent on each widget' }],
    decisions: [{ id: 'ADR-01', t: 'Scoring runs on-line, not batched', w: 'Batch scoring missed the halt window.', s: 'accepted' }],
    risks: [{ t: 'Camera drift', d: 'Uncalibrated cameras drift over months.', s: 'watching' }],
  },
};

// Cover at least one variant per slot in each lens by picking the first
// variant of every slot the library defines.
const PICKS: ProjectPagePicks = Object.fromEntries(
  LENS_ORDER.map(lensId => {
    const lens = LENS_LIBRARY[lensId];
    const slotPicks = Object.fromEntries(lens.slots.map(slot => [slot.id, slot.variants[0].id]));
    return [lensId, slotPicks];
  }),
);

describe('renderProjectPages', () => {
  const pages = renderProjectPages(SUMMARY, PICKS);

  it('returns all three lenses', () => {
    expect(Object.keys(pages).sort()).toEqual(['architecture', 'feature', 'marketing']);
  });

  it.each(['marketing', 'feature', 'architecture'] as const)('%s starts with a doctype', lens => {
    expect(pages[lens].startsWith('<!DOCTYPE html>')).toBe(true);
  });

  it.each(['marketing', 'feature', 'architecture'] as const)('%s contains no script tags', lens => {
    expect(pages[lens]).not.toMatch(/<script/i);
  });

  it.each(['marketing', 'feature', 'architecture'] as const)('%s makes no external network calls', lens => {
    expect(pages[lens]).not.toMatch(/googleapis\.com/i);
    expect(pages[lens]).not.toMatch(/https?:\/\//i);
  });

  it('marketing output mentions the project name', () => {
    expect(pages.marketing).toContain(SUMMARY.identity.name);
  });

  it('falls back to the preset v1 pick when picks is empty', () => {
    const fallbackPages = renderProjectPages(SUMMARY, {});
    expect(fallbackPages.marketing.startsWith('<!DOCTYPE html>')).toBe(true);
    // preset v1's hero pick is 'editorial', which renders the project claim as an <h1>.
    expect(fallbackPages.marketing).toContain(SUMMARY.identity.claim);
  });

  it('escapes HTML-significant characters in the title/description', () => {
    const trickySummary: ProjectPageSummary = {
      ...SUMMARY,
      identity: { ...SUMMARY.identity, name: 'Acme <Widgets> & "Co"', oneLine: "It's <great> & \"fast\"" },
    };
    const trickyPages = renderProjectPages(trickySummary, PICKS);
    const head = trickyPages.marketing.slice(0, trickyPages.marketing.indexOf('</head>'));
    expect(head).not.toContain('<Widgets>');
    expect(head).not.toContain('"fast"');
    expect(head).toContain('&lt;Widgets&gt;');
    expect(head).toContain('&amp;');
  });
});
