/** One image viewer for chat attachments and markdown images, plus the round button laid over a thumbnail. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronLeft, ChevronRight, Copy, Download, X, ZoomIn, ZoomOut } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'

/** Dark round button over an image thumbnail (shown on hover). */
export function ImageOverlayButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <IconButton
      size="sm"
      label={label}
      onClick={onClick}
      className="pointer-events-auto bg-black/55 text-white backdrop-blur-sm hover:bg-black/75 hover:text-white"
    >
      {children}
    </IconButton>
  )
}

/** Put on every chat thumbnail <img> so the lightbox can step through the conversation's images. */
export const LIGHTBOX_ATTR = 'data-lightbox'

interface GalleryItem {
  src: string
  alt: string
  filename: string
}

/** Thumbnails currently in the document, in reading order (excluding the lightbox itself). */
function collectGallery(): GalleryItem[] {
  const seen = new Set<string>()
  const out: GalleryItem[] = []
  document.querySelectorAll<HTMLImageElement>(`img[${LIGHTBOX_ATTR}]`).forEach((img) => {
    const src = img.getAttribute('src') || ''
    if (!src || seen.has(src)) return
    seen.add(src)
    out.push({ src, alt: img.alt, filename: img.getAttribute(LIGHTBOX_ATTR) || img.alt || 'image.png' })
  })
  return out
}

function downloadImage(src: string, filename: string) {
  const a = document.createElement('a')
  a.href = src
  a.download = filename
  if (/^https?:\/\//i.test(src)) {
    a.target = '_blank'
    a.rel = 'noreferrer'
  }
  a.click()
}

export function ImageLightbox({
  src,
  alt,
  filename,
  onSave,
  onClose
}: {
  src: string
  alt: string
  filename: string
  onSave: () => void
  onClose: () => void
}) {
  const [zoom, setZoom] = useState(1)
  // Fitted size at 100%; zoom resizes the box (not a transform) so the scroll area covers all sides.
  const [base, setBase] = useState<{ w: number; h: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2
    el.scrollTop = (el.scrollHeight - el.clientHeight) / 2
  }, [zoom])
  const [copiedImg, setCopiedImg] = useState(false)
  // Snapshot of the chat's images when the viewer opens; ←/→ step through them.
  const gallery = useMemo(() => {
    const items = collectGallery()
    return items.some((it) => it.src === src) ? items : [{ src, alt, filename }]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [index, setIndex] = useState(() => Math.max(0, gallery.findIndex((it) => it.src === src)))
  const current = gallery[index] ?? { src, alt, filename }
  const isInitial = current.src === src
  const count = gallery.length
  const go = (delta: number) => {
    if (count < 2) return
    setIndex((i) => (i + delta + count) % count)
    setZoom(1)
  }
  const save = () => (isInitial ? onSave() : downloadImage(current.src, current.filename))

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') go(-1)
      if (e.key === 'ArrowRight') go(1)
      if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(3, Number((z + 0.25).toFixed(2))))
      if (e.key === '-') setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))
      if (e.key === '0') setZoom(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, count])

  const copyImageToClipboard = async () => {
    try {
      const res = await fetch(current.src)
      const rawBlob = await res.blob()
      const pngBlob =
        rawBlob.type === 'image/png'
          ? rawBlob
          : await new Promise<Blob>((resolve, reject) => {
              const img = new Image()
              img.crossOrigin = 'anonymous'
              img.onload = () => {
                const canvas = document.createElement('canvas')
                canvas.width = img.naturalWidth
                canvas.height = img.naturalHeight
                const ctx = canvas.getContext('2d')
                ctx?.drawImage(img, 0, 0)
                canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png')
              }
              img.onerror = reject
              img.src = current.src
            })
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })])
      setCopiedImg(true)
      setTimeout(() => setCopiedImg(false), 1600)
    } catch {
      /* ignore if clipboard image API unavailable */
    }
  }

  // Portal: markdown images sit inside <p>, and a transformed ancestor would break `fixed`.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/82 p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={current.alt}
      onClick={onClose}
    >
      <div
        className="mb-3 flex w-full max-w-4xl items-center justify-between gap-3 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="truncate text-[13px] font-medium text-white/90">
          {current.filename}
          {count > 1 && <span className="ml-2 tabular-nums text-white/55">{index + 1} / {count}</span>}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
            title="缩小 (-)"
            className="grid size-8 place-items-center rounded-full bg-white/15 text-white hover:bg-white/25"
          >
            <ZoomOut className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            title="重置缩放 (0)"
            className="rounded-full bg-white/15 px-2.5 py-1 text-[11.5px] font-medium tabular-nums text-white hover:bg-white/25"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(3, Number((z + 0.25).toFixed(2))))}
            title="放大 (+)"
            className="grid size-8 place-items-center rounded-full bg-white/15 text-white hover:bg-white/25"
          >
            <ZoomIn className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void copyImageToClipboard()}
            className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-white/25"
          >
            {copiedImg ? <Check className="size-3.5 text-status-online" /> : <Copy className="size-3.5" />}
            {copiedImg ? '已复制' : '复制图片'}
          </button>
          <button
            type="button"
            onClick={save}
            className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-white/25"
          >
            <Download className="size-3.5" /> 保存图片
          </button>
          <button
            type="button"
            aria-label="关闭预览"
            onClick={onClose}
            className="grid size-8 place-items-center rounded-full bg-white/15 text-white hover:bg-white/25"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>
      <div ref={scrollRef} className="flex max-h-[82vh] max-w-[92vw] overflow-auto" onClick={(e) => e.stopPropagation()}>
        <img
          key={current.src}
          src={current.src}
          alt={current.alt}
          onLoad={(e) => zoom === 1 && setBase({ w: e.currentTarget.offsetWidth, h: e.currentTarget.offsetHeight })}
          style={zoom !== 1 && base ? { width: base.w * zoom, height: base.h * zoom, maxWidth: 'none', maxHeight: 'none' } : undefined}
          className="m-auto max-h-[80vh] max-w-[88vw] shrink-0 rounded-xl object-contain shadow-dialog"
        />
      </div>
      {count > 1 && (
        <>
          <button
            type="button"
            aria-label="上一张 (←)"
            title="上一张 (←)"
            onClick={(e) => {
              e.stopPropagation()
              go(-1)
            }}
            className="absolute top-1/2 left-4 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-white/15 text-white hover:bg-white/25"
          >
            <ChevronLeft className="size-6" />
          </button>
          <button
            type="button"
            aria-label="下一张 (→)"
            title="下一张 (→)"
            onClick={(e) => {
              e.stopPropagation()
              go(1)
            }}
            className="absolute top-1/2 right-4 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-white/15 text-white hover:bg-white/25"
          >
            <ChevronRight className="size-6" />
          </button>
        </>
      )}
    </div>,
    document.body
  )
}
