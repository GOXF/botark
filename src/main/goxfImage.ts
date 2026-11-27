import { ipcMain, net } from 'electron'
import { GOXF_IMAGE_CHANNELS, type GoxfImageFetchResult } from '@shared/goxfImage'

const MAX_BYTES = 40 * 1024 * 1024

/**
 * GOXF: chat images are often presigned S3 links that <img> shows fine but the
 * renderer cannot fetch (no CORS), so "复制图片" failed silently. Main fetches
 * them instead; the renderer re-encodes to PNG and writes the clipboard.
 */
export function registerImageIpc(): void {
  ipcMain.handle(GOXF_IMAGE_CHANNELS.fetch, async (_event, url: unknown): Promise<GoxfImageFetchResult> => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok: false, error: 'Only http(s) images' }
    try {
      const res = await net.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20_000) })
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
      const buf = new Uint8Array(await res.arrayBuffer())
      if (buf.byteLength > MAX_BYTES) return { ok: false, error: 'Image too large' }
      return { ok: true, bytes: buf, type: res.headers.get('content-type') ?? '' }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
