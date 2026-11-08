/**
 * matrixHtml.test.cjs — Competitor matrix HTML page: self-contained document,
 * sections, escaping, validateHomeHtml + size, empty state, dark mode.
 *
 * Run: timeout 120 npx vitest run src/main/lib/project-pages/__tests__/matrixHtml.test.cjs
 */

'use strict';

import { test, expect } from 'vitest';
const { renderMatrixHtml, escapeHtml } = require('../matrixHtml.cjs');
const { validateMatrix } = require('../competitiveMatrix.cjs');
const { validateHomeHtml } = require('../../feedback-remote/projectHomeAdminRoutes.cjs');

const T = '2026-11-08T12:00:00.000Z';
const COMPETITORS = ['claude-desktop', 'opencode', 'cursor', 'aider'];
const XSS = '<img src=x onerror=alert(1)>';

function support(selfStatus = 'yes', note = '') {
  const s = { self: { status: selfStatus, note, sourceIds: [] } };
  const others = ['yes', 'partial', 'no', 'unknown'];
  COMPETITORS.forEach((c, i) => { s[c] = { status: others[i], note: `${c} note`, sourceIds: ['src-1'] }; });
  return s;
}

function feature(id, title, selfStatus, priority, groupId = 'sessions') {
  return {
    id, groupId, title, description: `${title} description`,
    sentiment: { signal: 'loved', summary: `${title} sentiment summary`, sourceIds: ['src-1'] },
    support: support(selfStatus, `${title} self note`),
    recommendation: { priority, rationale: `${title} rationale`, sessionGoal: 'g' },
    firstSeenAt: T, updatedAt: T,
  };
}

function buildMatrix() {
  return {
    schemaVersion: 1,
    product: { id: 'self', name: 'Session Manager', summary: 'cockpit' },
    competitors: COMPETITORS.map((id) => ({
      id, name: `Name ${id}`, url: `https://example.com/${id}`, category: 'harness', chosenBy: 'user', why: 'popular',
    })),
    groups: [
      { id: 'tools', title: 'Tools Group', description: 'tooling' },
      { id: 'sessions', title: 'Sessions Group', description: '' },
    ],
    features: [
      feature('f-yes', 'Has it feature', 'yes', 'none'),
      feature('f-p2', 'Bravo', 'no', 'P2'),
      feature('f-p0b', 'Zulu', 'partial', 'P0'),
      feature('f-p0a', 'Alpha', 'no', 'P0'),
      feature('f-tool', 'Toolbox', 'no', 'P1', 'tools'),
      feature('f-xss', XSS, 'no', 'P3'),
    ],
    sources: [{
      id: 'src-1', url: 'https://example.com/post?a=1&b=2', title: 'Launch post', publisher: 'Example Inc',
      publishedAt: '2026-10-01', retrievedAt: T, kind: 'blog',
    }],
    runs: [
      { at: '2026-11-01T09:00:00.000Z', model: 'opus', competitors: [], added: [], changed: [], notes: 'older run' },
      { at: T, model: 'opus', competitors: ['Claude Desktop'], added: ['f-yes'], changed: [], notes: 'newer run' },
    ],
    updatedAt: T,
  };
}

function valid(m) {
  const v = validateMatrix(m);
  expect(v.error).toBeUndefined();
  return v.matrix;
}

const tags = (html) => html.match(/<[^>]*>/g) || [];

test('fixture is a valid matrix', () => {
  expect(validateMatrix(buildMatrix()).ok).toBe(true);
});

test('complete doctype document, single inline style, no script/href/src/url(', () => {
  const html = renderMatrixHtml(valid(buildMatrix()));
  expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
  expect(html).toContain('</html>');
  expect((html.match(/<style\b/gi) || []).length).toBe(1);
  expect(html).not.toMatch(/<script\b/i);
  for (const t of tags(html)) expect(t).not.toMatch(/\b(?:href|src)\s*=/i);
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  expect(css).not.toMatch(/url\(/i);
  expect(css.split('\n').length).toBeLessThan(150);
});

test('header shows product vs competitors, updatedAt date and run count', () => {
  const html = renderMatrixHtml(valid(buildMatrix()));
  const header = html.match(/<header>([\s\S]*?)<\/header>/)[1];
  expect(header).toContain('Session Manager');
  for (const c of COMPETITORS) expect(header).toContain(`Name ${c}`);
  expect(header).toContain('2026-11-08');
  expect(header).toContain('2 runs');
});

test('one table per group in groups order, self column first, rows sorted by priority then title', () => {
  const html = renderMatrixHtml(valid(buildMatrix()));
  const tables = html.match(/<table>[\s\S]*?<\/table>/g);
  expect(tables.length).toBe(2);
  expect(html.indexOf('Tools Group')).toBeLessThan(html.indexOf('Sessions Group'));
  expect(tables[0]).toContain('Toolbox');
  const heads = tables[1].match(/<thead>[\s\S]*?<\/thead>/)[0].match(/<th[^>]*>([^<]*)<\/th>/g)
    .map((h) => h.replace(/<[^>]*>/g, ''));
  expect(heads).toEqual(['Feature', 'Session Manager', ...COMPETITORS.map((c) => `Name ${c}`)]);
  const rowTitles = tables[1].split("<tbody>")[1].match(/<tr><th class="feat">([^<]*)<\/th>/g).map((r) => r.replace(/<[^>]*>/g, ''));
  expect(rowTitles).toEqual(['Alpha', 'Zulu', 'Bravo', escapeHtml(XSS), 'Has it feature']);
  // cell count: one per product per row
  const firstRow = tables[1].match(/<tbody><tr>[\s\S]*?<\/tr>/)[0];
  expect((firstRow.match(/<td>/g) || []).length).toBe(5);
});

test('cells show status symbol + label and the note', () => {
  const html = renderMatrixHtml(valid(buildMatrix()));
  expect(html).toContain('✓ Has it');
  expect(html).toContain('◐ Partial');
  expect(html).toContain('✗ Missing');
  expect(html).toContain('? Unknown');
  expect(html).toContain('Alpha self note');
  expect(html).toContain('claude-desktop note');
});

test('recommendations list missingFeatures with priority and rationale', () => {
  const html = renderMatrixHtml(valid(buildMatrix()));
  const sec = html.match(/<h2>Recommendations<\/h2>([\s\S]*?)<\/section>/)[1];
  const order = ['Alpha', 'Zulu', 'Toolbox', 'Bravo'].map((t) => sec.indexOf(`<strong>${t}</strong>`));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect(order).toEqual(order.slice().sort((a, b) => a - b));
  expect(sec).toContain('P0');
  expect(sec).toContain('Alpha rationale');
  expect(sec).not.toContain('Has it feature');
});

test('feature details, sources and run history newest first', () => {
  const html = renderMatrixHtml(valid(buildMatrix()));
  const details = html.match(/<h2>Feature details<\/h2>([\s\S]*?)<\/section>/)[1];
  expect(details).toContain('Alpha description');
  expect(details).toContain('loved');
  expect(details).toContain('Alpha sentiment summary');
  const sources = html.match(/<h2>Sources<\/h2>([\s\S]*?)<\/section>/)[1];
  expect(sources).toContain('Launch post');
  expect(sources).toContain('Example Inc');
  expect(sources).toContain('2026-10-01');
  expect(sources).toContain('https://example.com/post?a=1&amp;b=2');
  const runs = html.match(/<h2>Run history<\/h2>([\s\S]*?)<\/section>/)[1];
  expect(runs.indexOf('newer run')).toBeLessThan(runs.indexOf('older run'));
  expect(runs.indexOf('newer run')).toBeGreaterThan(-1);
});

test('escapeHtml escapes & < > " \' and the XSS title appears only escaped', () => {
  expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  const html = renderMatrixHtml(valid(buildMatrix()));
  expect(html).not.toContain(XSS);
  expect(html).not.toMatch(/<img\b/i);
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
});

test('passes validateHomeHtml and stays under 1 MB for 300 features', () => {
  expect(validateHomeHtml(renderMatrixHtml(valid(buildMatrix())))).toBeNull();
  const m = buildMatrix();
  m.features = [];
  for (let i = 0; i < 300; i++) {
    const f = feature(`f-${i}`, `Feature ${i} ${'x'.repeat(100)}`, i % 2 ? 'no' : 'partial', 'P1', i % 2 ? 'tools' : 'sessions');
    f.description = 'd'.repeat(1500);
    f.sentiment.summary = 's'.repeat(400);
    f.recommendation.rationale = 'r'.repeat(300);
    m.features.push(f);
  }
  const html = renderMatrixHtml(valid(m));
  expect(Buffer.byteLength(html, 'utf8')).toBeLessThanOrEqual(1024 * 1024);
  expect(validateHomeHtml(html)).toBeNull();
});

test('zero features renders header and "No features yet", no tables', () => {
  const m = buildMatrix();
  m.features = [];
  const html = renderMatrixHtml(valid(m));
  expect(html).toContain('<header>');
  expect(html).toContain('No features yet');
  expect(html).not.toMatch(/<table\b/);
  expect(validateHomeHtml(html)).toBeNull();
});

test('light and dark colors via prefers-color-scheme: dark', () => {
  const html = renderMatrixHtml(valid(buildMatrix()));
  expect(html).toMatch(/@media \(prefers-color-scheme: dark\)\{:root\{--bg:/);
});
