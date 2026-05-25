---
id: refactoring/tighten-module-boundaries
title: Tighten module boundaries
category: Refactoring
sendMode: paste
description: Demotes single-use exports to module-private; moves test-only helpers to __test__.
---
This module's public surface has grown organically: [name the module]. List every exported symbol. For each, classify: (a) used by 3+ external callers — keep public, (b) used by 1-2 external callers — consider inlining at the call site, (c) only used inside this module — make it module-private, (d) only used in tests — move to a `__test__` helper. Apply the demotions. Re-run typecheck and tests after each commit.
