---
id: qa/e2e-critical-path
title: E2E test for the critical user path
category: QA
sendMode: paste
description: Writes a Playwright test using role/label locators with web-first assertions and no manual sleeps.
---
Use the `playwright-e2e` skill to write a Playwright test for this user flow: [describe path]. Use role/label locators (`getByRole`, `getByLabel`, `getByTestId`) — no XPath, no long CSS chains. Rely on Playwright's auto-wait; do not insert `waitForTimeout` or manual sleeps. Use web-first assertions (`expect(locator).toBeVisible()`, etc.) so retries happen automatically. Each test must own its data setup and teardown — no shared state across tests.
