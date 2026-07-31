'use strict';

/**
 * importReferences.cjs — IPC-facing wrapper around personaImportHealth's
 * import-chain walker, adding the size/token-estimate fields the "referenced
 * files" panel needs. Reuses walkImports rather than reparsing `@path` syntax.
 */

const fs = require('node:fs');
const { walkImports } = require('./personaImportHealth.cjs');

// Maps walkImports' result shape to what the renderer panel needs per file:
// resolved path, existence, size, a rough token estimate, and overall health.
function listReferencedFiles(rootPath) {
  return walkImports(rootPath).map(({ importPath, exists, ok }) => {
    let sizeBytes = 0;
    if (exists) {
      try {
        sizeBytes = fs.statSync(importPath).size;
      } catch {
        sizeBytes = 0;
      }
    }
    return {
      path: importPath,
      exists,
      sizeBytes,
      tokenEstimate: Math.round(sizeBytes / 4),
      ok,
    };
  });
}

module.exports = { listReferencedFiles };
