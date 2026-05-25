---
id: security/ipc-boundary-hardening
title: IPC / cross-process boundary hardening
category: Security
sendMode: paste
description: Audits every IPC handler for schema validation, path allowlists, URL scheme checks, and shell-safe argv.
---
Audit every IPC handler, message-port listener, and main-to-renderer boundary in this repo. For each handler, verify: payload is validated by a schema before use; file paths are validated against an allowlist of roots (no `..` escapes, no symlink follows into denied dirs); URLs are scheme-checked before fetch; shell commands never pass user input through `shell: true`. Output a checklist per handler with PASS/FAIL/UNCLEAR and a one-line patch suggestion for each FAIL.
