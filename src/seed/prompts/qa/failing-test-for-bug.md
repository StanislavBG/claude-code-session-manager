---
id: qa/failing-test-for-bug
title: Generate a failing test that reproduces this bug
category: QA
sendMode: paste
description: Pins the exact wrong behavior in a test before any fix, using the project's existing test runner.
---
I have a bug: [describe symptom + steps to reproduce]. Before any fix, write a failing test that pins the exact wrong behavior. The test must fail today on `main` and pass once the bug is fixed. Use the project's existing test runner and the same file/folder convention as the nearest sibling tests. Run the test and paste the failure output so I can verify it reproduces.
