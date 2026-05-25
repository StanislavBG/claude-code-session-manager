---
id: qa/api-contract-tests
title: API contract test suite
category: QA
sendMode: paste
description: Exercises happy path, 4xx, auth boundaries, rate limits, idempotency, and pagination for each endpoint.
---
Engage the `playwright-api-testing` skill. For each public endpoint, write a request-context test that exercises: 200 happy path with schema validation, 4xx invalid input, 401/403 auth boundaries, 429 rate limit (if applicable), idempotency key replay returns identical body, and pagination correctness. Mock no internals — hit the real test server. Validate response bodies against the OpenAPI schema if one exists; otherwise pin the shape with a snapshot.
