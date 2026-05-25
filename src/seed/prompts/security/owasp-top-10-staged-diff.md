---
id: security/owasp-top-10-staged-diff
title: Review staged diff for OWASP Top 10 issues
category: Security
sendMode: auto-fire
description: Sweeps the staged diff against OWASP Top 10:2021 categories and reports findings as a severity table.
---
Invoke the `security-review` skill on the currently staged diff. Walk OWASP Top 10:2021 in order (A01 Broken Access Control, A02 Cryptographic Failures, A03 Injection, A04 Insecure Design, A05 Security Misconfiguration, A06 Vulnerable Components, A07 Auth Failures, A08 Software & Data Integrity, A09 Logging Failures, A10 SSRF) and report findings as a markdown table with columns: severity (critical/high/medium/low), OWASP category, file:line, one-sentence description, suggested fix. Skip categories with no findings rather than padding. Do not include style or naming nits — security only.
