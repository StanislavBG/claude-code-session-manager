/**
 * Plays a project's generated demo video (an HTML/JS file on disk) inside
 * Project Home. Inline scripts are blocked by the app CSP in a srcDoc frame,
 * so this loads the file over the existing smfile:// scheme in an iframe
 * sandboxed with allow-scripts only — opaque origin, no host access, no
 * popups — the same isolation HtmlPreview uses for the Editor's HTML preview.
 */
import { smfileUrl } from '../../../../state/editor'

interface Props {
  path: string
  mtimeMs: number
}

export function DemoVideoFrame({ path, mtimeMs }: Props) {
  return (
    <div className="aspect-video w-full bg-black">
      <iframe
        key={`${path}#${mtimeMs}`}
        title="Demo video"
        data-testid="demo-video-frame"
        src={smfileUrl(path)}
        sandbox="allow-scripts"
        className="w-full h-full border-0"
      />
    </div>
  )
}
