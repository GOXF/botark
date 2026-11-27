/**
 * GOXF fork: pinned official Mihomo release assets and their archive handling.
 * Version and SHA-256 values match jlcodes99/cockpit-tools
 * sidecars/mihomo/upstream-assets.json and the GitHub release digests of
 * MetaCubeX/mihomo v1.19.33. Pure (no Electron).
 */
import { createHash } from 'node:crypto'
import { gunzipSync, inflateRawSync } from 'node:zlib'

export const MIHOMO_VERSION = '1.19.33'
export const MIHOMO_RELEASE_BASE = `https://github.com/MetaCubeX/mihomo/releases/download/v${MIHOMO_VERSION}/`
export const MIHOMO_RELEASES_PAGE = `https://github.com/MetaCubeX/mihomo/releases/tag/v${MIHOMO_VERSION}`

export interface MihomoAsset {
  file: string
  sha256: string
  size: number
}

/** key = `${process.platform}-${process.arch}` */
export const MIHOMO_ASSETS: Record<string, MihomoAsset> = {
  'darwin-x64': { file: 'mihomo-darwin-amd64-v1-v1.19.33.gz', sha256: '61f979d6aae3deffe4e3895161349c3d9189149eef88c5aceb7c6d4a7270a78d', size: 22333945 },
  'darwin-arm64': { file: 'mihomo-darwin-arm64-v1.19.33.gz', sha256: '060b64b0f2c9a310831db0fe4adb2878de67bfa606c311813c1f13966aa504b6', size: 20784157 },
  'linux-x64': { file: 'mihomo-linux-amd64-v1-v1.19.33.gz', sha256: '8ec92e7b2fdc6b853ba00156bab7e4e965c8b0d843b8c4ac8ab98795f02ad524', size: 22893964 },
  'linux-arm64': { file: 'mihomo-linux-arm64-v1.19.33.gz', sha256: 'ba408b317080ee265c46cb923a50018c1b82cbd708551cdd46a1e3e307396187', size: 20824326 },
  'win32-x64': { file: 'mihomo-windows-amd64-v1-v1.19.33.zip', sha256: 'fb0b960eff568459502d4ebe53e9cca203053d86ec9024fe935f19615d74d9aa', size: 22543530 },
  'win32-arm64': { file: 'mihomo-windows-arm64-v1.19.33.zip', sha256: 'a2a26869a14634c49f3fbcecc593b498ed8591fbdd7616b24475b3d60b148da3', size: 20212418 }
}

export function selectMihomoAsset(platform: string = process.platform, arch: string = process.arch): MihomoAsset | null {
  return MIHOMO_ASSETS[`${platform}-${arch}`] ?? null
}

/** A release asset as GitHub's API lists it (`digest` is "sha256:<hex>"). */
export interface MihomoReleaseAsset {
  name: string
  browser_download_url: string
  size: number
  digest?: string | null
}

/** A downloadable kernel: which file, where, and the hash it must have. */
export interface MihomoDownload {
  version: string
  file: string
  url: string
  size: number
  sha256: string
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** This OS/arch's official asset name for any version (the pinned name with the version swapped). */
export function assetNamePattern(platform: string = process.platform, arch: string = process.arch): RegExp | null {
  const pinned = selectMihomoAsset(platform, arch)
  if (!pinned) return null
  const [head, tail] = pinned.file.split(MIHOMO_VERSION)
  return new RegExp(`^${escapeRe(head ?? '')}(\\d+\\.\\d+\\.\\d+)${escapeRe(tail ?? '')}$`)
}

/**
 * GOXF: the newest official release's asset for this OS/arch, trusted only with
 * the SHA-256 digest GitHub publishes for it. Null when the release lacks one.
 */
export function pickReleaseAsset(
  release: { tag_name?: string; assets?: MihomoReleaseAsset[] } | null | undefined,
  platform: string = process.platform,
  arch: string = process.arch
): MihomoDownload | null {
  const re = assetNamePattern(platform, arch)
  if (!re || !release?.assets) return null
  for (const a of release.assets) {
    const m = re.exec(a.name)
    const hash = /^sha256:([0-9a-f]{64})$/i.exec(a.digest ?? '')
    if (!m || !hash || !/^https:\/\/github\.com\//.test(a.browser_download_url)) continue
    return { version: m[1]!, file: a.name, url: a.browser_download_url, size: a.size, sha256: hash[1]!.toLowerCase() }
  }
  return null
}

/** Semver-ish compare of "1.19.34" style versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}

export const mihomoBinaryName = (platform: string = process.platform): string => (platform === 'win32' ? 'mihomo.exe' : 'mihomo')

export const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

/** The pinned asset this archive is (by SHA-256), for this platform. */
export function matchPinnedAsset(data: Buffer, platform: string = process.platform, arch: string = process.arch): MihomoAsset | null {
  const expected = selectMihomoAsset(platform, arch)
  if (!expected) return null
  return data.length === expected.size && sha256(data) === expected.sha256 ? expected : null
}

/** Any pinned asset (other OS/arch) — used to explain a wrong local file. */
export function anyPinnedAsset(data: Buffer): MihomoAsset | null {
  const hash = sha256(data)
  return Object.values(MIHOMO_ASSETS).find((a) => a.sha256 === hash) ?? null
}

const BINARY_LIMIT = 256 * 1024 * 1024

/** Unpack the engine binary from a verified official archive (.gz single file, or .zip with one mihomo*.exe). */
export function extractMihomoBinary(archive: Buffer, assetFile: string): Buffer {
  if (assetFile.endsWith('.gz')) {
    const out = gunzipSync(archive, { maxOutputLength: BINARY_LIMIT })
    if (out.length < 1024) throw new Error('内核压缩包内容异常')
    return out
  }
  if (assetFile.endsWith('.zip')) return extractZipExe(archive)
  throw new Error('不支持的压缩包格式')
}

/** Minimal ZIP reader (central directory; stored or deflate) for the single engine .exe. */
export function extractZipExe(zip: Buffer): Buffer {
  const eocdMin = 22
  let eocd = -1
  for (let i = zip.length - eocdMin; i >= Math.max(0, zip.length - eocdMin - 65535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip 损坏（找不到目录）')
  const count = zip.readUInt16LE(eocd + 10)
  let p = zip.readUInt32LE(eocd + 16)
  if (count > 64) throw new Error('zip 条目过多')
  const found: Buffer[] = []
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 损坏（目录项）')
    const method = zip.readUInt16LE(p + 10)
    const compSize = zip.readUInt32LE(p + 20)
    const size = zip.readUInt32LE(p + 24)
    const nameLen = zip.readUInt16LE(p + 28)
    const extraLen = zip.readUInt16LE(p + 30)
    const commentLen = zip.readUInt16LE(p + 32)
    const localOff = zip.readUInt32LE(p + 42)
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen
    if (name.includes('..') || name.startsWith('/') || name.includes('\\') || name.includes(':')) throw new Error('zip 含不安全路径')
    const base = name.split('/').pop() ?? ''
    if (!/^mihomo[\w.-]*\.exe$/i.test(base)) continue
    if (size > BINARY_LIMIT) throw new Error('zip 条目过大')
    if (zip.readUInt32LE(localOff) !== 0x04034b50) throw new Error('zip 损坏（本地头）')
    const dataStart = localOff + 30 + zip.readUInt16LE(localOff + 26) + zip.readUInt16LE(localOff + 28)
    const raw = zip.subarray(dataStart, dataStart + compSize)
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw, { maxOutputLength: BINARY_LIMIT }) : null
    if (!data || data.length !== size) throw new Error('zip 条目无法解压')
    found.push(data)
  }
  if (found.length !== 1) throw new Error(found.length ? 'zip 里有多个内核文件' : 'zip 里没有 mihomo 内核')
  return found[0]!
}

/** `mihomo -v` output → version (`1.19.33`). */
export function parseMihomoVersion(output: string): string | null {
  return /Mihomo(?: Meta)?\s+v?(\d+\.\d+\.\d+)/i.exec(output)?.[1] ?? null
}
