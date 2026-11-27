/** GOXF fork: read an image's bytes in the main process (no CORS), for copying it to the clipboard. */
export const GOXF_IMAGE_CHANNELS = {
  fetch: 'goxf:image:fetch'
} as const

export type GoxfImageFetchResult = { ok: true; bytes: Uint8Array; type: string } | { ok: false; error: string }

export interface GoxfImageBridge {
  fetch(url: string): Promise<GoxfImageFetchResult>
}
