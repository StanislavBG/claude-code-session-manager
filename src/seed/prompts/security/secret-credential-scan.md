---
id: security/secret-credential-scan
title: Secret + credential scan with remediation plan
category: Security
sendMode: auto-fire
description: Greps the tree for hardcoded secrets, checks git history, and orders rotate → redact → gitignore.
---
Grep the working tree for hardcoded secrets — API keys, OAuth tokens, JWTs, private keys, database URLs with embedded passwords, and webhook signing secrets. Use both pattern matching (e.g., `sk-`, `xoxb-`, `AKIA`, `-----BEGIN`, `Bearer `) and entropy heuristics on string literals over 20 chars. For each finding report file:line, the secret type, whether it is in tracked git history (`git log -S`), and a remediation order: rotate first, then redact, then add to `.gitignore`/secret manager. Do not print the secret value in clear — show a masked prefix only.
