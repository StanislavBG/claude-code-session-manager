'use strict';
import { describe, it, expect } from 'vitest';
const fs = require('fs');
const path = require('path');
const {
  checkProjectVideoToolRunnable,
  mcpToolNamesFromScope,
  PROJECT_VIDEO_WRITE_ID,
  PROJECT_VIDEO_REVIEW_WRITE_ID,
} = require('../projectVideoToolCheck.cjs');

const CWD = '/tmp/proj';
const splitTools = (line) => line.split(',').map((s) => s.trim()).filter(Boolean);

function depsFor({ exists = true, tools = null } = {}) {
  return {
    assertAgentTypeWritable: async (cwd, name) => {
      if (!exists) {
        throw new Error(`agentType '${name}' does not resolve to a readable persona file — checked ${cwd}/.claude/agents/${name}.md and ~/.claude/agents/${name}.md. Available personas: demo-video-builder, dev-lead`);
      }
    },
    resolvePrdPersonaForSpawn: async () => ({ model: 'x', systemPrompt: 's', personaPath: '/p.md', tools }),
  };
}

// Mirror of scripts/scheduler-mcp-server.cjs jobToolScope's name rule, kept
// as a fixed-string oracle (src/main never requires from scripts/).
function jobToolScopeNames(entries) {
  const names = new Set();
  for (const entry of entries) {
    if (!entry.startsWith('mcp__')) continue;
    const i = entry.indexOf('__', 5);
    if (i > 0) names.add(entry.slice(i + 2));
  }
  return names;
}

describe('checkProjectVideoToolRunnable', () => {
  it('rejects a persona that does not resolve, with the available personas', async () => {
    const r = await checkProjectVideoToolRunnable({ cwd: CWD, agentName: 'claude', job: {} }, depsFor({ exists: false }));
    expect(r.ok).toBe(false);
    expect(r.error.startsWith('A Project Video tool runs as a scheduled job, so its persona must be a file in <cwd>/.claude/agents/ or ~/.claude/agents/:')).toBe(true);
    expect(r.error).toContain("agentType 'claude' does not resolve");
    expect(r.error).toContain('Available personas: demo-video-builder, dev-lead');
  });

  it('rejects a missing agentName as an unresolved persona', async () => {
    const r = await checkProjectVideoToolRunnable({ cwd: CWD, agentName: '', job: {} }, depsFor());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^A Project Video tool runs as a scheduled job/);
  });

  it('rejects the real tiktok-animator tools line (no MCP tools)', async () => {
    const tools = splitTools('Read, Grep, Glob, Bash, Edit, Write');
    const r = await checkProjectVideoToolRunnable({ cwd: CWD, agentName: 'tiktok-animator', job: { review: true } }, depsFor({ tools }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain(PROJECT_VIDEO_WRITE_ID);
    expect(r.error).toContain(PROJECT_VIDEO_REVIEW_WRITE_ID);
    expect(r.error).toContain('a scheduled job can call only the MCP tools its persona lists');
  });

  it('without review, only project_video_write is required', async () => {
    const tools = splitTools('Read, Write');
    const r = await checkProjectVideoToolRunnable({ cwd: CWD, agentName: 'a', job: {} }, depsFor({ tools }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain(PROJECT_VIDEO_WRITE_ID);
    expect(r.error).not.toContain(PROJECT_VIDEO_REVIEW_WRITE_ID);
  });

  it('a review tool listing only project_video_write names the review tool as missing', async () => {
    const tools = ['Read', PROJECT_VIDEO_WRITE_ID];
    const r = await checkProjectVideoToolRunnable({ cwd: CWD, agentName: 'a', job: { review: true } }, depsFor({ tools }));
    expect(r.ok).toBe(false);
    expect(r.error).toContain(PROJECT_VIDEO_REVIEW_WRITE_ID);
    expect(r.error).not.toContain(PROJECT_VIDEO_WRITE_ID);
  });

  it('a review tool listing both tools is ok', async () => {
    const tools = ['Read', PROJECT_VIDEO_WRITE_ID, PROJECT_VIDEO_REVIEW_WRITE_ID];
    const r = await checkProjectVideoToolRunnable({ cwd: CWD, agentName: 'a', job: { review: true } }, depsFor({ tools }));
    expect(r).toEqual({ ok: true });
  });

  it('a non-review tool listing project_video_write is ok', async () => {
    const tools = ['Read', PROJECT_VIDEO_WRITE_ID];
    const r = await checkProjectVideoToolRunnable({ cwd: CWD, agentName: 'a', job: {} }, depsFor({ tools }));
    expect(r).toEqual({ ok: true });
  });

  it('an unscoped persona (no tools list, or *) is ok', async () => {
    expect(await checkProjectVideoToolRunnable({ cwd: CWD, agentName: 'a', job: { review: true } }, depsFor({ tools: null }))).toEqual({ ok: true });
    expect(await checkProjectVideoToolRunnable({ cwd: CWD, agentName: 'a', job: { review: true } }, depsFor({ tools: ['*'] }))).toEqual({ ok: true });
  });
});

describe('mcpToolNamesFromScope', () => {
  it('agrees with jobToolScope on fixed strings', () => {
    const entries = [
      'mcp__session-manager-scheduler__project_video_write',
      'mcp__session-manager-scheduler',
      'Read',
    ];
    const ours = mcpToolNamesFromScope({ tools: entries });
    const theirs = jobToolScopeNames(entries);
    expect([...ours].sort()).toEqual([...theirs].sort());
    expect([...ours]).toEqual(['project_video_write']);
  });

});

describe('lib layout', () => {
  it('lists projectVideoToolCheck under persona-macro', () => {
    const layout = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../../scripts/lib-layout.json'), 'utf8'));
    expect(layout.projectVideoToolCheck).toBe('persona-macro');
  });
});
