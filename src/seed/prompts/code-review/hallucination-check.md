---
id: code-review/hallucination-check
title: Hallucination check on AI-generated code
category: Code Review
sendMode: auto-fire
description: Verifies every imported symbol, signature, and API in the diff exists in the pinned dep version.
---
This diff was written by an AI assistant. Verify it does not hallucinate. For every import, function call, and library API used, confirm the symbol actually exists in the installed dependency version (check `node_modules` / `package.json` / project source). Flag any non-existent functions, wrong signatures, hallucinated package names, or APIs that exist in a different version than what is pinned. Also check the happy path was not assumed — flag missing null/empty/error handling for inputs the function can actually receive.
