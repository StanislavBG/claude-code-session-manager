/**
 * McpServerDetail — the detail pane for one configured MCP server, in the Claude config design
 * (design-mocks/claude-config renders 12-home-mcp / 08-project-mcp, DESIGN_SPEC.md §5.5).
 *
 * Header: an eyebrow `ORIGIN · TRANSPORT · SCOPE · <file> › mcpServers › <name>`, the mono name and
 * a status pill from the server's last mcpChecks result, and Check again / Edit JSON on the right —
 * after an "Approved" toggle for a project server (`approval`, the page's disabledMcpjsonServers).
 * There is no Enabled switch: Claude Code has no per-server enabled field. A check runs only on a
 * click (Check again, or the Tools card's Check <name>) — never on mount.
 *
 * Body: a COMMAND card (`<command> <args…>`, or URL for a remote server) with a copy-icon Copy; an
 * ENVIRONMENT · N card for a stdio server, or HEADERS · N for a remote one, every value masked until
 * its row's Show is pressed, with `+ Add variable` / `+ Add header`; a TOOLS · N card with the first
 * 8 tools as chips plus `+N more`, and `checked <ago>`. The footer closes the body: only
 * `Saved — matches <file>` (`cleanLabel`) while there is nothing to save, else `footer` (the page's
 * SaveBar with Save / Revert). Edit JSON swaps COMMAND / ENVIRONMENT / TOOLS for today's full
 * per-server form, passed in as `editor`, so no field is lost.
 *
 * A server an enabled plugin adds (`plugin` set) opens read-only (FROM PLUGINS): a `plugin`
 * transport and `via the <plugin> plugin · read-only` in the eyebrow, COMMAND and TOOLS only, and no
 * Edit JSON or + Add — it is checked like any other server but never edited here.
 *
 * Values never reach a toast or a log. The value of a new variable is read from an uncontrolled
 * input on Add, so it is never mirrored into a DOM attribute either.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { ConfigCard } from '../../claudeConfig/ConfigLayout'
import { AlmanacIcon } from '../../layout/AlmanacIcon'
import { Toggle } from '../../ui/Toggle'
import { mcpCheckKey, useMcpChecks } from '../../../state/mcpChecks'
import { toast } from '../../../state/toast'
import { copyText } from '../../../lib/clipboard'
import { formatAgo } from '../../../lib/formatTime'
import { PROVENANCE_LABEL, type Provenance } from '../../../lib/provenance'
import type { Scope } from '../../../lib/scopes'
import type { McpCheckRequest, McpCheckResult } from '../../../../preload/api'
import type { McpServer } from '../McpServers'

/** A server's check state as the page draws it: its last check result's status, or `unchecked`. */
export type McpCheckState = 'unchecked' | McpCheckResult['status']

export const MCP_CHECK_LABEL: Record<McpCheckState, string> = {
  unchecked: 'Not checked',
  connected: 'Connected',
  failed: 'Failed',
  'needs-auth': 'Needs auth',
}

/**
 * Status dot per state — shared by the list rows and the pill (spec §4): a hollow ring = not
 * checked, sage = connected, red = failed, honey = needs auth.
 */
export const MCP_DOT_CLASS: Record<McpCheckState, string> = {
  unchecked: 'border-[1.5px] border-fg-faint/60',
  connected: 'bg-sage',
  failed: 'bg-red-500',
  'needs-auth': 'bg-honey',
}

// The pill's tint per state: Connected on bg-sage/15 text-sage-dark (spec §6), the others in their
// dot's hue; Not checked stays quiet.
const PILL_CLASS: Record<McpCheckState, string> = {
  unchecked: 'bg-bg-elev text-fg-dim',
  connected: 'bg-sage/15 text-sage-dark',
  failed: 'bg-red-500/10 text-red-700',
  'needs-auth': 'bg-honey/15 text-honey-dark',
}

const SCOPE_LABEL: Record<Scope, string> = {
  user: 'User scope',
  project: 'Project scope',
  local: 'Local scope',
}

/** How many tool chips show before `+N more`. */
export const MCP_TOOL_CHIP_LIMIT = 8

/** How often "checked <ago>" is redrawn, so it doesn't stay at "just now". */
const AGO_REFRESH_MS = 30_000

const MASK = '••••••••'

// Words a POSIX shell reads back unchanged; anything else is single-quoted so the copied line
// runs with exactly the configured arguments.
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/

function shellQuote(word: string): string {
  return SHELL_SAFE.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`
}

/** Whether Claude Code reaches this server over the network (url + headers) rather than stdio. */
function isRemote(server: McpServer): boolean {
  return (server.type ?? 'stdio') !== 'stdio'
}

/** COMMAND's line: `<command> <args…>` shell-quoted for stdio, the URL for a remote server; '' if unset. */
export function mcpCommandLine(server: McpServer): string {
  if (isRemote(server)) return server.url ?? ''
  if (!server.command) return ''
  return [server.command, ...(server.args ?? [])].map(shellQuote).join(' ')
}

// Claude Code names a server's tool `mcp__<server>__<tool>`; a character outside [A-Za-z0-9_-]
// (not allowed in a tool name) becomes `_`.
const toolNamePart = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_')

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${toolNamePart(server)}__${toolNamePart(tool)}`
}

const BUTTON_CLASS =
  'h-[38px] inline-flex items-center whitespace-nowrap px-4 bg-bg-hi border border-line rounded-[10px] text-[13.5px] font-medium text-fg hover:border-rule disabled:opacity-50 disabled:hover:border-line'

const LINK_CLASS = 'text-[13px] font-semibold text-accent hover:text-accent-dark'

const EYEBROW_CLASS = 'text-[11px] font-semibold uppercase tracking-[0.1em] text-fg-faint'

/** A project server's approval, as the page reads it from <cwd>/.claude/settings.json. */
export interface McpApproval {
  /** Not listed in `disabledMcpjsonServers`. */
  approved: boolean
  busy: boolean
  onChange: (approved: boolean) => void
}

/** The footer while there is nothing to save: a sage dot and `Saved — matches <file>`, no buttons. */
export function McpSavedLine({ label }: { label: string }) {
  return (
    <div className="px-3 py-1.5 flex items-center text-xs">
      <span data-testid="savebar-clean" className="min-w-0 flex items-center gap-[7px] text-fg-faint">
        <span aria-hidden="true" className="shrink-0 w-1.5 h-1.5 rounded-full bg-sage" />
        <span className="truncate">{label}</span>
      </span>
    </div>
  )
}

export interface McpServerDetailProps {
  name: string
  server: McpServer
  scope: Scope
  /** The scope's file as the page names it: `~/.claude.json` (user) or `.mcp.json` (project). */
  fileLabel?: string
  /** The plugin that adds this server; set = read-only (no Edit JSON, no + Add, no editor). */
  plugin?: string
  /** This server's mcpChecks request; null when there is no project to check it in. */
  checkRequest: McpCheckRequest | null
  /** The origin the list row resolves too (override, else auto-classified), so the two agree. */
  origin: Provenance
  /** Writes the changed server into the page's draft (the SaveBar then reads dirty). Unused when read-only. */
  onChange?: (next: McpServer) => void
  /** true while Edit JSON is open: `editor` replaces COMMAND / ENVIRONMENT / TOOLS. Ignored when read-only. */
  editing?: boolean
  onEditingChange?: (editing: boolean) => void
  /** Today's full per-server form, shown while `editing`. */
  editor?: ReactNode
  /** Closes the body while there are unsaved edits — the page's SaveBar (Save / Revert). */
  footer?: ReactNode
  /** Set while there is nothing to save: the footer is only this line (`Saved — matches <file>`). */
  cleanLabel?: string
  /** A project server's Approved toggle; absent = no approval step (user scope, plugins). */
  approval?: McpApproval
}

export function McpServerDetail({
  name,
  server,
  scope,
  fileLabel,
  plugin,
  checkRequest,
  origin,
  onChange,
  editing: editingProp = false,
  onEditingChange,
  editor,
  footer,
  cleanLabel,
  approval,
}: McpServerDetailProps) {
  const readOnly = plugin !== undefined
  const editing = !readOnly && editingProp
  const key = checkRequest ? mcpCheckKey(checkRequest) : null
  // Stored references / primitives only (CLAUDE.md Avoid list).
  const result = useMcpChecks((s) => (key === null ? undefined : s.results[key]))
  const checking = useMcpChecks((s) => (key === null ? false : s.checking[key] === true))
  const check = useMcpChecks((s) => s.check)
  useRedrawEvery(AGO_REFRESH_MS, result !== undefined)

  const state: McpCheckState = result?.status ?? 'unchecked'
  const remote = isRemote(server)
  const runCheck = () => {
    if (checkRequest) void check(checkRequest)
  }

  return (
    <div data-testid="mcp-detail" className="flex flex-col min-w-0">
      <div className="shrink-0 px-9 pt-6 pb-5 border-b border-line flex items-end gap-3 whitespace-nowrap">
        <div className="flex-1 min-w-0">
          <div data-testid="mcp-detail-meta" className={`truncate ${EYEBROW_CLASS}`}>
            <span data-testid="mcp-detail-origin">{PROVENANCE_LABEL[origin]}</span>
            {' · '}
            <span data-testid="mcp-detail-transport">{readOnly ? 'plugin' : (server.type ?? 'stdio')}</span>
            {' · '}
            {readOnly ? (
              <>
                <span data-testid="mcp-detail-plugin">via the {plugin} plugin</span>
                {' · '}
                <span data-testid="mcp-detail-readonly">read-only</span>
              </>
            ) : (
              <>
                <span data-testid="mcp-detail-scope">{SCOPE_LABEL[scope]}</span>
                {' · '}
                <span data-testid="mcp-detail-keypath">
                  {fileLabel} › mcpServers › {name}
                </span>
              </>
            )}
          </div>
          <div className="mt-1.5 flex items-center gap-2.5 min-w-0">
            <h2
              data-testid="mcp-detail-name"
              className="min-w-0 truncate font-mono text-[27px] font-semibold tracking-[-0.015em] text-fg"
            >
              {name}
            </h2>
            <span
              data-testid="mcp-detail-status"
              data-status={state}
              title={result && !result.ok ? result.error : undefined}
              className={`shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold ${PILL_CLASS[state]}`}
            >
              <span
                aria-hidden="true"
                className={`w-1.5 h-1.5 shrink-0 box-border rounded-full ${MCP_DOT_CLASS[state]}${checking ? ' animate-pulse' : ''}`}
              />
              {MCP_CHECK_LABEL[state]}
            </span>
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {scope === 'user' && !readOnly ? (
            <span data-testid="mcp-detail-scope-note" className="mr-2 inline-flex items-center gap-2 text-[13px] text-fg-dim">
              <span aria-hidden="true" className="w-[7px] h-[7px] rounded-full bg-sage" />
              On in every project
            </span>
          ) : null}
          {approval && !readOnly ? (
            <span
              data-testid="mcp-detail-approved"
              title="disabledMcpjsonServers in .claude/settings.json"
              className="mr-2 inline-flex text-[13px]"
            >
              <Toggle checked={approval.approved} disabled={approval.busy} onChange={approval.onChange} label="Approved" />
            </span>
          ) : null}
          <button
            type="button"
            data-testid="mcp-check-again"
            onClick={runCheck}
            disabled={checkRequest === null || checking}
            className={BUTTON_CLASS}
          >
            {checking ? 'Checking…' : 'Check again'}
          </button>
          {readOnly ? null : editing ? (
            <button type="button" data-testid="mcp-edit-done" onClick={() => onEditingChange?.(false)} className={BUTTON_CLASS}>
              Done
            </button>
          ) : (
            <button type="button" data-testid="mcp-edit-json" onClick={() => onEditingChange?.(true)} className={BUTTON_CLASS}>
              Edit JSON
            </button>
          )}
        </div>
      </div>

      <div className="px-9 py-7 flex flex-col gap-5 max-w-[1100px]">
        {editing ? (
          editor
        ) : (
          <>
            <CommandCard server={server} readOnly={readOnly} />
            {readOnly ? null : remote ? (
              <ValuesCard
                testId="mcp-headers"
                label="Headers"
                noun="header"
                separator=":"
                emptyText="No headers set."
                values={server.headers ?? {}}
                onAdd={(k, v) => onChange?.({ ...server, headers: { ...(server.headers ?? {}), [k]: v } })}
              />
            ) : (
              <ValuesCard
                testId="mcp-env"
                label="Environment"
                noun="variable"
                separator="="
                emptyText="No variables set."
                values={server.env ?? {}}
                onAdd={(k, v) => onChange?.({ ...server, env: { ...(server.env ?? {}), [k]: v } })}
              />
            )}
            <ToolsCard
              serverName={name}
              result={result}
              checking={checking}
              canCheck={checkRequest !== null}
              onCheck={runCheck}
            />
          </>
        )}
        {cleanLabel !== undefined ? (
          <div className="-mx-3">
            <McpSavedLine label={cleanLabel} />
          </div>
        ) : footer !== undefined ? (
          <div className="-mx-3">{footer}</div>
        ) : null}
      </div>
    </div>
  )
}

/** Re-renders every `ms` while `active` — for labels computed from the clock. */
function useRedrawEvery(ms: number, active: boolean): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => setTick((t) => t + 1), ms)
    return () => window.clearInterval(id)
  }, [ms, active])
}

function CommandCard({ server, readOnly }: { server: McpServer; readOnly: boolean }) {
  const remote = isRemote(server)
  const line = mcpCommandLine(server)
  const copy = async () => {
    // The toast names what was copied, never the copied text.
    if (await copyText(line)) toast.success(remote ? 'URL copied' : 'Command copied')
    else toast.error(remote ? 'Copy failed — the URL was not copied' : 'Copy failed — the command was not copied')
  }
  return (
    <ConfigCard
      label={remote ? 'URL' : 'Command'}
      action={
        <button
          type="button"
          data-testid="mcp-command-copy"
          onClick={() => void copy()}
          disabled={!line}
          className="shrink-0 inline-flex items-center gap-[7px] text-[13px] text-fg-dim hover:text-fg disabled:opacity-50 disabled:hover:text-fg-dim"
        >
          <span aria-hidden="true" data-testid="mcp-command-copy-icon" className="inline-flex shrink-0">
            <AlmanacIcon name="copy" size={15} />
          </span>
          Copy
        </button>
      }
    >
      <div data-testid="mcp-command-box" className="font-mono text-[16px] text-fg">
        {line ? (
          <span data-testid="mcp-command" className="break-words">
            {line}
          </span>
        ) : (
          <span data-testid="mcp-command-empty" className="font-sans text-[14px] text-fg-faint">
            {readOnly
              ? remote ? 'No URL set.' : 'No command set.'
              : remote ? 'No URL set — Edit JSON to add one.' : 'No command set — Edit JSON to add one.'}
          </span>
        )}
      </div>
    </ConfigCard>
  )
}

/**
 * KEY = value rows with every value masked until its row's Show is pressed, or "No … set.";
 * `+ Add <noun>` opens a KEY / value row whose Add writes the pair into the draft.
 */
function ValuesCard({
  testId,
  label,
  noun,
  separator,
  emptyText,
  values,
  onAdd,
}: {
  testId: 'mcp-env' | 'mcp-headers'
  label: string
  noun: 'variable' | 'header'
  separator: '=' | ':'
  emptyText: string
  values: Record<string, string>
  onAdd: (key: string, value: string) => void
}) {
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set())
  const [adding, setAdding] = useState(false)
  const [newKey, setNewKey] = useState('')
  const valueRef = useRef<HTMLInputElement>(null)

  const keys = Object.keys(values)
  const trimmedKey = newKey.trim()
  // A key with whitespace or the separator can't round-trip as a variable / header name.
  const canAdd = trimmedKey !== '' && !/\s/.test(trimmedKey) && !trimmedKey.includes(separator)

  const toggle = (k: string) =>
    setRevealed((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  const close = () => {
    setAdding(false)
    setNewKey('')
  }
  const submit = () => {
    if (!canAdd) return
    onAdd(trimmedKey, valueRef.current?.value ?? '')
    close()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }

  return (
    <div data-testid={testId}>
      <ConfigCard label={label} labelNote={String(keys.length)}>
        <div className="flex flex-col gap-1.5">
          {keys.length === 0 && !adding ? (
            <div data-testid={`${testId}-empty`} className="text-[14px] text-fg-dim">
              {emptyText}
            </div>
          ) : null}
          {keys.map((k) => {
            const shown = revealed.has(k)
            return (
              <div key={k} data-testid={`${testId}-row-${k}`} className="flex items-center gap-2.5 font-mono text-[13.5px]">
                <span className="shrink-0 font-semibold text-fg">{k}</span>
                <span aria-hidden="true" className="shrink-0 text-fg-faint/60">
                  {separator}
                </span>
                <span
                  data-testid={`${testId}-value-${k}`}
                  title={shown ? undefined : 'Hidden — Show reveals it'}
                  className={`min-w-0 break-words ${shown ? 'text-fg-dim' : 'text-fg-faint tracking-wider'}`}
                >
                  {shown ? values[k] : MASK}
                </span>
                <button
                  type="button"
                  data-testid={`${testId}-reveal-${k}`}
                  aria-pressed={shown}
                  aria-label={`${shown ? 'Hide' : 'Show'} the value of ${k}`}
                  onClick={() => toggle(k)}
                  className="ml-auto shrink-0 font-sans text-[13px] text-fg-dim hover:text-fg"
                >
                  {shown ? 'Hide' : 'Show'}
                </button>
              </div>
            )
          })}
          {adding ? (
            <div data-testid={`${testId}-add-form`} className="flex items-center gap-2 py-1">
              <input
                data-testid={`${testId}-new-key`}
                aria-label={`New ${noun} name`}
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={noun === 'variable' ? 'KEY' : 'Header-Name'}
                spellCheck={false}
                autoFocus
                className="w-44 h-8 px-2 bg-bg border border-line rounded-md font-mono text-xs text-fg"
              />
              <span aria-hidden="true" className="font-mono text-xs text-fg-faint">
                {separator}
              </span>
              <input
                ref={valueRef}
                type="password"
                autoComplete="off"
                data-testid={`${testId}-new-value`}
                aria-label={`New ${noun} value`}
                onKeyDown={onKeyDown}
                placeholder="value"
                spellCheck={false}
                className="flex-1 min-w-0 h-8 px-2 bg-bg border border-line rounded-md font-mono text-xs text-fg"
              />
              <button
                type="button"
                data-testid={`${testId}-add-confirm`}
                onClick={submit}
                disabled={!canAdd}
                className="shrink-0 h-8 px-3 rounded-md bg-accent text-bg-hi text-xs font-semibold hover:bg-accent/90 disabled:opacity-50 disabled:hover:bg-accent"
              >
                Add
              </button>
              <button
                type="button"
                data-testid={`${testId}-add-cancel`}
                onClick={close}
                className="shrink-0 h-8 px-2 text-xs text-fg-faint hover:text-fg"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="pt-1">
              <button type="button" data-testid={`${testId}-add`} onClick={() => setAdding(true)} className={LINK_CLASS}>
                + Add {noun}
              </button>
            </div>
          )}
        </div>
      </ConfigCard>
    </div>
  )
}

/**
 * TOOLS · N from the last check: the first MCP_TOOL_CHIP_LIMIT tools as mono chips, then `+N more`
 * (which lists the rest), and the `mcp__<server>__…` prefix Claude calls them by. Unchecked: a dashed
 * "Tools appear after a check" card whose button runs the check — on click only.
 */
export function ToolsCard({
  serverName,
  result,
  checking,
  canCheck,
  onCheck,
}: {
  serverName: string
  result: McpCheckResult | undefined
  checking: boolean
  canCheck: boolean
  onCheck: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const now = Date.now()
  const prefix = `mcp__${toolNamePart(serverName)}__…`

  if (!result && !checking) {
    return (
      <div
        data-testid="mcp-tools"
        className="flex items-center gap-4 px-[18px] py-4 rounded-[14px] border border-dashed border-rule"
      >
        <div data-testid="mcp-tools-empty" className="flex-1 min-w-0">
          <div className="text-[15px] font-semibold text-fg">Tools appear after a check</div>
          <div className="text-[13.5px] text-fg-dim">
            A check connects to {serverName} once and lists every tool it offers, named{' '}
            <span className="font-mono text-[12.5px]">{prefix}</span>
          </div>
        </div>
        <button
          type="button"
          data-testid="mcp-tools-check"
          onClick={onCheck}
          disabled={!canCheck}
          className="shrink-0 h-[38px] px-4 rounded-[10px] bg-accent text-bg-hi hover:bg-accent/90 text-[13.5px] font-semibold disabled:opacity-50"
        >
          Check {serverName}
        </button>
      </div>
    )
  }

  const tools = result?.ok ? result.tools : []
  const shown = expanded ? tools : tools.slice(0, MCP_TOOL_CHIP_LIMIT)
  const hidden = tools.length - shown.length
  const checkedLabel = checking ? (
    <span data-testid="mcp-detail-checked" className="shrink-0 text-[13px] text-fg-dim">
      checking…
    </span>
  ) : result ? (
    <span
      data-testid="mcp-detail-checked"
      title={new Date(result.checkedAt).toLocaleString()}
      className="shrink-0 text-[13px] text-fg-dim"
    >
      checked {formatAgo(Math.min(result.checkedAt, now), now)}
    </span>
  ) : null

  return (
    <div data-testid="mcp-tools">
      <ConfigCard label="Tools" labelNote={result?.ok ? String(tools.length) : undefined} action={checkedLabel}>
        {!result ? (
          <div className="text-[14px] text-fg-dim">Checking {serverName}…</div>
        ) : !result.ok ? (
          <div data-testid="mcp-tools-empty" className="text-[14px] text-fg-dim">
            {result.status === 'needs-auth' ? 'The last check needs auth' : 'The last check failed'}: {result.error}
          </div>
        ) : tools.length === 0 ? (
          <div data-testid="mcp-tools-empty" className="text-[14px] text-fg-dim">
            The last check listed no tools.
          </div>
        ) : (
          <div className="flex flex-col gap-3 pt-1.5">
            <div data-testid="mcp-tools-chips" className="flex flex-wrap items-center gap-2">
              {shown.map((t, i) => (
                <span
                  key={`${i}:${t.name}`}
                  data-testid={`mcp-tool-row-${t.name}`}
                  title={t.description ? `${mcpToolName(serverName, t.name)} — ${t.description}` : mcpToolName(serverName, t.name)}
                  className="px-2.5 py-1 rounded-md bg-bg-elev border border-line font-mono text-[13px] text-fg"
                >
                  {t.name}
                </span>
              ))}
              {hidden > 0 ? (
                <button type="button" data-testid="mcp-tools-more" onClick={() => setExpanded(true)} className={LINK_CLASS}>
                  +{hidden} more
                </button>
              ) : null}
            </div>
            <div className="text-[13px] text-fg-dim">
              Claude calls them as <span className="font-mono text-[12.5px]">{prefix}</span>
            </div>
          </div>
        )}
      </ConfigCard>
    </div>
  )
}
