'use strict';

/**
 * SHIPPED_PERSONA_SEEDS — every distinct version this app has ever bundled
 * for the four seed personas (`src/main/seedAgentPersonas.cjs`'s `PERSONAS`),
 * keyed by persona name. One entry per version actually shipped in
 * `src/seed/agents/<name>.md`'s git history; exact duplicates (same body
 * hash and same `fm`) are dropped.
 *
 * `seedAgentPersonas.cjs`'s upgrade pass only replaces an installed persona
 * file when its body hash matches one of the `bodySha256` values below — a
 * body that never shipped from this app (hand-written, or hand-edited after
 * install) is left alone, never overwritten. `fm` holds every frontmatter
 * key that version had, except `name` and `seedVersion` — those two are
 * never diffed against this list.
 *
 * When you change a bundled persona, add its new version here. The test in
 * seedAgentPersonas.test.cjs prints the entry to paste.
 */

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const SHIPPED_PERSONA_SEEDS = deepFreeze({
  "architect": [
    {
      commit: "dba99697",
      bodySha256: "40a4d41445e7fdb128f4f1d8d3eef88b857ca466726b3719b36cb69933f09168",
      fm: {
        description: "The primary Actor for an Epic's whole interactive conversation — owns overall plan and decomposition, clarifies scope, searches before building, decomposes work into scheduled PRDs via /develop, tracks them to completion, and verifies before calling anything done. Never implements a PRD itself — that's dev-lead's job, one PRD at a time, headless. Task-type framing is the Epic's Mission tag's job, not this persona's.",
        model: "opus",
        tags: "feature, bug, discussion",
        title: "Engineering — Architect",
        tools: "Read, Grep, Glob, Bash, Edit, Write",
      },
    },
  ],
  "dev-lead": [
    {
      commit: "dba99697",
      bodySha256: "7821f5bf3f1617fb4c9ea80c81fc37680bfc4c61346e59f58da456c69ef74a90",
      fm: {
        description: "Executes exactly one already-scoped PRD at a time, headless, start to finish — reads the PRD's Goal/Acceptance Criteria/Implementation notes and standards.md, implements it, verifies against its own AC, and reports. Has no visibility into the overall plan — that's architect's job. Not currently wired to run automatically; a PRD must name this persona explicitly (e.g. in its Implementation notes) for an executor to adopt it.",
        model: "fable",
        title: "Engineering — Software Engineer",
        tools: "Read, Grep, Glob, Bash, Edit, Write",
      },
    },
    {
      commit: "07b73fac",
      bodySha256: "21284b34473fd4a9b727e8fa2a0702379751d3af0985392a9814f91a4fdc8551",
      fm: {
        description: "Executes exactly one already-scoped PRD at a time, headless, start to finish — reads the PRD's Goal/Acceptance Criteria/Implementation notes and standards.md, implements it, verifies against its own AC, and reports. Has no visibility into the overall plan — that's architect's job. This is the default persona a scheduled PRD runs as: the scheduler resolves a PRD's `agentType` frontmatter field (default `dev-lead`) to this file and launches the headless executor AS this persona via `--append-system-prompt`.",
        model: "sonnet",
        title: "Engineering — Software Engineer",
        tools: "Read, Grep, Glob, Bash, Edit, Write",
      },
    },
    {
      commit: "2751c9f5",
      bodySha256: "375b46dd6f1edc7b7e304e0be5bf32a4e61ca4adf329bc73d65ba2224e3c7b8a",
      fm: {
        description: "Executes exactly one already-scoped PRD at a time, headless, start to finish — reads the PRD's Goal/Acceptance Criteria/Implementation notes and standards.md, implements it, verifies against its own AC, and reports. Has no visibility into the overall plan — that's architect's job. This is the default persona a scheduled PRD runs as: the scheduler resolves a PRD's `agentType` frontmatter field (default `dev-lead`) to this file and launches the headless executor AS this persona via `--append-system-prompt`.",
        model: "sonnet",
        title: "Engineering — Software Engineer",
        tools: "Read, Grep, Glob, Bash, Edit, Write",
      },
    },
    {
      commit: "9f8286d7",
      bodySha256: "86e5d8a679c3be879b162140d403f905a1ef9edbcc54b3bf4b3a278425dea841",
      fm: {
        description: "Executes exactly one already-scoped PRD at a time, headless, start to finish — reads the PRD's Goal/Acceptance Criteria/Implementation notes and standards.md, implements it, verifies against its own AC, and reports. Has no visibility into the overall plan — that's architect's job. This is the default persona a scheduled PRD runs as: the scheduler resolves a PRD's `agentType` frontmatter field (default `dev-lead`) to this file and launches the headless executor AS this persona via `--append-system-prompt`.",
        model: "sonnet",
        title: "Engineering — Software Engineer",
        tools: "Read, Grep, Glob, Bash, Edit, Write",
      },
    },
    {
      commit: "ab4be752",
      bodySha256: "dbd5500968b75cbbe6549e612dc3df5de8d1569fa902cac173705542ea095225",
      fm: {
        description: "Executes exactly one already-scoped PRD at a time, headless, start to finish — reads the PRD's Goal/Acceptance Criteria/Implementation notes and standards.md, implements it, verifies against its own AC, and reports. Has no visibility into the overall plan — that's architect's job. This is the default persona a scheduled PRD runs as: the scheduler resolves a PRD's `agentType` frontmatter field (default `dev-lead`) to this file and launches the headless executor AS this persona via `--append-system-prompt`.",
        model: "sonnet",
        title: "Engineering — Software Engineer",
        tools: "Read, Grep, Glob, Bash, Edit, Write",
      },
    },
    {
      commit: "535b04f8",
      bodySha256: "91232cfd7ce5fb1dc608ff639a07dcb1c5c13c22502ae4790f51707f498ec917",
      fm: {
        description: "Executes exactly one already-scoped PRD at a time, headless, start to finish — reads the PRD's Goal/Acceptance Criteria/Implementation notes and standards.md, implements it, verifies against its own AC, and reports. Has no visibility into the overall plan — that's architect's job. This is the default persona a scheduled PRD runs as: the scheduler resolves a PRD's `agentType` frontmatter field (default `dev-lead`) to this file and launches the headless executor AS this persona via `--append-system-prompt`.",
        model: "sonnet",
        title: "Engineering — Software Engineer",
        tools: "Read, Grep, Glob, Bash, Edit, Write",
      },
    },
  ],
  "project-home-builder": [
    {
      commit: "e9f2f540",
      bodySha256: "e1c80f465179f814f1e9ea95529434309e5238facdc8c6664cb8f44f8302e148",
      fm: {
        description: "Generates a project's 5 static Project Page HTML files (Home / Marketing Landing / Feature Description / Architecture Overview / Brief) by following the session-manager app's own MCP contract for the pipeline — portable to any machine with the app installed, no source-repo paths required.",
        title: "Project Pages — Builder",
        tools: "Read, Grep, Glob, Bash, Write, Edit",
      },
    },
    {
      commit: "5cc32fa4",
      bodySha256: "7ad61d9b9dbe7f35727baf83f94c3c244deb25133eebb78c9295c9841237dd1c",
      fm: {
        description: "Reads a project and writes ONE self-contained overview page (home.html) for its Project Home tab, then saves it with a single project_home_write call.",
        title: "Project Home — Builder",
        tools: "Read, Grep, Glob, Bash, Write, Edit",
      },
    },
  ],
  "validator": [
    {
      commit: "41c28597",
      bodySha256: "4791f25651b4fc3b7cfa3a26148e6dd1cceec05f057b882516fafcdcc04f71e7",
      fm: {
        description: "Validates a finished PLAN (the PRDs that share one planId) once, after its last PRD lands — re-runs each PRD's gate, checks every acceptance criterion against the real tree, reviews the plan's combined diff, and reports one VERIFIED/REFUTED verdict per PRD via sentinel lines. Runs headless as a scheduled PRD (agentType: validator); never edits product code and never queues work.",
        model: "sonnet",
        title: "Engineering — Plan Validator",
        tools: "Read, Grep, Glob, Bash",
      },
    },
    {
      commit: "7ed8dd1d",
      bodySha256: "80d19294bc8a0e654f242a6177ae14ebdb116c899614c6b6bed503774624a0b8",
      fm: {
        description: "Validates a finished PLAN (the PRDs that share one planId) once, after its last PRD lands — re-runs each PRD's gate, checks every acceptance criterion against the real tree, reviews the plan's combined diff, and reports one VERIFIED/REFUTED verdict per PRD via sentinel lines. Runs headless as a scheduled PRD (agentType: validator); never edits product code and never queues work.",
        model: "sonnet",
        title: "Engineering — Plan Validator",
        tools: "Read, Grep, Glob, Bash",
      },
    },
    {
      commit: "9f8286d7",
      bodySha256: "8e95bfe06f70e7f9ae7f22de829b6f40727714e7f66364d166756b269ad7d50f",
      fm: {
        description: "Validates a finished PLAN (the PRDs that share one planId) once, after its last PRD lands — re-runs each PRD's gate, checks every acceptance criterion against the real tree, reviews the plan's combined diff, and reports one VERIFIED/REFUTED verdict per PRD via sentinel lines. Runs headless as a scheduled PRD (agentType: validator); never edits product code and never queues work.",
        model: "sonnet",
        title: "Engineering — Plan Validator",
        tools: "Read, Grep, Glob, Bash",
      },
    },
    {
      commit: "ab4be752",
      bodySha256: "512ec61490f6b652268bedc2aebd07fb4aafe8df53cfed38bb728348a29f29cc",
      fm: {
        description: "Validates a finished PLAN (the PRDs that share one planId) once, after its last PRD lands — re-runs each PRD's gate, checks every acceptance criterion against the real tree, reviews the plan's combined diff, and reports one VERIFIED/REFUTED verdict per PRD via sentinel lines. Runs headless as a scheduled PRD (agentType: validator); never edits product code and never queues work.",
        model: "sonnet",
        title: "Engineering — Plan Validator",
        tools: "Read, Grep, Glob, Bash",
      },
    },
    {
      commit: "535b04f8",
      bodySha256: "5aeaf796a30ac98bdce440a6fcd088e1c776ae762f2778327439ab8d75a2de94",
      fm: {
        description: "Validates a finished PLAN (the PRDs its validate PRD lists) once, after its last PRD lands — re-runs each PRD's gate, checks every acceptance criterion against the real tree, reviews the plan's combined diff, and reports one VERIFIED/REFUTED verdict per PRD via sentinel lines. Runs headless as a scheduled PRD (agentType: validator); never edits product code and never queues work.",
        model: "sonnet",
        title: "Engineering — Plan Validator",
        tools: "Read, Grep, Glob, Bash",
      },
    },
  ],
});

module.exports = { SHIPPED_PERSONA_SEEDS };
