import { useCallback, useEffect, useState } from 'react'
import { EmptyLine, Section } from '@/components/info/Section'
import { Button } from '@/components/ui/Button'
import { RefreshButton } from '@/components/muse/RefreshButton'
import { getBridge } from '@/lib/bridge'
import { cleanSidebarError } from '@/lib/sidebarCompat'
import { useBotStore } from '@/store/botStore'
import { t } from '@/lib/i18n'

type MemoryHit = { id: string; title: string; snippet: string }

export function parseMemoryMarkdownToHits(label: string, content: string): MemoryHit[] {
  const trimmed = content.trim()
  if (!trimmed) return []
  const sections = trimmed.split(/^##+\s+/m).filter((s) => s.trim().length > 0)
  if (sections.length > 1) {
    return sections.slice(0, 20).map((sec, idx) => {
      const newlineIdx = sec.indexOf('\n')
      const heading = (newlineIdx >= 0 ? sec.slice(0, newlineIdx) : sec).trim()
      const body = (newlineIdx >= 0 ? sec.slice(newlineIdx + 1) : '').replace(/\s+/g, ' ').trim()
      return {
        id: `${label}-${idx}`,
        title: heading || label,
        snippet: body.slice(0, 280)
      }
    })
  }
  const bullets = trimmed
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*•]\s+/, '').trim())
    .filter((l) => l && !l.startsWith('#'))
  if (bullets.length > 1) {
    return bullets.slice(0, 20).map((line, idx) => ({
      id: `${label}-b-${idx}`,
      title: label,
      snippet: line.slice(0, 280)
    }))
  }
  return [
    {
      id: `${label}-0`,
      title: label,
      snippet: trimmed.replace(/\s+/g, ' ').slice(0, 280)
    }
  ]
}

function asHits(raw: unknown, fallbackTitle = 'MEMORY'): MemoryHit[] {
  if (typeof raw === 'string') return parseMemoryMarkdownToHits(fallbackTitle, raw)
  if (!raw || typeof raw !== 'object') return []
  const root = raw as Record<string, unknown>

  // Direct `memory.get` / `fs.read` document payload (`content` / `text` / `markdown`)
  const directText = root['content'] ?? root['text'] ?? root['markdown'] ?? root['value']
  if (typeof directText === 'string' && directText.trim()) {
    const uriLabel = String(root['memory_uri'] ?? root['path'] ?? root['title'] ?? fallbackTitle)
      .replace(/^memory:\/\//i, '')
      .replace(/\.md$/i, '')
    return parseMemoryMarkdownToHits(uriLabel || fallbackTitle, directText)
  }

  const lists = [root['results'], root['items'], root['memories'], root['entries'], root['hits']]
  let arr: unknown[] = []
  for (const c of lists) {
    if (Array.isArray(c)) {
      arr = c
      break
    }
  }
  if (!arr.length && Array.isArray(raw)) arr = raw
  const out: MemoryHit[] = []
  for (const row of arr) {
    if (!row || typeof row !== 'object') continue
    const o = row as Record<string, unknown>
    const id = String(o['id'] ?? o['memory_id'] ?? o['memory_uri'] ?? o['key'] ?? out.length)
    const rawTitle = String(o['title'] ?? o['name'] ?? o['label'] ?? o['memory_uri'] ?? o['kind'] ?? id)
      .replace(/^memory:\/\//i, '')
    const snippet = String(
      o['snippet'] ?? o['text'] ?? o['content'] ?? o['summary'] ?? o['value'] ?? ''
    ).slice(0, 280)
    out.push({ id, title: rawTitle, snippet })
  }
  return out
}

const DEFAULT_MEMORY_URIS = ['memory://MEMORY.md', 'memory://USER.md'] as const

export function MemorySection({ accountId }: { accountId: string }) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MemoryHit[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [unavailable, setUnavailable] = useState(false)
  const status = useBotStore((s) => s.accounts[accountId]?.status)

  const runSearch = useCallback(
    async (q: string) => {
      const muse = getBridge()?.muse
      if (!muse?.rpc) {
        setUnavailable(true)
        return
      }
      setLoading(true)
      setError(undefined)
      setUnavailable(false)
      try {
        const trimmedQuery = q.trim()
        if (trimmedQuery) {
          const raw = await muse.rpc({
            accountId,
            method: 'memory.search',
            params: { query: trimmedQuery, limit: 20 }
          })
          setHits(asHits(raw))
          return
        }

        // Initial overview without search query: `memory.get` requires `memory_uri`.
        // Probe canonical memory URIs first, then fall back to `memory.search` / `fs.read`.
        const collected: MemoryHit[] = []
        let anySucceeded = false

        for (const uri of DEFAULT_MEMORY_URIS) {
          try {
            const doc = await muse.rpc({
              accountId,
              method: 'memory.get',
              params: { memory_uri: uri }
            })
            anySucceeded = true
            collected.push(...asHits(doc, uri.replace(/^memory:\/\//, '').replace(/\.md$/i, '')))
          } catch {
            /* try next source */
          }
        }

        if (collected.length === 0) {
          try {
            const searched = await muse.rpc({
              accountId,
              method: 'memory.search',
              params: { query: '*', limit: 20 }
            })
            anySucceeded = true
            collected.push(...asHits(searched))
          } catch {
            /* fallback to workspace MEMORY.md */
          }
        }

        if (collected.length === 0) {
          for (const path of ['MEMORY.md', 'workspace/MEMORY.md']) {
            try {
              const fileDoc = await muse.rpc({
                accountId,
                method: 'fs.read',
                params: { path }
              })
              anySucceeded = true
              const parsed = asHits(fileDoc, 'MEMORY')
              if (parsed.length > 0) {
                collected.push(...parsed)
                break
              }
            } catch {
              /* ignore */
            }
          }
        }

        setHits(collected)
        if (!anySucceeded && collected.length === 0) {
          setUnavailable(true)
        }
      } catch (err) {
        setHits([])
        setError(cleanSidebarError(err))
        setUnavailable(true)
      } finally {
        setLoading(false)
      }
    },
    [accountId]
  )

  useEffect(() => {
    if (status === 'online' || status === 'busy' || status === 'attention') void runSearch('')
  }, [runSearch, status])

  const consolidate = async () => {
    const muse = getBridge()?.muse
    if (!muse?.rpc) return
    setBusy(true)
    setError(undefined)
    try {
      await muse.rpc({ accountId, method: 'memory.consolidate', params: {} })
      await runSearch(query)
    } catch (err) {
      setError(cleanSidebarError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title={t('Muse memory')}
      count={hits.length || undefined}
      action={<RefreshButton loading={loading} onClick={() => void runSearch(query)} />}
    >
      <div className="flex flex-col gap-2">
        <div className="flex gap-1.5">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch(query)
            }}
            placeholder={t('Search memory…')}
            aria-label={t('Search memory…')}
            className="h-7 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 text-[12px] text-ink outline-none placeholder:text-ink-muted"
          />
          <Button size="sm" variant="secondary" disabled={busy || loading} onClick={() => void consolidate()}>
            {t('Consolidate')}
          </Button>
        </div>
        {error && <p className="text-[12px] text-status-error">{error}</p>}
        {unavailable && hits.length === 0 ? (
          <EmptyLine>{t('Memory unavailable')}</EmptyLine>
        ) : hits.length === 0 ? (
          <EmptyLine>{t('No memory hits')}</EmptyLine>
        ) : (
          <ul className="divide-y divide-line">
            {hits.map((h) => (
              <li key={h.id} className="py-1.5">
                <p className="text-[12.5px] font-medium text-ink">{h.title}</p>
                {h.snippet ? <p className="mt-0.5 text-[11.5px] text-ink-secondary">{h.snippet}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  )
}
