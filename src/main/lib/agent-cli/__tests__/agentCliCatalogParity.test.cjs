'use strict';
// Parity: the renderer's display labels (src/renderer/lib/agentCliCatalog.ts)
// must match main's AGENT_CLI_CATALOG labels. Read as text — main tests can't
// import renderer TS.
import { test, expect } from 'vitest';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../../../../..');
const RENDERER = path.join(ROOT, 'src/renderer/lib/agentCliCatalog.ts');
const REGISTRY = path.join(ROOT, 'src/main/lib/agent-cli/agentCliRegistry.cjs');

function rendererLabels() {
  const src = fs.readFileSync(RENDERER, 'utf8');
  const m = src.match(/AGENT_CLI_LABELS[^=]*=\s*\{([\s\S]*?)\}/);
  if (!m) throw new Error('AGENT_CLI_LABELS object literal not found in ' + RENDERER);
  const out = {};
  for (const [, k, v] of m[1].matchAll(/['"]?([a-z]+)['"]?\s*:\s*['"]([^'"]+)['"]/g)) out[k] = v;
  return out;
}

const hasRegistry = fs.existsSync(REGISTRY);
if (!hasRegistry) console.warn('[agentCliCatalogParity] skipped: ' + REGISTRY + ' does not exist');

test.skipIf(!hasRegistry)('renderer AGENT_CLI_LABELS equal AGENT_CLI_CATALOG labels in agentCliRegistry.cjs', () => {
  const { AGENT_CLI_CATALOG } = require(REGISTRY);
  const expected = Object.fromEntries(Object.entries(AGENT_CLI_CATALOG).map(([id, e]) => [id, e.label]));
  expect(rendererLabels()).toEqual(expected);
});
