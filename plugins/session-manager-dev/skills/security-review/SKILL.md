---
name: security-review
description: >-
  Check for common security vulnerabilities before shipping code — focus on what
  actually gets exploited (OWASP Top 10: injection, auth, secrets, access control),
  not compliance theater. Use before committing code that handles user input, auth,
  or data storage; when adding API endpoints or external integrations; when
  reviewing dependencies; or when asked to do a security review. Keywords: security,
  vulnerability, OWASP, injection, auth, secrets, review.
---

# Security Review

## Overview

Check for common security vulnerabilities before shipping code. Focus on what actually gets exploited, not compliance theater.

## When to Use

- Before committing code that handles user input, auth, or data storage
- When adding new API endpoints or external integrations
- When reviewing dependencies or updating packages
- When asked to do a security review

## OWASP Top 10 Checklist

### Injection (SQL, NoSQL, OS Command, LDAP)
- All user input parameterized or escaped before use in queries
- No string concatenation in SQL/NoSQL queries
- No `eval()`, `exec()`, `shell=True`, or `child_process.exec()` with user input
- ORM/query builder used instead of raw queries where possible

### Broken Authentication
- Passwords hashed with bcrypt/argon2 (never MD5/SHA1)
- Session tokens are random, long, and expire
- MFA available for sensitive operations
- No credentials in URLs, logs, or error messages

### Sensitive Data Exposure
- No secrets in code, config files, or git history (.env, API keys, tokens)
- Data encrypted at rest (AES-256) and in transit (TLS)
- Sensitive fields excluded from logs and API responses
- PII handled according to data classification

### XSS (Cross-Site Scripting)
- All output HTML-encoded by default (React JSX handles this)
- No `dangerouslySetInnerHTML` or `v-html` without sanitization
- Content-Security-Policy headers set
- User input never inserted into `<script>` tags or event handlers

### Broken Access Control
- Every API endpoint checks authentication AND authorization
- No direct object references without ownership verification
- CORS configured to specific allowed origins (not `*`)
- Rate limiting on auth and sensitive endpoints

### Security Misconfiguration
- No default credentials or debug modes in production
- Error messages don't leak stack traces or internal details
- HTTP security headers set (HSTS, X-Frame-Options, X-Content-Type-Options)
- Unnecessary features and endpoints disabled

### CSRF (Cross-Site Request Forgery)
- State-changing requests use CSRF tokens or SameSite cookies
- POST/PUT/DELETE endpoints reject requests without valid tokens

## Dependency Check

```bash
# Node.js
npm audit
# Check for known vulnerabilities
npx audit-ci --moderate

# Python
pip-audit
safety check
```

Flag: outdated packages with known CVEs, unmaintained dependencies, packages with suspiciously few downloads or recent ownership transfers.

## Secrets Scan

Look for accidentally committed secrets:
- API keys, tokens, passwords in source files
- `.env` files not in `.gitignore`
- Hardcoded connection strings
- Private keys or certificates

## Input Validation Rules

- Validate at system boundaries (API endpoints, form handlers, file uploads)
- Reject unexpected input types and sizes
- Whitelist over blacklist
- Validate on the server, never trust client-only validation

## When Reporting Issues

Classify findings:
- **Critical**: Exploitable now, data at risk (injection, auth bypass, exposed secrets)
- **High**: Exploitable with effort (XSS, CSRF, broken access control)
- **Medium**: Defense-in-depth gap (missing headers, weak config)
- **Low**: Best practice deviation (could become a problem later)

Always provide the fix, not just the finding.
