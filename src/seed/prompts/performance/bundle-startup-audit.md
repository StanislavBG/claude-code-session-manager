---
id: performance/bundle-startup-audit
title: Bundle size / startup time audit
category: Performance
sendMode: auto-fire
description: Lists top 20 modules by size, duplicated deps, dev-only leaks, and synchronous imports over 50KB.
---
Analyze the production bundle. Report: total gzipped size, top 20 modules by size with their import paths, any duplicated dependency versions, any dev-only dependency leaking into the prod bundle, and any synchronously-imported module over 50 KB that could be lazy-loaded. Suggest concrete `import()` boundaries and tree-shaking opportunities. Cite the entry file:line that pulls each heavy module.
