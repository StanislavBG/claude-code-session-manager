/**
 * residueCheck.test.cjs — the No-residue Stop-hook checker shipped in the
 * session-manager-dev plugin (plugins/session-manager-dev/hooks/residue-check.cjs).
 *
 * Run: timeout 180 npx vitest run src/main/__tests__/residueCheck.test.cjs
 */

'use strict';

import { test, expect, describe, afterEach } from 'vitest';
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../../../plugins/session-manager-dev/hooks/residue-check.cjs');
const { findResidue } = require(SCRIPT);

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

function baseEnv(extra = {}) {
  const env = { ...process.env };
  delete env.SM_CHAT_SESSION_ID;
  delete env.SM_SCHEDULER_JOB_SLUG;
  delete env.SM_SCHEDULER_JOB_EPIC_ID;
  delete env.SM_RESIDUE_CHECK;
  return { ...env, ...extra };
}

function run(input, envExtra = { SM_CHAT_SESSION_ID: 'sess-1' }) {
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: baseEnv(envExtra),
    encoding: 'utf8',
    timeout: 10000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const RESIDUE = 'Done.\n\n## Still open\n- wire the toggle into settings\n';

describe('findResidue — headings and bold labels', () => {
  const labels = ['Still open', 'Open items', 'Remaining', 'Not covered', 'Deferred', 'Follow-ups', 'Left for later'];
  for (const label of labels) {
    test(`heading "${label}"`, () => {
      const text = `Shipped X.\n\n### ${label}\n- fix the flaky spec\n- rename the helper\n\n## Verified\n- all good\n`;
      expect(findResidue(text)).toEqual(['- fix the flaky spec', '- rename the helper']);
    });
    test(`bold label "${label}:"`, () => {
      const text = `Shipped X.\n\n**${label}:**\n- fix the flaky spec\n`;
      expect(findResidue(text)).toEqual(['- fix the flaky spec']);
    });
    test(`inline bold label "${label}"`, () => {
      const text = `Shipped X.\n\n**${label}:** the migration script.\n`;
      expect(findResidue(text)).toEqual([`**${label}:** the migration script.`]);
    });
  }

  test('a "none" entry under a residue label does not count', () => {
    expect(findResidue('**Still open:** none.\n')).toEqual([]);
    expect(findResidue('## Remaining\n- None\n')).toEqual([]);
  });

  test('clean report finds nothing', () => {
    expect(findResidue('## Done\n- queued 4203-fix-x\n- closed Y: duplicate of Z\n')).toEqual([]);
  });

  test('caps at 5 lines', () => {
    const items = Array.from({ length: 9 }, (_, i) => `- item ${i}`).join('\n');
    expect(findResidue(`## Follow-ups\n${items}\n`)).toHaveLength(5);
  });
});

describe('findResidue — phrases', () => {
  const phrases = ['needs a new Epic', 'say the word', "haven't queued", "didn't look into", 'follow-up for later'];
  for (const p of phrases) {
    test(`phrase "${p}"`, () => {
      const line = `The cache bug ${p} if you want it.`;
      expect(findResidue(`All green.\n${line}\n`)).toEqual([line]);
    });
  }
  test('case-insensitive and curly apostrophe', () => {
    expect(findResidue('I HAVEN’T QUEUED the doc fix.')).toEqual(['I HAVEN’T QUEUED the doc fix.']);
  });
});

describe('findResidue — gap and hand-off wording (real 2026-11-23 endings)', () => {
  test('session 02: bold Gap label with a promise to add a PRD later', () => {
    const line = "**Gap:** two of the event kinds, `job.tool_use` and `human.message`, have no PRD that writes them. I'll add that PRD alongside the wave 1 fixes.";
    expect(findResidue(`Plan settled.\n\n${line}\n`)).toEqual([line]);
  });
  test('Gap / Gaps / What happens next as whole headings and bold labels', () => {
    for (const label of ['Gap', 'Gaps', 'What happens next']) {
      expect(findResidue(`## ${label}\n- the doc chapter\n`)).toEqual(['- the doc chapter']);
      expect(findResidue(`## ${label}:\n- the doc chapter\n`)).toEqual(['- the doc chapter']);
      expect(findResidue(`**${label}:**\n- the doc chapter\n`)).toEqual(['- the doc chapter']);
    }
    expect(findResidue('## Gap analysis\n- three rows checked\n')).toEqual([]);
  });
  test('session 07: "one gap" in prose', () => {
    const line = '- **Manual:** I only set `documentsAppVersion` to 0.141.0 (`565456c7`, pushed). No chapter was revised: none describes the changed behaviour, the renderer is unchanged, and "Needs review" still means "being fixed". The manual stays at 2.6.0 with no new manual release. One gap: no chapter covers preflight holds; it would fit in `plans-and-scheduler.html`.';
    expect(findResidue(`Released.\n\n${line}\n`)).toEqual([line]);
  });
  test('session 16: What happens next list of tasks for the owner', () => {
    const text = [
      '**Checks this turn:** all 51 related test files (1,446 tests) pass on current main `6682dfb1`.',
      '',
      '**What happens next:**',
      '- **You:** publish a release that carries this work. I didn\'t, because main also holds other plans that are still in progress.',
      '- **Burrow thread:** all 3 replies are still unused.',
      '',
    ].join('\n');
    expect(findResidue(text)).toEqual([
      '- **You:** publish a release that carries this work. I didn\'t, because main also holds other plans that are still in progress.',
      '- **Burrow thread:** all 3 replies are still unused.',
    ]);
  });
  test('session 17: "I left those to them"', () => {
    const line = "For you: restart Session Manager so it runs 0.140.0 — Burrow can't register its tools until then. Several other Epics also owe their own post-release replies (to Self, and the Task-primitive reply to Burrow); I left those to them. Both memory notes now record 0.140.0 as live and Burrow's thread as closed.";
    expect(findResidue(`Done.\n\n${line}\n`)).toEqual([line]);
  });
  test('"I will add that" and quoted / code / table forms', () => {
    expect(findResidue('I will add that test next wave.\n')).toEqual(['I will add that test next wave.']);
    expect(findResidue('The checker now matches "one gap" and `left those to`.\n')).toEqual([]);
    expect(findResidue('| wording | one gap; I\'ll add that |\n')).toEqual([]);
    expect(findResidue('```\nOne gap: x. I left those to them.\n```\n')).toEqual([]);
  });
  test('a clean Landed / Decided / Queued / Scheduled / Needs you report flags nothing', () => {
    const text = [
      '**Landed:** 4214-residue-label-whole-match (`a1b2c3d4`) — labels match only as a whole heading.',
      '',
      '**Decided:** the hook stays fail-open; revert = `git revert a1b2c3d4`.',
      '',
      '**Queued:** 4227-residue-check-gap-and-handoff-wording — adds the Gap and hand-off wording.',
      '',
      '**Scheduled:** 4228-validate runs after 4227 (dependsOn).',
      '',
      '**Needs you:** restart Session Manager after the next release so the hook loads.',
      '',
    ].join('\n');
    expect(findResidue(text)).toEqual([]);
  });
});

describe('findResidue — word bounds and outcome-carrying lines (4248)', () => {
  test('a phrase inside a longer word does not count', () => {
    expect(findResidue('The phone gap is closed.\n')).toEqual([]);
    expect(findResidue('There is none gap here.\n')).toEqual([]);
    expect(findResidue('Saying the wordsmith fix shipped.\n')).toEqual([]);
  });
  test('a whole-word phrase still counts', () => {
    const line = 'One gap: no chapter covers preflight holds';
    expect(findResidue(`${line}\n`)).toEqual([line]);
  });
  test('a line naming its own outcome (PRD number + outcome verb) does not count', () => {
    expect(findResidue('There was one gap and PRD 4300 closed it.\n')).toEqual([]);
    expect(findResidue('## Follow-ups\n- the doc chapter: queued 4301-doc-chapter\n')).toEqual([]);
    expect(findResidue('**Gap:** the event writer — fixed by 4302.\n')).toEqual([]);
  });
  test('a PRD number alone, or an outcome verb alone, is not an outcome', () => {
    expect(findResidue('There was one gap near PRD 4300.\n')).toEqual(['There was one gap near PRD 4300.']);
    expect(findResidue('## Still open\n- the doc fix is not queued yet\n')).toEqual(['- the doc fix is not queued yet']);
  });
  test("4227's four real hand-back endings are still flagged", () => {
    const s02 = "**Gap:** two of the event kinds, `job.tool_use` and `human.message`, have no PRD that writes them. I'll add that PRD alongside the wave 1 fixes.";
    const s07 = '- **Manual:** I only set `documentsAppVersion` to 0.141.0 (`565456c7`, pushed). No chapter was revised: none describes the changed behaviour, the renderer is unchanged, and "Needs review" still means "being fixed". The manual stays at 2.6.0 with no new manual release. One gap: no chapter covers preflight holds; it would fit in `plans-and-scheduler.html`.';
    const s16 = '- **You:** publish a release that carries this work. I didn\'t, because main also holds other plans that are still in progress.';
    const s17 = "For you: restart Session Manager so it runs 0.140.0 — Burrow can't register its tools until then. Several other Epics also owe their own post-release replies (to Self, and the Task-primitive reply to Burrow); I left those to them. Both memory notes now record 0.140.0 as live and Burrow's thread as closed.";
    expect(findResidue(`Plan settled.\n\n${s02}\n`)).toEqual([s02]);
    expect(findResidue(`Released.\n\n${s07}\n`)).toEqual([s07]);
    expect(findResidue(`**What happens next:**\n${s16}\n`)).toEqual([s16]);
    expect(findResidue(`Done.\n\n${s17}\n`)).toEqual([s17]);
  });
});

describe('findResidue — ignored regions', () => {
  test('code fences', () => {
    const text = '```\n## Still open\n- x\nsay the word\n```\nDone.\n';
    expect(findResidue(text)).toEqual([]);
  });
  test('tilde fences', () => {
    expect(findResidue('~~~md\nsay the word\n~~~\n')).toEqual([]);
  });
  test('blockquotes', () => {
    expect(findResidue('> say the word\n> ## Still open\n')).toEqual([]);
  });
  test('Needs you heading', () => {
    const text = '## Needs you\n- run `sudo apt install socat` — say the word when done\n';
    expect(findResidue(text)).toEqual([]);
  });
  test('Needs you bold label', () => {
    expect(findResidue('**Needs you:** say the word after the 2FA code.\n')).toEqual([]);
  });
  test('Needs you section ends at the next heading', () => {
    const text = '## Needs you\n- one action\n\n## Follow-ups\n- leftover\n';
    expect(findResidue(text)).toEqual(['- leftover']);
  });
  test('quoted phrases (straight, curly, single, backtick) do not count', () => {
    expect(findResidue('One report said "Not queued, needs a new Epic from you" twice.\n')).toEqual([]);
    expect(findResidue('Another ended “Say the word and I’ll push it.” again.\n')).toEqual([]);
    expect(findResidue("The phrase 'say the word' showed up 5 times.\n")).toEqual([]);
    expect(findResidue('The checker matches `needs a new epic` and `say the word`.\n')).toEqual([]);
  });
  test('an apostrophe inside a word does not open a quote', () => {
    const line = "It's a bug that needs a new Epic from you, I'm afraid.";
    expect(findResidue(`${line}\n`)).toEqual([line]);
  });
  test('markdown table rows', () => {
    const text = '| Kind | Quote |\n| --- | --- |\n| outside goal | needs a new Epic from you; say the word |\n';
    expect(findResidue(text)).toEqual([]);
  });
  test('a heading that only starts with a label word is not a label', () => {
    expect(findResidue('## Remaining budget\n- 4 PRDs of 30 used\n')).toEqual([]);
    expect(findResidue('**Deferred to PRD 4100 (queued)**\n- the doc fix\n')).toEqual([]);
    expect(findResidue('**Deferred to PRD 4100 (queued):** the doc fix.\n')).toEqual([]);
  });
  test('a label with a trailing colon still counts', () => {
    expect(findResidue('## Still open:\n- wire the toggle\n')).toEqual(['- wire the toggle']);
    expect(findResidue('**Remaining:**\n- wire the toggle\n')).toEqual(['- wire the toggle']);
    expect(findResidue('**Remaining**:\n- wire the toggle\n')).toEqual(['- wire the toggle']);
  });
  test('still flags a real unquoted Still open list and plain-prose phrase', () => {
    expect(findResidue('Done.\n\n**Still open:**\n- no reply sent yet\n')).toEqual(['- no reply sent yet']);
    const line = 'The cache bug needs a new Epic from you.';
    expect(findResidue(`All green.\n${line}\n`)).toEqual([line]);
  });
  test('non-string input', () => {
    expect(findResidue(undefined)).toEqual([]);
    expect(findResidue(42)).toEqual([]);
  });
});

describe('script entry point', () => {
  test('blocks with a reason quoting the lines', () => {
    const r = run({ last_assistant_message: RESIDUE, stop_hook_active: false });
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.out);
    expect(obj.decision).toBe('block');
    expect(obj.reason).toContain('wire the toggle into settings');
    expect(obj.reason).toMatch(/queue a PRD/);
    expect(obj.reason).toMatch(/one-line revert/);
    expect(obj.reason).toMatch(/trigger/);
    expect(obj.reason).toMatch(/close it with a reason/);
    expect(obj.reason).toMatch(/Needs you/);
    expect(obj.reason).toMatch(/end the turn again/);
  });

  test('silent without SM_CHAT_SESSION_ID', () => {
    const r = run({ last_assistant_message: RESIDUE }, {});
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
  });

  test('silent in a scheduled job', () => {
    const r = run({ last_assistant_message: RESIDUE }, { SM_CHAT_SESSION_ID: 's', SM_SCHEDULER_JOB_SLUG: '4202-x' });
    expect(r.out).toBe('');
    expect(r.code).toBe(0);
  });

  test('silent when SM_RESIDUE_CHECK=0', () => {
    const r = run({ last_assistant_message: RESIDUE }, { SM_CHAT_SESSION_ID: 's', SM_RESIDUE_CHECK: '0' });
    expect(r.out).toBe('');
    expect(r.code).toBe(0);
  });

  test('silent when stop_hook_active', () => {
    const r = run({ last_assistant_message: RESIDUE, stop_hook_active: true });
    expect(r.out).toBe('');
    expect(r.code).toBe(0);
  });

  test('silent when the message ends with the SM_NEEDS_INPUT marker + JSON', () => {
    const msg = `${RESIDUE}\n<<<SM_NEEDS_INPUT>>>\n{"questions":["Which one?"]}\n`;
    const r = run({ last_assistant_message: msg });
    expect(r.out).toBe('');
    expect(r.code).toBe(0);
  });

  test('silent on a clean report', () => {
    const r = run({ last_assistant_message: 'All queued: 4203-fix.\n' });
    expect(r.out).toBe('');
    expect(r.code).toBe(0);
  });

  test('falls back to the last assistant text in transcript_path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'residue-'));
    tmpDirs.push(dir);
    const tp = path.join(dir, 't.jsonl');
    const lines = [
      { type: 'user', message: { role: 'user', content: 'go' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Old: say the word' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: RESIDUE }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: {} }] } },
    ];
    fs.writeFileSync(tp, lines.map((l) => JSON.stringify(l)).join('\n') + '\nnot json\n');
    const r = run({ transcript_path: tp });
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.out);
    expect(obj.decision).toBe('block');
    expect(obj.reason).toContain('wire the toggle');
    expect(obj.reason).not.toContain('Old: say the word');
  });

  test('fails open on bad input', () => {
    for (const bad of ['', 'not json', '[]', 'null', JSON.stringify({ transcript_path: '/nonexistent/x.jsonl' })]) {
      const r = run(bad);
      expect(r.code).toBe(0);
      expect(r.out).toBe('');
    }
  });
});

describe('plugin hooks.json wiring', () => {
  const HOOKS_JSON = path.resolve(__dirname, '../../../plugins/session-manager-dev/hooks/hooks.json');
  const PLUGIN_ROOT = path.resolve(__dirname, '../../../plugins/session-manager-dev');

  test('registers exactly one Stop command hook pointing at an existing script', () => {
    const cfg = JSON.parse(fs.readFileSync(HOOKS_JSON, 'utf8'));
    expect(Object.keys(cfg.hooks)).toEqual(['Stop']);
    const stop = cfg.hooks.Stop;
    expect(Array.isArray(stop)).toBe(true);
    const hooks = stop.flatMap((g) => g.hooks);
    expect(hooks).toHaveLength(1);
    const [h] = hooks;
    expect(h.type).toBe('command');
    expect(h.timeout).toBe(10);
    expect(h.command).toBe('node "${CLAUDE_PLUGIN_ROOT}/hooks/residue-check.cjs"');
    const m = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)/.exec(h.command);
    expect(m).not.toBeNull();
    const script = path.join(PLUGIN_ROOT, m[1]);
    expect(script).toBe(SCRIPT);
    expect(fs.statSync(script).isFile()).toBe(true);
  });
});
