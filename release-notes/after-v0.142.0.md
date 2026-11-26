# Fine-grained `epic_state_changed` rows are back

0.142.0 is the one release whose `epic_state_changed` rows (`GET /admin/events`, and the service MCP's `events_read` tool) carried only `awaiting_approval`, `open` and `closed`. Those rows were derived at read time from lifecycle transitions, had no `blockedKind` and were never stored.

This release serves the fine-grained rows again: `to` is one of `closed`, `awaiting_approval`, `needs_input`, `blocked`, `working`, `in_review`, `verified`, `open` or `gone`, read from the Epic event log, under contract version 1. 0.142.0's rows do not appear after upgrading, and rows written by 0.141.0 stay readable. A reader that followed Epics while 0.142.0 ran should re-read the states it cares about with `GET /admin/epic`, as for `gap: true`. See [external-contract.md](../session-manager-operations/architecture/external-contract.md).
