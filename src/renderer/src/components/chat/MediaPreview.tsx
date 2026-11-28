import { desktopCopy, useDesktopLocale } from '@/lib/desktopCopy'
import { memo, useEffect, useMemo, useState } from 'react'
import { Download, FileText, Film, FolderOpen, Image as ImageIcon, Maximize2, Music, X, ZoomIn } from 'lucide-react'
import { downloadPercent, formatDownloadSize, type GoxfDownloadEvent } from '@shared/goxfDownload'
import { Button } from '@/components/ui/Button'
import { ImageLightbox, ImageOverlayButton, LIGHTBOX_ATTR } from './ImageLightbox'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { formatBytes } from '@/lib/format'
import { t } from '@/lib/i18n'
import { useBotStore } from '@/store/botStore'
import type { ChatMediaPart, ChatMessage } from '@/types'
import type { NativeDocumentTarget } from './NativeDocumentDialog'

function isHttp(path: string): boolean {
  return /^https?:\/\//i.test(path)
}

function looksLikeImage(part: ChatMediaPart): boolean {
  if (part.kind === 'image') return true
  const mime = (part.mimeType || '').toLowerCase()
  if (mime.startsWith('image/')) return true
  if (/^data:image\//i.test(part.path || '')) return true
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp)(?:[?#].*)?$/i.test(part.path || part.name || '')
}

function looksLikeAudio(part: ChatMediaPart): boolean {
  const mime = (part.mimeType || '').toLowerCase()
  if (mime.startsWith('audio/')) return true
  if (/^data:audio\//i.test(part.path || '')) return true
  return /\.(mp3|m4a|aac|wav|ogg|oga|flac)(?:[?#].*)?$/i.test(part.path || part.name || '')
}

function looksLikeVideo(part: ChatMediaPart): boolean {
  const mime = (part.mimeType || '').toLowerCase()
  if (mime.startsWith('video/')) return true
  if (/^data:video\//i.test(part.path || '')) return true
  return /\.(mp4|m4v|webm|mov|mkv|avi)(?:[?#].*)?$/i.test(part.path || part.name || '')
}

function isHarkMedia(accountId: string | undefined, path: string): boolean {
  return (
    (Boolean(accountId) && useBotStore.getState().accounts[accountId!]?.platformId === 'hark') ||
    /^(harkatt|harkfile):\/\//i.test(path) ||
    /hark\.com|hark\.ai/i.test(path)
  )
}

function isMuseMedia(accountId: string | undefined, path: string): boolean {
  const trimmed = path.trim()
  if (!trimmed || /^data:/i.test(trimmed)) return false
  const owner = accountId ? useBotStore.getState().accounts[accountId]?.platformId : undefined
  if (owner) return owner === 'meta-muse'
  return /^\/?(?:fs\/raw\/)?workspace\//i.test(trimmed) ||
    /^https?:\/\/(?:[^/]*\.)?muse\.ai\//i.test(trimmed)
}

function isDotMedia(accountId: string | undefined, path: string): boolean {
  const trimmed = path.trim()
  if (!trimmed || /^data:/i.test(trimmed)) return false
  if (/^(CalpicoFile_|file_|libfile_|sediment:\/\/|dotfile:\/\/|dotatt:\/\/)/i.test(trimmed)) return true
  if (/^https?:\/\/(?:[^/]*\.)?chatgpt\.com\/backend-api\//i.test(trimmed)) return true
  if (accountId && useBotStore.getState().accounts[accountId]?.platformId === 'dot') return true
  return false
}

function isGrokMedia(accountId: string | undefined, path: string): boolean {
  const trimmed = path.trim()
  if (!trimmed || /^data:/i.test(trimmed)) return false
  if (/^(grokatt|grokstore):\/\//i.test(trimmed)) return true
  if (accountId && useBotStore.getState().accounts[accountId]?.platformId === 'grok') return true
  return false
}

function isCueMedia(accountId: string | undefined, path: string): boolean {
  const trimmed = path.trim()
  if (!trimmed || /^data:/i.test(trimmed)) return false
  if (/^https?:\/\/(?:[^/]*\.)?(?:cue\.im|manus\.im|manus\.ai|manuscdn\.com)\//i.test(trimmed)) {
    return true
  }
  if (accountId && useBotStore.getState().accounts[accountId]?.platformId === 'cue') return true
  return false
}

function isMuseAuthHttpUrl(path: string): boolean {
  return /^https?:\/\/(?:[^/]*\.)?muse\.ai\//i.test(path.trim())
}

function needsAuthProxyHttpUrl(path: string): boolean {
  const trimmed = path.trim()
  return (
    /^https?:\/\/(?:[^/]*\.)?muse\.ai\//i.test(trimmed) ||
    /^https?:\/\/app\.hark\.com\/api\//i.test(trimmed) ||
    /^https?:\/\/(?:[^/]*\.)?chatgpt\.com\/backend-api\//i.test(trimmed) ||
    /^https?:\/\/(?:[^/]*\.)?(?:cue\.im|api\.manus\.im|api\.manus\.ai)\//i.test(trimmed)
  )
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const bytes = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function saveDataOrUrlToDisk(src: string, filename: string, mimeType?: string): void {
  const safeName = filename || 'media'
  if (src.startsWith('data:')) {
    const comma = src.indexOf(',')
    if (comma > 0) {
      const header = src.slice(5, comma)
      const detectedMime = header.split(';')[0] || mimeType || 'application/octet-stream'
      const b64 = src.slice(comma + 1)
      const blob = new Blob([base64ToBytes(b64)], { type: detectedMime })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = safeName
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
      return
    }
  }
  const a = document.createElement('a')
  a.href = src
  a.download = safeName
  if (isHttp(src)) {
    a.target = '_blank'
    a.rel = 'noreferrer'
  }
  a.click()
}

function sniffImageMimeFromBase64(b64: string): string | undefined {
  if (b64.startsWith('iVBORw0KGgo')) return 'image/png'
  if (b64.startsWith('/9j/')) return 'image/jpeg'
  if (b64.startsWith('UklGR')) return 'image/webp'
  if (b64.startsWith('R0lGOD')) return 'image/gif'
  if (b64.startsWith('PHN2Zy') || b64.startsWith('PD94bW')) return 'image/svg+xml'
  return undefined
}

function extractWorkspaceMarkdownImages(text: string): ChatMediaPart[] {
  if (!text || !text.includes('![')) return []
  const out: ChatMediaPart[] = []
  const seen = new Set<string>()
  const re = /!\[([^\]]*)\]\(([^)]+)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const alt = m[1]?.trim() || undefined
    const raw = m[2]?.trim() || ''
    if (!raw || /^data:image\//i.test(raw)) continue
    if (/^https?:\/\//i.test(raw) && !isMuseAuthHttpUrl(raw)) continue
    if (
      !/^\/?(?:fs\/raw\/)?workspace\//i.test(raw) &&
      !isMuseAuthHttpUrl(raw) &&
      !/\.(png|jpe?g|gif|webp|svg)(?:[?#].*)?$/i.test(raw)
    ) {
      continue
    }
    const normalized = isMuseAuthHttpUrl(raw)
      ? raw
      : raw.replace(/^\/?fs\/raw\//i, '').replace(/^\/+/, '')
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push({
      kind: 'image',
      path: normalized,
      name: alt || normalized.split('/').pop()?.split('?')[0] || normalized
    })
  }
  return out
}

export function getMessageMedia({ role, media, text, attachments }: ChatMessage): ChatMediaPart[] {
  // GOXF: a user message shows Hark's copy of its pictures only when the local attachments are gone (history reload).
  if (role === 'user') return attachments?.length ? [] : media ?? []
  const parts = media ?? []
  const inlineImages = extractWorkspaceMarkdownImages(text)
  if (inlineImages.length === 0) return parts
  return [
    ...parts,
    ...inlineImages.filter((image) => !parts.some((part) => part.path === image.path))
  ]
}

async function downloadHarkMedia(accountId: string, part: ChatMediaPart) {
  const bridge = getBridge()?.hark
  if (!bridge?.rpc) throw new Error('Hark download unavailable')
  const cleanRef = part.path.trim().replace(/^(harkatt|harkfile):\/\//i, '')
  const result = await bridge.rpc({
    accountId,
    op: 'downloadArtifact',
    url: /^https?:\/\//i.test(cleanRef) ? cleanRef : undefined,
    fileId: !/^https?:\/\//i.test(cleanRef) ? cleanRef : undefined,
    name: part.name
  })
  if (!result.ok) throw new Error(result.message || `Hark download failed (${result.status})`)
  if (!result.data || typeof result.data !== 'object') throw new Error('Hark download returned no data')
  return result.data as { dataBase64: string; mimeType: string; filename?: string }
}

async function downloadDotMedia(accountId: string, part: ChatMediaPart) {
  const bridge = getBridge()?.dot
  if (!bridge?.rpc) throw new Error('Dot download unavailable')
  const rawPath = part.path.trim()
  const isHttpUrl = /^https?:\/\//i.test(rawPath)
  const result = await bridge.rpc({
    accountId,
    op: 'downloadFile',
    url: isHttpUrl ? rawPath : undefined,
    fileId: !isHttpUrl ? rawPath.replace(/^(sediment|dotfile|dotatt):\/\//i, '') : undefined,
    name: part.name
  })
  if (!result.ok) throw new Error(result.message || `Dot download failed (${result.status})`)
  if (!result.data || typeof result.data !== 'object') throw new Error('Dot download returned no data')
  const d = result.data as { dataBase64: string; mimeType: string; filename?: string; name?: string }
  return { dataBase64: d.dataBase64, mimeType: d.mimeType, filename: d.filename || d.name }
}

async function downloadGrokMedia(accountId: string, part: ChatMediaPart) {
  const grok = getBridge()?.grok
  if (!grok?.rpc) throw new Error('Grok download unavailable')
  const storeState = useBotStore.getState()
  const ownerBot =
    storeState.bots.find(
      (b) => b.platformId === 'grok' && b.accountIds.includes(accountId) && b.selectedAgentId
    ) ?? storeState.bots.find((b) => b.accountIds.includes(accountId))
  const dl = await grok.rpc({
    accountId,
    op: 'downloadAttachment',
    agentId: ownerBot?.selectedAgentId,
    path: part.path,
    name: part.name
  })
  if (!dl.ok || !dl.data || typeof dl.data !== 'object') {
    throw new Error(dl.ok ? 'Grok download returned no data' : dl.message || 'Grok download failed')
  }
  const d = dl.data as { dataBase64: string; mimeType: string; filename?: string }
  if (!d.dataBase64) throw new Error('Grok download returned empty data')
  return d
}

async function downloadCueMedia(accountId: string, part: ChatMediaPart) {
  const bridge = getBridge()?.cue
  if (!bridge?.rpc) throw new Error('Cue download unavailable')
  const dl = await bridge.rpc({
    accountId,
    op: 'downloadMedia',
    url: part.path,
    name: part.name
  })
  if (!dl.ok || !dl.data || typeof dl.data !== 'object') {
    throw new Error(!dl.ok ? dl.message : 'Cue media download failed')
  }
  const d = dl.data as { dataBase64?: string; mimeType?: string; filename?: string }
  if (!d.dataBase64) throw new Error('Empty Cue media payload')
  return {
    dataBase64: d.dataBase64,
    mimeType: d.mimeType || part.mimeType || 'application/octet-stream',
    filename: d.filename || part.name
  }
}

async function fetchPlatformMediaBytes(
  accountId: string,
  part: ChatMediaPart
): Promise<{ dataBase64: string; mimeType: string; filename?: string } | null> {
  const rawPath = (part.path || '').trim()
  if (rawPath.startsWith('data:')) {
    const comma = rawPath.indexOf(',')
    if (comma > 0) {
      const mime = rawPath.slice(5, comma).split(';')[0] || part.mimeType || 'application/octet-stream'
      return { dataBase64: rawPath.slice(comma + 1), mimeType: mime, filename: part.name }
    }
  }
  if (isMuseMedia(accountId, rawPath)) {
    const muse = getBridge()?.muse
    if (muse?.previewWorkspaceFile) {
      const preview = await muse.previewWorkspaceFile(accountId, rawPath)
      return { dataBase64: preview.dataBase64, mimeType: preview.mimeType, filename: part.name }
    }
  }
  if (isHarkMedia(accountId, rawPath)) {
    return downloadHarkMedia(accountId, part)
  }
  if (isDotMedia(accountId, rawPath)) {
    return downloadDotMedia(accountId, part)
  }
  if (isGrokMedia(accountId, rawPath)) {
    return downloadGrokMedia(accountId, part)
  }
  if (isCueMedia(accountId, rawPath)) {
    return downloadCueMedia(accountId, part)
  }
  return null
}


/** GOXF: several pictures share one row at an equal height, each as wide as its shape allows; a very wide shot fits whole on a tint. */
const TILE_H = 130
function tileWidth(aspect?: number): number {
  return aspect ? Math.round(Math.max(90, Math.min(280, aspect * TILE_H))) : TILE_H
}
function tileImgClass(aspect?: number): string {
  return aspect && aspect > 2.2 ? 'max-h-full max-w-full object-contain' : 'size-full object-cover'
}

export function WorkspaceImage({
  part,
  accountId,
  mine,
  tile
}: {
  part: ChatMediaPart
  accountId?: string
  /** User's own picture: same size cap as a local attachment. */
  mine?: boolean
  /** One of several pictures: an equal-height tile, clickable anywhere. */
  tile?: boolean
}) {
  useDesktopLocale()
  const initialDirectSrc =
    /^data:image\//i.test(part.path) || (isHttp(part.path) && !needsAuthProxyHttpUrl(part.path))
      ? part.path
      : null
  const [src, setSrc] = useState<string | null>(initialDirectSrc)
  const [failed, setFailed] = useState(false)
  const [triedProxy, setTriedProxy] = useState(false)
  const [retryNonce, setRetryNonce] = useState(0)
  const [lightboxOpen, setLightboxOpen] = useState(false)

  useEffect(() => {
    const nextDirect =
      /^data:image\//i.test(part.path) || (isHttp(part.path) && !needsAuthProxyHttpUrl(part.path))
        ? part.path
        : null
    setSrc(nextDirect)
    setFailed(false)
    setTriedProxy(false)
  }, [part.path])

  useEffect(() => {
    if (src || failed || !accountId) return
    let cancelled = false
    void (async () => {
      try {
        const fetched = await fetchPlatformMediaBytes(accountId, part)
        if (cancelled) return
        if (!fetched?.dataBase64) {
          setFailed(true)
          return
        }
        const mime =
          (fetched.mimeType && fetched.mimeType.toLowerCase().startsWith('image/')
            ? fetched.mimeType
            : undefined) ||
          sniffImageMimeFromBase64(fetched.dataBase64) ||
          (part.mimeType?.toLowerCase().startsWith('image/') ? part.mimeType : undefined) ||
          (looksLikeImage(part) ? 'image/png' : '')
        if (!mime) {
          setFailed(true)
          return
        }
        setSrc(`data:${mime};base64,${fetched.dataBase64}`)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [accountId, part, src, failed, retryNonce])

  const [fitWidth, setFitWidth] = useState<number | null>(null)
  const [aspect, setAspect] = useState<number>()
  const filename = part.name || (!isHttp(part.path) ? part.path.split('/').pop() : undefined) || 'image.png'

  if (src) {
    return (
      <>
        <div className="group/img relative bg-sunken/30">
          <button
            type="button"
            onClick={() => setLightboxOpen(true)}
            className={tile ? 'flex cursor-zoom-in items-center justify-center' : 'block w-full cursor-zoom-in text-left'}
            style={tile ? { width: tileWidth(aspect), height: TILE_H } : undefined}
            title={desktopCopy("点击放大查看", "Click to zoom in")}
          >
            <img
              src={src}
              alt={part.name || part.path}
              {...{ [LIGHTBOX_ATTR]: filename }}
              className={tile ? tileImgClass(aspect) : cn(mine ? 'max-h-56 max-w-64' : 'max-h-72 max-w-full', 'mx-auto block object-contain')}
              // Give the image its scaled width up front, so a fit-content card hugs it
              // instead of reserving the natural width (blank strip beside wide-ish shots).
              style={!tile && fitWidth ? { width: fitWidth } : undefined}
              onLoad={(e) => {
                const { naturalWidth: w, naturalHeight: h } = e.currentTarget
                if (w && h) setFitWidth(Math.round(Math.min(w, (w * (mine ? 224 : 288)) / h)))
                if (w && h) setAspect(w / h)
              }}
              onError={() => {
                if (isHttp(src) && !triedProxy && accountId) {
                  setTriedProxy(true)
                  setSrc(null)
                } else {
                  setSrc(null)
                  setFailed(true)
                }
              }}
            />
          </button>
          <div className="pointer-events-none absolute top-2 right-2 flex items-center gap-1 opacity-0 transition-opacity group-hover/img:opacity-100">
            <ImageOverlayButton label={desktopCopy("放大查看", "Zoom In")} onClick={() => setLightboxOpen(true)}>
              <ZoomIn />
            </ImageOverlayButton>
            <ImageOverlayButton label={desktopCopy("保存图片", "Save Picture")} onClick={() => saveDataOrUrlToDisk(src, filename, part.mimeType)}>
              <Download />
            </ImageOverlayButton>
          </div>
        </div>
        {lightboxOpen && (
          <ImageLightbox
            src={src}
            alt={part.name || part.path}
            filename={filename}
            onSave={() => saveDataOrUrlToDisk(src, filename, part.mimeType)}
            onClose={() => setLightboxOpen(false)}
          />
        )}
      </>
    )
  }
  return (
    <div className="flex items-center gap-2 px-2.5 py-2 text-[12px]">
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent-50 text-accent-600">
        <ImageIcon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block max-w-56 truncate font-medium text-ink">{part.name || part.path}</span>
        <span className="block truncate text-caption text-ink-muted" title={part.path}>
          {failed ? t('Preview unavailable') : t('Loading preview…')}
        </span>
      </span>
      {failed && accountId && (
        <button
          type="button"
          onClick={() => {
            setFailed(false)
            setTriedProxy(false)
            setRetryNonce((n) => n + 1)
          }}
          className="shrink-0 rounded-full bg-hover px-2 py-0.5 text-[11px] font-medium text-accent-600 hover:bg-active"
        >{desktopCopy("重试", "Try again")}</button>
      )}
    </div>
  )
}

function WorkspaceAV({
  part,
  accountId,
  kind
}: {
  part: ChatMediaPart
  accountId?: string
  kind: 'audio' | 'video'
}) {
  useDesktopLocale()
  const { path, name, mimeType, imageId, kind: mediaKind } = part
  const directSrc = /^data:(?:audio|video)\//i.test(path) || (isHttp(path) && !needsAuthProxyHttpUrl(path)) ? path : null
  const [retryNonce, setRetryNonce] = useState(0)
  const source = useMemo(() => ({
    accountId, part: { path, name, mimeType, imageId, kind: mediaKind }, kind, retryNonce
  }), [accountId, path, name, mimeType, imageId, mediaKind, kind, retryNonce])
  const [proxySrc, setProxySrc] = useState<{ source: typeof source; url: string }>()
  const [failedSource, setFailedSource] = useState<typeof source>()
  const [proxySource, setProxySource] = useState<typeof source>()
  const useProxy = !directSrc || proxySource === source
  const failed = failedSource === source || (useProxy && !accountId)
  const src = failed ? null : useProxy
    ? (proxySrc?.source === source ? proxySrc.url : null)
    : directSrc

  useEffect(() => {
    const { accountId: owner, part: media, kind: mediaType } = source
    if (!useProxy || !owner) return
    let cancelled = false
    let objectUrl: string | null = null
    void (async () => {
      try {
        const fetched = await fetchPlatformMediaBytes(owner, media)
        if (cancelled) return
        if (!fetched?.dataBase64) {
          setFailedSource(source)
          return
        }
        const mt = (fetched.mimeType || media.mimeType || '').toLowerCase()
        const fallbackMime = mediaType === 'audio' ? 'audio/mpeg' : 'video/mp4'
        const effectiveMime = mt.startsWith(`${mediaType}/`) ? mt : fallbackMime
        const blob = new Blob([base64ToBytes(fetched.dataBase64)], { type: effectiveMime })
        objectUrl = URL.createObjectURL(blob)
        setProxySrc({ source, url: objectUrl })
      } catch {
        if (!cancelled) setFailedSource(source)
      }
    })()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [source, useProxy])

  const filename =
    part.name ||
    (!isHttp(part.path) ? part.path.split('/').pop() : undefined) ||
    (kind === 'audio' ? 'audio.mp3' : 'video.mp4')

  const handleMediaError = () => {
    if (src && isHttp(src) && !useProxy && accountId) {
      setProxySource(source)
    } else {
      setFailedSource(source)
    }
  }

  if (src) {
    return (
      <div className="px-2.5 py-2">
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5 text-[12px] font-medium text-ink">
            {kind === 'video' ? (
              <Film className="size-3.5 shrink-0 text-accent-600" aria-hidden />
            ) : (
              <Music className="size-3.5 shrink-0 text-accent-600" aria-hidden />
            )}
            <span className="max-w-56 truncate">{filename}</span>
          </span>
          <button
            type="button"
            onClick={() => saveDataOrUrlToDisk(src, filename, part.mimeType)}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-hover px-2 py-0.5 text-[11px] font-medium text-ink-secondary hover:bg-active hover:text-ink"
            title={desktopCopy("下载保存", "Save download")}
          >
            <Download className="size-3" />{desktopCopy(" 保存", " Save")}</button>
        </div>
        {kind === 'audio' ? (
          <audio controls preload="metadata" src={src} onError={handleMediaError} className="w-full max-w-md" />
        ) : (
          <video
            controls
            playsInline
            preload="metadata"
            src={src}
            onError={handleMediaError}
            className="max-h-72 w-full max-w-md rounded-lg bg-black"
          />
        )}
      </div>
    )
  }
  return (
    <div className="flex items-center gap-2 px-2.5 py-2 text-[12px]">
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent-50 text-accent-600">
        {kind === 'video' ? <Film className="size-4" aria-hidden /> : <Music className="size-4" aria-hidden />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block max-w-56 truncate font-medium text-ink">{filename}</span>
        <span className="block truncate text-caption text-ink-muted" title={part.path}>
          {failed ? t('Preview unavailable') : t('Loading preview…')}
        </span>
      </span>
      {failed && accountId && (
        <button
          type="button"
          onClick={() => setRetryNonce((n) => n + 1)}
          className="shrink-0 rounded-full bg-hover px-2 py-0.5 text-[11px] font-medium text-accent-600 hover:bg-active"
        >{desktopCopy("重试", "Try again")}</button>
      )}
    </div>
  )
}

export const MediaPreview = memo(function MediaPreview({
  parts,
  accountId,
  onOpenDoc,
  mine
}: {
  parts: ChatMediaPart[]
  accountId?: string
  onOpenDoc?: (target: NativeDocumentTarget) => void
  mine?: boolean
}) {
  useDesktopLocale()
  const [downloadingKey, setDownloadingKey] = useState<string | null>(null)
  const [downloadError, setDownloadError] = useState<string | null>(null)
  // GOXF: http(s) files stream to Downloads in main with progress + size, instead of base64 over IPC.
  const [progress, setProgress] = useState<Record<string, GoxfDownloadEvent>>({})
  const downloads = getBridge()?.goxfDownloads
  useEffect(() => downloads?.onEvent((e) => setProgress((prev) => (e.id in prev ? { ...prev, [e.id]: e } : prev))), [downloads])
  if (!parts.length) return null

  const handleDirectDownload = async (part: ChatMediaPart) => {
    const key = part.path || part.name || ''
    const rawUrl = (part.path || '').trim()
    if (downloads && /^https?:\/\//i.test(rawUrl)) {
      setDownloadError(null)
      setProgress((prev) => ({ ...prev, [key]: { id: key, received: 0, total: 0, state: 'progress' } }))
      const res = await downloads.start({ id: key, url: rawUrl, filename: part.name })
      if (!res.ok && res.error !== 'cancelled') setDownloadError(res.error || 'Download failed')
      return
    }
    if (!accountId) return
    setDownloadingKey(key)
    setDownloadError(null)
    try {
      const rawPath = (part.path || '').trim()
      const isHttpUrl = /^https?:\/\//i.test(rawPath)
      const fetched = await fetchPlatformMediaBytes(accountId, part)

      const dataBase64 = fetched?.dataBase64 || ''
      const mimeType = fetched?.mimeType || part.mimeType || 'application/octet-stream'
      const filename =
        fetched?.filename ||
        part.name ||
        (!isHttpUrl && !rawPath.startsWith('data:') ? rawPath.split('/').pop() : undefined) ||
        'attachment'

      if (dataBase64) {
        const blob = new Blob([base64ToBytes(dataBase64)], { type: mimeType })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = filename
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 2000)
      } else if (isHttpUrl) {
        window.open(rawPath, '_blank', 'noopener,noreferrer')
      } else {
        throw new Error('Download unavailable')
      }
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : String(error))
    } finally {
      setDownloadingKey(null)
    }
  }

  const allImages = parts.length >= 2 && parts.every((p) => looksLikeImage(p))

  return (
    <>
      <ul
        className={cn(
          'mb-1.5 max-w-[78%] gap-1.5',
          allImages ? cn('flex flex-wrap', mine && 'justify-end') : 'flex flex-col'
        )}
        aria-label={t('Media')}
      >
      {parts.map((part) => {
        const isHttpUrl = isHttp(part.path)
        const subtitle = isHttpUrl
          ? part.mimeType || desktopCopy("可预览 / 下载文件", "Files you can preview or download")
          : part.path
        const key = part.path || part.name || 'part'
        return (
          <li
            key={key}
            className={cn(
              'overflow-hidden rounded-xl border border-line bg-surface shadow-soft',
              // A lone image hugs its own width instead of stretching the card (blank strip on the right).
              !allImages && looksLikeImage(part) && 'w-fit max-w-full self-start'
            )}
          >
            {looksLikeImage(part) ? (
              <WorkspaceImage part={part} accountId={accountId} mine={mine} tile={allImages} />
            ) : looksLikeAudio(part) ? (
              <WorkspaceAV part={part} accountId={accountId} kind="audio" />
            ) : looksLikeVideo(part) ? (
              <WorkspaceAV part={part} accountId={accountId} kind="video" />
            ) : (
              <div className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12px]">
                <button
                  type="button"
                  onClick={() => {
                    if (accountId && onOpenDoc) {
                      onOpenDoc({
                        accountId,
                        title: part.name || (!isHttpUrl ? part.path.split('/').pop() : undefined) || 'Document',
                        path: part.path,
                        mimeType: part.mimeType
                      })
                    }
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left hover:opacity-85"
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-accent-50 text-accent-600">
                    <FileText className="size-4" aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <span className="block max-w-56 truncate font-medium text-ink">
                      {part.name || part.path}
                    </span>
                    {(() => {
                      const p = progress[key]
                      if (!p) return (
                        <span className="block truncate text-caption text-ink-muted" title={subtitle}>
                          {subtitle}
                        </span>
                      )
                      const pct = downloadPercent(p.received, p.total)
                      const label = p.state === 'done' ? `已下载 · ${formatDownloadSize(p.total || p.received, 0)}`
                        : p.state === 'error' ? `下载失败 · ${p.error ?? ''}`
                        : p.state === 'cancelled' ? '已取消'
                        : `${pct === null ? '' : pct + '% · '}${formatDownloadSize(p.received, p.total)}`
                      return (
                        <span className="block min-w-48">
                          <span className="block truncate text-caption tabular-nums text-ink-muted" role="status">{label}</span>
                          {p.state === 'progress' && (
                            <span className="mt-1 block h-1 overflow-hidden rounded-full bg-sunken">
                              <span className={cn('block h-full rounded-full bg-accent-500 transition-[width]', pct === null && 'w-1/3 animate-pulse')}
                                style={pct === null ? undefined : { width: `${pct}%` }} />
                            </span>
                          )}
                        </span>
                      )
                    })()}
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      if (accountId && onOpenDoc) {
                        onOpenDoc({
                          accountId,
                          title: part.name || (!isHttpUrl ? part.path.split('/').pop() : undefined) || 'Document',
                          path: part.path,
                          mimeType: part.mimeType
                        })
                      }
                    }}
                    className="text-accent-600"
                  >
                    <Maximize2 /> {desktopCopy("预览", "Preview")}
                  </Button>
                  {progress[key]?.state === 'progress' ? (
                    <Button size="sm" variant="secondary" onClick={() => void downloads?.cancel(key)}>
                      <X /> 取消
                    </Button>
                  ) : progress[key]?.state === 'done' && progress[key]?.path ? (
                    <Button size="sm" variant="secondary" onClick={() => void downloads?.reveal(progress[key]!.path!)}>
                      <FolderOpen /> 打开文件夹
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={downloadingKey === key}
                      onClick={() => void handleDirectDownload(part)}
                    >
                      <Download /> {downloadingKey === key ? desktopCopy("下载中…", "Downloading…") : desktopCopy("下载", "Download")}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </li>
        )
      })}
      </ul>
      {downloadError && <p className="mb-1.5 text-[12px] text-status-error-ink">{downloadError}</p>}
    </>
  )
})

/** GOXF fork name, used by group chat (RoomView). */
export const MediaParts = MediaPreview

export const UserAttachmentItem = memo(function UserAttachmentItem({
  file,
  tile
}: {
  file: NonNullable<ChatMessage['attachments']>[number]
  /** One of several pictures: an equal-height tile, clickable anywhere. */
  tile?: boolean
}) {
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [aspect, setAspect] = useState<number>()
  const [avUrl, setAvUrl] = useState<string | null>(null)
  const isImage = file.mimeType.startsWith('image/') && Boolean(file.dataBase64)
  const isVideo = file.mimeType.startsWith('video/') && Boolean(file.dataBase64)
  const isAudio = file.mimeType.startsWith('audio/') && Boolean(file.dataBase64)

  useEffect(() => {
    if ((!isVideo && !isAudio) || !file.dataBase64) {
      setAvUrl(null)
      return
    }
    const blob = new Blob([base64ToBytes(file.dataBase64)], { type: file.mimeType })
    const url = URL.createObjectURL(blob)
    setAvUrl(url)
    return () => {
      URL.revokeObjectURL(url)
    }
  }, [file.dataBase64, file.mimeType, isVideo, isAudio])

  if (isImage && file.dataBase64) {
    const dataSrc = `data:${file.mimeType};base64,${file.dataBase64}`
    return (
      <>
        <li className="overflow-hidden rounded-xl border border-line bg-surface shadow-soft">
          <button
            type="button"
            onClick={() => setLightboxOpen(true)}
            className={tile ? 'flex cursor-zoom-in items-center justify-center bg-sunken/30' : 'block cursor-zoom-in'}
            style={tile ? { width: tileWidth(aspect), height: TILE_H } : undefined}
            title={file.name}
          >
            <img src={dataSrc} alt={file.name} {...{ [LIGHTBOX_ATTR]: file.name }}
              className={tile ? tileImgClass(aspect) : 'max-h-56 max-w-64 object-contain'}
              onLoad={(e) => {
                const { naturalWidth: w, naturalHeight: h } = e.currentTarget
                if (w && h) setAspect(w / h)
              }} />
          </button>
        </li>
        {lightboxOpen && (
          <ImageLightbox
            src={dataSrc}
            alt={file.name}
            filename={file.name}
            onSave={() => saveDataOrUrlToDisk(dataSrc, file.name)}
            onClose={() => setLightboxOpen(false)}
          />
        )}
      </>
    )
  }

  if ((isVideo || isAudio) && avUrl) {
    return (
      <li className="overflow-hidden rounded-xl border border-line bg-surface px-2.5 py-2 shadow-soft">
        <p className="mb-1 max-w-56 truncate text-[12px] font-medium text-ink">{file.name}</p>
        {isVideo ? (
          <video controls playsInline preload="metadata" src={avUrl} className="max-h-56 w-full max-w-sm rounded-lg bg-black" />
        ) : (
          <audio controls preload="metadata" src={avUrl} className="w-64 max-w-full" />
        )}
      </li>
    )
  }

  return (
    <li className="flex items-center gap-2 rounded-xl border border-line bg-surface py-1.5 pr-3 pl-2 shadow-soft">
      <span className="grid size-7 place-items-center rounded-lg bg-accent-50 text-accent-600">
        {file.mimeType.startsWith('image/') ? (
          <ImageIcon className="size-4" aria-hidden />
        ) : file.mimeType.startsWith('video/') ? (
          <Film className="size-4" aria-hidden />
        ) : file.mimeType.startsWith('audio/') ? (
          <Music className="size-4" aria-hidden />
        ) : (
          <FileText className="size-4" aria-hidden />
        )}
      </span>
      <span className="min-w-0">
        <span className="block max-w-48 truncate text-ui font-medium">{file.name}</span>
        <span className="block text-caption text-ink-muted">{formatBytes(file.size)}</span>
      </span>
    </li>
  )
})
