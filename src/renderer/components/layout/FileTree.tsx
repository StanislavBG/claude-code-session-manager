/**
 * FileTree — VS Code-style file explorer scoped to the active tab's cwd.
 *
 * Features:
 *   - Lazy expand: children are fetched on first toggle, then cached on the node.
 *   - Hidden-file toggle (re-fetches the root + collapses all expansions).
 *   - Fuzzy substring search filter against node names.
 *   - Per-row right-click context menu: rename / delete / new file / new folder
 *     / open externally / reveal in OS / copy path / send to chat.
 *   - Best-effort git status badges if `window.api.git?.fileStatus` exists; the
 *     call is wrapped so a missing IPC degrades silently.
 *
 * The component does not own the cwd selector — MainPane passes the active
 * terminal tab's cwd in. When the cwd changes, all transient state (expansion,
 * search, inline rename) is reset.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileEntry } from '../../../preload/api'

interface FileTreeProps {
  cwd: string
  /** When the user picks a previewable file. */
  onPreviewFile?: (path: string) => void
  /** Pipe an @-mention to the active terminal. */
  onSendToChat?: (path: string) => void
  /** Active tab id — used to send "@path " via pty.write. */
  activeTabId?: string | null
}

interface TreeNode extends FileEntry {
  children?: TreeNode[]
  loading?: boolean
}

type GitStatusType = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'staged' | 'conflict'
type GitStatusMap = Record<string, GitStatusType>

const GIT_BADGES: Record<GitStatusType, { color: string; label: string }> = {
  modified: { color: '#e2a93d', label: 'M' },
  added: { color: '#3fb950', label: 'A' },
  deleted: { color: '#f85149', label: 'D' },
  renamed: { color: '#a371f7', label: 'R' },
  untracked: { color: '#8b949e', label: 'U' },
  staged: { color: '#3fb950', label: 'S' },
  conflict: { color: '#f85149', label: '!' },
}

const PREVIEWABLE_EXTS = new Set([
  'md', 'txt', 'json', 'js', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs', 'rb',
  'c', 'cpp', 'h', 'hpp', 'java', 'sh', 'bash', 'css', 'scss', 'html', 'xml',
  'yaml', 'yml', 'toml', 'ini', 'conf', 'env', 'log', 'sql', 'gitignore',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp',
])

function isPreviewable(name: string): boolean {
  const ext = name.toLowerCase().split('.').pop() || ''
  return PREVIEWABLE_EXTS.has(ext)
}

function getExtColor(name: string, isDir: boolean): string {
  if (isDir) return '#d97757'
  const ext = name.toLowerCase().split('.').pop() || ''
  switch (ext) {
    case 'ts': case 'tsx': return '#3178c6'
    case 'js': case 'jsx': return '#f7df1e'
    case 'json': return '#cbcb41'
    case 'md': return '#8a93a0'
    case 'css': case 'scss': return '#cc6699'
    case 'py': return '#3776ab'
    case 'go': return '#00add8'
    case 'rs': return '#dea584'
    case 'sh': case 'bash': return '#89e051'
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'svg': return '#a4c639'
    default: return '#8a93a0'
  }
}

async function tryLoadGitStatus(cwd: string): Promise<GitStatusMap> {
  // Wave 1d ships window.api.git.fileStatus. Until then, gracefully no-op.
  try {
    const api = (window as unknown as { api?: { git?: { fileStatus?: (cwd: string) => Promise<GitStatusMap> } } }).api
    if (!api?.git?.fileStatus) return {}
    return await api.git.fileStatus(cwd)
  } catch {
    return {}
  }
}

interface ContextMenuState {
  x: number
  y: number
  node: TreeNode
}

export function FileTree({ cwd, onPreviewFile, onSendToChat, activeTabId }: FileTreeProps) {
  const [root, setRoot] = useState<TreeNode[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [gitStatus, setGitStatus] = useState<GitStatusMap>({})
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [createPrompt, setCreatePrompt] = useState<{ parent: string; kind: 'file' | 'folder' } | null>(null)
  const [createName, setCreateName] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState<TreeNode | null>(null)

  const renameInputRef = useRef<HTMLInputElement>(null)
  const createInputRef = useRef<HTMLInputElement>(null)

  const loadRoot = useCallback(async () => {
    if (!cwd) return
    setLoading(true)
    setError(null)
    const result = await window.api.files.list(cwd, showHidden)
    if (!result.ok) {
      setError(result.error ?? 'failed to list')
      setRoot([])
    } else {
      setRoot(result.entries.map((e) => ({ ...e })))
    }
    setLoading(false)
  }, [cwd, showHidden])

  // Reset transient state + load when cwd changes.
  useEffect(() => {
    setExpanded(new Set())
    setSearch('')
    setRenaming(null)
    setMenu(null)
    setCreatePrompt(null)
    setDeleteConfirm(null)
    setGitStatus({})
    loadRoot()
    tryLoadGitStatus(cwd).then(setGitStatus)
  }, [cwd, loadRoot])

  // Re-load when hidden toggle changes.
  useEffect(() => {
    loadRoot()
  }, [showHidden, loadRoot])

  // Refresh git status every 5s while mounted.
  useEffect(() => {
    if (!cwd) return
    const id = window.setInterval(() => {
      tryLoadGitStatus(cwd).then(setGitStatus)
    }, 5000)
    return () => window.clearInterval(id)
  }, [cwd])

  // Close context menu on outside click / escape.
  useEffect(() => {
    if (!menu) return
    const onDown = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  // Auto-focus rename input.
  useEffect(() => {
    if (renaming) setTimeout(() => renameInputRef.current?.select(), 30)
  }, [renaming])

  // Auto-focus create input.
  useEffect(() => {
    if (createPrompt) setTimeout(() => createInputRef.current?.focus(), 30)
  }, [createPrompt])

  const toggleDir = useCallback(async (node: TreeNode) => {
    const next = new Set(expanded)
    if (next.has(node.path)) {
      next.delete(node.path)
      setExpanded(next)
      return
    }
    next.add(node.path)
    setExpanded(next)
    if (node.children) return
    const result = await window.api.files.list(node.path, showHidden)
    if (!result.ok) return
    // Mutate the tree to attach children.
    setRoot((prev) => attachChildren(prev, node.path, result.entries.map((e) => ({ ...e }))))
  }, [expanded, showHidden])

  const refreshNode = useCallback(async (nodePath: string) => {
    if (nodePath === cwd) {
      await loadRoot()
      return
    }
    const result = await window.api.files.list(nodePath, showHidden)
    if (result.ok) {
      setRoot((prev) => attachChildren(prev, nodePath, result.entries.map((e) => ({ ...e }))))
    }
  }, [cwd, loadRoot, showHidden])

  const handleFileClick = useCallback((node: TreeNode) => {
    if (node.isDirectory) {
      toggleDir(node)
      return
    }
    if (isPreviewable(node.name) && onPreviewFile) {
      onPreviewFile(node.path)
    } else {
      window.api.files.openExternal(node.path)
    }
  }, [toggleDir, onPreviewFile])

  const sendPathToChat = useCallback((nodePath: string) => {
    if (onSendToChat) {
      onSendToChat(nodePath)
      return
    }
    if (activeTabId) {
      // Convert absolute path to a relative one when possible, then "@path ".
      const rel = nodePath.startsWith(cwd + '/') ? nodePath.slice(cwd.length + 1) : nodePath
      window.api.pty.write({ tabId: activeTabId, data: `@${rel} ` })
    }
  }, [onSendToChat, activeTabId, cwd])

  const openContextMenu = useCallback((e: React.MouseEvent, node: TreeNode) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, node })
  }, [])

  const startRename = (node: TreeNode) => {
    setRenaming(node.path)
    setRenameValue(node.name)
  }

  const commitRename = async () => {
    if (!renaming) return
    const name = renameValue.trim()
    if (!name) { setRenaming(null); return }
    const result = await window.api.files.rename(renaming, name)
    setRenaming(null)
    if (result.ok) {
      const parent = renaming.slice(0, renaming.lastIndexOf('/'))
      await refreshNode(parent || cwd)
      tryLoadGitStatus(cwd).then(setGitStatus)
    } else {
      setError(result.error ?? 'rename failed')
    }
  }

  const commitCreate = async () => {
    if (!createPrompt) return
    const name = createName.trim()
    if (!name) { setCreatePrompt(null); setCreateName(''); return }
    const result = await window.api.files.create(createPrompt.parent, name, createPrompt.kind)
    setCreatePrompt(null)
    setCreateName('')
    if (result.ok) {
      await refreshNode(createPrompt.parent)
      if (createPrompt.kind === 'folder') {
        setExpanded((prev) => new Set([...prev, createPrompt.parent]))
      }
    } else {
      setError(result.error ?? 'create failed')
    }
  }

  const confirmDelete = async () => {
    if (!deleteConfirm) return
    const result = await window.api.files.delete(deleteConfirm.path)
    const parent = deleteConfirm.path.slice(0, deleteConfirm.path.lastIndexOf('/'))
    setDeleteConfirm(null)
    if (result.ok) {
      await refreshNode(parent || cwd)
      tryLoadGitStatus(cwd).then(setGitStatus)
    } else {
      setError(result.error ?? 'delete failed')
    }
  }

  // Search filter applies to top-level node names only — same as Unleashed.
  // O(n) where n = current root size.
  const filteredRoot = useMemo(() => {
    if (!search.trim()) return root
    const q = search.toLowerCase()
    return root.filter((n) => n.name.toLowerCase().includes(q))
  }, [root, search])

  const projectName = cwd?.split('/').filter(Boolean).pop() || 'project'

  return (
    <div className="w-60 h-full flex flex-col bg-bg-elev border-r border-line text-fg">
      {/* Header */}
      <div className="p-3 border-b border-line shrink-0">
        <div className="flex items-center gap-2 mb-2 min-w-0">
          <FolderIcon size={14} className="shrink-0 text-accent" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-fg truncate">{projectName}</p>
            <p className="text-[10px] text-fg-faint truncate" title={cwd}>{cwd}</p>
          </div>
          <button
            onClick={loadRoot}
            className="p-1 rounded text-fg-faint hover:text-fg hover:bg-bg-hi transition-colors"
            title="Refresh"
            disabled={loading}
          >
            <RefreshIcon size={12} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
        <div className="relative">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search files…"
            className="w-full px-2 py-1 text-xs bg-bg-hi border border-line rounded text-fg placeholder-fg-faint focus:outline-none focus:border-accent/40"
          />
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-line shrink-0">
        <button
          onClick={() => setCreatePrompt({ parent: cwd, kind: 'file' })}
          className="p-1.5 rounded text-fg-faint hover:text-fg hover:bg-bg-hi transition-colors"
          title="New file"
        >
          <FilePlusIcon size={12} />
        </button>
        <button
          onClick={() => setCreatePrompt({ parent: cwd, kind: 'folder' })}
          className="p-1.5 rounded text-fg-faint hover:text-fg hover:bg-bg-hi transition-colors"
          title="New folder"
        >
          <FolderPlusIcon size={12} />
        </button>
        <div className="flex-1" />
        <button
          onClick={() => setShowHidden((v) => !v)}
          className={`p-1.5 rounded transition-colors ${showHidden ? 'text-accent' : 'text-fg-faint hover:text-fg'} hover:bg-bg-hi`}
          title={showHidden ? 'Hide hidden files' : 'Show hidden files'}
        >
          {showHidden ? <EyeIcon size={12} /> : <EyeOffIcon size={12} />}
        </button>
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto py-1">
        {error && (
          <div className="px-3 py-2 text-[11px] text-red-400">{error}</div>
        )}
        {!error && filteredRoot.length === 0 && !loading && (
          <div className="p-4 text-center text-[11px] text-fg-faint">
            {search ? 'no matches' : 'empty folder'}
          </div>
        )}
        {!error && (
          <Rows
            nodes={filteredRoot}
            depth={0}
            expanded={expanded}
            gitStatus={gitStatus}
            renaming={renaming}
            renameValue={renameValue}
            renameInputRef={renameInputRef}
            onRenameChange={setRenameValue}
            onRenameCommit={commitRename}
            onRenameCancel={() => setRenaming(null)}
            onToggleDir={toggleDir}
            onFileClick={handleFileClick}
            onSendToChat={sendPathToChat}
            onContextMenu={openContextMenu}
          />
        )}
      </div>

      {/* Footer hint */}
      <div className="px-3 py-1.5 border-t border-line text-[10px] text-fg-faint shrink-0">
        Click to preview · Double-click external · Right-click for more
      </div>

      {/* Context menu */}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          node={menu.node}
          onClose={() => setMenu(null)}
          onRename={() => { startRename(menu.node); setMenu(null) }}
          onDelete={() => { setDeleteConfirm(menu.node); setMenu(null) }}
          onNewFile={() => { setCreatePrompt({ parent: menu.node.path, kind: 'file' }); setMenu(null) }}
          onNewFolder={() => { setCreatePrompt({ parent: menu.node.path, kind: 'folder' }); setMenu(null) }}
          onOpenExternal={() => { window.api.files.openExternal(menu.node.path); setMenu(null) }}
          onShowInFinder={() => { window.api.files.showInFinder(menu.node.path); setMenu(null) }}
          onCopyPath={() => { navigator.clipboard?.writeText(menu.node.path); setMenu(null) }}
          onSendToChat={() => { sendPathToChat(menu.node.path); setMenu(null) }}
        />
      )}

      {/* Create prompt */}
      {createPrompt && (
        <Modal
          title={`New ${createPrompt.kind}`}
          subtitle={`in ${displayName(createPrompt.parent)}`}
          onCancel={() => { setCreatePrompt(null); setCreateName('') }}
          onConfirm={commitCreate}
          confirmLabel="Create"
          confirmDisabled={!createName.trim()}
        >
          <input
            ref={createInputRef}
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitCreate()
              if (e.key === 'Escape') { setCreatePrompt(null); setCreateName('') }
            }}
            placeholder={createPrompt.kind === 'file' ? 'filename.txt' : 'folder-name'}
            className="w-full px-3 py-2 rounded bg-bg-hi border border-line text-fg text-sm placeholder-fg-faint focus:outline-none focus:border-accent/50"
          />
        </Modal>
      )}

      {/* Delete confirm */}
      {deleteConfirm && (
        <Modal
          title={`Delete ${deleteConfirm.isDirectory ? 'folder' : 'file'}`}
          subtitle={null}
          onCancel={() => setDeleteConfirm(null)}
          onConfirm={confirmDelete}
          confirmLabel="Delete"
          danger
        >
          <p className="text-sm text-fg-dim">
            Move <span className="text-fg font-medium">"{deleteConfirm.name}"</span> to the trash?
            {deleteConfirm.isDirectory && (
              <span className="block text-xs text-fg-faint mt-1">
                All contents will be moved with it.
              </span>
            )}
          </p>
        </Modal>
      )}
    </div>
  )
}

// -------------------------------------------------------------------------
// Tree rows
// -------------------------------------------------------------------------

interface RowsProps {
  nodes: TreeNode[]
  depth: number
  expanded: Set<string>
  gitStatus: GitStatusMap
  renaming: string | null
  renameValue: string
  renameInputRef: React.RefObject<HTMLInputElement>
  onRenameChange: (v: string) => void
  onRenameCommit: () => void
  onRenameCancel: () => void
  onToggleDir: (node: TreeNode) => void
  onFileClick: (node: TreeNode) => void
  onSendToChat: (path: string) => void
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void
}

function Rows(props: RowsProps): React.ReactElement {
  const { nodes, depth, expanded, gitStatus, renaming, onContextMenu } = props
  return (
    <>
      {nodes.map((node) => {
        const isExpanded = expanded.has(node.path)
        const isRenaming = renaming === node.path
        const status = gitStatus[node.path]
        const color = getExtColor(node.name, node.isDirectory)
        return (
          <div key={node.path}>
            <div
              className="group flex items-center gap-1.5 py-0.5 pr-2 cursor-pointer transition-colors hover:bg-bg-hi"
              style={{ paddingLeft: `${8 + depth * 14}px` }}
              onClick={() => {
                if (isRenaming) return
                if (node.isDirectory) props.onToggleDir(node)
                else props.onFileClick(node)
              }}
              onDoubleClick={() => {
                if (!node.isDirectory) window.api.files.openExternal(node.path)
              }}
              onContextMenu={(e) => onContextMenu(e, node)}
            >
              {node.isDirectory ? (
                <ChevronIcon
                  size={10}
                  className={`shrink-0 text-fg-faint transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                />
              ) : (
                <span className="w-[10px] shrink-0" />
              )}
              {node.isDirectory ? (
                isExpanded ? <FolderOpenIcon size={12} color={color} /> : <FolderIcon size={12} color={color} />
              ) : (
                <FileIcon size={12} color={color} />
              )}
              {isRenaming ? (
                <input
                  ref={props.renameInputRef}
                  value={props.renameValue}
                  onChange={(e) => props.onRenameChange(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={props.onRenameCommit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') props.onRenameCommit()
                    if (e.key === 'Escape') props.onRenameCancel()
                  }}
                  className="flex-1 min-w-0 px-1 py-0 text-xs bg-bg border border-accent/40 rounded text-fg focus:outline-none"
                />
              ) : (
                <span
                  className={`flex-1 truncate text-xs ${node.name.startsWith('.') ? 'text-fg-faint' : 'text-fg-dim'}`}
                >
                  {node.name}
                </span>
              )}
              {status && (
                <span
                  className="shrink-0 text-[9px] font-bold px-1 rounded"
                  style={{ color: GIT_BADGES[status].color, backgroundColor: `${GIT_BADGES[status].color}20` }}
                  title={status}
                >
                  {GIT_BADGES[status].label}
                </span>
              )}
              {!node.isDirectory && (
                <button
                  onClick={(e) => { e.stopPropagation(); props.onSendToChat(node.path) }}
                  title="Send @path to active terminal"
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-fg-faint hover:text-accent hover:bg-bg transition-all shrink-0"
                >
                  <SendIcon size={10} />
                </button>
              )}
            </div>
            {node.isDirectory && isExpanded && node.children && (
              <Rows {...props} nodes={node.children} depth={depth + 1} />
            )}
          </div>
        )
      })}
    </>
  )
}

// -------------------------------------------------------------------------
// Context menu
// -------------------------------------------------------------------------

interface ContextMenuProps {
  x: number
  y: number
  node: TreeNode
  onClose: () => void
  onRename: () => void
  onDelete: () => void
  onNewFile: () => void
  onNewFolder: () => void
  onOpenExternal: () => void
  onShowInFinder: () => void
  onCopyPath: () => void
  onSendToChat: () => void
}

function ContextMenu(props: ContextMenuProps) {
  const { x, y, node } = props
  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-[300] w-56 rounded-lg border border-line bg-bg-elev shadow-xl text-xs py-1"
      style={{ left: x, top: y }}
    >
      {!node.isDirectory && (
        <MenuItem label="Send to chat" onClick={props.onSendToChat} />
      )}
      <MenuItem label="Open in default app" onClick={props.onOpenExternal} />
      <MenuItem label="Reveal in OS" onClick={props.onShowInFinder} />
      <Divider />
      <MenuItem label="Copy path" onClick={props.onCopyPath} />
      <MenuItem label="Rename" onClick={props.onRename} />
      {node.isDirectory && (
        <>
          <Divider />
          <MenuItem label="New file" onClick={props.onNewFile} />
          <MenuItem label="New folder" onClick={props.onNewFolder} />
        </>
      )}
      <Divider />
      <MenuItem label="Delete" onClick={props.onDelete} danger />
    </div>
  )
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 hover:bg-bg-hi transition-colors ${danger ? 'text-red-400' : 'text-fg-dim hover:text-fg'}`}
    >
      {label}
    </button>
  )
}

function Divider() {
  return <div className="my-1 border-t border-line" />
}

// -------------------------------------------------------------------------
// Modal
// -------------------------------------------------------------------------

interface ModalProps {
  title: string
  subtitle?: string | null
  onCancel: () => void
  onConfirm: () => void
  confirmLabel?: string
  confirmDisabled?: boolean
  danger?: boolean
  children: React.ReactNode
}

function Modal(props: ModalProps) {
  return (
    <div
      className="fixed inset-0 z-[400] flex items-center justify-center bg-black/60"
      onMouseDown={(e) => { if (e.target === e.currentTarget) props.onCancel() }}
    >
      <div className="w-96 rounded-lg border border-line bg-bg-elev p-4 shadow-2xl">
        <h3 className="text-sm font-medium text-fg mb-1">{props.title}</h3>
        {props.subtitle && (
          <p className="text-[11px] text-fg-faint mb-3 truncate">{props.subtitle}</p>
        )}
        <div className="mb-4">{props.children}</div>
        <div className="flex justify-end gap-2">
          <button
            onClick={props.onCancel}
            className="px-3 py-1 text-xs text-fg-dim hover:text-fg border border-line rounded transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={props.onConfirm}
            disabled={!!props.confirmDisabled}
            className={`px-3 py-1 text-xs text-white rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${props.danger ? 'bg-red-600 hover:bg-red-500' : 'bg-accent hover:bg-accent/90'}`}
          >
            {props.confirmLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function displayName(p: string): string {
  return p.split('/').filter(Boolean).pop() || p
}

/** Immutable tree update: returns a new node array with children attached at path. */
function attachChildren(nodes: TreeNode[], targetPath: string, children: TreeNode[]): TreeNode[] {
  return nodes.map((n) => {
    if (n.path === targetPath) return { ...n, children }
    if (n.children) return { ...n, children: attachChildren(n.children, targetPath, children) }
    return n
  })
}

// -------------------------------------------------------------------------
// Inline SVG icons (matches Header's pattern — no new dependency)
// -------------------------------------------------------------------------

function Svg({ size, children, className, color }: { size: number; children: React.ReactNode; className?: string; color?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color || 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {children}
    </svg>
  )
}

function FolderIcon({ size, className, color }: { size: number; className?: string; color?: string }) {
  return (
    <Svg size={size} className={className} color={color}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </Svg>
  )
}
function FolderOpenIcon({ size, className, color }: { size: number; className?: string; color?: string }) {
  return (
    <Svg size={size} className={className} color={color}>
      <path d="M6 14l1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
    </Svg>
  )
}
function FileIcon({ size, className, color }: { size: number; className?: string; color?: string }) {
  return (
    <Svg size={size} className={className} color={color}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </Svg>
  )
}
function ChevronIcon({ size, className }: { size: number; className?: string }) {
  return (
    <Svg size={size} className={className}>
      <polyline points="9 18 15 12 9 6" />
    </Svg>
  )
}
function RefreshIcon({ size, className }: { size: number; className?: string }) {
  return (
    <Svg size={size} className={className}>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </Svg>
  )
}
function FilePlusIcon({ size, className }: { size: number; className?: string }) {
  return (
    <Svg size={size} className={className}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="18" x2="12" y2="12" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </Svg>
  )
}
function FolderPlusIcon({ size, className }: { size: number; className?: string }) {
  return (
    <Svg size={size} className={className}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      <line x1="12" y1="11" x2="12" y2="17" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </Svg>
  )
}
function EyeIcon({ size, className }: { size: number; className?: string }) {
  return (
    <Svg size={size} className={className}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  )
}
function EyeOffIcon({ size, className }: { size: number; className?: string }) {
  return (
    <Svg size={size} className={className}>
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </Svg>
  )
}
function SendIcon({ size, className }: { size: number; className?: string }) {
  return (
    <Svg size={size} className={className}>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </Svg>
  )
}
