/** One image viewer for chat attachments and markdown images, plus the round button laid over a thumbnail. */
import { copyImageSrc } from '@/lib/goxfCopyImage'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronLeft, ChevronRight, Copy, Download, X, ZoomIn, ZoomOut } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'

/** Dark round button over an image thumbnail (shown on hover). */
export function ImageOverlayButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <IconButton
      size="sm"
      label={label}
      onClick={onClick}
      className="pointer-events-auto bg-overlay text-on-overlay backdrop-blur-sm hover:bg-overlay-strong hover:text-on-overlay"
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
  const [copiedImg, setCopiedImg] = useState<false | 'ok' | 'fail'>(false)
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
    // GOXF: read via main (presigned links have no CORS) and say when it fails.
    const ok = await copyImageSrc(current.src)
    setCopiedImg(ok ? 'ok' : 'fail')
    setTimeout(() => setCopiedImg(false), 1600)
  }

  // Portal: markdown images sit inside <p>, and a transformed ancestor would break `fixed`.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-overlay-strong p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={current.alt}
      onClick={onClose}
    >
      <div
        className="mb-3 flex w-full max-w-4xl items-center justify-between gap-3 text-on-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="truncate text-[13px] font-medium text-on-overlay">
          {current.filename}
          {count > 1 && <span className="ml-2 tabular-nums text-on-overlay-muted">{index + 1} / {count}</span>}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <IconButton
            label="缩小"
            shortcut="-"
            onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
            className="bg-on-overlay/15 text-on-overlay hover:bg-on-overlay/25 hover:text-on-overlay"
          >
            <ZoomOut />
          </IconButton>
          <Button
            size="sm"
            onClick={() => setZoom(1)}
            title="重置缩放 (0)"
            className="tabular-nums bg-on-overlay/15 text-on-overlay hover:bg-on-overlay/25 hover:text-on-overlay"
          >
            {Math.round(zoom * 100)}%
          </Button>
          <IconButton
            label="放大"
            shortcut="+"
            onClick={() => setZoom((z) => Math.min(3, Number((z + 0.25).toFixed(2))))}
            className="bg-on-overlay/15 text-on-overlay hover:bg-on-overlay/25 hover:text-on-overlay"
          >
            <ZoomIn />
          </IconButton>
          <Button size="sm" onClick={() => void copyImageToClipboard()} className="bg-on-overlay/15 text-on-overlay hover:bg-on-overlay/25 hover:text-on-overlay">
            {copiedImg === 'ok' ? <Check className="text-status-online" /> : <Copy />}
            {copiedImg === 'ok' ? '已复制' : copiedImg === 'fail' ? '复制失败' : '复制图片'}
          </Button>
          <Button size="sm" onClick={save} className="bg-on-overlay/15 text-on-overlay hover:bg-on-overlay/25 hover:text-on-overlay">
            <Download /> 保存图片
          </Button>
          <IconButton label="关闭预览" onClick={onClose} className="bg-on-overlay/15 text-on-overlay hover:bg-on-overlay/25 hover:text-on-overlay">
            <X />
          </IconButton>
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
          <IconButton
            label="上一张"
            shortcut="←"
            onClick={(e) => {
              e.stopPropagation()
              go(-1)
            }}
            className="absolute top-1/2 left-4 size-11 -translate-y-1/2 [&_svg]:size-6 bg-on-overlay/15 text-on-overlay hover:bg-on-overlay/25 hover:text-on-overlay"
          >
            <ChevronLeft />
          </IconButton>
          <IconButton
            label="下一张"
            shortcut="→"
            onClick={(e) => {
              e.stopPropagation()
              go(1)
            }}
            className="absolute top-1/2 right-4 size-11 -translate-y-1/2 [&_svg]:size-6 bg-on-overlay/15 text-on-overlay hover:bg-on-overlay/25 hover:text-on-overlay"
          >
            <ChevronRight />
          </IconButton>
        </>
      )}
    </div>,
    document.body
  )
}
