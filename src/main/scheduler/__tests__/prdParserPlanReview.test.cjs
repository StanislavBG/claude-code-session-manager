'use strict';

// prdParser reads the planReview frontmatter field (only `required` counts).
import { afterAll, describe, expect, test } from 'vitest';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const prdParser = require('../prdParser.cjs');

describe('prdParser planReview', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-prd-plan-review-'));
  afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

  async function parse(name, fmLines) {
    const file = path.join(root, name);
    fs.writeFileSync(file, `---\ntitle: T\n${fmLines}---\n\n# Goal\nx\n`);
    return prdParser.parsePrd(file);
  }

  test('planReview: required is returned', async () => {
    const prd = await parse('9401-with.md', 'planReview: required\n');
    expect(prd.planReview).toBe('required');
  });

  test('absent planReview is null', async () => {
    const prd = await parse('9402-without.md', '');
    expect(prd.planReview).toBeNull();
  });

  test('any other value is null', async () => {
    const prd = await parse('9403-other.md', 'planReview: maybe\n');
    expect(prd.planReview).toBeNull();
  });
});
