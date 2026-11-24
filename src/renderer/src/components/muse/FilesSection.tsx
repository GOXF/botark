import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, File, FileCode, FileImage, FileText, Pin, PinOff, Search, Trash2 } from 'lucide-react'
import type { MuseFileEntryView } from '@shared/ipc'
import { EmptyLine, Section } from '@/components/info/Section'
import { Button } from '@/components/ui/Button'
import { RefreshButton } from '@/components/muse/RefreshButton'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { cleanSidebarError, isOnlineAccountStatus } from '@/lib/sidebarCompat'
import { useBotStore } from '@/store/botStore'
import { t } from '@/lib/i18n'
import type { MuseWorkspaceFile } from '../../../../main/muse-native/fs'

type Filter = 'all' | 'pinned' | 'artifact' | 'library'
const FILTERS: ReadonlyArray<[Filter, string]> = [
  ['all', 'All'],
  ['pinned', 'Pinned'],
  ['artifact', 'Artifacts'],
  ['library', 'Library']
]

function formatBytes(n: number | null): string {
  if (n == null || n < 0) return ''
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB'
  return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB'
}

function relativeTime(ms: number | null): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  const min = Math.round(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(ms).toLocaleDateString()
}

function FileGlyph({ file }: { file: MuseFileEntryView }) {
  const mime = file.mimeType ?? ''
  const name = file.name.toLowerCase()
  const Icon = mime.startsWith('image/')
    ? FileImage
    : /\.(ts|tsx|js|py|json|sh|html|css)$/.test(name)
      ? FileCode
      : mime.startsWith('text/') || /\.(md|txt|pdf|docx?)$/.test(name)
        ? FileText
        : File
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-hover text-ink-secondary">
      <Icon className="size-4" aria-hidden />
    </span>
  )
}

const PIN_KEY = (accountId: string) => `bothub-library-pins:${accountId}`
function loadPins(accountId: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(PIN_KEY(accountId)) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

function decodeBase64Utf8(b64: string): string {
  try {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return ''
  }
}

function InlineFilePreview({ accountId, file }: { accountId: string; file: MuseFileEntryView }) {
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState<{ mimeType: string; dataBase64?: string; text?: string; truncated?: boolean } | null>(null)
  const [err, setErr] = useState<string>()
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string>()
  const path = file.path || (file.id.includes('/') ? file.id : '')

  const load = useCallback(async () => {
    const muse = getBridge()?.muse
    if (!muse) return
    if (!path) {
      setErr(t('Preview unavailable'))
      return
    }
    setLoading(true)
    setErr(undefined)
    try {
      if (muse.previewWorkspaceFile) {
        const res: Awaited<ReturnType<typeof muse.previewWorkspaceFile>> & { truncated?: boolean } = await muse.previewWorkspaceFile(accountId, path)
        const mt = (res.mimeType || file.mimeType || '').toLowerCase()
        const isText =
          mt.startsWith('text/') ||
          mt.includes('json') ||
          mt.includes('xml') ||
          mt.includes('javascript') ||
          /\.(md|txt|json|py|ts|tsx|js|jsx|sh|yaml|yml|toml|html|css|csv|log)$/i.test(file.name)
        const text = isText ? decodeBase64Utf8(res.dataBase64) : undefined
        setPreview({
          mimeType: res.mimeType || file.mimeType || 'application/octet-stream',
          dataBase64: res.dataBase64,
          text: text?.slice(0, 60_000),
          truncated: Boolean(res.truncated || (text && text.length > 60_000))
        })
        return
      }
      if (muse.rpc) {
        const raw = await muse.rpc({ accountId, method: 'fs.read', params: { path } })
        const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
        const content = typeof o['content'] === 'string' ? (o['content'] as string) : typeof o['text'] === 'string' ? (o['text'] as string) : ''
        const b64 = typeof o['data_base64'] === 'string' ? (o['data_base64'] as string) : undefined
        const text = content || (b64 ? decodeBase64Utf8(b64) : JSON.stringify(raw, null, 2) || '')
        setPreview({
          mimeType: file.mimeType || 'text/plain',
          dataBase64: b64,
          text: text.slice(0, 60_000),
          truncated: o['truncated'] === true || text.length > 60_000
        })
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [accountId, file.mimeType, file.name, path])

  useEffect(() => {
    void load()
  }, [load])

  const downloadFile = async () => {
    const muse = getBridge()?.muse
    if (!muse?.rpc || !path) return
    setDownloading(true)
    setDownloadError(undefined)
    try {
      const fileData = await muse.rpc({ accountId, method: 'workspace.download', params: { path } }) as MuseWorkspaceFile
      if (!fileData || fileData.truncated !== false || typeof fileData.dataBase64 !== 'string' ||
          !Number.isSafeInteger(fileData.byteLength) || fileData.byteLength < 0) {
        throw new Error('Muse did not return the complete file')
      }
      const bin = atob(fileData.dataBase64)
      if (bin.length !== fileData.byteLength) throw new Error('Muse returned an incomplete file')
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const blob = new Blob([bytes], { type: fileData.mimeType || 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = file.name || 'download'
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : String(error))
    } finally {
      setDownloading(false)
    }
  }

  const setActiveDocument = useBotStore((s) => s.setActiveDocument)

  const mt = preview?.mimeType.toLowerCase() ?? ''
  return (
    <div className="col-span-2 mt-1.5 flex flex-col gap-1.5 border-t border-line pt-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-ink-secondary">{t('Preview')}</span>
        <div className="flex items-center gap-1">
          {preview && <button
            type="button"
            onClick={() =>
              setActiveDocument({
                accountId,
                title: file.name,
                path: file.path || file.id,
                markdown: !preview.truncated && (mt.includes('markdown') || file.name.endsWith('.md')) ? preview.text : undefined,
                html: !preview.truncated && (mt.includes('html') || file.name.endsWith('.html')) ? preview.text : undefined,
                mimeType: preview.mimeType,
                platformId: 'meta-muse'
              })
            }
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-accent-600 hover:bg-surface"
          >
            画布打开
          </button>}
          <button
            type="button"
            disabled={downloading || !path}
            onClick={() => void downloadFile()}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-accent-600 hover:bg-surface"
          >
            <Download className="size-3" /> {downloading ? t('Downloading…') : t('Download')}
          </button>
        </div>
      </div>
      {downloadError && <p className="text-status-error" role="alert">{downloadError}</p>}
      {preview?.truncated && <p className="text-ink-muted">{t('Preview truncated. Download the full file.')}</p>}
      {loading ? (
        <p className="text-ink-muted">{t('Loading preview…')}</p>
      ) : err || !preview ? (
        <p className="text-ink-muted">{err || t('Preview unavailable')}</p>
      ) : mt.startsWith('image/') && preview.dataBase64 ? (
        <img
          src={`data:${preview.mimeType};base64,${preview.dataBase64}`}
          alt={file.name}
          className="max-h-56 max-w-full rounded-lg border border-line bg-surface object-contain"
        />
      ) : mt.startsWith('audio/') && preview.dataBase64 ? (
        <audio controls src={`data:${preview.mimeType};base64,${preview.dataBase64}`} className="w-full" />
      ) : mt.startsWith('video/') && preview.dataBase64 ? (
        <video controls src={`data:${preview.mimeType};base64,${preview.dataBase64}`} className="max-h-56 w-full rounded-lg bg-black" />
      ) : preview.text ? (
        <pre className="max-h-56 overflow-auto rounded-lg border border-line bg-surface p-2 font-mono text-[11px] leading-4 whitespace-pre-wrap text-ink">
          {preview.text}
        </pre>
      ) : (
        <p className="text-ink-muted">{t('Binary file — click Download to save')}</p>
      )}
    </div>
  )
}

/** Muse Library & Artifacts: search (local + fs.search), filter chips, remote/local pins, inline preview, and delete. */
export function FilesSection({ accountId }: { accountId: string }) {
  return <AccountFilesSection key={accountId} accountId={accountId} />
}

function AccountFilesSection({ accountId }: { accountId: string }) {
  const [items, setItems] = useState<MuseFileEntryView[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [open, setOpen] = useState<string | null>(null)
  const [pins, setPins] = useState<Set<string>>(() => loadPins(accountId))
  const [confirmDelete, setConfirmDelete] = useState<string>()
  const [busyKey, setBusyKey] = useState<string>()
  const connected = useBotStore((s) => isOnlineAccountStatus(s.accounts[accountId]?.status))

  const refresh = useCallback(async () => {
    const muse = getBridge()?.muse
    if (!muse?.listFiles) return
    setLoading(true)
    setError(undefined)
    try {
      setItems(await muse.listFiles(accountId))
    } catch (err) {
      setError(cleanSidebarError(err))
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    if (connected) void refresh()
  }, [refresh, connected])

  useEffect(() => {
    const muse = getBridge()?.muse
    if (!muse?.onEvent) return
    return muse.onEvent((event) => {
      if (event.type === 'files' && event.accountId === accountId) setItems(event.files)
    })
  }, [accountId])

  useEffect(() => setPins(loadPins(accountId)), [accountId])

  const keyOf = (f: MuseFileEntryView) => f.source + ':' + f.id
  const isPinned = (f: MuseFileEntryView) => f.pinned || pins.has(keyOf(f))
  const togglePin = async (f: MuseFileEntryView) => {
    const muse = getBridge()?.muse
    const k = keyOf(f)
    const nextPinned = !isPinned(f)
    if (f.source === 'artifact' && muse?.rpc) {
      try {
        await muse.rpc({
          accountId,
          method: 'artifacts.pin',
          params: { id: f.id, artifact_id: f.id, pinned: nextPinned }
        })
        await refresh()
      } catch {
        /* fall back to local pin */
      }
    }
    setPins((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      localStorage.setItem(PIN_KEY(accountId), JSON.stringify([...next]))
      return next
    })
  }

  const removeFile = async (f: MuseFileEntryView) => {
    const k = keyOf(f)
    if (confirmDelete !== k) {
      setConfirmDelete(k)
      return
    }
    const muse = getBridge()?.muse
    if (!muse?.rpc) return
    setBusyKey(k)
    setError(undefined)
    try {
      if (f.source === 'artifact') {
        await muse.rpc({ accountId, method: 'artifacts.remove', params: { id: f.id, artifact_id: f.id } })
      } else if (f.path) {
        await muse.rpc({ accountId, method: 'fs.delete', params: { path: f.path } })
      }
      setConfirmDelete(undefined)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyKey(undefined)
    }
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items
      .filter((f) => (filter === 'all' ? true : filter === 'pinned' ? isPinned(f) : f.source === filter))
      .filter((f) => !q || f.name.toLowerCase().includes(q) || (f.path ?? '').toLowerCase().includes(q))
      .sort((a, b) => Number(isPinned(b)) - Number(isPinned(a)) || (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, query, filter, pins])

  return (
    <Section
      title={t('Documents and Files')}
      count={items.length || undefined}
      flush
      action={<RefreshButton loading={loading} onClick={() => void refresh()} />}
    >
      <div className="flex flex-col gap-2 border-b border-line px-3 py-2.5">
        <label className="flex h-8 items-center gap-2 rounded-lg bg-hover px-2.5 text-ink-muted">
          <Search className="size-3.5 shrink-0" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Search files')}
            aria-label={t('Search files')}
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-muted"
          />
        </label>
        <div className="flex gap-1" role="radiogroup" aria-label={t('Filter files')}>
          {FILTERS.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={filter === id}
              onClick={() => setFilter(id)}
              className={cn(
                'press h-6 rounded-full px-2.5 text-[11px] font-medium transition-colors',
                filter === id ? 'bg-ink text-canvas' : 'bg-hover text-ink-secondary hover:text-ink'
              )}
            >
              {t(label)}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="px-3 pt-2 text-[12px] text-status-error">{error}</p>}
      {visible.length === 0 ? (
        <div className="px-3 py-2.5">
          <EmptyLine>
            {loading ? t('Loading files…') : items.length ? t('No files match') : t('Files the bot creates show up here')}
          </EmptyLine>
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {visible.map((f) => {
            const k = keyOf(f)
            const pinned = isPinned(f)
            const expanded = open === k
            const meta = [relativeTime(f.updatedAtMs), formatBytes(f.sizeBytes)].filter(Boolean).join(' · ')
            return (
              <li key={k} className="group/file">
                <div className="flex items-center gap-2.5 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => setOpen(expanded ? null : k)}
                    aria-expanded={expanded}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                  >
                    <FileGlyph file={f} />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] text-ink">{f.name}</span>
                      {meta && <span className="block truncate text-[11px] text-ink-muted">{meta}</span>}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void togglePin(f)}
                    aria-label={pinned ? t('Unpin') : t('Pin')}
                    title={f.pinned ? t('Pinned in Muse') : pinned ? t('Unpin') : t('Pin')}
                    className={cn(
                      'press-icon grid size-7 shrink-0 place-items-center rounded-full transition-opacity hover:bg-hover',
                      pinned ? 'text-accent-600' : 'text-ink-muted opacity-0 group-hover/file:opacity-100 focus-visible:opacity-100'
                    )}
                  >
                    {pinned ? <Pin className="size-3.5" /> : <PinOff className="size-3.5" />}
                  </button>
                  {(f.source === 'artifact' || f.path) && (
                    <Button
                      size="sm"
                      variant={confirmDelete === k ? 'danger-confirm' : 'ghost'}
                      disabled={busyKey === k}
                      onClick={() => void removeFile(f)}
                      className={cn(
                        confirmDelete !== k && 'opacity-0 group-hover/file:opacity-100 focus-visible:opacity-100'
                      )}
                    >
                      {confirmDelete === k ? t('Confirm') : <Trash2 className="size-3.5" />}
                    </Button>
                  )}
                </div>
                {expanded && (
                  <dl className="mx-3 mb-2.5 grid animate-veil-in grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg bg-hover px-3 py-2 text-[11px]">
                    <dt className="text-ink-muted">{t('Source')}</dt>
                    <dd className="text-ink capitalize">{f.source}</dd>
                    <dt className="text-ink-muted">{t('Type')}</dt>
                    <dd className="truncate text-ink">{f.mimeType ?? f.kind}</dd>
                    {f.path && (
                      <>
                        <dt className="text-ink-muted">{t('Path')}</dt>
                        <dd className="truncate font-mono text-ink" title={f.path}>
                          {f.path}
                        </dd>
                      </>
                    )}
                    <InlineFilePreview key={JSON.stringify([accountId, f.id, f.path])} accountId={accountId} file={f} />
                  </dl>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}
