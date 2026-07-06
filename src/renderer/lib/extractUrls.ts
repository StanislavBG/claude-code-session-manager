// Detects URLs in raw (pre-render) chat markdown — bare `https?://...` or the URL
// portion of a `[label](url)` link. Dedups and hard-caps at 3 to bound the ResultCard
// callouts rendered below a TerminalChat assistant turn's prose (see TerminalChat.tsx).
const MAX_EXTRACTED_URLS = 3

export function extractUrls(text: string): string[] {
  const seen = new Set<string>()
  const urls: string[] = []
  const re = /\[[^\]]*\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s)"'<>]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const url = m[1] ?? m[0]
    if (!seen.has(url)) {
      seen.add(url)
      urls.push(url)
      if (urls.length >= MAX_EXTRACTED_URLS) break
    }
  }
  return urls
}
