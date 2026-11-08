/**
 * McpServerDetail — the Extensions 3a detail pane for one configured MCP server
 * (design-mocks/extensions-3a/DESIGN_SPEC.md §4; prototype lines 236-271).
 *
 * Header: the name, a status pill + "checked <ago>" from the server's last mcpChecks result,
 * the provenance and transport badges, the scope and the key path the server is stored under,
 * and Check again / Edit JSON on the right. The provenance badge here is display-only; the
 * origin override menu is in the Edit JSON form. There is no Enabled switch: Claude Code has no
 * per-server enabled field (spec §7.1).
 *
 * Body: COMMAND (`$ <command> <args…>`, or a remote server's URL) with Copy; ENVIRONMENT for a
 * stdio server, or HEADERS for a remote one (the field each transport reads, as in today's form),
 * with every value masked until its row is revealed; TOOLS from the last check. Edit JSON swaps
 * the body for today's full per-server form, passed in as `editor`, so no field is lost (§7.2).
 *
 * A server an enabled plugin adds (`plugin` set) opens read-only (spec §4 FROM PLUGINS): a `plugin`
 * transport badge and `via the <plugin> plugin` in place of the scope + key path, COMMAND and TOOLS
 * only, and no Edit JSON or + Add — it is checked like any other server but never edited here.
 *
 * Values never reach a toast or a log. The value of a new variable is read from an uncontrolled
 * input on Add, so it is never mirrored into a DOM attribute either.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Badge } from '../../ui/Badge'
import { ProvenanceBadge } from '../../ui/ProvenanceBadge'
import { mcpCheckKey, useMcpChecks } from '../../../state/mcpChecks'
import { toast } from '../../../state/toast'
import { copyText } from '../../../lib/clipboard'
import { formatAgo } from '../../../lib/formatTime'
import type { ProvenanceInput } from '../../../lib/provenance'
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
  'h-7 inline-flex items-center whitespace-nowrap px-[11px] bg-bg-hi border border-line rounded-md text-[12.5px] text-fg hover:border-rule disabled:opacity-50 disabled:hover:border-line'

const SECTION_LABEL_CLASS = 'text-[11px] font-semibold tracking-[.06em] uppercase text-fg-faint'

const NOTE_CLASS = 'px-3 py-2.5 border border-dashed border-rule rounded-md text-[12.5px] text-fg-faint'

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
  /** The provenance input the list row resolves too, so the badge and the row agree. */
  provenance: ProvenanceInput
  /** Writes the changed server into the page's draft (the SaveBar then reads dirty). Unused when read-only. */
  onChange?: (next: McpServer) => void
  /** true while Edit JSON is open: `editor` replaces COMMAND / ENVIRONMENT / TOOLS. Ignored when read-only. */
  editing?: boolean
  onEditingChange?: (editing: boolean) => void
  /** Today's full per-server form, shown while `editing`. */
  editor?: ReactNode
}

export function McpServerDetail({
  name,
  server,
  scope,
  fileLabel,
  plugin,
  checkRequest,
  provenance,
  onChange,
  editing: editingProp = false,
  onEditingChange,
  editor,
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
  const now = Date.now()
  const remote = isRemote(server)

  return (
    <div data-testid="mcp-detail" className="flex flex-col gap-[18px] px-6 py-[18px]">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex flex-col gap-2">
          <div className="min-w-0 flex items-center gap-3">
            <h2 data-testid="mcp-detail-name" className="min-w-0 truncate text-[22px] leading-tight font-semibold tracking-[-.01em] text-fg">
              {name}
            </h2>
            <span
              data-testid="mcp-detail-status"
              data-status={state}
              title={result && !result.ok ? result.error : undefined}
              className={`shrink-0 inline-flex items-center gap-1.5 h-[22px] px-[9px] rounded-full text-xs font-semibold ${PILL_CLASS[state]}`}
            >
              <span
                aria-hidden="true"
                className={`w-1.5 h-1.5 shrink-0 box-border rounded-full ${MCP_DOT_CLASS[state]}${checking ? ' animate-pulse' : ''}`}
              />
              {MCP_CHECK_LABEL[state]}
            </span>
            {checking ? (
              <span data-testid="mcp-detail-checked" className="shrink-0 text-xs text-fg-faint">
                checking…
              </span>
            ) : result ? (
              <span
                data-testid="mcp-detail-checked"
                title={new Date(result.checkedAt).toLocaleString()}
                className="shrink-0 text-xs text-fg-faint"
              >
                checked {formatAgo(Math.min(result.checkedAt, now), now)}
              </span>
            ) : null}
          </div>
          <div data-testid="mcp-detail-meta" className="flex flex-wrap items-center gap-2 text-xs text-fg-faint">
            {/* Display-only here: its override menu opens right-aligned and the badge sits at the
                pane's left edge, so the menu would be clipped. Edit JSON's form carries the override. */}
            <ProvenanceBadge scope={scope} input={provenance} interactive={false} />
            <span data-testid="mcp-detail-transport" className="inline-flex">
              <Badge tone="dim">{readOnly ? 'plugin' : (server.type ?? 'stdio')}</Badge>
            </span>
            {readOnly ? (
              <>
                <span data-testid="mcp-detail-plugin">via the {plugin} plugin</span>
                <span aria-hidden="true" className="text-fg-faint/60">·</span>
                <span data-testid="mcp-detail-readonly">read-only</span>
              </>
            ) : (
              <>
                <span data-testid="mcp-detail-scope">{SCOPE_LABEL[scope]}</span>
                <span aria-hidden="true" className="text-fg-faint/60">·</span>
                <span data-testid="mcp-detail-keypath" className="min-w-0 font-mono text-[11.5px] text-fg-dim break-words">
                  {fileLabel} › mcpServers › {name}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="ml-auto shrink-0 flex items-center gap-2">
          <button
            type="button"
            data-testid="mcp-check-again"
            onClick={() => {
              if (checkRequest) void check(checkRequest)
            }}
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

      {editing ? (
        editor
      ) : (
        <>
          <CommandSection server={server} readOnly={readOnly} />
          {readOnly ? null : remote ? (
            <ValuesSection
              testId="mcp-headers"
              label="Headers"
              noun="header"
              separator=":"
              emptyText="No headers set"
              values={server.headers ?? {}}
              onAdd={(k, v) => onChange?.({ ...server, headers: { ...(server.headers ?? {}), [k]: v } })}
            />
          ) : (
            <ValuesSection
              testId="mcp-env"
              label="Environment"
              noun="variable"
              separator="="
              emptyText="No variables set"
              values={server.env ?? {}}
              onAdd={(k, v) => onChange?.({ ...server, env: { ...(server.env ?? {}), [k]: v } })}
            />
          )}
          <ToolsSection serverName={name} result={result} />
        </>
      )}
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

function CommandSection({ server, readOnly }: { server: McpServer; readOnly: boolean }) {
  const remote = isRemote(server)
  const line = mcpCommandLine(server)
  const copy = async () => {
    // The toast names what was copied, never the copied text.
    if (await copyText(line)) toast.success(remote ? 'URL copied' : 'Command copied')
    else toast.error(remote ? 'Copy failed — the URL was not copied' : 'Copy failed — the command was not copied')
  }
  return (
    <section className="flex flex-col gap-[7px]">
      <h3 className={SECTION_LABEL_CLASS}>Command</h3>
      <div
        data-testid="mcp-command-box"
        className="flex items-center gap-2.5 px-3 py-2.5 bg-bg-hi border border-line rounded-md font-mono text-[13px] text-fg"
      >
        {remote ? null : (
          <span aria-hidden="true" className="shrink-0 text-fg-faint/60">
            $
          </span>
        )}
        {line ? (
          <span data-testid="mcp-command" className="min-w-0 break-words">
            {line}
          </span>
        ) : (
          <span data-testid="mcp-command-empty" className="min-w-0 font-sans text-[12.5px] text-fg-faint">
            {readOnly
              ? remote ? 'No URL set.' : 'No command set.'
              : remote ? 'No URL set — Edit JSON to add one.' : 'No command set — Edit JSON to add one.'}
          </span>
        )}
        <button
          type="button"
          data-testid="mcp-command-copy"
          onClick={() => void copy()}
          disabled={!line}
          className="ml-auto shrink-0 font-sans text-xs text-fg-faint hover:text-fg disabled:opacity-50 disabled:hover:text-fg-faint"
        >
          Copy
        </button>
      </div>
    </section>
  )
}

/**
 * KEY = value rows with every value masked until its row's Show is pressed, or the dashed
 * empty box; `+ Add <noun>` opens a KEY / value row whose Add writes the pair into the draft.
 */
function ValuesSection({
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

  const addButton = (
    <button
      type="button"
      data-testid={`${testId}-add`}
      onClick={() => setAdding(true)}
      className="shrink-0 text-[12.5px] font-semibold text-accent hover:text-accent-dark"
    >
      + Add {noun}
    </button>
  )

  return (
    <section data-testid={testId} className="flex flex-col gap-[7px]">
      <h3 className={SECTION_LABEL_CLASS}>{label}</h3>
      {keys.length === 0 && !adding ? (
        <div
          data-testid={`${testId}-empty`}
          className="flex items-center gap-2.5 px-3 py-2.5 border border-dashed border-rule rounded-md text-[12.5px] text-fg-faint"
        >
          {emptyText}
          <span className="ml-auto">{addButton}</span>
        </div>
      ) : null}
      {keys.length > 0 ? (
        <div className="bg-bg-hi border border-line rounded-md divide-y divide-line">
          {keys.map((k) => {
            const shown = revealed.has(k)
            return (
              <div key={k} data-testid={`${testId}-row-${k}`} className="flex items-center gap-2.5 px-3 py-2 font-mono text-[12.5px]">
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
                  className="ml-auto shrink-0 font-sans text-xs text-fg-faint hover:text-fg"
                >
                  {shown ? 'Hide' : 'Show'}
                </button>
              </div>
            )
          })}
        </div>
      ) : null}
      {adding ? (
        <div data-testid={`${testId}-add-form`} className="flex items-center gap-2 px-3 py-2 bg-bg-hi border border-line rounded-md">
          <input
            data-testid={`${testId}-new-key`}
            aria-label={`New ${noun} name`}
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={noun === 'variable' ? 'KEY' : 'Header-Name'}
            spellCheck={false}
            autoFocus
            className="w-44 h-7 px-2 bg-bg border border-line rounded font-mono text-xs text-fg"
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
            className="flex-1 min-w-0 h-7 px-2 bg-bg border border-line rounded font-mono text-xs text-fg"
          />
          <button
            type="button"
            data-testid={`${testId}-add-confirm`}
            onClick={submit}
            disabled={!canAdd}
            className="shrink-0 h-7 px-2.5 rounded-md bg-accent text-bg-hi text-xs font-semibold hover:bg-accent/90 disabled:opacity-50 disabled:hover:bg-accent"
          >
            Add
          </button>
          <button
            type="button"
            data-testid={`${testId}-add-cancel`}
            onClick={close}
            className="shrink-0 h-7 px-2 text-xs text-fg-faint hover:text-fg"
          >
            Cancel
          </button>
        </div>
      ) : keys.length > 0 ? (
        <div>{addButton}</div>
      ) : null}
    </section>
  )
}

function ToolsSection({ serverName, result }: { serverName: string; result: McpCheckResult | undefined }) {
  return (
    <section data-testid="mcp-tools" className="flex flex-col gap-[7px]">
      <h3 className={`flex items-baseline gap-2 ${SECTION_LABEL_CLASS}`}>
        Tools
        {result?.ok ? (
          <>
            <span data-testid="mcp-tools-count" className="font-mono font-medium tracking-normal text-fg-faint/60">
              {result.tools.length}
            </span>
            <span className="font-normal tracking-normal normal-case text-fg-faint/80">from the last check</span>
          </>
        ) : null}
      </h3>
      {!result ? (
        <div data-testid="mcp-tools-empty" className={NOTE_CLASS}>
          Check this server to list its tools.
        </div>
      ) : !result.ok ? (
        <div data-testid="mcp-tools-empty" className={NOTE_CLASS}>
          {result.status === 'needs-auth' ? 'The last check needs auth' : 'The last check failed'}: {result.error}
        </div>
      ) : result.tools.length === 0 ? (
        <div data-testid="mcp-tools-empty" className={NOTE_CLASS}>
          The last check listed no tools.
        </div>
      ) : (
        <div className="bg-bg-hi border border-line rounded-md divide-y divide-line">
          {result.tools.map((t, i) => (
            <div
              key={`${i}:${t.name}`}
              data-testid={`mcp-tool-row-${t.name}`}
              className="grid grid-cols-[120px_minmax(0,1fr)_auto] items-baseline gap-4 px-3 py-2.5"
            >
              <span title={t.name} className="truncate font-mono text-[12.5px] font-semibold text-fg">
                {t.name}
              </span>
              <span title={t.description || undefined} className="line-clamp-2 text-[12.5px] text-fg-dim">
                {t.description ?? ''}
              </span>
              <span className="font-mono text-[11px] text-fg-faint/80">{mcpToolName(serverName, t.name)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
