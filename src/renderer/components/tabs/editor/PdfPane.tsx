/**
 * PdfPane — renders a PDF in Chromium's built-in viewer via the smfile://
 * scheme. The file is served home-scoped by the smfile handler (index.cjs);
 * `frame-src smfile:` in the CSP permits the iframe. No JS library needed.
 */

import { smfileUrl } from '../../../state/editor'

export function PdfPane({ path }: { path: string }) {
  return (
    <iframe
      title={path}
      src={smfileUrl(path)}
      className="w-full h-full bg-white border-0"
    />
  )
}
