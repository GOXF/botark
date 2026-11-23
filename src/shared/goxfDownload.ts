/** GOXF fork: download an http(s) file to the Downloads folder with progress (streamed, not via base64 IPC). */
export const GOXF_DOWNLOAD_CHANNELS = {
  start: 'goxf:download:start',
  cancel: 'goxf:download:cancel',
  reveal: 'goxf:download:reveal',
  event: 'goxf:download:event'
} as const

export interface GoxfDownloadEvent {
  id: string
  received: number
  /** 0 when the server sent no Content-Length. */
  total: number
  state: 'progress' | 'done' | 'error' | 'cancelled'
  path?: string
  error?: string
}

export interface GoxfDownloadBridge {
  start(req: { id: string; url: string; filename?: string }): Promise<{ ok: boolean; path?: string; error?: string }>
  cancel(id: string): Promise<void>
  reveal(path: string): Promise<void>
  onEvent(listener: (event: GoxfDownloadEvent) => void): () => void
}

/** "58.3 MB / 155.6 MB" or "12 MB" when the total is unknown. */
export function formatDownloadSize(received: number, total: number): string {
  const mb = (n: number) => (n >= 100 * 1024 * 1024 ? (n / 1048576).toFixed(0) : (n / 1048576).toFixed(1)) + ' MB'
  return total > 0 ? `${mb(received)} / ${mb(total)}` : mb(received)
}

export function downloadPercent(received: number, total: number): number | null {
  return total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : null
}

/** Safe file name from an explicit name or the URL's last path segment. */
export function downloadFileName(url: string, filename?: string): string {
  let name = (filename || '').trim()
  if (!name) {
    try { name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '') } catch { name = '' }
  }
  name = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').slice(0, 180)
  return name || 'download'
}
