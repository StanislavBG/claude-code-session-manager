/**
 * The one sandboxed-iframe implementation for hosted Project Pages HTML —
 * used by both ProjectHome.tsx's main hosted document and
 * ProjectPagesSection.tsx's lens viewer, so there is exactly one
 * `<iframe sandbox srcDoc>` call site in the app, not two.
 */
export function HtmlFrame({ title, html }: { title: string; html: string }) {
  return (
    <iframe
      title={title}
      sandbox="allow-same-origin"
      srcDoc={html}
      style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
    />
  )
}
