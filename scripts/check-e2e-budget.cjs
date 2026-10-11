#!/usr/bin/env node
'use strict'

// E2E budget: fails when the tests/e2e spec count exceeds E2E_SPEC_CEILING.
// New flows go to unit/RTL tests unless an existing spec is merged or removed.
// Root dir: first CLI argument or SM_E2E_ROOT (tests use a scratch tree);
// defaults to the repo. Complexity: one readdir.

const fs = require('fs')
const path = require('path')

const E2E_SPEC_CEILING = 19

const ROOT = path.resolve(process.argv[2] || process.env.SM_E2E_ROOT || path.join(__dirname, '..'))
const dir = path.join(ROOT, 'tests', 'e2e')
const count = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.spec\.(ts|mjs)$/.test(f)).length : 0

if (count > E2E_SPEC_CEILING) {
  console.error(`e2e budget exceeded: ${count} specs in tests/e2e, ceiling ${E2E_SPEC_CEILING} - merge or delete a spec (see tests/README.md "E2E budget")`)
  process.exit(1)
}
console.log(`e2e budget ok: ${count}/${E2E_SPEC_CEILING}`)
