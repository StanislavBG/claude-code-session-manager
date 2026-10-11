# HUMAN_LEARN/

Human-readable explainer pages. The `explain-to-me` skill that wrote them was retired
2026-10-11; the existing pages are kept as static docs. **Not an OWNERS namespace** — no
code path writes here and no `assertOpsWrite` guard applies.

**Retention: keep.** Keep rather than deleting; there is no archive
subfolder.

## Contents

- `index.html` — one combined component-explainer page. Last regenerated **2026-07-24**.
  It is now **stale** on the removed Browser tab, DOM-capture, and Web Remote (desktop
  half) surfaces — those sections describe subsystems that have since been removed from
  the codebase. Don't trust it for those areas; treat it as history until regenerated.
- `SKILL_MAP.html` — never produced; the skill that would have written it is retired.

## How to update

The generator skill is gone. Hand-edit `index.html` if a fix is needed, or leave it as
history.
