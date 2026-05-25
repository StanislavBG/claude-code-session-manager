---
id: qa/wcag-axe-scan
title: WCAG 2.2 accessibility scan with axe-core
category: QA
sendMode: auto-fire
description: Runs axe-core against every route, reports violations by WCAG criterion at A/AA levels.
---
Invoke the `playwright-accessibility` skill. Run an axe-core scan against every route in the app, configured for WCAG 2.0/2.1/2.2 levels A and AA. Report findings as a table: severity, WCAG criterion (e.g., 1.4.3 Contrast, 2.4.7 Focus Visible, 2.5.8 Target Size which is new in 2.2), selector, fix. For "incomplete" items where axe could not be certain, list them separately and propose a manual check. Skip AAA unless the project explicitly targets it.
