# Voice Agent Master Plan

Goal: harden the in-app voice-to-Claude pipeline (the speech harness around Claude Code) along 8 feature axes. Each feature gets an in-depth PRD, a critique, a revised PRD, and two implementation passes; the whole run finishes with a security review and a code review.

## Features (DAG nodes)

| ID | Feature | Implementation tier | Key files touched |
|----|---------|---------------------|-------------------|
| F1 | Push-to-talk + global hotkey | medium | `main/index.cjs`, `state/voice.ts`, preload |
| F2 | Disable mic until model ready | trivial | `state/voice.ts`, `LeftNav.tsx` |
| F3 | Mic-level meter / waveform | medium | new component, AnalyserNode pipeline |
| F4 | Barge-in for TTS | small | `state/voice.ts`, `speechSynthesis.ts` |
| F5 | Device picker + remembered selection | medium | new UI, settings, MicVAD config |
| F6 | Streaming partials | large | `whisperWorker.ts`, `speechRecognition.ts` |
| F7 | First-run mic check | medium-large | new component + flow |
| F8 | Turn-detection upgrade (semantic) | large | replaces VAD endpointing |

## Per-feature workflow

Each feature follows the same six-stage pipeline:

1. **PRD v1** — research subagent writes initial PRD to `docs/voice/prd/<id>-<slug>.md`.
2. **Critique** — critique subagent finds gaps, edge cases, missing failure modes.
3. **PRD v2** — main thread folds critique into a revised PRD.
4. **Implementation v1** — code change.
5. **Refinement review** — critique subagent reviews the diff.
6. **Implementation v2** — apply refinements.

## Dependency order (implementation)

```
F2 ──┐
     ├── F1 ── F5 ── F3 ── F7 ── F6 ── F8
F4 ──┘
```

F2 and F4 are tiny and unblock UX immediately. F1 depends on no other feature but pairs naturally with F2 (button state). F3, F5, F7 have shared mic-init concerns and should land in this order to avoid churn. F6 and F8 are the heaviest and rely on the rest being stable.

## Final phase

- **Security review** via the `security-review` skill on the cumulative diff.
- **Code review** via the `requesting-code-review` skill / `code-reviewer` agent.
- Address findings before declaring done.

## Checkpoints

- [ ] CP1 — All 8 PRD v1 drafts written
- [ ] CP2 — All 8 critiques returned
- [ ] CP3 — All 8 PRD v2 finalized
- [ ] CP4 — F2, F4 implemented (smallest, validates flow)
- [ ] CP5 — F1, F5 implemented
- [ ] CP6 — F3, F7 implemented
- [ ] CP7 — F6 implemented
- [ ] CP8 — F8 implemented
- [ ] CP9 — Security review clean
- [ ] CP10 — Code review clean

Status of each PRD/impl tracked via the TaskList tool.
