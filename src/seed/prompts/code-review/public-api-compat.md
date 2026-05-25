---
id: code-review/public-api-compat
title: Public API compatibility review
category: Code Review
sendMode: paste
description: Classifies every exported-symbol change as additive / breaking / semantic-breaking and proposes a shim.
---
Compare the diff against the previous version of every exported symbol. For each public function, class, type, or schema that changed, classify: (a) backward-compatible additive, (b) breaking — signature change, (c) breaking — semantic change, (d) breaking — removal. For each breaking change, propose either a deprecation shim, a major-version bump, or a migration note. Output as a table with `symbol — change class — proposed remediation`.
