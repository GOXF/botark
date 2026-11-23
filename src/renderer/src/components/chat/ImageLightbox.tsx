/** One image viewer for chat attachments and markdown images, plus the round button laid over a thumbnail. */
import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, Download, X, ZoomIn, ZoomOut } from 'lucide-react'
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
  const [copiedImg, setCopiedImg] = useState(false)

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(3, Number((z + 0.25).toFixed(2))))
      if (e.key === '-') setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))
      if (e.key === '0') setZoom(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const copyImageToClipboard = async () => {
    try {
      const res = await fetch(src)
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
              img.src = src
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
      aria-label={alt}
      onClick={onClose}
    >
      <div
        className="mb-3 flex w-full max-w-4xl items-center justify-between gap-3 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="truncate text-[13px] font-medium text-white/90">{filename}</span>
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
            onClick={onSave}
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
      <div className="flex max-h-[82vh] max-w-[92vw] items-center justify-center overflow-auto" onClick={(e) => e.stopPropagation()}>
        <img
          src={src}
          alt={alt}
          style={zoom !== 1 ? { transform: `scale(${zoom})`, transformOrigin: 'center center' } : undefined}
          className="max-h-[80vh] max-w-[88vw] rounded-xl object-contain shadow-dialog transition-transform duration-150"
        />
      </div>
    </div>,
    document.body
  )
}
