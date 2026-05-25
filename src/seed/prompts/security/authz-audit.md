---
id: security/authz-audit
title: Auth + authorization audit
category: Security
sendMode: paste
description: Audits every authenticated route/middleware/IPC handler for broken access control (OWASP A01) and IDOR.
---
Audit every authenticated route, middleware, and IPC handler in this repo for broken access control (OWASP A01) and identification/authentication failures (OWASP A07). For each endpoint or handler, state: who can call it, what authz check protects it, whether that check happens before any side effect, and whether the user-supplied identifier is ever trusted without rebinding to the session subject. Flag any TOCTOU windows, missing authorization on object IDs (IDOR), or auth checks that happen after a database write.
