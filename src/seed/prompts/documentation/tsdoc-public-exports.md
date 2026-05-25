---
id: documentation/tsdoc-public-exports
title: TSDoc/JSDoc pass on public exports
category: Documentation
sendMode: auto-fire
description: @param + @returns + @throws + @example for every exported symbol in src/.
---
For every exported function, class, type, and constant in the `src/` public surface, add or update TSDoc comments. Required tags: one-line summary, `@param` per parameter with type semantics (not just "the name"), `@returns` describing the return shape including null/undefined cases, `@throws` for documented exceptions, `@example` for non-trivial APIs. Do NOT document trivial getters, internal helpers, or anything not exported. Match the project's existing TSDoc style if one exists.
