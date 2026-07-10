/**
 * runVerify.cjs — post-run reconciliation verifier.
 *
 * Called by scheduler.cjs after every agent exit=0, before marking a job
 * "completed". Pattern-matches tool_result content from the run log and checks
 * dependency prerequisites to catch false-positives (clean-exit ≠ done).
 *
 * Pure: no IPC, no queue writes. Writes a verdicts.json sidecar to runDir as
 * a by-product so the renderer and any offline tooling can read the result
 * without re-parsing the log.
 *
 * Exported API:
 *   verifyRun({ runDir, prdPath, queueEntry, allJobs }) → Promise<Verdict>
 *
 * Verdict shape:
 *   { verdict: 'clean'|'halt'|'deps_unmet'|'transcript_errors'|'verify_unavailable',
 *     reason: string,
 *     downgradeTo: 'pending'|'needs_review'|null }
 *
 * Downgrade policy:
 *   clean           → null        (caller stamps 'completed')
 *   halt            → 'pending'   (re-fires automatically next slot)
 *   deps_unmet      → 'pending'   (re-fires when deps clear)
 *   transcript_errors → 'needs_review' (requires human flip)
 *   verify_unavailable → 'needs_review'
 *
 * Time complexity: O(N·L) where N = log line count, L = avg content line count.
 * The log is read once with readFileSync (700 KB typical; well within Node.js
 * heap). Line-by-line JSON parsing keeps working set small.
 *
 * Non-goals: semantic understanding of agent output, retroactive re-verification
 * of already-completed jobs.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VERDICTS_SCHEMA_VERSION = 1;

// ─── content pattern detectors ───────────────────────────────────────────────

/**
 * Detect high-signal error patterns in a single tool_result content string.
 * Returns { verdict, pattern } on match, null if clean.
 *
 * Checked in priority order (cheapest first):
 *   1. FAIL/FATAL at line start
 *   2. Traceback + Error within 10 lines (Python exception)
 *   3. ModuleNotFoundError / ImportError (missing venv / broken deps)
 */
/**
 * True when a tool_result content is a Claude Code harness tool error rather
 * than task output — emitted when the model calls a tool that doesn't exist or
 * isn't allowed (e.g. `<tool_use_error>Error: No such tool available: bash`).
 * The harness rejects the call; the model recovers by retrying with a valid
 * tool. Never a task failure, so the verifier must not downgrade on it.
 */
function isHarnessToolError(content) {
  if (typeof content !== 'string' || !content) return false;
  return content.includes('<tool_use_error>')
    || /\bNo such tool available\b/.test(content);
}

function detectPattern(content) {
  if (typeof content !== 'string' || !content) return null;

  // (1) FAIL/FATAL at the start of a line (case-sensitive, multiline).
  if (/^FAIL\b/m.test(content) || /^FATAL\b/m.test(content)) {
    return { verdict: 'transcript_errors', pattern: 'FAIL/FATAL at line start' };
  }

  // (2) Python Traceback + exception line within next 10 lines. Both anchored
  // to line starts: reviewer prose quoting "will crash with ImportError" or
  // embedding "...Error:" mid-sentence must not match (feedback 2026-06-10-01).
  //
  // The TERMINATING exception decides the class: a Traceback ending in
  // ModuleNotFoundError/ImportError is the missing-dependency class ("the
  // verification couldn't run", same as detector 3), NOT a logic failure — so
  // it routes through the weaker verify_unavailable path (env-recovery escape
  // hatch + success demotion). A Traceback ending in any other exception
  // (KeyError, AssertionError, …) stays transcript_errors — that is the real
  // false-PASS class the verifier exists to catch (2026-05-23 incident).
  // (feedback 2026-06-10 addendum: interpreter-search setup probes that ended
  // in ModuleNotFoundError were 3/3 false positives.)
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*Traceback \(most recent call last\):/.test(lines[i])) {
      for (let j = i + 1; j < Math.min(i + 11, lines.length); j++) {
        const m = lines[j].match(/^\s*([A-Za-z_][\w.]*(?:Error|Exception))\s*:/);
        if (m) {
          if (m[1] === 'ModuleNotFoundError' || m[1] === 'ImportError') {
            return { verdict: 'verify_unavailable', pattern: `Traceback → ${m[1]}` };
          }
          return { verdict: 'transcript_errors', pattern: 'Traceback + Error within 10 lines' };
        }
      }
    }
  }

  // (3) Import / module errors (verification was skipped). Line-anchored:
  // real interpreter output starts the line with the exception name
  // ("ModuleNotFoundError: No module named 'x'"); prose never does.
  if (/^\s*(?:ModuleNotFoundError|ImportError)\s*(?::|$)/m.test(content)) {
    return { verdict: 'verify_unavailable', pattern: 'ModuleNotFoundError/ImportError' };
  }

  return null;
}

// ─── log parser ───────────────────────────────────────────────────────────────

/**
 * Coerce a tool_result content field to a plain string.
 * Claude's stream-json may send content as either a string or an array of
 * { type: 'text', text: '...' } blocks.
 */
function extractContent(item) {
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) {
    return item.content
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  }
  return '';
}

/**
 * Parse the run log into a flat sequence of extracted events.
 *
 * Event shapes:
 *   { kind:'tool_use',    seq, toolUseId, toolName, description, command }
 *   { kind:'tool_result', seq, toolUseId, content, isError }
 *   { kind:'result',      seq, subtype, resultText }
 *
 * Non-JSON lines (scheduler metadata "[scheduler] ...") are silently skipped.
 * Malformed JSON lines are also skipped.
 *
 * O(N) where N = log line count.
 *
 * @returns {{ events: object[], resultEvent: object|null, error: string|null }}
 */
function parseLog(logPath) {
  let text;
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch (e) {
    return { events: [], resultEvent: null, error: e.message };
  }

  const events = [];
  let resultEvent = null;
  let seq = 0;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('[scheduler]')) continue;

    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    if (!obj || typeof obj !== 'object') continue;

    // Final result event.
    if (obj.type === 'result') {
      const ev = {
        kind: 'result',
        seq: seq++,
        subtype: obj.subtype ?? '',
        resultText: typeof obj.result === 'string' ? obj.result : '',
      };
      resultEvent = ev;
      events.push(ev);
      continue;
    }

    // Assistant turn: extract tool_use items.
    if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
      for (const item of obj.message.content) {
        if (item?.type === 'tool_use') {
          events.push({
            kind: 'tool_use',
            seq: seq++,
            toolUseId: item.id ?? '',
            toolName: item.name ?? '',
            description: item.input?.description ?? '',
            command: item.input?.command ?? '',
          });
        }
      }
      continue;
    }

    // User turn: extract tool_result items.
    if (obj.type === 'user' && Array.isArray(obj.message?.content)) {
      for (const item of obj.message.content) {
        if (item?.type === 'tool_result') {
          events.push({
            kind: 'tool_result',
            seq: seq++,
            toolUseId: item.tool_use_id ?? '',
            content: extractContent(item),
            isError: item.is_error === true,
          });
        }
      }
      continue;
    }
  }

  return { events, resultEvent, error: null };
}

// ─── self-recovery helpers ────────────────────────────────────────────────────

/**
 * Return the description of the tool_use that produced a given tool_result
 * (matched by tool_use_id). Returns '' if not found.
 */
function toolUseDesc(events, toolUseId) {
  if (!toolUseId) return '';
  for (const ev of events) {
    if (ev.kind === 'tool_use' && ev.toolUseId === toolUseId) return ev.description ?? '';
  }
  return '';
}

/**
 * Return the tool name of the tool_use that produced a given tool_result.
 * Returns '' if not found.
 */
function toolUseName(events, toolUseId) {
  if (!toolUseId) return '';
  for (const ev of events) {
    if (ev.kind === 'tool_use' && ev.toolUseId === toolUseId) return ev.toolName ?? '';
  }
  return '';
}

/**
 * Check whether the next ≤5 tool_use calls after `fromSeq` include a package
 * install command (pip install, pip3 install, uv sync, uv pip install).
 */
function hasInstallRecovery(events, fromSeq) {
  let count = 0;
  for (const ev of events) {
    if (ev.seq <= fromSeq) continue;
    if (ev.kind !== 'tool_use') continue;
    if (++count > 5) break;
    const combined = `${ev.command ?? ''} ${ev.description ?? ''}`;
    if (/pip\d*\s+install/i.test(combined) || /uv\s+(?:sync|pip\s+install)/i.test(combined)) {
      return true;
    }
  }
  return false;
}

/**
 * Check whether the error at `errorSeq` is self-recovered within the next 30
 * events.
 *
 * Recovery heuristic: another tool_use with the same non-empty `description`
 * appears within 30 events of the error, AND its corresponding tool_result is
 * free of error patterns AND is not is_error=true.
 */
function isSelfRecovered(events, errorSeq, desc) {
  if (!desc) return false;

  // Build a quick lookup from tool_use_id → tool_result event.
  const resultByUseId = new Map();
  for (const ev of events) {
    if (ev.kind === 'tool_result') resultByUseId.set(ev.toolUseId, ev);
  }

  let seen = 0;
  for (const ev of events) {
    if (ev.seq <= errorSeq) continue;
    if (++seen > 30) break;
    if (ev.kind !== 'tool_use' || ev.description !== desc) continue;
    const result = resultByUseId.get(ev.toolUseId);
    if (result && !result.isError && !detectPattern(result.content)) return true;
  }
  return false;
}

// ─── soak / deps parsing ─────────────────────────────────────────────────────

/**
 * Extract soak days from a text string.
 *
 * Accepted forms (case-insensitive):
 *   "30+ days", "30 days", "≥ 180 days", "180-day soak",
 *   "N days of soak", "N days each", "soak of N days"
 *
 * Returns { soakDays, soakPhrase } or null.
 * Refuses to parse if the unit is not days (surfaces as verify_unavailable
 * at the dep-check call site).
 */
function extractSoakFromBody(body) {
  const PATTERNS = [
    /(\d+)\+?\s*-?day\s+soak/i,
    /soak\s+of\s+(\d+)\+?\s*days?/i,
    /≥\s*(\d+)\s+days?/i,
    /(\d+)\+?\s*days?\s+(?:of\s+)?soak/i,
    /(\d+)\+?\s*days?\s+each/i,
    /only\s+after\s+\S+.*?(?:run\s+)?(\d+)\+?\s*days?/i,
  ];
  for (const re of PATTERNS) {
    const m = body.match(re);
    if (m && m[1]) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n) && n > 0 && n <= 3650) return { soakDays: n, soakPhrase: m[0].trim() };
    }
  }
  return null;
}

/**
 * Parse dependency slug fragments from a PRD body:
 *   - Lines under "# Dependencies", "# Depends on", "# Pre-condition", "# Blocked on"
 *   - Inline "This PRD is blocked on: - M2 — ..."
 *
 * Returns a deduplicated array of lowercase fragment strings.
 */
function parsePrdBodyDepFragments(body) {
  const frags = [];

  const SECTION_RE = /^#+\s*(?:depends?\s+on|dependencies|pre-?conditions?|blocked\s+on)[^\n]*\n([\s\S]*?)(?=\n#|$)/im;
  const INLINE_RE = /(?:this\s+prd\s+is\s+blocked\s+on|depends?\s+on)\s*:?\s+([\s\S]*?)(?=\n\n|$)/i;

  const sections = [];
  const sm = body.match(SECTION_RE);
  if (sm) sections.push(sm[1]);
  const im = body.match(INLINE_RE);
  if (im) sections.push(im[1]);

  for (const section of sections) {
    for (const m of section.matchAll(/^\s*[-*]\s*([A-Za-z][A-Za-z0-9._-]+)/gm)) {
      const frag = m[1].toLowerCase();
      if (frag.length >= 2) frags.push(frag);
    }
  }
  return [...new Set(frags)];
}

/**
 * Verify that all declared dependencies for `queueEntry` are satisfied.
 *
 * Two layers:
 *   1. queue.json's `dependsOn` array (explicit slug list, often empty).
 *   2. PRD body deps section (prose slug fragments + optional soak period).
 *
 * @returns {{ ok: boolean, reason?: string, floorDate?: string }}
 */
function checkDeps(queueEntry, allJobs, prdBody) {
  const bySlug = new Map(allJobs.map((j) => [j.slug, j]));

  // 1. Queue-level dependsOn (explicit).
  const queueDeps = Array.isArray(queueEntry.dependsOn) ? queueEntry.dependsOn : [];
  for (const depSlug of queueDeps) {
    const dep = bySlug.get(depSlug);
    if (!dep) {
      return { ok: false, reason: `dependsOn: "${depSlug}" not found in queue` };
    }
    if (dep.status !== 'completed') {
      return { ok: false, reason: `dependsOn: "${depSlug}" is ${dep.status} (need completed)` };
    }
  }

  // 2. PRD body deps (prose).
  if (prdBody) {
    const frags = parsePrdBodyDepFragments(prdBody);
    const soak = extractSoakFromBody(prdBody);
    let latestFinishedMs = null;

    for (const frag of frags) {
      // Substring match: "m7" matches "44-signal-builder-m7-final-cutover".
      const matches = allJobs.filter(
        (j) => j.slug !== queueEntry.slug && j.slug.toLowerCase().includes(frag),
      );
      if (matches.length === 0) continue; // unresolvable fragment — skip

      for (const dep of matches) {
        if (dep.status !== 'completed') {
          return {
            ok: false,
            reason: `PRD body dep "${frag}" → "${dep.slug}" is ${dep.status} (need completed)`,
          };
        }
        if (dep.finishedAt) {
          const t = new Date(dep.finishedAt).getTime();
          if (!isNaN(t) && (latestFinishedMs === null || t > latestFinishedMs)) {
            latestFinishedMs = t;
          }
        }
      }
    }

    // Soak period check.
    if (soak && latestFinishedMs !== null) {
      const floorMs = latestFinishedMs + soak.soakDays * 86_400_000;
      if (Date.now() < floorMs) {
        const floorDate = new Date(floorMs).toISOString().slice(0, 10);
        return {
          ok: false,
          reason: `Soak not elapsed: "${soak.soakPhrase}" requires waiting until ${floorDate}`,
          floorDate,
        };
      }
    }
  }

  return { ok: true };
}

// ─── sentinel scanner ─────────────────────────────────────────────────────────

/**
 * Scan for a `SCHEDULER_VERDICT: PASS|FAIL` sentinel line in the run output.
 *
 * Checks `resultEvent.resultText` first (the agent's final message), then the
 * last tool_result content. Anchored to line-start so prose mentioning the
 * string in mid-sentence does not match.
 *
 * Returns 'pass', 'fail', or null.
 */
function scanSentinel(resultEvent, events) {
  const RE = /^SCHEDULER_VERDICT:\s*(PASS|FAIL)\b/m;

  if (resultEvent) {
    const m = resultEvent.resultText.match(RE);
    if (m) return m[1].toLowerCase();
  }

  let lastToolResult = null;
  for (const ev of events) {
    if (ev.kind === 'tool_result') lastToolResult = ev;
  }
  if (lastToolResult && lastToolResult.content) {
    const m = lastToolResult.content.match(RE);
    if (m) return m[1].toLowerCase();
  }

  return null;
}

// ─── main verifier ────────────────────────────────────────────────────────────

/**
 * Verify a completed run (exit=0). Returns a verdict indicating whether the
 * scheduler should mark the job 'completed', downgrade to 'pending', or
 * escalate to 'needs_review'.
 *
 * @param {object}   params
 * @param {string}   params.runDir            Absolute path to the run directory.
 * @param {string}   params.prdPath           Absolute path to the PRD .md file.
 * @param {object}   params.queueEntry        The queue.json entry for this job.
 * @param {object[]} [params.allJobs]         All entries from queue.json (dep checks).
 * @param {boolean}  [params.committedDuringRun] True when HEAD moved during the run,
 *                                            confirming the job's commit landed.
 *                                            Default false for back-compat.
 * @param {boolean}  [params.allowPreSentinelHeal] When true, a commit-in-window
 *                                            with no SCHEDULER_VERDICT: FAIL is
 *                                            sufficient to override weak verdicts
 *                                            (transcript_errors/verify_unavailable)
 *                                            even without a PASS sentinel. Only
 *                                            set by the boot reverify self-heal
 *                                            pass for pre-sentinel legacy runs.
 * @returns {Promise<{verdict:string, reason:string, downgradeTo:string|null}>}
 */
async function verifyRun({ runDir, prdPath, queueEntry, allJobs = [], committedDuringRun = false, allowPreSentinelHeal = false }) {
  const { slug } = queueEntry;
  const logPath = path.join(runDir, `${slug}.log`);
  const verdictsPath = path.join(runDir, `${slug}.verdicts.json`);

  /** Write the sidecar and return the verdict object. */
  function conclude(verdict, reason, downgradeTo, extras) {
    const record = {
      schemaVersion: VERDICTS_SCHEMA_VERSION,
      verdict,
      reason,
      downgradeTo,
      scannedAt: new Date().toISOString(),
      ...(extras ?? {}),
    };
    try { fs.writeFileSync(verdictsPath, JSON.stringify(record, null, 2)); } catch { /* best-effort */ }
    return { verdict, reason, downgradeTo, ...(extras ?? {}) };
  }

  try {
    // ── Read PRD body (strip frontmatter) ──────────────────────────────────
    let prdBody = '';
    try {
      const prdText = fs.readFileSync(prdPath, 'utf8');
      if (prdText.startsWith('---\n')) {
        const end = prdText.indexOf('\n---', 4);
        prdBody = end !== -1 ? prdText.slice(end + 4).trim() : prdText;
      } else {
        prdBody = prdText;
      }
    } catch { /* PRD unreadable — skip PRD-level dep checks */ }

    // ── 1. Dependency check ────────────────────────────────────────────────
    // Run first: if deps are unmet we can skip the expensive log parse.
    const depsResult = checkDeps(queueEntry, allJobs, prdBody);
    if (!depsResult.ok) {
      return conclude('deps_unmet', depsResult.reason, 'pending', {
        soakFloorDate: depsResult.floorDate ?? null,
      });
    }

    // ── 2. Parse log ───────────────────────────────────────────────────────
    const { events, resultEvent, error: parseError } = parseLog(logPath);

    if (parseError) {
      return conclude('verify_unavailable', `log unreadable: ${parseError}`, 'needs_review');
    }

    // ── 3. HALT detection ─────────────────────────────────────────────────
    // Primary: check the final `{"type":"result"}` event's `result` text.
    if (resultEvent) {
      const rt = resultEvent.resultText;
      if (/\bHALT:/i.test(rt) || /^HALT\b/m.test(rt)) {
        const firstLine = rt.split('\n')[0].slice(0, 200);
        let reason = `Agent HALTed: ${firstLine}`;
        // Embed machine-parseable floor date if present in HALT message.
        const dateMatch = rt.match(/~?(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) reason += ` (eligible from: ${dateMatch[1]})`;
        return conclude('halt', reason, 'pending');
      }
    }

    // ── 4. Tool-result error scan ─────────────────────────────────────────
    const total = events.length;
    const last20pctStart = Math.floor(total * 0.8);
    const issues = [];
    // Non-blocking notes: signals worth recording but not strong enough to
    // downgrade (e.g. a missing-dependency probe in a run that still succeeded).
    const annotations = [];
    const runSucceeded = !!resultEvent && resultEvent.subtype === 'success';

    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev.kind !== 'tool_result') continue;

      // Harness tool errors (`<tool_use_error>…`) are emitted when the model
      // requests a tool that isn't available — e.g. a wrong-case name like
      // "bash" instead of "Bash", or a tool outside the allowlist. The harness
      // rejects the call and the model retries with a valid tool; the task is
      // unaffected. These are never task failures, so they are exempt from both
      // the is_error scan and the content pattern scan (false-positive class
      // seen in 58-web-remote-correctness-batch, 2026-06-10).
      if (isHarnessToolError(ev.content)) continue;

      // is_error:true in the final 20% of the transcript.
      if (ev.isError && i >= last20pctStart) {
        const desc = toolUseDesc(events, ev.toolUseId);
        if (!isSelfRecovered(events, ev.seq, desc)) {
          issues.push({
            verdict: 'transcript_errors',
            reason: `is_error=true in final 20% of transcript (event ${i}/${total})`,
            priority: 2,
          });
          continue; // is_error already covers any content patterns
        }
      }

      if (!ev.content) continue;

      // Subagent (Task) results are structured prose — review findings that
      // *describe* exceptions ("will crash with ImportError") are the dominant
      // false-positive source (feedback 2026-06-10-01). Real runtime errors
      // surface through Bash/test tool_results, which are still scanned.
      if (toolUseName(events, ev.toolUseId) === 'Task') continue;

      const hit = detectPattern(ev.content);
      if (!hit) continue;

      const desc = toolUseDesc(events, ev.toolUseId);

      if (hit.verdict === 'verify_unavailable') {
        // ModuleNotFoundError/ImportError: first check for pip/uv install in
        // the next ≤5 tool_use calls (the agent may have self-healed).
        if (!hasInstallRecovery(events, ev.seq) && !isSelfRecovered(events, ev.seq, desc)) {
          const note = `${hit.pattern} at event ${i}, no install recovery found`;
          if (runSucceeded) {
            // "Verification couldn't run" is the weakest signal. When the run
            // still reached a genuine result:success, the agent resolved its
            // environment (often an interpreter/venv search the recovery
            // heuristics above don't model) and finished — record it as an
            // annotation, do NOT downgrade. transcript_errors (real logic/test
            // failures) are never demoted this way, so the false-PASS guard is
            // intact. (feedback 2026-06-10 addendum.)
            annotations.push({ verdict: 'verify_unavailable', reason: note });
          } else {
            issues.push({ verdict: 'verify_unavailable', reason: note, priority: 1 });
          }
        }
      } else {
        // transcript_errors (FAIL/FATAL/Traceback): self-recovery escape hatch.
        if (!isSelfRecovered(events, ev.seq, desc)) {
          issues.push({
            verdict: 'transcript_errors',
            reason: `${hit.pattern} at event ${i} (no self-recovery)`,
            priority: 2,
          });
        }
      }
    }

    // Scan for the SCHEDULER_VERDICT sentinel emitted by the finish protocol.
    const sentinel = scanSentinel(resultEvent, events);
    const sentinelFields = sentinel ? { sentinel } : {};
    const extras = (annotations.length || sentinel)
      ? { ...(annotations.length ? { annotations } : {}), ...sentinelFields }
      : undefined;

    // No pattern hits is not automatically "clean": a run that neither
    // committed anything nor ever emitted the finish-protocol sentinel likely
    // ended before doing real work (e.g. stopped on a clarifying question).
    // Weaker evidence than a caught transcript error, but still not clean.
    if (sentinel === null && !committedDuringRun) {
      issues.push({
        verdict: 'no_verdict_sentinel',
        reason: 'run made no commit and emitted no SCHEDULER_VERDICT sentinel — likely ended before the finish protocol (e.g. stopped on a clarifying question)',
        priority: 1,
      });
    }

    if (issues.length === 0) {
      const reason = annotations.length
        ? `no blocking issues (${annotations.length} annotation(s): ${annotations.map((a) => a.reason).join('; ')})`
        : 'no issues detected';
      return conclude('clean', reason, null, extras);
    }

    // Pick highest-priority issue (transcript_errors > verify_unavailable ==
    // no_verdict_sentinel; ties keep the loop's original order via stable sort).
    issues.sort((a, b) => b.priority - a.priority);
    const top = issues[0];

    // Sentinel override: SCHEDULER_VERDICT: PASS + a commit that landed during
    // the run is authoritative evidence the job succeeded. Suppresses incidental
    // transcript noise (grep results with "Error", TDD red-phase reproductions,
    // Traceback in debug output) for the two weakest verdict classes.
    // MUST NOT apply to halt or deps_unmet — those keep their existing semantics.
    if (
      sentinel === 'pass'
      && committedDuringRun
      && (top.verdict === 'transcript_errors' || top.verdict === 'verify_unavailable')
    ) {
      return conclude('clean',
        `SCHEDULER_VERDICT: PASS + commit landed overrides ${top.verdict}`,
        null,
        { ...(annotations.length ? { annotations } : {}), sentinel, sentinelOverride: top.verdict },
      );
    }

    // Pre-sentinel heal: job predates SCHEDULER_VERDICT emission. A commit in
    // the run window with no explicit FAIL sentinel is weak but sufficient to
    // override the two weakest verdict classes during the self-heal pass.
    // Only applies when the caller opts in (allowPreSentinelHeal=true) — live
    // runs never set this, so only the boot reverify self-heal uses it.
    if (
      allowPreSentinelHeal
      && committedDuringRun
      && sentinel !== 'fail'
      && (top.verdict === 'transcript_errors' || top.verdict === 'verify_unavailable')
    ) {
      return conclude('clean',
        `pre-sentinel heal: committed in run window, no SCHEDULER_VERDICT: FAIL, overrides ${top.verdict}`,
        null,
        { ...(annotations.length ? { annotations } : {}), preSentinelHeal: top.verdict },
      );
    }

    return conclude(top.verdict, top.reason, 'needs_review', extras);

  } catch (e) {
    return conclude(
      'verify_unavailable',
      `verifier threw: ${e?.message ?? String(e)}`,
      'needs_review',
    );
  }
}

module.exports = {
  verifyRun,
  // Exposed for unit tests.
  detectPattern,
  isHarnessToolError,
  toolUseName,
  extractSoakFromBody,
  parsePrdBodyDepFragments,
  checkDeps,
  parseLog,
  scanSentinel,
};
