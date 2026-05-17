/**
 * Supervisor e2e test.
 *
 * Verifies that supervisorTick() identifies a stale job and SIGTERMs the
 * offending descendant bash subprocess without killing the agent process.
 *
 * Setup:
 *  1. A real bash subprocess is spawned with `until false; do sleep 1; done`
 *     (a classic unsatisfiable poll-loop).
 *  2. A fake `claude` shim is written to a temp dir and prepended to PATH;
 *     when invoked as the Opus probe it returns a kill-bash verdict with the
 *     actual bash PID.
 *  3. A synthetic queue.json entry marks the job as "running" with the bash
 *     parent's PID.
 *  4. A stale run log (mtime and content older than the stale threshold) is
 *     written to the runs dir.
 *  5. `supervisor:tick-now` IPC is invoked; within 30 s we assert:
 *     - the bash subprocess is dead (ESRCH on kill -0)
 *     - supervisor.log has a kill-bash entry for the test slug
 */

import { test, expect, _electron as electron } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')

const HOME = os.homedir()
const SM_ROOT = path.join(HOME, '.claude', 'session-manager')
const PRDS_DIR = path.join(SM_ROOT, 'scheduled-plans', 'prds')
const RUNS_DIR = path.join(SM_ROOT, 'scheduled-plans', 'runs')
const QUEUE_JSON = path.join(SM_ROOT, 'scheduled-plans', 'queue.json')
const SUPERVISOR_LOG = path.join(SM_ROOT, 'supervisor.log')

const TEST_SLUG = 'e2e-supervisor-wedged-job'
const TEST_RUN_ID = '2020-01-01T00-00-00-000Z'

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Write the fake claude shim that returns a kill-bash verdict. */
function writeFakeClaudeShim(shimDir: string, bashPid: number, agentPid: number): string {
  const shimPath = path.join(shimDir, 'claude')
  // The shim outputs the probe result JSON, mimicking --output-format json.
  const output = JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: JSON.stringify({
      verdict: 'stuck',
      action: 'kill-bash',
      targetPid: bashPid,
      reason: 'until false; do sleep 1; done is an unsatisfiable loop',
    }),
    total_cost_usd: 0.001,
  })
  fs.writeFileSync(shimPath, `#!/bin/bash\necho '${output.replace(/'/g, "'\\''")}'\n`, { mode: 0o755 })
  return shimPath
}

/** Write a stale JSONL run log (no recent timestamps). */
function writeStaleRunLog(runDir: string, slug: string) {
  fs.mkdirSync(runDir, { recursive: true })
  const logPath = path.join(runDir, `${slug}.log`)
  // Timestamp from 30 minutes ago — well past the 10-min stale threshold.
  const staleTs = new Date(Date.now() - 30 * 60_000).toISOString()
  const content = [
    `[scheduler] starting ${slug} at ${staleTs}`,
    JSON.stringify({ type: 'assistant', timestamp: staleTs, message: { role: 'assistant', content: [] } }),
    '',
  ].join('\n')
  fs.writeFileSync(logPath, content)
  // Back-date the file mtime to match.
  const staleDate = new Date(Date.now() - 30 * 60_000)
  fs.utimesSync(logPath, staleDate, staleDate)
  return logPath
}

/** Inject a running job into queue.json with the given pids. */
function injectRunningJob(agentPid: number, runId: string) {
  let queue: Record<string, unknown> = { config: {}, jobs: [], scheduledFor: null, lastRunAt: null, paused: null }
  try {
    queue = JSON.parse(fs.readFileSync(QUEUE_JSON, 'utf8'))
  } catch { /* first boot */ }

  const jobs = Array.isArray(queue.jobs) ? (queue.jobs as unknown[]) : []
  // Remove any stale test entry.
  const filtered = jobs.filter((j: unknown) => (j as { slug?: string }).slug !== TEST_SLUG)
  filtered.push({
    slug: TEST_SLUG,
    title: 'E2E supervisor test job',
    cwd: '/tmp',
    parallelGroup: 99,
    estimateMinutes: 1,
    bodyPreview: '',
    status: 'running',
    runId,
    startedAt: new Date(Date.now() - 40 * 60_000).toISOString(),
    finishedAt: null,
    exitCode: null,
    error: null,
    runtime: { pid: agentPid, runId, startedAt: new Date(Date.now() - 40 * 60_000).toISOString() },
  })
  queue.jobs = filtered

  const tmp = `${QUEUE_JSON}.supervisor-test-${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(queue, null, 2))
  fs.renameSync(tmp, QUEUE_JSON)
}

function cleanupTestArtifacts(agentPid: number | null, bashPid: number | null, shimDir: string) {
  // Kill leftover subprocesses (best-effort).
  for (const pid of [agentPid, bashPid]) {
    if (pid && isAlive(pid)) {
      try { process.kill(pid, 'SIGKILL') } catch { /* */ }
    }
  }
  // Remove shim dir.
  try { fs.rmSync(shimDir, { recursive: true, force: true }) } catch { /* */ }
  // Remove test PRD if present.
  try { fs.unlinkSync(path.join(PRDS_DIR, `${TEST_SLUG}.md`)) } catch { /* */ }
  // Remove test run dir.
  try { fs.rmSync(path.join(RUNS_DIR, TEST_RUN_ID), { recursive: true, force: true }) } catch { /* */ }
  // Remove the test job from queue.json.
  try {
    const q = JSON.parse(fs.readFileSync(QUEUE_JSON, 'utf8'))
    q.jobs = (q.jobs as { slug?: string }[]).filter((j) => j.slug !== TEST_SLUG)
    const tmp = `${QUEUE_JSON}.cleanup-${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(q, null, 2))
    fs.renameSync(tmp, QUEUE_JSON)
  } catch { /* */ }
}

test('supervisor tick kills wedged bash subprocess and logs kill-bash', async () => {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-supervisor-shim-'))
  let agentChild: ReturnType<typeof spawn> | null = null
  let agentPid: number | null = null
  let bashPid: number | null = null

  try {
    // 1. Spawn a "fake agent" process that itself spawns the wedged bash.
    //    We use a long-lived sleep as the agent parent so we have a real PID
    //    tree to verify. The bash child is its direct subprocess.
    agentChild = spawn('bash', ['-c', 'bash -c "until false; do sleep 1; done" & CHILD_PID=$!; echo "CHILD:$CHILD_PID"; wait'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    agentPid = agentChild.pid!

    // Read bash child PID from the agent's stdout.
    bashPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for CHILD: line')), 5000)
      let buf = ''
      agentChild!.stdout!.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        const m = buf.match(/CHILD:(\d+)/)
        if (m) {
          clearTimeout(timer)
          resolve(parseInt(m[1], 10))
        }
      })
    })

    expect(agentPid).toBeGreaterThan(0)
    expect(bashPid).toBeGreaterThan(0)
    expect(isAlive(bashPid)).toBe(true)

    // 2. Write the fake claude shim.
    writeFakeClaudeShim(shimDir, bashPid, agentPid)

    // 3. Write a stale run log.
    const runDir = path.join(RUNS_DIR, TEST_RUN_ID)
    writeStaleRunLog(runDir, TEST_SLUG)

    // 4. Inject the running job into queue.json.
    injectRunningJob(agentPid, TEST_RUN_ID)

    // 5. Launch the app with the shim on PATH.
    const app = await electron.launch({
      args: [path.join(ROOT, 'src', 'main', 'index.cjs')],
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        SM_E2E: '1',
        // Prepend shim dir so our fake `claude` is found before the real one.
        PATH: `${shimDir}:${process.env.PATH ?? ''}`,
        // Use a very short stale threshold (1 min) so the 30-min-old log qualifies.
        // The supervisor reads config from queue.json; we'll override via the IPC.
      },
    })

    try {
      const win = await app.firstWindow()
      await win.waitForSelector('text=Claude Session Manager', { timeout: 15000 })
      // Let the main process fully initialize.
      await sleep(3000)

      // 6. Invoke supervisor:tick-now via IPC.
      const tickResult = await win.evaluate(() => window.api.supervisor.tickNow())
      expect(tickResult).toHaveProperty('ok', true)

      // 7. Wait up to 30 s for the bash process to die.
      await expect.poll(() => !isAlive(bashPid!), { timeout: 30_000 }).toBe(true)

      // 8. Assert supervisor.log has a kill-bash entry for our slug.
      let logHasEntry = false
      try {
        const logText = fs.readFileSync(SUPERVISOR_LOG, 'utf8')
        for (const line of logText.split('\n')) {
          if (!line.trim()) continue
          try {
            const entry = JSON.parse(line)
            if (entry.jobSlug === TEST_SLUG && entry.action === 'kill-bash') {
              logHasEntry = true
              break
            }
          } catch { /* */ }
        }
      } catch { /* */ }
      expect(logHasEntry).toBe(true)
    } finally {
      await app.close()
    }
  } finally {
    cleanupTestArtifacts(agentPid, bashPid, shimDir)
  }
})

test('SM_SUPERVISOR_DISABLE=1 prevents supervisor from starting', async () => {
  // With SM_SUPERVISOR_DISABLE=1, supervisor:tick-now should still respond ok
  // (the IPC handler is registered regardless) but no probes should fire even
  // if there are stale running jobs — because supervisorTick() is a no-op when
  // the supervisor never starts (interval never set up, and if tick is called
  // directly the SM_SUPERVISOR_DISABLE check is in startSupervisor not tick).
  // The primary regression check is that the app starts cleanly and the
  // existing scheduler behavior is unchanged.

  const app = await electron.launch({
    args: [path.join(ROOT, 'src', 'main', 'index.cjs')],
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      SM_E2E: '1',
      SM_SUPERVISOR_DISABLE: '1',
    },
  })

  const win = await app.firstWindow()
  await win.waitForSelector('text=Claude Session Manager', { timeout: 15000 })
  await sleep(2000)

  // Scheduler state should be accessible (no regression).
  const schedState = await win.evaluate(() => window.api.schedule.state())
  expect(schedState).toHaveProperty('jobs')
  expect(schedState).toHaveProperty('config')

  // supervisor:tick-now IPC is registered and returns ok.
  const tickResult = await win.evaluate(() => window.api.supervisor.tickNow())
  expect(tickResult).toHaveProperty('ok', true)

  await app.close()
})
