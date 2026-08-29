import { memo, useMemo, useState } from 'react'
import { Panel } from '../ui/Panel'
import { ViewTabs } from '../ui/ViewTabs'
import { EmptyState } from '../ui/EmptyState'
import { Badge } from '../ui/Badge'
import {
  ERD_ENTITIES,
  ERD_GROUPS,
  ERD_BOX_MAX_ROWS,
  layoutErd,
  erdEntity,
  erdGroup,
  relationsFor,
  neighborsOf,
  cardinalityGlyph,
  type ErdEntity,
  type ErdField,
  type ErdGroupId,
  type ErdBox,
  type ErdEdge,
} from '../../lib/dataModelErd'

type View = 'diagram' | 'tables'

const VIEW_OPTIONS: ReadonlyArray<{ key: View; label: string }> = [
  { key: 'diagram', label: 'Diagram' },
  { key: 'tables', label: 'Tables' },
]

/**
 * Data Model — read-only ERD over lib/dataModelErd.ts's hand-maintained
 * mirror of what Session Manager actually persists. Answers "where does the
 * app keep X, who is allowed to write it, and what is it joined to" — the
 * storage path and single-writer owner are first-class, not footnotes.
 * Follows TagLibrary.tsx's shape: memoized, no props, no IPC — every fact
 * shown comes from the imported entity/relation/layout data, never
 * hardcoded here.
 */
function DataModelComponent() {
  const [view, setView] = useState<View>('diagram')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hiddenGroups, setHiddenGroups] = useState<Set<ErdGroupId>>(() => new Set())

  const visibleEntities = useMemo(
    () => ERD_ENTITIES.filter((e) => !hiddenGroups.has(e.group)),
    [hiddenGroups],
  )
  const layout = useMemo(() => layoutErd(visibleEntities), [visibleEntities])

  const toggleGroup = (gid: ErdGroupId) => {
    setHiddenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(gid)) next.delete(gid)
      else next.add(gid)
      return next
    })
    setSelectedId(null)
  }

  const selectedEntity = selectedId ? erdEntity(selectedId) : null
  const isVisible = (id: string) => visibleEntities.some((e) => e.id === id)

  return (
    <Panel
      toolbar={
        <>
          <ViewTabs options={VIEW_OPTIONS} active={view} onChange={setView} />
          <Legend hiddenGroups={hiddenGroups} onToggle={toggleGroup} />
          <span className="ml-auto text-fg-faint">{ERD_ENTITIES.length} entities</span>
        </>
      }
    >
      {view === 'diagram' ? (
        <div className="h-full flex">
          <div className="flex-1 min-w-0 overflow-auto">
            <ErdDiagram
              layout={layout}
              selectedId={selectedId}
              onSelect={(id) => setSelectedId((prev) => (prev === id ? null : id))}
            />
          </div>
          <div className="w-96 shrink-0 border-l border-line overflow-y-auto">
            {selectedEntity ? (
              <EntityDetail
                entity={selectedEntity}
                onSelectRelated={(id) => (isVisible(id) ? setSelectedId(id) : undefined)}
              />
            ) : (
              <EmptyState title="select an entity" hint="click a box in the diagram to see its storage, fields, and relations" />
            )}
          </div>
        </div>
      ) : (
        <TablesView />
      )}
    </Panel>
  )
}

// Memoized: no props; the entity/relation data it reads is static module state.
export const DataModel = memo(DataModelComponent)

function Legend({
  hiddenGroups,
  onToggle,
}: {
  hiddenGroups: Set<ErdGroupId>
  onToggle: (gid: ErdGroupId) => void
}) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {ERD_GROUPS.map((g) => {
        const hidden = hiddenGroups.has(g.id)
        return (
          <button
            key={g.id}
            onClick={() => onToggle(g.id)}
            title={`${g.blurb} (${g.realm})`}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10.5px] ${
              hidden ? 'border-line text-fg-faint opacity-50' : 'border-line text-fg-dim hover:text-fg'
            }`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${g.tone.dot}`} />
            {g.label}
            <span className="text-fg-faint">{g.realm}</span>
          </button>
        )
      })}
    </div>
  )
}

function ErdDiagram({
  layout,
  selectedId,
  onSelect,
}: {
  layout: ReturnType<typeof layoutErd>
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const neighbors = useMemo(() => (selectedId ? new Set(neighborsOf(selectedId)) : null), [selectedId])

  const edgeTouchesSelected = (edge: ErdEdge) =>
    !!selectedId && (edge.relation.from === selectedId || edge.relation.to === selectedId)

  if (layout.boxes.length === 0) {
    return <EmptyState title="no entities in view" hint="toggle a group in the legend to show its entities" />
  }

  return (
    <div className="relative p-4" style={{ width: layout.width + 32, height: layout.height + 32 }}>
      <svg
        width={layout.width}
        height={layout.height}
        className="absolute left-4 top-4 overflow-visible"
      >
        {layout.edges.map((edge) => {
          const emphasised = edgeTouchesSelected(edge)
          return (
            <path
              key={`${edge.relation.from}-${edge.relation.to}-${edge.relation.label}`}
              data-testid={`erd-edge-${edge.relation.from}-${edge.relation.to}`}
              d={edge.d}
              fill="none"
              className={emphasised ? 'stroke-accent' : 'stroke-line'}
              strokeWidth={emphasised ? 2 : 1}
              opacity={selectedId && !emphasised ? 0.25 : 1}
            />
          )
        })}
        {layout.edges.map((edge) => {
          if (!edgeTouchesSelected(edge)) return null
          return (
            <text
              key={`label-${edge.relation.from}-${edge.relation.to}-${edge.relation.label}`}
              x={edge.mx}
              y={edge.my}
              textAnchor="middle"
              className="fill-fg-dim text-[10px]"
            >
              {edge.relation.label}
            </text>
          )
        })}
      </svg>
      {layout.boxes.map((box) => (
        <ErdBoxView
          key={box.id}
          box={box}
          selected={box.id === selectedId}
          dimmed={!!selectedId && box.id !== selectedId && !neighbors?.has(box.id)}
          onClick={() => onSelect(box.id)}
        />
      ))}
    </div>
  )
}

function ErdBoxView({
  box,
  selected,
  dimmed,
  onClick,
}: {
  box: ErdBox
  selected: boolean
  dimmed: boolean
  onClick: () => void
}) {
  const entity = erdEntity(box.id)
  const group = erdGroup(box.group)
  const shownFields = entity.fields.slice(0, ERD_BOX_MAX_ROWS)
  const moreCount = entity.fields.length - shownFields.length

  return (
    <button
      type="button"
      data-testid={`erd-box-${box.id}`}
      onClick={onClick}
      className={`absolute text-left rounded border overflow-hidden bg-bg-hi ${
        selected ? 'border-accent ring-1 ring-accent' : 'border-line'
      } ${dimmed ? 'opacity-30' : ''}`}
      style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
    >
      <div className="px-2 py-1 border-b border-line flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${group.tone.dot}`} />
        <span className="text-[11px] font-semibold text-fg truncate">{entity.name}</span>
      </div>
      {entity.aka && (
        <div className="px-2 pt-0.5 text-[9.5px] text-fg-faint truncate">{entity.aka}</div>
      )}
      <div className="px-2 py-0.5">
        {shownFields.map((f) => (
          <div key={f.name} className="text-[9.5px] font-mono text-fg-dim truncate flex items-center gap-1">
            {f.key && <span className="text-fg-faint">{f.key}</span>}
            <span className="truncate">{f.name}</span>
          </div>
        ))}
        {moreCount > 0 && <div className="text-[9.5px] text-fg-faint italic">+{moreCount} more</div>}
      </div>
    </button>
  )
}

function FieldTable({ fields }: { fields: ErdField[] }) {
  return (
    <table className="w-full text-[11px] font-mono">
      <thead className="text-fg-faint uppercase tracking-wide text-[9.5px]">
        <tr className="border-b border-line">
          <th className="text-left font-normal px-2 py-1">name</th>
          <th className="text-left font-normal px-2 py-1">type</th>
          <th className="text-left font-normal px-2 py-1">key</th>
          <th className="text-left font-normal px-2 py-1">note</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((f) => (
          <tr key={f.name} className="border-b border-line/50">
            <td className="px-2 py-1 text-fg">
              {f.name}
              {f.optional && <span className="text-fg-faint">?</span>}
            </td>
            <td className="px-2 py-1 text-fg-dim">{f.type}</td>
            <td className="px-2 py-1">
              {f.key && (
                <Badge tone={f.key === 'pk' ? 'accent' : 'dim'}>
                  {f.key}
                  {f.ref ? ` → ${f.ref}` : ''}
                </Badge>
              )}
            </td>
            <td className="px-2 py-1 text-fg-faint">{f.note}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function EntityStorage({ entity }: { entity: ErdEntity }) {
  return (
    <div className="space-y-1 text-[11px]">
      <div className="flex items-center gap-1.5">
        <span className="text-fg-faint w-20 shrink-0">path</span>
        <span className="font-mono text-fg-dim break-all">{entity.store.path}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-fg-faint w-20 shrink-0">format</span>
        <span className="font-mono text-fg-dim">{entity.store.format}</span>
      </div>
      {entity.store.writer && (
        <div className="flex items-center gap-1.5">
          <span className="text-fg-faint w-20 shrink-0">writer</span>
          <Badge tone="accent">single-writer: {entity.store.writer}</Badge>
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <span className="text-fg-faint w-20 shrink-0">definedIn</span>
        <span className="font-mono text-fg-dim break-all">{entity.store.definedIn}</span>
      </div>
    </div>
  )
}

function EntityDetail({
  entity,
  onSelectRelated,
}: {
  entity: ErdEntity
  onSelectRelated: (id: string) => void
}) {
  const group = erdGroup(entity.group)
  const relations = relationsFor(entity.id)

  return (
    <div className="p-3 space-y-3">
      <div>
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${group.tone.dot}`} />
          <span className="text-sm font-semibold text-fg">{entity.name}</span>
        </div>
        {entity.aka && <div className="text-[10.5px] text-fg-faint">{entity.aka}</div>}
        <Badge tone="dim" className="mt-1">{group.label}</Badge>
      </div>
      <div className="text-xs text-fg-dim leading-relaxed">{entity.summary}</div>
      <div>
        <SectionLabel>storage</SectionLabel>
        <EntityStorage entity={entity} />
      </div>
      <div>
        <SectionLabel>fields</SectionLabel>
        <FieldTable fields={entity.fields} />
      </div>
      {entity.notes && entity.notes.length > 0 && (
        <div>
          <SectionLabel>notes</SectionLabel>
          <ul className="list-disc pl-4 space-y-0.5 text-xs text-fg-dim">
            {entity.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <SectionLabel>relations</SectionLabel>
        {relations.length === 0 ? (
          <div className="text-xs text-fg-faint italic">no relations</div>
        ) : (
          <ul className="space-y-1">
            {relations.map((r) => {
              const otherId = r.from === entity.id ? r.to : r.from
              const other = erdEntity(otherId)
              return (
                <li key={`${r.from}-${r.to}-${r.label}`} className="flex items-center gap-1.5 text-xs">
                  <span className="font-mono text-fg-faint w-10 shrink-0">{cardinalityGlyph(r.cardinality)}</span>
                  <span className="text-fg-dim">{r.label}</span>
                  {r.via && <span className="font-mono text-[10px] text-fg-faint">via {r.via}</span>}
                  <button
                    type="button"
                    onClick={() => onSelectRelated(otherId)}
                    className="ml-auto text-accent hover:underline font-mono"
                  >
                    {other.name}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

function SectionLabel({ children }: { children: string }) {
  return <div className="text-[10.5px] uppercase tracking-wide text-fg-faint mb-1 font-mono">{children}</div>
}

function TablesView() {
  return (
    <div className="p-4 space-y-6">
      {ERD_GROUPS.map((group) => {
        const entities = ERD_ENTITIES.filter((e) => e.group === group.id)
        if (entities.length === 0) return null
        return (
          <div key={group.id}>
            <div className="flex items-center gap-1.5 mb-2">
              <span className={`w-2 h-2 rounded-full ${group.tone.dot}`} />
              <span className="text-xs font-semibold text-fg">{group.label}</span>
              <span className="text-[10.5px] text-fg-faint">{group.realm}</span>
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              {entities.map((entity) => (
                <div key={entity.id} className="border border-line rounded bg-bg-hi p-3 space-y-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-fg">{entity.name}</span>
                      {entity.aka && <span className="text-[10.5px] text-fg-faint">{entity.aka}</span>}
                    </div>
                    <Badge tone="dim" className="mt-1">{group.label}</Badge>
                  </div>
                  <div className="text-xs text-fg-dim leading-relaxed">{entity.summary}</div>
                  <EntityStorage entity={entity} />
                  <FieldTable fields={entity.fields} />
                  {entity.notes && entity.notes.length > 0 && (
                    <ul className="list-disc pl-4 space-y-0.5 text-xs text-fg-dim">
                      {entity.notes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
