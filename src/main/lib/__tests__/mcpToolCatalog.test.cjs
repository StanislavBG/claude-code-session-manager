/**
 * mcpToolCatalog.test.cjs — parity + shape gate for PRD (mcpToolCatalog):
 * asserts the catalog and the live scheduler-mcp-server.cjs TOOLS array can
 * never drift apart, that every catalog entry is a well-formed
 * documentation record, and that each tool's exampleArgs is actually
 * runnable against that tool's own inputSchema.
 *
 * Run: timeout 120 npx vitest run src/main/lib/__tests__/mcpToolCatalog.test.cjs
 */
'use strict';

import { test, expect } from 'vitest';
const path = require('node:path');
const { MCP_TOOL_CATALOG, MCP_RECIPES, CatalogEntrySchema, composeDescription } = require('../mcpToolCatalog.cjs');
// scheduler-mcp-server.cjs guards its stdio-server main() behind
// `require.main === module`, so requiring it here (require.main is the test
// runner, not this file) just loads TOOLS without opening a stdio transport.
const { TOOLS } = require(path.join(__dirname, '../../../../scripts/scheduler-mcp-server.cjs'));

const LIVE_MCP_TOOL_NAMES = TOOLS.map((t) => t.name);

test('every live MCP tool name has a catalog entry', () => {
  const catalogNames = new Set(MCP_TOOL_CATALOG.map((e) => e.name));
  const missing = LIVE_MCP_TOOL_NAMES.filter((n) => !catalogNames.has(n));
  expect(missing).toEqual([]);
});

test('every catalog entry corresponds to a live MCP tool', () => {
  const liveNames = new Set(LIVE_MCP_TOOL_NAMES);
  const extra = MCP_TOOL_CATALOG.filter((e) => !liveNames.has(e.name)).map((e) => e.name);
  expect(extra).toEqual([]);
});

test.each(TOOLS)('$name description is composed from the catalog, not a separate literal', (tool) => {
  const entry = MCP_TOOL_CATALOG.find((e) => e.name === tool.name);
  expect(entry).toBeTruthy();
  expect(tool.description).toBe(composeDescription(entry));
  expect(tool.description.length).toBeGreaterThan(0);
});

test.each(MCP_TOOL_CATALOG)('$name has all required catalog fields', (entry) => {
  expect(() => CatalogEntrySchema.parse(entry)).not.toThrow();
  expect(entry.name).toBeTruthy();
  expect(entry.group).toBeTruthy();
  expect(entry.purpose).toBeTruthy();
  expect(entry.whenToUse).toBeTruthy();
  expect(entry.whenNotToUse).toBeTruthy();
  expect(entry.exampleArgs).toBeTruthy();
});

test('a catalog entry missing a required field fails schema validation', () => {
  const broken = {
    name: 'some_tool',
    group: 'scheduler',
    purpose: '',
    whenToUse: 'x',
    whenNotToUse: 'y',
    exampleArgs: {},
    notes: null,
  };
  expect(() => CatalogEntrySchema.parse(broken)).toThrow();

  const missingField = {
    name: 'some_tool',
    group: 'scheduler',
    purpose: 'x',
    whenToUse: 'y',
    // whenNotToUse omitted entirely
    exampleArgs: {},
    notes: null,
  };
  expect(() => CatalogEntrySchema.parse(missingField)).toThrow();
});

test.each(MCP_TOOL_CATALOG)('$name composeDescription joins purpose/whenToUse/whenNotToUse/notes deterministically', (entry) => {
  const expected = [entry.purpose, entry.whenToUse, entry.whenNotToUse, entry.notes].filter(Boolean).join(' ');
  expect(composeDescription(entry)).toBe(expected);
  expect(composeDescription(entry).length).toBeGreaterThan(0);
});

test('project-home group lists the page/video tools and the two aliases', () => {
  expect(MCP_TOOL_CATALOG.filter((e) => e.group === 'project-home').map((e) => e.name)).toEqual([
    'project_home_write', 'project_page_write', 'project_matrix_read', 'project_matrix_write',
    'project_video_write', 'project_demo_video_write', 'project_character_write',
  ]);
});

test('project_matrix_read/write catalog entries document the warm-start load and the single save', () => {
  const entry = (n) => MCP_TOOL_CATALOG.find((x) => x.name === n);
  const read = entry('project_matrix_read');
  const write = entry('project_matrix_write');
  for (const e of [read, write]) {
    expect(e.group).toBe('project-home');
    for (const k of ['purpose', 'whenToUse', 'whenNotToUse', 'notes']) expect(typeof e[k]).toBe('string');
    expect(e.notes).toContain('SM_PROJECT_ROOT');
  }
  expect(composeDescription(read)).toContain('JSON Schema');
  expect(composeDescription(write)).toContain('matrixPath');
  expect(composeDescription(write)).toContain('project_matrix_read');
  expect(write.exampleArgs).toEqual({ matrixPath: '/home/bilko/.cache/competitive-matrix/run/matrix.json', model: 'claude-opus-5-5' });
});

test('aliases say so and no page text invites <script>', () => {
  const entry = (n) => MCP_TOOL_CATALOG.find((x) => x.name === n);
  const textOf = (n) => composeDescription(entry(n));
  expect(textOf('project_home_write')).toMatch(/ALIAS of project_page_write.*Overview page/);
  expect(textOf('project_demo_video_write')).toMatch(/ALIAS of project_video_write.*adds a project-demo video/);
  for (const n of ['project_home_write', 'project_page_write']) {
    expect(textOf(n)).toContain('inline <style> only');
    expect(textOf(n)).toContain('scripts never run');
    expect(textOf(n)).not.toMatch(/<style>\/<script>/);
    expect(textOf(n).replace(/<script src>/g, '')).not.toContain('<script');
  }
  expect(textOf('project_home_write')).toContain('knowledge/overview');
  expect(textOf('project_demo_video_write')).toContain('videos/');
  expect(textOf('project_home_write')).not.toContain('home.html');
  for (const e of MCP_TOOL_CATALOG) expect(composeDescription(e)).not.toContain('The only write path for the demo video');
  expect(entry('project_page_write').exampleArgs).toHaveProperty('pageId');
  expect(entry('project_video_write').exampleArgs).toHaveProperty('lengthS');
});

test('customer_feedback_submit text covers goal, description, images, consent and warning; no {F} wording', () => {
  const e = MCP_TOOL_CATALOG.find((x) => x.name === 'customer_feedback_submit');
  const text = composeDescription(e);
  for (const s of ['goal', 'description', 'up to 5', 'PNG/JPEG/WebP/GIF', 'absolute path', 'Attached: <path>',
    'exact goal, description, tag and image list', 'only after they agree', 'Never attach an image the human did not ask to send',
    'warning']) {
    expect(text).toContain(s);
  }
  expect(Object.keys(e.exampleArgs).sort()).toEqual(['description', 'goal', 'imagePaths', 'tag']);
  for (const x of MCP_TOOL_CATALOG) expect(composeDescription(x)).not.toContain('{F}');
});

test('MCP_RECIPES covers queue-work, unstick-needs-review, and hand-off-to-another-project', () => {
  const ids = MCP_RECIPES.map((r) => r.id);
  expect(ids).toContain('queue-work-via-develop');
  expect(ids).toContain('unstick-needs-review-job');
  expect(ids).toContain('hand-finding-to-another-project');
  // the single-tool project_home_write needs no recipe; the old 4-step one is gone
  expect(ids).not.toContain('generate-project-home');
  for (const recipe of MCP_RECIPES) {
    expect(recipe.title).toBeTruthy();
    expect(Array.isArray(recipe.steps)).toBe(true);
    expect(recipe.steps.length).toBeGreaterThan(0);
  }
});

test.each(MCP_TOOL_CATALOG)('$name exampleArgs satisfies its own inputSchema required fields', (entry) => {
  const tool = TOOLS.find((t) => t.name === entry.name);
  expect(tool).toBeTruthy();
  const required = tool.inputSchema?.required ?? [];
  for (const key of required) {
    expect(Object.prototype.hasOwnProperty.call(entry.exampleArgs, key)).toBe(true);
    expect(entry.exampleArgs[key]).not.toBeUndefined();
  }
});

test('htmlPath guidance lives only on project_demo_video_write', () => {
  const textOf = (name) => {
    const e = MCP_TOOL_CATALOG.find((x) => x.name === name);
    return [e.purpose, e.whenToUse, e.whenNotToUse, e.notes].filter(Boolean).join(' ');
  };
  expect(textOf('project_home_write')).not.toContain('htmlPath');
  const demo = MCP_TOOL_CATALOG.find((x) => x.name === 'project_demo_video_write');
  expect(demo.whenToUse).toContain('htmlPath');
});

test('feedback_open_session advertises the structured proposal contract', () => {
  const tool = TOOLS.find((t) => t.name === 'feedback_open_session');
  expect(tool.inputSchema.required).toEqual(['toCwd', 'fromCwd', 'title', 'motivation', 'acceptanceCriteria', 'body']);
  expect(tool.inputSchema.properties.series.required).toEqual(['key', 'title', 'index', 'total']);
  expect(tool.inputSchema.properties.plan.description).toMatch(/feature/);
  const entry = MCP_TOOL_CATALOG.find((e) => e.name === 'feedback_open_session');
  expect(entry.exampleArgs).toHaveProperty('motivation');
  expect(entry.exampleArgs).toHaveProperty('acceptanceCriteria');
  expect(entry.exampleArgs).toHaveProperty('plan');
  expect(entry.exampleArgs).toHaveProperty('series');
});

test('epic_list requires only cwd; epic_get requires cwd plus exactly one of id / externalRef', () => {
  const list = TOOLS.find((t) => t.name === 'epic_list');
  expect(list.inputSchema.required).toEqual(['cwd']);
  expect(Object.keys(list.inputSchema.properties).sort()).toEqual(['cwd', 'limit', 'offset', 'state']);
  const get = TOOLS.find((t) => t.name === 'epic_get');
  expect(get.inputSchema.required).toEqual(['cwd']);
  expect(Object.keys(get.inputSchema.properties).sort()).toEqual(['cwd', 'externalRef', 'id', 'receipt']);
  const entry = MCP_TOOL_CATALOG.find((e) => e.name === 'epic_get');
  expect(entry.requiredOneOf).toEqual([['id', 'externalRef']]);
  for (const name of ['epic_list', 'epic_get']) {
    expect(MCP_TOOL_CATALOG.find((e) => e.name === name).group).toBe('epics');
  }
});

test('agent_list takes one optional cwd, sits in the agents group and its description comes from the catalog', () => {
  const tool = TOOLS.find((t) => t.name === 'agent_list');
  expect(tool).toBeDefined();
  expect(Object.keys(tool.inputSchema.properties)).toEqual(['cwd']);
  expect(tool.inputSchema.required).toBeUndefined();
  const entry = MCP_TOOL_CATALOG.find((e) => e.name === 'agent_list');
  expect(entry.group).toBe('agents');
  expect(tool.description).toBe(composeDescription(entry));
});

test('epic_get with both id and externalRef is refused before any admin call', async () => {
  const { handleCallTool } = require(path.join(__dirname, '../../../../scripts/scheduler-mcp-server.cjs'));
  const saved = process.env.SM_SCHEDULER_JOB_MCP_TOOLS;
  delete process.env.SM_SCHEDULER_JOB_MCP_TOOLS;
  try {
    const result = await handleCallTool({ params: { name: 'epic_get', arguments: { cwd: '/tmp/x', id: 'a', externalRef: 'b' } } });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('exactly one of');
  } finally {
    if (saved !== undefined) process.env.SM_SCHEDULER_JOB_MCP_TOOLS = saved;
  }
});

test('scheduler_create_prd does not require estimateMinutes but keeps the other required fields', () => {
  const tool = TOOLS.find((t) => t.name === 'scheduler_create_prd');
  const required = tool.inputSchema.required;
  expect(required).not.toContain('estimateMinutes');
  for (const f of ['title', 'goal', 'acceptanceCriteria', 'implementationNotes', 'gate', 'files']) {
    expect(required).toContain(f);
  }
  const entry = MCP_TOOL_CATALOG.find((e) => e.name === 'scheduler_create_prd');
  expect(entry.exampleArgs).not.toHaveProperty('estimateMinutes');
});

test('scheduler_create_prd files/estimateMinutes wording reflects files-overlap hold and persona default', () => {
  const entry = MCP_TOOL_CATALOG.find((e) => e.name === 'scheduler_create_prd');
  expect(entry.purpose).toMatch(/never runs two PRDs with overlapping files at once/);
  expect(entry.purpose).toMatch(/real output or order dependencies/);
  expect(entry.purpose).not.toMatch(/must not share a file/);
  const tool = TOOLS.find((t) => t.name === 'scheduler_create_prd');
  const files = tool.inputSchema.properties.files.description;
  expect(files).toMatch(/never runs two PRDs with overlapping files at once/);
  expect(files).toMatch(/real output or order dependencies/);
  expect(tool.inputSchema.properties.estimateMinutes.description).toMatch(/defaultEstimateMinutes.*45-minute/);
});

test('project_demo_video_write whenToUse advertises 5-60 seconds', () => {
  const demo = MCP_TOOL_CATALOG.find((x) => x.name === 'project_demo_video_write');
  expect(demo.whenToUse).toContain('5-60 seconds');
  expect(demo.whenToUse).not.toContain('5-30');
});

// ── summary field (readme-mcp-tool-summaries) ─────────────────────────────
// `summary` is the one plain-language line the npm README's generated MCP
// tool table shows. It must stay out of the live description.

const BANNED_SUMMARY_PHRASES = ['admin API', 'THE ONLY', 'session-manager app'];

test.each(MCP_TOOL_CATALOG)('$name has a schema-valid plain-language summary', (entry) => {
  expect(typeof entry.summary).toBe('string');
  expect(() => CatalogEntrySchema.shape.summary.parse(entry.summary)).not.toThrow();
  expect(entry.summary).toMatch(/^[A-Z]/);
  expect(entry.summary.endsWith('.')).toBe(true);
  for (const phrase of BANNED_SUMMARY_PHRASES) expect(entry.summary).not.toContain(phrase);
});

test('summary schema rejects pipes, backticks, newlines and bad lengths', () => {
  const s = CatalogEntrySchema.shape.summary;
  expect(() => s.parse('Too short')).toThrow();
  expect(() => s.parse('x'.repeat(91))).toThrow();
  expect(() => s.parse('Has a | pipe in it.')).toThrow();
  expect(() => s.parse('Has a `tick` in it.')).toThrow();
  expect(() => s.parse('Two lines\nin this one.')).toThrow();
  expect(() => s.parse('A fine summary line.')).not.toThrow();
});

test('catalog has 35 entries and every summary is unique', () => {
  expect(MCP_TOOL_CATALOG).toHaveLength(35);
  const summaries = MCP_TOOL_CATALOG.map((e) => e.summary);
  expect(new Set(summaries).size).toBe(summaries.length);
});

test('summaries read at grade 8 or lower on average, none above grade 12', async () => {
  const { fleschKincaidGrade } = await import(
    /* @vite-ignore */ path.resolve(__dirname, '../../../../web/manual/readability.mjs')
  );
  const grades = MCP_TOOL_CATALOG.map((e) => ({ name: e.name, grade: fleschKincaidGrade(e.summary) }));
  const mean = grades.reduce((sum, g) => sum + g.grade, 0) / grades.length;
  expect(mean).toBeLessThanOrEqual(8.0);
  expect(grades.filter((g) => g.grade > 12.0)).toEqual([]);
});

test.each(MCP_TOOL_CATALOG)('$name composeDescription ignores summary', (entry) => {
  expect(composeDescription({ ...entry, summary: 'Changed.' })).toBe(composeDescription(entry));
});

// requiredOneOf: groups of args where the handler refuses a call missing the
// whole group ('exactly one of'). README renders it; live descriptions don't.
const ONE_OF_TOOLS = MCP_TOOL_CATALOG.filter((e) => e.requiredOneOf);

test('requiredOneOf is set on exactly the tools whose handler resolves exactly one of a group', () => {
  expect(ONE_OF_TOOLS.map((e) => e.name).sort()).toEqual([
    'epic_get',
    'project_character_write',
    'project_demo_video_write',
    'project_matrix_write',
    'project_page_write',
    'project_video_write',
  ]);
});

test('requiredOneOf schema: optional, groups of 2+ names', () => {
  const base = { name: 't', group: 'help', purpose: 'p', summary: 'A summary line here', whenToUse: 'u', whenNotToUse: 'n', exampleArgs: {}, notes: null };
  expect(() => CatalogEntrySchema.parse(base)).not.toThrow();
  expect(() => CatalogEntrySchema.parse({ ...base, requiredOneOf: [['a', 'b']] })).not.toThrow();
  expect(() => CatalogEntrySchema.parse({ ...base, requiredOneOf: [['a']] })).toThrow();
  expect(() => CatalogEntrySchema.parse({ ...base, requiredOneOf: ['a'] })).toThrow();
});

test.each(ONE_OF_TOOLS)('$name requiredOneOf names exist in its inputSchema.properties', (entry) => {
  const tool = TOOLS.find((t) => t.name === entry.name);
  const props = Object.keys(tool.inputSchema.properties || {});
  for (const group of entry.requiredOneOf) {
    expect(group.length).toBeGreaterThanOrEqual(2);
    for (const arg of group) expect(props).toContain(arg);
  }
});

test.each(ONE_OF_TOOLS)('$name handler refuses a call missing a whole requiredOneOf group', async (entry) => {
  const { handleCallTool } = require(path.join(__dirname, '../../../../scripts/scheduler-mcp-server.cjs'));
  const saved = process.env.SM_SCHEDULER_JOB_MCP_TOOLS;
  delete process.env.SM_SCHEDULER_JOB_MCP_TOOLS;
  try {
    for (const group of entry.requiredOneOf) {
      const args = { ...entry.exampleArgs };
      for (const arg of group) delete args[arg];
      const result = await handleCallTool({ params: { name: entry.name, arguments: args } });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('exactly one of');
    }
  } finally {
    if (saved !== undefined) process.env.SM_SCHEDULER_JOB_MCP_TOOLS = saved;
  }
});

test.each(MCP_TOOL_CATALOG)('$name composeDescription ignores requiredOneOf', (entry) => {
  expect(composeDescription({ ...entry, requiredOneOf: [['zz_a', 'zz_b']] })).toBe(composeDescription(entry));
  expect(composeDescription(entry)).not.toContain('zz_a');
});
