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

test('MCP_RECIPES covers queue-work, unstick-needs-review, and hand-off-to-another-project', () => {
  const ids = MCP_RECIPES.map((r) => r.id);
  expect(ids).toContain('queue-work-via-develop');
  expect(ids).toContain('unstick-needs-review-job');
  expect(ids).toContain('hand-finding-to-another-project');
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
