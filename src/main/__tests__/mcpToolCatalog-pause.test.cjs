import { describe, it, expect } from 'vitest';
const catalog = require('../lib/mcpToolCatalog.cjs');

describe('scheduler_pause catalog wording', () => {
  const list = Array.isArray(catalog) ? catalog : (catalog.MCP_TOOL_CATALOG || catalog.CATALOG || catalog.TOOLS || Object.values(catalog).find(Array.isArray));
  const entry = list.find((e) => e.name === 'scheduler_pause');
  const text = [entry.purpose, entry.whenToUse, entry.whenNotToUse, entry.notes].join(' ');

  it('says it is machine-wide', () => {
    expect(text).toContain('every project');
  });
  it('says it expires after 30 minutes', () => {
    expect(text).toContain('30 minutes');
  });
});
