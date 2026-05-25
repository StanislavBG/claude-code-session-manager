---
id: security/dependency-audit
title: Dependency audit with exploitability triage
category: Security
sendMode: auto-fire
description: Runs npm audit and triages each advisory by whether the vulnerable path is actually reachable here.
---
Run the `dependency-auditor` subagent. Execute `npm audit --json` (or the equivalent for this stack), then for every high/critical advisory determine whether the vulnerable code path is actually reachable from this application's entrypoints — most transitive advisories are not exploitable here. Group output as: (1) exploitable + needs immediate patch, (2) exploitable but mitigated by configuration, (3) not reachable, low priority, (4) needs human investigation. Cite the advisory ID, the dependent path (`npm ls`), and the proposed remediation (upgrade, override, or replace).
