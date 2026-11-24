import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { EmptyLine, Section } from '@/components/info/Section'
import { Button } from '@/components/ui/Button'
import { RefreshButton } from '@/components/muse/RefreshButton'
import { getBridge } from '@/lib/bridge'
import { cleanSidebarError, isOnlineAccountStatus } from '@/lib/sidebarCompat'
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

type MemoryResult = { hits: MemoryHit[]; unavailable: boolean }
const memoryReads = new Map<string, Promise<MemoryResult>>()

function loadMemory(accountId: string, query: string, fresh: boolean): Promise<MemoryResult> {
  const key = JSON.stringify([accountId, query])
  const existing = memoryReads.get(key)
  if (existing && !fresh) return existing
  const request = readMemory(accountId, query).finally(() => {
    if (memoryReads.get(key) === request) memoryReads.delete(key)
  })
  memoryReads.set(key, request)
  return request
}

async function readMemory(accountId: string, query: string): Promise<MemoryResult> {
  const muse = getBridge()?.muse
  if (!muse?.rpc) return { hits: [], unavailable: true }
  if (query) {
    const raw = await muse.rpc({ accountId, method: 'memory.search', params: { query, limit: 20 } })
    return { hits: asHits(raw), unavailable: false }
  }
  const docs = await Promise.allSettled(DEFAULT_MEMORY_URIS.map((memory_uri) =>
    muse.rpc({ accountId, method: 'memory.get', params: { memory_uri } })
  ))
  let anySucceeded = docs.some((doc) => doc.status === 'fulfilled')
  const hits = docs.flatMap((doc, index) => doc.status === 'fulfilled'
    ? asHits(doc.value, DEFAULT_MEMORY_URIS[index]!.replace(/^memory:\/\//, '').replace(/\.md$/, '')) : [])
  if (!hits.length) {
    try {
      hits.push(...asHits(await muse.rpc({ accountId, method: 'memory.search', params: { query: '*', limit: 20 } })))
      anySucceeded = true
    } catch {
      /* Try the workspace files. */
    }
  }
  for (const path of ['MEMORY.md', 'workspace/MEMORY.md']) {
    if (hits.length) break
    try {
      hits.push(...asHits(await muse.rpc({ accountId, method: 'fs.read', params: { path } })))
      anySucceeded = true
    } catch {
      /* Try the next path. */
    }
  }
  return { hits, unavailable: !anySucceeded }
}

export function MemorySection({ accountId }: { accountId: string }) {
  return <AccountMemorySection key={accountId} accountId={accountId} />
}

function AccountMemorySection({ accountId }: { accountId: string }) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<MemoryHit[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [unavailable, setUnavailable] = useState(false)
  const connected = useBotStore((s) => isOnlineAccountStatus(s.accounts[accountId]?.status))
  const submittedQuery = useRef('')
  const request = useRef(0)
  const mounted = useRef(false)

  useLayoutEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const runSearch = useCallback(async (q: string, fresh = false) => {
    if (!mounted.current) return
    const query = q.trim()
    submittedQuery.current = query
    const version = ++request.current
    const current = () => mounted.current && request.current === version
    setLoading(true)
    setError(undefined)
    setUnavailable(false)
    try {
      const result = await loadMemory(accountId, query, fresh)
      if (!current()) return
      setHits(result.hits)
      setUnavailable(result.unavailable)
    } catch (err) {
      if (!current()) return
      setHits([])
      setError(cleanSidebarError(err))
      setUnavailable(true)
    } finally {
      if (current()) setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    if (connected) void runSearch(submittedQuery.current)
    else setLoading(false)
    return () => { request.current++ }
  }, [connected, runSearch])

  const consolidate = async () => {
    const muse = getBridge()?.muse
    if (!muse?.rpc) return
    setBusy(true)
    setError(undefined)
    try {
      await muse.rpc({ accountId, method: 'memory.consolidate', params: {} })
      if (mounted.current) await runSearch(submittedQuery.current, true)
    } catch (err) {
      if (mounted.current) setError(cleanSidebarError(err))
    } finally {
      if (mounted.current) setBusy(false)
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
