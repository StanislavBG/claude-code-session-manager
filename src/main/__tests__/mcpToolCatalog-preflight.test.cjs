/**
 * mcpToolCatalog-preflight.test.cjs — create, batch create and update tool
 * descriptions explain `preflight` (PRD preflight-api-schemas).
 */
import { describe, it, expect } from 'vitest';
const catalog = require('../lib/mcpToolCatalog.cjs');

const list = Array.isArray(catalog) ? catalog : (catalog.MCP_TOOL_CATALOG || catalog.CATALOG || catalog.TOOLS || Object.values(catalog).find(Array.isArray));

describe.each(['scheduler_create_prd', 'scheduler_create_prds', 'scheduler_update_prd'])('%s describes preflight', (name) => {
  const entry = list.find((e) => e.name === name);
  const text = entry.purpose;
  it('names the field as optional, read-only, shell-free, gate syntax', () => {
    expect(text).toContain('`preflight` (optional');
    expect(text).toContain('read-only, shell-free command in gate syntax');
  });
  it('states the 60 s cap, exit 0 and the backoff hold', () => {
    expect(text).toContain('at most 60 s');
    expect(text).toContain('must exit 0 before the PRD runs');
    expect(text).toContain('holds the PRD and re-checks it on a backoff while it fails');
  });
});
