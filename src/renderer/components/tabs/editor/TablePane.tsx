/**
 * TablePane — renders CSV/TSV text as a scrollable table (Google-Sheets-ish).
 *
 * Hand-rolled quoted-field parser (no papaparse dep): handles "..." quoting,
 * doubled "" escapes, and embedded newlines. Delimiter inferred from extension
 * (.tsv → tab, else comma). Rows are capped for DOM safety; the cap is surfaced
 * (no silent truncation). The raw text stays editable via the Edit toggle.
 */

import { useMemo } from 'react'
import { extOf } from '../../../state/editor'

const MAX_ROWS = 2000

/** Parse delimited text into rows of cells. O(n) over characters. */
function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += c
    } else if (c === '"') {
      inQuotes = true
    } else if (c === delim) {
      row.push(field); field = ''
    } else if (c === '\n') {
      row.push(field); field = ''
      rows.push(row); row = []
      if (rows.length >= MAX_ROWS) break
    } else if (c === '\r') {
      // swallow — handled by the \n branch
    } else {
      field += c
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

export function TablePane({ path, text }: { path: string; text: string }) {
  const delim = extOf(path) === 'tsv' ? '\t' : ','
  const { header, body, truncated } = useMemo(() => {
    const rows = parseDelimited(text, delim)
    const truncated = rows.length >= MAX_ROWS
    const [header = [], ...body] = rows
    return { header, body, truncated }
  }, [text, delim])

  if (!header.length) {
    return <div className="p-6 text-xs text-fg-faint">empty file</div>
  }

  return (
    <div className="h-full overflow-auto bg-bg">
      {truncated && (
        <div className="px-3 py-1 text-[10px] text-amber-700 bg-amber-100/40 border-b border-line">
          Showing first {MAX_ROWS.toLocaleString()} rows — switch to Edit to see the full file.
        </div>
      )}
      <table className="text-xs border-collapse">
        <thead className="sticky top-0">
          <tr>
            <th className="px-2 py-1 bg-bg-elev border border-line text-fg-faint font-normal w-10 text-right">#</th>
            {header.map((h, i) => (
              <th key={i} className="px-3 py-1 bg-bg-elev border border-line text-fg font-medium text-left whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri} className="even:bg-bg-elev/40">
              <td className="px-2 py-1 border border-line text-fg-faint text-right tabular-nums">{ri + 1}</td>
              {header.map((_, ci) => (
                <td key={ci} className="px-3 py-1 border border-line text-fg-dim whitespace-pre">{r[ci] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
