/**
 * check-readme.test.cjs — README.md generated regions render from code,
 * apply idempotently, leave text outside markers alone, and report stale /
 * malformed regions with exit 1. Never touches the real README.md.
 *
 * Run: timeout 300 npx vitest run scripts/__tests__/check-readme.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '../..');
const {
  loadSources, renderRegions, applyRegions, run,
  checkGrade, checkLinks, checkRepoLinks, checkSize, checkLists, MAX_GRADE, MAX_BYTES,
} = require('../check-readme.cjs');
const { MCP_TOOL_CATALOG } = require('../../src/main/lib/mcpToolCatalog.cjs');

const fakeSources = () => ({
  catalog: [
    { name: 'tool_a', group: 'scheduler', summary: 'Does the first thing' },
    { name: 'tool_b', group: 'help', summary: 'Does the second thing' },
  ],
  tools: [
    { name: 'tool_a', inputSchema: { required: ['slug', 'cwd'] } },
    { name: 'tool_b', inputSchema: {} },
  ],
  recipes: [
    { id: 'r-one', title: 'Recipe one', steps: ['x'] },
    { id: 'r-two', title: 'Recipe two', steps: ['y'] },
  ],
  skills: ['alpha', 'beta', 'gamma'],
  nodeFloor: '22.12.0',
});

test('mcp-tools renders a table, one row per catalog entry in order', () => {
  const r = renderRegions(fakeSources());
  expect(r['mcp-tools']).toBe([
    '| Tool | Group | Required args | What it does |',
    '| --- | --- | --- | --- |',
    '| `tool_a` | scheduler | `slug`, `cwd` | Does the first thing |',
    '| `tool_b` | help | — | Does the second thing |',
  ].join('\n'));
});

test('mcp-recipes renders one list item per recipe; inline counts render', () => {
  const r = renderRegions(fakeSources());
  expect(r['mcp-recipes']).toBe('- `r-one` — Recipe one\n- `r-two` — Recipe two');
  expect(r['mcp-tool-count']).toBe('2');
  expect(r['skill-count']).toBe('3');
  expect(r['node-floor']).toBe('22.12.0');
});

test('inline and block regions are filled; outside text is byte-identical; idempotent', () => {
  const rendered = renderRegions(fakeSources());
  const before = 'Intro  \r\n has <!-- gen:mcp-tool-count -->99<!-- /gen:mcp-tool-count --> tools on Node <!-- gen:node-floor --><!-- /gen:node-floor -->+.\n\n<!-- gen:mcp-recipes -->\nold\n<!-- /gen:mcp-recipes -->\ntail ~~\n';
  const out = applyRegions(before, rendered);
  expect(out.errors).toEqual([]);
  expect(out.stale.sort()).toEqual(['mcp-recipes', 'mcp-tool-count', 'node-floor']);
  expect(out.text).toBe('Intro  \r\n has <!-- gen:mcp-tool-count -->2<!-- /gen:mcp-tool-count --> tools on Node <!-- gen:node-floor -->22.12.0<!-- /gen:node-floor -->+.\n\n<!-- gen:mcp-recipes -->\n- `r-one` — Recipe one\n- `r-two` — Recipe two\n<!-- /gen:mcp-recipes -->\ntail ~~\n');
  const again = applyRegions(out.text, rendered);
  expect(again).toEqual({ text: out.text, stale: [], errors: [] });
});

test('a README with no regions passes unchanged', () => {
  const out = applyRegions('# hi\nnothing here\n', renderRegions(fakeSources()));
  expect(out).toEqual({ text: '# hi\nnothing here\n', stale: [], errors: [] });
  expect(run('# hi\n', renderRegions(fakeSources()), false).code).toBe(0);
});

test('stale region gives exit 1 and the message', () => {
  const res = run('<!-- gen:skill-count -->1<!-- /gen:skill-count -->\n', renderRegions(fakeSources()), false);
  expect(res.code).toBe(1);
  expect(res.messages).toEqual(['README.md region skill-count is out of date. Run: npm run readme:build, then commit README.md.']);
  const ok = run('<!-- gen:skill-count -->3<!-- /gen:skill-count -->\n', renderRegions(fakeSources()), false);
  expect(ok.code).toBe(0);
});

test('--write mode returns rewritten text and exit 0', () => {
  const res = run('<!-- gen:skill-count -->1<!-- /gen:skill-count -->\n', renderRegions(fakeSources()), true);
  expect(res.code).toBe(0);
  expect(res.text).toBe('<!-- gen:skill-count -->3<!-- /gen:skill-count -->\n');
});

test('unknown, unclosed and duplicate markers are errors naming the region', () => {
  const rendered = renderRegions(fakeSources());
  const unknown = applyRegions('<!-- gen:bogus -->x<!-- /gen:bogus -->\n', rendered);
  expect(unknown.errors.join('\n')).toMatch(/unknown region bogus/);
  const unclosed = applyRegions('<!-- gen:mcp-tools -->\nrow\n', rendered);
  expect(unclosed.errors.join('\n')).toMatch(/unclosed region mcp-tools/);
  const unclosedInline = applyRegions('a <!-- gen:node-floor -->22 b\n', rendered);
  expect(unclosedInline.errors.join('\n')).toMatch(/unclosed region node-floor/);
  const strayClose = applyRegions('<!-- /gen:node-floor -->\n', rendered);
  expect(strayClose.errors.join('\n')).toMatch(/node-floor/);
  const dup = applyRegions('<!-- gen:skill-count -->3<!-- /gen:skill-count -->\n<!-- gen:skill-count -->3<!-- /gen:skill-count -->\n', rendered);
  expect(dup.errors.join('\n')).toMatch(/duplicate region skill-count/);
  const res = run('<!-- gen:bogus -->x<!-- /gen:bogus -->\n', rendered, true);
  expect(res.code).toBe(1);
  expect(res.messages.join('\n')).toMatch(/bogus/);
});

test('real sources: mcp-tools has exactly MCP_TOOL_CATALOG.length data rows', () => {
  const sources = loadSources(REPO_ROOT);
  const table = renderRegions(sources)['mcp-tools'].split('\n');
  expect(table.length - 2).toBe(MCP_TOOL_CATALOG.length);
  for (const row of table.slice(2)) expect(row.split('|').length).toBe(6);
  expect(sources.nodeFloor).toMatch(/^\d+\.\d+\.\d+$/);
  expect(sources.skills.length).toBeGreaterThan(0);
});

// ── Agent-friendly README rules ─────────────────────────────────────────────

async function loadReadability() {
  return import(/* @vite-ignore */ path.resolve(__dirname, '..', '..', 'web', 'manual', 'readability.mjs'));
}

test('MAX_GRADE and MAX_BYTES are exported with their values', () => {
  expect(MAX_GRADE).toBe(8.0);
  expect(MAX_BYTES).toBe(24000);
});

test('grade rule: plain prose passes', async () => {
  const r = await loadReadability();
  const md = '# Title\n\nThe cat sat on the mat.\n\n## Use it\n\nRun the app. It is fast.\n';
  expect(checkGrade(md, r)).toEqual([]);
});

test('grade rule: dense prose fails with overall and per-section grades, highest first', async () => {
  const r = await loadReadability();
  const dense = 'The epistemological ramifications of postmodern hermeneutical interpretation necessitate an interdisciplinary reconceptualization of institutionalized pedagogical methodologies.';
  const md = '# Title\n\nIntro text here.\n\n## Easy\n\nThe dog ran.\n\n## Hard\n\n' + dense + '\n';
  const out = checkGrade(md, r);
  expect(out.length).toBeGreaterThan(2);
  expect(out[0]).toMatch(/grade \d+\.\d .*8\.0/);
  const hard = out.findIndex((l) => l.includes('## Hard'));
  const easy = out.findIndex((l) => l.includes('## Easy'));
  expect(hard).toBeGreaterThan(0);
  expect(easy).toBeGreaterThan(hard);
});

test('link rule: https links and #anchors pass', () => {
  const md = '[a](https://x.dev/a) ![i](https://x.dev/i.png "t")\n[top](#top)\n<a href="https://x.dev">x</a> <img src="https://x.dev/y.png">\n';
  expect(checkLinks(md)).toEqual([]);
});

test('link rule: relative, http:// and file:// targets fail with line numbers', () => {
  const md = 'ok\n[rel](docs/a.md)\n![img](http://x.dev/i.png)\n<a href="file:///etc/x">x</a>\n<img src=\'./y.png\'>\n';
  const out = checkLinks(md);
  expect(out).toHaveLength(4);
  expect(out[0]).toMatch(/README\.md:2: .*docs\/a\.md/);
  expect(out[1]).toMatch(/README\.md:3: .*http:\/\/x\.dev/);
  expect(out[2]).toMatch(/README\.md:4: .*file:\/\//);
  expect(out[3]).toMatch(/README\.md:5: .*\.\/y\.png/);
});

const GH = 'https://github.com/StanislavBG/claude-code-session-manager';
const TRACKED = ['README.md', 'docs/guide.md', 'plugins/packs/apple-design/sm-pack.json'];

test('repo-link rule: blob and tree links to tracked paths pass (anchor/query removed)', () => {
  const md = `[g](${GH}/blob/main/docs/guide.md#install)\n[p](${GH}/tree/main/plugins/packs?x=1)\n[r](${GH}/blob/main/README.md)\n`;
  expect(checkRepoLinks(md, TRACKED)).toEqual([]);
});

test('repo-link rule: missing blob and tree paths fail with line numbers', () => {
  const md = `x\n[g](${GH}/blob/main/docs/gone.md#a)\n[t](${GH}/tree/main/plugin)\n`;
  const out = checkRepoLinks(md, TRACKED);
  expect(out).toHaveLength(2);
  expect(out[0]).toMatch(/README\.md:2: .*docs\/gone\.md/);
  expect(out[1]).toMatch(/README\.md:3: .*plugin/);
});

test('size rule: at the cap passes, over it fails printing the size', () => {
  expect(checkSize('a'.repeat(24000))).toEqual([]);
  const out = checkSize('é'.repeat(12001)); // 24002 bytes
  expect(out).toHaveLength(1);
  expect(out[0]).toMatch(/24002 bytes/);
});

const NAMES = { skills: ['develop', 'builder'], packs: ['apple-design'], personas: ['architect', 'dev-lead'] };

test('list rule: complete lists pass; absent regions are skipped', () => {
  const md = [
    '<!-- list:skills -->',
    '| Skill | What |', '| --- | --- |', '| `/develop` | plan |', '| `/builder` | ship |',
    '<!-- /list:skills -->',
    '<!-- list:personas -->', '- `architect` — plans', '* `dev-lead` runs `x`', '<!-- /list:personas -->',
  ].join('\n');
  expect(checkLists(md, NAMES)).toEqual([]);
  expect(checkLists('# nothing\n', NAMES)).toEqual([]);
});

test('list rule: missing and extra names are both reported', () => {
  const md = '<!-- list:packs -->\n- `apple-swift` pack\n<!-- /list:packs -->\n<!-- list:skills -->\n1. `develop`\n<!-- /list:skills -->\n';
  const out = checkLists(md, NAMES).join('\n');
  expect(out).toMatch(/packs.*missing.*apple-design/);
  expect(out).toMatch(/packs.*extra.*apple-swift/);
  expect(out).toMatch(/skills.*missing.*builder/);
  expect(checkLists('<!-- list:skills -->\n- `develop`\n', NAMES).join('\n')).toMatch(/unclosed/);
});
