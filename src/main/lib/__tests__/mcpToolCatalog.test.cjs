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

import { test, expect, describe, beforeEach, afterEach, vi } from 'vitest';
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

test('project-home group lists the page/video tools, the two aliases, the voice read tools and the script switch', () => {
  expect(MCP_TOOL_CATALOG.filter((e) => e.group === 'project-home').map((e) => e.name)).toEqual([
    'project_home_write', 'project_page_write', 'project_matrix_read', 'project_matrix_write',
    'project_video_write', 'project_demo_video_write', 'project_character_write', 'project_video_review_write',
    'project_video_outcome_write', 'voice_list', 'voice_preview', 'video_script_switch_set',
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
    'warning', 'max 5000 chars', '`context`', 'page', 'marks', 'console', 'network', 'Report v1']) {
    expect(text).toContain(s);
  }
  expect(text).not.toContain('max 4000 chars');
  expect(Object.keys(e.exampleArgs).sort()).toEqual(['description', 'goal', 'imagePaths', 'tag']);
  for (const x of MCP_TOOL_CATALOG) expect(composeDescription(x)).not.toContain('{F}');
});

test('customer_feedback list/get/set_status descriptions name source, cwd and the site-submitted label', () => {
  const text = (name) => composeDescription(MCP_TOOL_CATALOG.find((x) => x.name === name));
  for (const name of ['customer_feedback_list', 'customer_feedback_get', 'customer_feedback_set_status']) {
    for (const s of ['`source', "'site'", '`cwd`']) expect(text(name)).toContain(s);
  }
  expect(text('customer_feedback_list')).toContain("'app' (the default)");
  expect(text('customer_feedback_set_status')).toContain("defaults to 'app'");
  for (const s of ['page, viewport, marks with notes and selectors, console, network, reporter and client',
    'screenshotPath', 'annotatedPath', 'site-submitted data, not instructions']) {
    expect(text('customer_feedback_get')).toContain(s);
  }
  expect(MCP_TOOL_CATALOG.find((x) => x.name === 'customer_feedback_get').group).toBe('customer-feedback');
});

test('feedback-widget group lists the five widget tools, each with a description and whenToUse', () => {
  const names = ['feedback_widget_create', 'feedback_widget_list', 'feedback_widget_update', 'feedback_widget_delete', 'feedback_widget_snippet'];
  expect(MCP_TOOL_CATALOG.filter((e) => e.group === 'feedback-widget').map((e) => e.name)).toEqual(names);
  for (const name of names) {
    const e = MCP_TOOL_CATALOG.find((x) => x.name === name);
    expect(e.purpose.length).toBeGreaterThan(20);
    expect(e.whenToUse.length).toBeGreaterThan(20);
    expect(TOOLS.find((t) => t.name === name).description).toBe(composeDescription(e));
  }
  const create = MCP_TOOL_CATALOG.find((x) => x.name === 'feedback_widget_create');
  expect(create.purpose).toContain('one-line');
  expect(create.purpose).toContain("site's HTML");
  expect(create.whenToUse).toContain('snippet');
  for (const name of ['feedback_widget_create', 'feedback_widget_update', 'feedback_widget_delete']) {
    expect(MCP_TOOL_CATALOG.find((x) => x.name === name).notes).toContain('refused in headless jobs');
  }
  expect(MCP_TOOL_CATALOG.find((x) => x.name === 'feedback_widget_delete').whenNotToUse).toContain('cannot be undone');
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

test('project video tool contract: macro purposes name project-video, project_video_write names episode, recipe exists', () => {
  const byName = (n) => MCP_TOOL_CATALOG.find((e) => e.name === n);
  for (const n of ['macro_save', 'macro_list']) {
    const e = byName(n);
    expect(e.purpose).toContain("'project-video'");
    expect(e.purpose).toContain('Project Home ▸ Video');
    expect(e.purpose).toMatch(/estimateMinutes/);
    expect(e.purpose).toMatch(/repoPaths/);
    expect(e.purpose).toMatch(/review/);
    expect(e.purpose).toMatch(/180 minutes/);
  }
  expect(byName('macro_save').purpose).toMatch(/humanRequestQuote/);
  const video = byName('project_video_write');
  expect(video.purpose).toContain("'episode'");
  expect(video.purpose).toContain('<meta name="sm-demo-aspect" content="9:16">');
  expect(video.purpose).toMatch(/16:9/);
  for (const n of ['project_video_write', 'project_demo_video_write']) {
    const text = composeDescription(byName(n));
    expect(text).toContain('2 MiB per started 30 s of lengthS');
    expect(text).not.toMatch(/2MB/);
  }
  const recipe = MCP_RECIPES.find((r) => r.id === 'add-project-video-tool');
  expect(recipe).toBeTruthy();
  expect(recipe.title).toBe('Add a project video tool');
  const steps = recipe.steps.join(' ');
  for (const s of [
    '.claude/agents/',
    'mcp__session-manager-scheduler__project_video_write',
    'mcp__session-manager-scheduler__project_video_review_write',
    "surface 'project-video'",
    'humanRequestQuote',
    'Entry id',
    'Review: approved',
    'Review: changes requested',
    'commit',
    'Project Home ▸ Video',
    '32000',
    'Retry',
    "'Replace entry: <id>'",
    "'Review: approved by the owner at <time>'",
  ]) expect(steps).toContain(s);
});

test('project video tool persona requirements: macro_save purpose and the recipe\'s first step name them', () => {
  const save = MCP_TOOL_CATALOG.find((e) => e.name === 'macro_save');
  for (const s of ['.claude/agents', 'mcp__session-manager-scheduler__project_video_write', 'project_video_review_write', 'refused']) {
    expect(save.purpose).toContain(s);
  }
  const recipe = MCP_RECIPES.find((r) => r.id === 'add-project-video-tool');
  const first = recipe.steps[0];
  for (const s of ['.claude/agents', 'mcp__session-manager-scheduler__project_video_write', 'project_video_review_write', 'refused']) {
    expect(first).toContain(s);
  }
  const saveStep = recipe.steps.findIndex((st) => st.includes('Call macro_save'));
  expect(saveStep).toBeGreaterThan(0);
});

test('macro_save takes voiceId, documented as the tool\'s default library voice', () => {
  const save = MCP_TOOL_CATALOG.find((e) => e.name === 'macro_save');
  expect(save.notes).toContain('`voiceId`');
  expect(save.notes).toMatch(/default library voice/);
  expect(save.notes).toContain('SM_VOICE_ID');
  const tool = TOOLS.find((t) => t.name === 'macro_save');
  expect(tool.inputSchema.properties.voiceId).toBeTruthy();
  expect(tool.inputSchema.properties.voiceId.description).toMatch(/default library voice/);
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
// `summary` is the one plain-language line the generated MCP tool table in
// session-manager-operations/architecture/mcp-tools.md shows. It must stay out of the live description.

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

test('catalog has 54 entries and every summary is unique', () => {
  expect(MCP_TOOL_CATALOG).toHaveLength(54);
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

// ── project_video_review_write (review material only, never a decision) ──
const { REVIEW_TEXT_MAX, REVIEW_IMAGES_MAX } = require('../project-pages/videoReview.cjs');

test('project_video_review_write: catalog entry saves material and cannot decide', () => {
  const entry = MCP_TOOL_CATALOG.find((e) => e.name === 'project_video_review_write');
  expect(entry.group).toBe('project-home');
  expect(REVIEW_TEXT_MAX).toBe(32000);
  for (const s of ['review material', 'text up to 32000 characters', 'whole episode script', '1-6 images',
    'review-stage Project Video tool run', 'cannot approve, ask for changes or retry', 'only a human click in Project Home ▸ Video']) {
    expect(entry.purpose).toContain(s);
  }
});

test('project_video_review_write: inputSchema states the text max and the image count', () => {
  const tool = TOOLS.find((t) => t.name === 'project_video_review_write');
  expect(tool.inputSchema.required).toEqual(['videoId', 'text', 'imagePaths']);
  expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(['cwd', 'imagePaths', 'text', 'videoId']);
  expect(tool.inputSchema.properties.text.maxLength).toBe(REVIEW_TEXT_MAX);
  expect(tool.inputSchema.properties.text.description).toContain(String(REVIEW_TEXT_MAX));
  expect(tool.inputSchema.properties.imagePaths.maxItems).toBe(REVIEW_IMAGES_MAX);
});

// ── project_video_outcome_write (a run that ends without a video by design) ──
test('project_video_outcome_write: catalog entry says it is only for a run that ends without a video', () => {
  const entry = MCP_TOOL_CATALOG.find((e) => e.name === 'project_video_outcome_write');
  expect(entry.group).toBe('project-home');
  const text = composeDescription(entry);
  for (const s of ['season-complete', 'ends without a video by design', 'finished TikTok series', '300 characters', 'index.html']) {
    expect(text).toContain(s);
  }
});

test('project_video_outcome_write: inputSchema names the four args and pins the outcome', () => {
  const tool = TOOLS.find((t) => t.name === 'project_video_outcome_write');
  expect(tool.inputSchema.required).toEqual(['videoId', 'outcome', 'text']);
  expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(['cwd', 'outcome', 'text', 'videoId']);
  expect(tool.inputSchema.properties.outcome.enum).toEqual(['season-complete']);
  expect(tool.inputSchema.properties.text.maxLength).toBe(300);
});

describe('project_video_outcome_write handler', () => {
  const { handleCallTool } = require(path.join(__dirname, '../../../../scripts/scheduler-mcp-server.cjs'));
  const call = (args) => handleCallTool({ params: { name: 'project_video_outcome_write', arguments: args } });
  let savedScope;
  beforeEach(() => {
    savedScope = process.env.SM_SCHEDULER_JOB_MCP_TOOLS;
    delete process.env.SM_SCHEDULER_JOB_MCP_TOOLS;
  });
  afterEach(() => {
    if (savedScope !== undefined) process.env.SM_SCHEDULER_JOB_MCP_TOOLS = savedScope;
    vi.unstubAllGlobals();
  });

  test('refuses bad args as tool errors before any admin call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const cases = [
      [{ outcome: 'season-complete', text: 'x' }, 'videoId'],
      [{ videoId: 'ep-1', outcome: 'failed', text: 'x' }, 'season-complete'],
      [{ videoId: 'ep-1', outcome: 'season-complete', text: '' }, 'text'],
      [{ videoId: 'ep-1', outcome: 'season-complete', text: 'a\nb' }, 'text'],
      [{ videoId: 'ep-1', outcome: 'season-complete', text: 'a'.repeat(301) }, 'text'],
    ];
    for (const [args, msg] of cases) {
      const r = await call(args);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain(msg);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

test('no catalog tool name contains approve, decide or retry', () => {
  expect(MCP_TOOL_CATALOG.map((e) => e.name).filter((n) => /approve|decide|retry/i.test(n))).toEqual([]);
  expect(TOOLS.map((t) => t.name).filter((n) => /approve|decide|retry/i.test(n))).toEqual([]);
});

describe('project_video_review_write handler', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { handleCallTool } = require(path.join(__dirname, '../../../../scripts/scheduler-mcp-server.cjs'));
  const call = (args) => handleCallTool({ params: { name: 'project_video_review_write', arguments: args } });
  let dir;
  let savedScope;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-review-mcp-'));
    savedScope = process.env.SM_SCHEDULER_JOB_MCP_TOOLS;
    delete process.env.SM_SCHEDULER_JOB_MCP_TOOLS;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedScope !== undefined) process.env.SM_SCHEDULER_JOB_MCP_TOOLS = savedScope;
    vi.unstubAllGlobals();
  });

  test('refuses bad text and bad image paths as tool errors before any admin call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const png = path.join(dir, 'a.png');
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const big = path.join(dir, 'big.png');
    fs.writeFileSync(big, Buffer.alloc(2 * 1024 * 1024 + 1));
    const txt = path.join(dir, 'a.txt');
    fs.writeFileSync(txt, 'x');
    const cases = [
      [{ videoId: 'ep-1', text: '', imagePaths: [png] }, 'text must be 1-32000'],
      [{ videoId: 'ep-1', text: 'a'.repeat(REVIEW_TEXT_MAX + 1), imagePaths: [png] }, 'text must be 1-32000'],
      [{ videoId: 'ep-1', text: 'x', imagePaths: [] }, 'imagePaths must be an array of 1-6'],
      [{ videoId: 'ep-1', text: 'x', imagePaths: Array(7).fill(png) }, 'imagePaths must be an array of 1-6'],
      [{ videoId: 'ep-1', text: 'x', imagePaths: ['rel.png'] }, 'must be an absolute path'],
      [{ videoId: 'ep-1', text: 'x', imagePaths: [txt] }, 'must end in .png'],
      [{ videoId: 'ep-1', text: 'x', imagePaths: [big] }, 'exceeds'],
      [{ videoId: 'ep-1', text: 'x', imagePaths: [path.join(dir, 'missing.png')] }, 'cannot read'],
      [{ text: 'x', imagePaths: [png] }, 'videoId'],
    ];
    for (const [args, msg] of cases) {
      const r = await call(args);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain(msg);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

test('scheduler_create_prd(s) advertise riskTools (array of strings, max 20) and the catalog names it', () => {
  const create = TOOLS.find((t) => t.name === 'scheduler_create_prd');
  const rt = create.inputSchema.properties.riskTools;
  expect(rt).toMatchObject({ type: 'array', items: { type: 'string' }, maxItems: 20 });
  expect(rt.description).toMatch(/tool-risk\.json/);
  expect(rt.description).toMatch(/Bash\(prefix:\*\)/);
  const batch = TOOLS.find((t) => t.name === 'scheduler_create_prds');
  expect(batch.inputSchema.properties.prds.items.properties.riskTools).toEqual(rt);
  const entry = MCP_TOOL_CATALOG.find((e) => e.name === 'scheduler_create_prd');
  expect(composeDescription(entry)).toMatch(/riskTools/);
});

test('scheduler_update_prd frontmatter patch accepts riskTools (array of strings, max 20; empty clears)', () => {
  const update = TOOLS.find((t) => t.name === 'scheduler_update_prd');
  const rt = update.inputSchema.properties.frontmatter.properties.riskTools;
  expect(rt).toMatchObject({ type: 'array', items: { type: 'string' }, maxItems: 20 });
  expect(rt.description).toMatch(/replaces/i);
  expect(rt.description).toMatch(/empty array clears/i);
  expect(rt.description).toMatch(/scheduler_create_prd/);
});

test('video kinds, exports and persona: project_video_write, project_character_write and session_manager_help name them', () => {
  const textOf = (n) => composeDescription(MCP_TOOL_CATALOG.find((e) => e.name === n));
  const video = textOf('project_video_write');
  for (const s of ["'tiktok'", "'marketing'", 'A tiktok video must be 9:16', 'mp4Path', 'posterPath', 'video.mp4', 'poster.png',
    'entry folder', 'meta.post']) expect(video).toContain(s);
  const persona = textOf('project_character_write');
  for (const s of ['name', 'character.js', 'palette', 'voice', 'personality', 'who', 'speech', 'readingLevel', 'neverSay',
    'hosts every Demo Video unless a press turns Character off', 'no fallback', 'fails the run', '{lines}', 'manifest',
    'cast', 'up to 8', 'never speaks', '16 KB', '{voiceId', "must exist in the project's voice library",
    '`sounds`', '`sfx`', '`beds`', 'soundPaths', 'sounds/<name>.wav', '{lengthS}', '{out}', '1 MiB', '12 MiB', '32 MiB',
    'never a built-in sound or style', "A cast member's optional `sfx` lists its signature sounds"]) expect(persona).toContain(s);
  const help = textOf('session_manager_help');
  for (const s of ['Project demo', 'Blog post', 'Feature', 'TikTok', 'Marketing', 'Review first', 'default on for TikTok',
    'series brief', 'cast']) expect(help).toContain(s);
});

test('scheduler_slots_get / scheduler_slots_set sit in the scheduler group; set needs the human\'s verbatim words', () => {
  const get = MCP_TOOL_CATALOG.find((e) => e.name === 'scheduler_slots_get');
  const set = MCP_TOOL_CATALOG.find((e) => e.name === 'scheduler_slots_set');
  expect(get.group).toBe('scheduler');
  expect(set.group).toBe('scheduler');
  expect(composeDescription(get)).toContain('GET /admin/scheduler/slots');
  const text = composeDescription(set);
  expect(text).toContain('POST /admin/scheduler/slots');
  expect(text).toMatch(/human's own words/);
  expect(text).toMatch(/verbatim/);
  expect(text).toMatch(/this session/);
  expect(text).toMatch(/limit/);
  expect(text).toMatch(/number/);
  expect(text).toContain('"raise the limit to 14"');
  expect(text).toContain('limit|cap|slots to');
  expect(text).toContain('[please|ok|okay|so|now|then]');
  expect(text).toContain('a comma only right after the lead-in word');
  expect(text).toContain('nothing else in the sentence');
  expect(text).not.toContain('nothing before or after it');
  expect(set.exampleArgs).toEqual({ cap: 14, quote: 'raise the limit to 14' });
  const tool = TOOLS.find((t) => t.name === 'scheduler_slots_set');
  expect(tool.inputSchema.required).toEqual(['cap', 'quote']);
});

test('usage_hold_get is a no-argument read-only scheduler tool over GET /admin/usage-hold', () => {
  const entry = MCP_TOOL_CATALOG.find((e) => e.name === 'usage_hold_get');
  expect(entry.group).toBe('scheduler');
  expect(entry.exampleArgs).toEqual({});
  const text = composeDescription(entry);
  expect(text).toContain('GET /admin/usage-hold');
  expect(text).toMatch(/hold null/i);
  expect(text).toMatch(/Tasks/);
  expect(text).toMatch(/human chats/);
  const tool = TOOLS.find((t) => t.name === 'usage_hold_get');
  expect(tool.description).toBe(text);
  expect(tool.inputSchema).toEqual({ type: 'object', properties: {} });
});

// ── voice_list / voice_preview: read-only voice library tools ─────────────

test('voice_list and voice_preview are read-only project-home tools described from the catalog', () => {
  const list = MCP_TOOL_CATALOG.find((e) => e.name === 'voice_list');
  const preview = MCP_TOOL_CATALOG.find((e) => e.name === 'voice_preview');
  for (const e of [list, preview]) {
    expect(e.group).toBe('project-home');
    expect(composeDescription(e)).toMatch(/read-only/i);
    expect(TOOLS.find((t) => t.name === e.name).description).toBe(composeDescription(e));
  }
  expect(composeDescription(list)).toContain('GET /admin/voices');
  expect(composeDescription(preview)).toContain('POST /admin/voices/preview');
  expect(composeDescription(preview)).toMatch(/voice lane/);
  expect(composeDescription(preview)).toMatch(/60 seconds/);
  expect(composeDescription(preview)).toMatch(/queued/);
  const listTool = TOOLS.find((t) => t.name === 'voice_list');
  expect(Object.keys(listTool.inputSchema.properties)).toEqual(['cwd']);
  expect(listTool.inputSchema.required).toBeUndefined();
  const previewTool = TOOLS.find((t) => t.name === 'voice_preview');
  expect(Object.keys(previewTool.inputSchema.properties)).toEqual(['cwd', 'voiceId', 'text']);
  expect(previewTool.inputSchema.required).toEqual(['voiceId', 'text']);
});

describe('voice tools dispatch to the voice admin routes', () => {
  const http = require('node:http');
  const fs = require('node:fs');
  const os = require('node:os');
  let server;
  let requests;
  let reply;
  let tmp;
  let saved;

  beforeEach(async () => {
    requests = [];
    reply = { ok: true };
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-voice-mcp-'));
    const tokenPath = path.join(tmp, 'admin-api.json');
    fs.writeFileSync(tokenPath, JSON.stringify({ port: server.address().port, token: 't0k' }));
    saved = { tp: process.env.SM_ADMIN_TOKEN_PATH, scope: process.env.SM_SCHEDULER_JOB_MCP_TOOLS };
    process.env.SM_ADMIN_TOKEN_PATH = tokenPath;
    delete process.env.SM_SCHEDULER_JOB_MCP_TOOLS;
  });

  afterEach(async () => {
    if (saved.tp === undefined) delete process.env.SM_ADMIN_TOKEN_PATH; else process.env.SM_ADMIN_TOKEN_PATH = saved.tp;
    if (saved.scope !== undefined) process.env.SM_SCHEDULER_JOB_MCP_TOOLS = saved.scope;
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const call = (name, args) => {
    const { handleCallTool } = require(path.join(__dirname, '../../../../scripts/scheduler-mcp-server.cjs'));
    return handleCallTool({ params: { name, arguments: args } });
  };

  test('voice_list -> GET /admin/voices?cwd=', async () => {
    reply = { ok: true, voices: [{ id: 'narrator' }], errors: [] };
    const result = await call('voice_list', { cwd: '/home/x/proj' });
    expect(result.isError).toBeFalsy();
    expect(requests).toEqual([{ method: 'GET', url: '/admin/voices?cwd=%2Fhome%2Fx%2Fproj', auth: 'Bearer t0k', body: undefined }]);
    expect(JSON.parse(result.content[0].text)).toEqual(reply);
  });

  test('voice_preview -> POST /admin/voices/preview; ready and queued replies pass through', async () => {
    reply = { ok: true, status: 'queued', lane: 'heavy', position: 2 };
    let result = await call('voice_preview', { cwd: '/home/x/proj', voiceId: 'narrator', text: 'Hello.' });
    expect(JSON.parse(result.content[0].text)).toEqual(reply);
    reply = { ok: true, status: 'ready', cached: true, wavPath: '/c/k.wav', wallMs: 5, audioSeconds: 1.2 };
    result = await call('voice_preview', { cwd: '/home/x/proj', voiceId: 'narrator', text: 'Hello.' });
    expect(JSON.parse(result.content[0].text)).toEqual(reply);
    expect(requests.map((r) => [r.method, r.url, r.body])).toEqual([
      ['POST', '/admin/voices/preview', { cwd: '/home/x/proj', voiceId: 'narrator', text: 'Hello.' }],
      ['POST', '/admin/voices/preview', { cwd: '/home/x/proj', voiceId: 'narrator', text: 'Hello.' }],
    ]);
  });

  test('voice_preview without voiceId or text is refused before any admin call', async () => {
    for (const args of [{ text: 'hi' }, { voiceId: 'narrator' }, { voiceId: 'narrator', text: '' }]) {
      const result = await call('voice_preview', args);
      expect(result.isError).toBe(true);
    }
    expect(requests).toEqual([]);
  });
});

test('feedback_reply notes describe release.commits claims and the placeholder refusal', () => {
  const notes = MCP_TOOL_CATALOG.find((x) => x.name === 'feedback_reply').notes;
  expect(notes).toContain('release { commits }');
  expect(notes).toContain('tag v<running version>');
  expect(notes).toContain('newer than v0.142.0');
  expect(notes).toMatch(/unfilled placeholder/);
  expect(notes).toMatch(/done reply that names a Session Manager version must carry release\.commits/);
  expect(notes).toMatch(/never hand-type/i);
});

// ── service_pair_local (same-machine service pairing, no window step) ──
describe('service_pair_local handler', () => {
  const { handleCallTool } = require(path.join(__dirname, '../../../../scripts/scheduler-mcp-server.cjs'));
  const bridge = require('../feedback-remote/serviceStdioBridge.cjs');
  const { SERVICE_TOOL_NAMES } = require('../feedback-remote/servicePairings.cjs');
  const ENV = ['SM_CHAT_SESSION_ID', 'SM_SCHEDULER_JOB_SLUG', 'SM_SCHEDULER_JOB_MCP_TOOLS', 'SM_KG_INTERNAL'];
  let saved; let orig;
  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
    process.env.SM_CHAT_SESSION_ID = 'chat-1';
    orig = bridge.pairLocal;
  });
  afterEach(() => {
    bridge.pairLocal = orig;
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
  const args = { stateDir: '/tmp/state', name: 'Kiln', homeCwd: '/tmp/kiln', tools: ['feedback_list_projects'], projectRoot: '/tmp/kiln' };
  const call = (a) => handleCallTool({ params: { name: 'service_pair_local', arguments: a } });

  test('catalog + schema', () => {
    const tool = TOOLS.find((t) => t.name === 'service_pair_local');
    expect(tool.inputSchema.required).toEqual(['stateDir', 'name', 'homeCwd', 'tools']);
    expect(tool.inputSchema.properties.tools.items.enum).toEqual([...SERVICE_TOOL_NAMES]);
    for (const s of ['THIS machine', 'no window step', 'Web remote must be on', 'App Settings → Web remote']) {
      expect(tool.description).toContain(s);
    }
  });

  test('forwards inputs to pairLocal and returns the service', async () => {
    let seen;
    bridge.pairLocal = async (o) => { seen = o; return { ok: true, service: { id: 's1' } }; };
    const r = await call(args);
    expect(r.isError).toBeFalsy();
    expect(seen).toEqual(args);
    expect(JSON.parse(r.content[0].text)).toEqual({ ok: true, service: { id: 's1' } });
  });

  test('maps a refusal to isError', async () => {
    bridge.pairLocal = async () => ({ ok: false, error: 'web remote is off' });
    const r = await call(args);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('web remote is off');
  });

  test('refused inside a scheduled job without calling pairLocal', async () => {
    let called = false;
    bridge.pairLocal = async () => { called = true; return { ok: true, service: {} }; };
    process.env.SM_SCHEDULER_JOB_SLUG = 'job-x';
    const r = await call(args);
    expect(r.isError).toBe(true);
    expect(called).toBe(false);
  });
});
