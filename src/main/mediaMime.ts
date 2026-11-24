/**
 * Cross-platform media MIME sniffing (magic bytes + filename extension fallback).
 * Ensures images, videos, and audio served as `application/octet-stream` still
 * preview and play natively across Muse, Hark, Dot, Grok, and Hermes.
 */

export function sniffMediaMimeFromBytes(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.byteLength >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return 'image/gif'
  }
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  ) {
    if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
      return 'image/webp'
    }
    if (bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45) {
      return 'audio/wav'
    }
    if (bytes[8] === 0x41 && bytes[9] === 0x56 && bytes[10] === 0x49 && bytes[11] === 0x20) {
      return 'video/x-msvideo'
    }
  }
  // ISO Base Media File Format (`ftyp` box): MP4 / QuickTime MOV / M4A / AVIF
  if (
    bytes.byteLength >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!).toLowerCase()
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
    if (brand === 'm4a ' || brand === 'm4b ') return 'audio/mp4'
    if (brand === 'qt  ') return 'video/quicktime'
    return 'video/mp4'
  }
  // EBML header: WebM / Matroska
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(64, bytes.byteLength))).toLowerCase()
    return head.includes('webm') ? 'video/webm' : 'video/x-matroska'
  }
  // Ogg container
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x4f &&
    bytes[1] === 0x67 &&
    bytes[2] === 0x67 &&
    bytes[3] === 0x53
  ) {
    return 'audio/ogg'
  }
  // FLAC
  if (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x66 &&
    bytes[1] === 0x4c &&
    bytes[2] === 0x61 &&
    bytes[3] === 0x43
  ) {
    return 'audio/flac'
  }
  // AAC ADTS uses a 12-bit sync word followed by a zero layer field.
  if (
    bytes.byteLength >= 7 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0 &&
    ((bytes[2]! >> 2) & 0x0f) <= 12
  ) {
    return 'audio/aac'
  }
  // MP3 (ID3 tag or MPEG sync frame)
  if (
    (bytes.byteLength >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
    (bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
  ) {
    return 'audio/mpeg'
  }
  // PDF
  if (
    bytes.byteLength >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return 'application/pdf'
  }
  // SVG text head
  if (bytes.byteLength >= 5) {
    const head = new TextDecoder().decode(bytes.subarray(0, Math.min(256, bytes.byteLength))).trimStart()
    if (/^(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(head)) {
      return 'image/svg+xml'
    }
  }
  return undefined
}

export function guessMediaMimeFromName(nameOrPath?: string): string | undefined {
  if (!nameOrPath) return undefined
  const clean = nameOrPath.split(/[?#]/, 1)[0]?.toLowerCase() ?? ''
  if (clean.endsWith('.png')) return 'image/png'
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg'
  if (clean.endsWith('.gif')) return 'image/gif'
  if (clean.endsWith('.webp')) return 'image/webp'
  if (clean.endsWith('.svg')) return 'image/svg+xml'
  if (clean.endsWith('.avif')) return 'image/avif'
  if (clean.endsWith('.bmp')) return 'image/bmp'
  if (clean.endsWith('.mp4') || clean.endsWith('.m4v')) return 'video/mp4'
  if (clean.endsWith('.webm')) return 'video/webm'
  if (clean.endsWith('.mov')) return 'video/quicktime'
  if (clean.endsWith('.mkv')) return 'video/x-matroska'
  if (clean.endsWith('.avi')) return 'video/x-msvideo'
  if (clean.endsWith('.mp3')) return 'audio/mpeg'
  if (clean.endsWith('.m4a')) return 'audio/mp4'
  if (clean.endsWith('.aac')) return 'audio/aac'
  if (clean.endsWith('.wav')) return 'audio/wav'
  if (clean.endsWith('.ogg') || clean.endsWith('.oga')) return 'audio/ogg'
  if (clean.endsWith('.flac')) return 'audio/flac'
  if (clean.endsWith('.pdf')) return 'application/pdf'
  if (clean.endsWith('.html') || clean.endsWith('.htm')) return 'text/html'
  if (clean.endsWith('.md') || clean.endsWith('.markdown')) return 'text/markdown'
  if (clean.endsWith('.json')) return 'application/json'
  if (clean.endsWith('.csv') || clean.endsWith('.tsv')) return 'text/csv'
  return undefined
}

export function inferMediaMime(opts: {
  headerMime?: string
  nameOrPath?: string
  bytes?: Uint8Array
  fallback?: string
}): string {
  const raw = opts.headerMime?.split(';')[0]?.trim().toLowerCase()
  const isGeneric =
    !raw ||
    raw === 'application/octet-stream' ||
    raw === 'binary/octet-stream' ||
    raw === 'application/binary'
  if (!isGeneric) return raw
  const sniffed = opts.bytes ? sniffMediaMimeFromBytes(opts.bytes) : undefined
  if (sniffed) return sniffed
  const guessed = guessMediaMimeFromName(opts.nameOrPath)
  if (guessed) return guessed
  return raw || opts.fallback || 'application/octet-stream'
}
