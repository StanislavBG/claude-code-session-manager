---
id: security/cwe-top-25-hunt
title: Hunt for the CWE Top 25 in this directory
category: Security
sendMode: paste
description: Sweeps the open directory against the 2024 CWE Top 25; adversarial self-verification before reporting.
---
Hand this off to the `security-auditor` subagent. Sweep the directory I have open against the 2024 CWE Top 25 — prioritize CWE-79 (XSS), CWE-787 (out-of-bounds write), CWE-89 (SQL injection), CWE-352 (CSRF), CWE-22 (path traversal), CWE-78 (OS command injection), CWE-94 (code injection), CWE-918 (SSRF), and CWE-77 (command injection). For each hit, cite file:line, name the CWE, show a minimal reproducer or the exact attack input, and propose a patch. Do an adversarial verification pass on your own findings before reporting — drop any you cannot defend.
