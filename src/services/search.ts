const WORDS = /[\p{L}\p{N}\p{M}]+/gu
const normalized = (value: string): string => value.normalize('NFKC').toLowerCase()
export type SearchMode = 'all' | 'any'

export function queryTerms(value: unknown): string[] {
  if (typeof value !== 'string' || value.length > 1000) return []
  return [...new Set([...value.matchAll(WORDS)].map(m => normalized(m[0])).filter(w => w.length > 1))].slice(0, 8)
}

/** Unicode word matches, stable relevance, and a snippet in the original text. */
export function searchText(text: string, words: string[], mode: SearchMode = 'all'): { score: number; snippet: string } | null {
  const wanted = new Set(words.map(normalized))
  const counts = new Map<string, number>()
  let first = -1
  for (const token of text.matchAll(WORDS)) {
    const word = normalized(token[0])
    if (!wanted.has(word)) continue
    counts.set(word, Math.min(4, (counts.get(word) ?? 0) + 1))
    if (first < 0) first = token.index!
  }
  if (!counts.size || mode === 'all' && counts.size !== wanted.size) return null
  const start = Math.max(0, first - 80), end = start + 200
  const snippet = `${start ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`
  return { score: counts.size * 100 + [...counts.values()].reduce((n, v) => n + v, 0), snippet }
}

export const searchLimit = (value: unknown, fallback = 8, max = 20): number => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(1, Math.min(Math.floor(n) || fallback, max)) : fallback
}
