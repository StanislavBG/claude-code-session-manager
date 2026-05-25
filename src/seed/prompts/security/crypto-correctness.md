---
id: security/crypto-correctness
title: Crypto + secret-handling correctness pass
category: Security
sendMode: paste
description: Reviews crypto primitives, password hashing, JWT signing, and TLS config against OWASP A02.
---
Find every use of crypto primitives, password hashing, JWT signing/verification, and TLS configuration in this repo. Check against OWASP A02 Cryptographic Failures: no MD5/SHA-1 for security, no ECB mode, no PBKDF2 with iteration counts under 600k, bcrypt cost factor ≥ 12, argon2id preferred over bcrypt for new code, JWTs verified with the algorithm pinned (no `alg: none` accepted), nonces never reused with AES-GCM, randomness from `crypto.randomBytes` not `Math.random`. Report file:line + category + suggested fix.
