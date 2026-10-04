// Detects URLs in raw (pre-render) chat markdown — bare `https?://...` or the URL
// portion of a `[label](url)` link. Dedups and hard-caps at 3 to bound the ResultCard
// callouts rendered below a TerminalChat assistant turn's prose (see TerminalChat.tsx).
const MAX_EXTRACTED_URLS = 3

const TRAILING_PUNCT = new Set(['*', '_', '~', '`', '.', ',', ';', ':', '!', '?', "'", '"', ']'])

const count = (s: string, ch: string): number => s.split(ch).length - 1

// Bare URLs in prose pick up markdown/sentence punctuation (`**url**`, `` `url` ``, `url.`).
// A trailing `)` is only dropped when unbalanced, so `…/Foo_(bar)` survives.
function trimTrailingPunctuation(url: string): string {
  let end = url.length
  while (end > 0) {
    const ch = url[end - 1]
    if (TRAILING_PUNCT.has(ch)) {
      end--
    } else if (ch === ')' && count(url.slice(0, end), ')') > count(url.slice(0, end), '(')) {
      end--
    } else {
      break
    }
  }
  return url.slice(0, end)
}

export function extractUrls(text: string): string[] {
  const seen = new Set<string>()
  const urls: string[] = []
  const re = /\[[^\]]*\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s"'<>`]+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const url = m[1] ?? trimTrailingPunctuation(m[0])
    if (/^https?:\/\/$/.test(url)) continue
    if (!seen.has(url)) {
      seen.add(url)
      urls.push(url)
      if (urls.length >= MAX_EXTRACTED_URLS) break
    }
  }
  return urls
}
