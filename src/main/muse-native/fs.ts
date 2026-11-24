/**
 * Muse VM filesystem helpers (official HatchGatewayFs).
 *
 * Upload: chunked `fs.write` with data_base64 (512 KiB), optional staging
 * `.upload-<uuid>.part` + `fs.rename` when stageBeforePublish && >1 chunk.
 * Preview: `fs.raw` binary GET on `/fs/raw/{*path}` (media channel in web client;
 * BotHub uses the same daemon Noise connection).
 */
import { randomUUID } from 'node:crypto'
import { inferMediaMime } from '../mediaMime'
import type { MuseNativeGateway } from './gateway'

const CHUNK = 524_288 // 512 KiB — official HatchGatewayFs
const FILE_REF_BYTES = 0xa0_0000 // 10 MiB non-image → file_ref
const VIDEO_REF_BYTES = 0x3c0_0000 // 60 MiB video

export function needsFileRef(mimeType: string, size: number): boolean {
  const mime = mimeType.toLowerCase()
  if (mime.startsWith('image/')) return false
  if (mime.startsWith('video/')) return size >= VIDEO_REF_BYTES
  return size >= FILE_REF_BYTES
}

export function buildWorkspaceUploadPath(filename: string, counter = 0): string {
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, '_')
  const i = safe.lastIndexOf('.')
  const base = i > 0 ? safe.slice(0, i) : safe
  const ext = i > 0 ? safe.slice(i).replace(/[^a-zA-Z0-9.]/g, '_') : ''
  const rand = Math.random().toString(36).slice(2, 6)
  return `workspace/user/files/${base}_${counter}_${rand}${ext}`
}

export function normalizeMuseFsPath(path: string): string {
  let s = path.trim()
  const wasFsRawUrl = /^https?:\/\/[^/]+\/fs\/raw\//i.test(s) || /^\/?fs\/raw\//i.test(s)
  // Strip full muse.ai/fs/raw/ URL if passed verbatim
  s = s.replace(/^https?:\/\/[^/]+\/fs\/raw\//i, '')
  if (wasFsRawUrl) {
    s = s.split(/[?#]/, 1)[0] ?? s
    try {
      s = decodeURIComponent(s)
    } catch {
      /* keep raw if malformed percent-encoding */
    }
  }
  // Strip leading slashes and /fs/raw/ prefix
  s = s.replace(/^\/+/, '').replace(/^fs\/raw\//i, '').replace(/^\/+/, '')
  // Normalize VM absolute home paths like home/muse/workspace/... -> workspace/...
  const wsIdx = s.search(/(?:^|\/)workspace\//i)
  if (wsIdx > 0) {
    s = s.slice(wsIdx).replace(/^\/+/, '')
  }
  if (!s) throw new Error('empty fs path')
  for (const seg of s.split('/')) {
    if (!seg || seg === '.' || seg === '..' || seg.includes('\\') || seg.includes('\0')) {
      throw new Error(`unsafe fs path segment in ${path.slice(0, 80)}`)
    }
  }
  return s
}

function normalizeFsPath(path: string): string {
  return normalizeMuseFsPath(path)
}

export function sniffImageMimeFromBytes(bytes: Uint8Array): string | undefined {
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
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  if (bytes.byteLength >= 5) {
    const head = new TextDecoder().decode(bytes.subarray(0, Math.min(256, bytes.byteLength))).trimStart()
    if (/^(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(head)) {
      return 'image/svg+xml'
    }
  }
  return undefined
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

export async function uploadWorkspaceFile(
  gw: MuseNativeGateway,
  path: string,
  bytes: Uint8Array,
  opts: { stageBeforePublish?: boolean; signal?: AbortSignal } = {}
): Promise<string> {
  const dest = normalizeFsPath(path)
  const size = bytes.byteLength
  const chunks = Math.ceil(size / CHUNK) || 1
  const stage = opts.stageBeforePublish === true && chunks > 1
  const slash = dest.lastIndexOf('/')
  const dir = slash >= 0 ? dest.slice(0, slash + 1) : ''
  const staging = `${dir}.upload-${randomUUID()}.part`
  const target = stage ? staging : dest

  if (size === 0) {
    await gw.request(
      'fs.write',
      { path: target, data_base64: '', overwrite: true, append: false, create_parent: true },
      360_000, opts.signal
    )
  } else {
    let offset = 0
    for (let i = 0; i < chunks; i++) {
      opts.signal?.throwIfAborted?.()
      const end = Math.min(offset + CHUNK, size)
      const slice = bytes.subarray(offset, end)
      await gw.request(
        'fs.write',
        {
          path: target,
          data_base64: bytesToBase64(slice),
          overwrite: i === 0,
          append: i !== 0,
          create_parent: i === 0
        },
        360_000, opts.signal
      )
      offset = end
    }
  }

  if (stage) {
    await gw.request(
      'fs.rename',
      { source: staging, destination: dest, create_parent: true, overwrite: true },
      120_000, opts.signal
    )
  }
  return dest
}

const PREVIEW_MAX = 8 * 1024 * 1024
const VIDEO_PREVIEW_MAX = 32 * 1024 * 1024

export const MUSE_WORKSPACE_DOWNLOAD = 'workspace.download'

export interface MuseWorkspaceFile {
  path: string
  mimeType: string
  dataBase64: string
  byteLength: number
  truncated: boolean
}

function previewLimit(path: string): number {
  return /\.(mp4|m4v|webm|mov|mkv|avi|mp3|wav|m4a|ogg|flac)(?:[?#].*)?$/i.test(path)
    ? VIDEO_PREVIEW_MAX
    : PREVIEW_MAX
}

function contentRange(value?: string): { start: number; end: number; length: number | undefined } | undefined {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(value ?? '')
  if (!match) return undefined
  const start = Number(match[1])
  const end = Number(match[2])
  const length = match[3] === '*' ? undefined : Number(match[3])
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start ||
      (length !== undefined && (!Number.isSafeInteger(length) || end >= length))) return undefined
  return { start, end, length }
}

function formatWorkspaceFile(path: string, bytes: Uint8Array, contentType: string | undefined, truncated: boolean): MuseWorkspaceFile {
  return {
    path,
    mimeType: inferMediaMime({
      headerMime: contentType, nameOrPath: path, bytes, fallback: guessMime(path) || 'application/octet-stream'
    }),
    dataBase64: bytesToBase64(bytes),
    byteLength: bytes.byteLength,
    truncated
  }
}

function checkFullResponse(status: number, received: number, length?: number, truncated?: boolean): void {
  if (status !== 200 || truncated || (length !== undefined && received !== length)) {
    throw new Error('Muse did not return the complete file')
  }
}

export async function fetchFsRawPreview(gw: MuseNativeGateway, path: string): Promise<MuseWorkspaceFile> {
  return fetchFsRaw(gw, path, false)
}

export async function downloadFsRawFile(gw: MuseNativeGateway, path: string): Promise<MuseWorkspaceFile> {
  return fetchFsRaw(gw, path, true)
}

async function fetchFsRaw(gw: MuseNativeGateway, path: string, download: boolean): Promise<MuseWorkspaceFile> {
  const p = normalizeFsPath(path)
  const maxBytes = previewLimit(p)
  const fetch = (filePath: string) => gw.requestBinary('fs.raw', download ? { path: filePath } : {
    path: filePath, _range: { start: 0, end: maxBytes - 1 }
  }, 120_000, download ? undefined : maxBytes)
  let resolvedPath = p
  let res: Awaited<ReturnType<typeof fetch>>
  try {
    res = await fetch(p)
  } catch (error) {
    if (p.startsWith('workspace/') || (error as { status?: number }).status !== 404) throw error
    resolvedPath = `workspace/${p}`
    res = await fetch(resolvedPath)
  }
  const { body, contentType, status, contentLength } = res
  if (download) {
    checkFullResponse(status, body.length, contentLength, res.truncated)
    return formatWorkspaceFile(resolvedPath, body, contentType, false)
  }
  const range = contentRange(res.contentRange)
  if (status === 206 && range?.start !== 0) throw new Error('Muse returned an invalid file preview range')
  const truncated = res.truncated || body.length > maxBytes ||
    (range ? range.length !== body.length || range.end + 1 !== body.length : contentLength !== undefined && contentLength > body.length)
  return formatWorkspaceFile(resolvedPath, body.subarray(0, maxBytes), contentType, truncated)
}

export async function fetchHttpWorkspaceFile(
  fetch: (url: string, init?: RequestInit) => Promise<Response>, url: string, download: boolean
): Promise<MuseWorkspaceFile> {
  const response = await fetch(url, { method: 'GET' })
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined)
    throw new Error(`HTTP ${response.status} fetching Muse media`)
  }
  const contentType = response.headers.get('content-type') ?? undefined
  const length = response.headers.get('content-length')
  // Fetch exposes decoded bytes when content encoding is in use.
  const contentLength = length && /^\d+$/.test(length) && !response.headers.get('content-encoding') ? Number(length) : undefined
  if (download) {
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error('Muse did not return the complete file')
    }
    const body = new Uint8Array(await response.arrayBuffer())
    checkFullResponse(response.status, body.length, contentLength)
    return formatWorkspaceFile(url, body, contentType, false)
  }

  const limit = previewLimit(url)
  const reader = response.body?.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  let truncated = contentLength !== undefined && contentLength > limit
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const remaining = limit - received
        const chunk = value.length > remaining ? value.slice(0, remaining) : value
        if (chunk.length) chunks.push(chunk)
        received += chunk.length
        if (value.length > remaining || (received === limit && truncated)) {
          truncated = true
          void reader.cancel().catch(() => undefined)
          break
        }
      }
    } finally {
      reader.releaseLock()
    }
  }
  if (response.status === 206) {
    const range = contentRange(response.headers.get('content-range') ?? undefined)
    if (range?.start !== 0) throw new Error('Muse returned an invalid file preview range')
    truncated ||= range.length !== received || range.end + 1 !== received
  }
  const body = Buffer.concat(chunks, received)
  return formatWorkspaceFile(url, body, contentType, truncated || (contentLength !== undefined && contentLength > received))
}

function guessMime(path: string): string | undefined {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.mp3')) return 'audio/mpeg'
  if (lower.endsWith('.m4a') || lower.endsWith('.aac')) return 'audio/mp4'
  if (lower.endsWith('.wav')) return 'audio/wav'
  if (lower.endsWith('.ogg') || lower.endsWith('.oga')) return 'audio/ogg'
  if (lower.endsWith('.mp4') || lower.endsWith('.m4v')) return 'video/mp4'
  if (lower.endsWith('.webm')) return 'video/webm'
  if (lower.endsWith('.mov')) return 'video/quicktime'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html'
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown'
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) return 'text/csv'
  if (/\.(txt|log|py|ts|tsx|js|jsx|sh|yaml|yml|toml|css|sql|xml)$/.test(lower)) return 'text/plain'
  return undefined
}
