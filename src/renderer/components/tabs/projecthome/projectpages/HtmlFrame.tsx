/**
 * The one sandboxed-iframe implementation for hosted Project Pages HTML —
 * the app's single `<iframe sandbox srcDoc>` call site.
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
