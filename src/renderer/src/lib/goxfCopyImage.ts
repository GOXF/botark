import { getBridge } from '@/lib/bridge'

/** Clipboard only takes PNG: re-encode other image types through a canvas. */
async function toPng(blob: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bmp.width
  canvas.height = bmp.height
  canvas.getContext('2d')!.drawImage(bmp, 0, 0)
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/png'))
}

async function readImage(src: string): Promise<Blob> {
  // Remote images (presigned S3 etc.) have no CORS for the app: read them in main.
  const viaMain = getBridge()?.goxfImage
  if (/^https?:\/\//i.test(src) && viaMain) {
    const res = await viaMain.fetch(src)
    if (res.ok) return new Blob([res.bytes as BlobPart], { type: res.type })
  }
  return (await fetch(src)).blob()
}

/** GOXF: copy an image (http, blob: or data: src) to the clipboard as PNG. Resolves false on failure. */
export async function copyImageSrc(src: string): Promise<boolean> {
  try {
    const blob = await readImage(src)
    const png = blob.type === 'image/png' ? blob : await toPng(blob)
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    return true
  } catch {
    return false
  }
}
