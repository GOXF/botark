import { describe, expect, it } from 'vitest'
import { deflateRawSync, gzipSync } from 'node:zlib'
import { existsSync, readFileSync } from 'node:fs'
import {
  anyPinnedAsset,
  assetNamePattern,
  compareVersions,
  pickReleaseAsset,
  extractMihomoBinary,
  extractZipExe,
  matchPinnedAsset,
  MIHOMO_ASSETS,
  MIHOMO_VERSION,
  parseMihomoVersion,
  selectMihomoAsset
} from './goxfMihomoAssets'

/** Minimal zip writer (deflate) for fixtures. */
function zip(entries: Array<[string, Buffer]>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, data] of entries) {
    const comp = deflateRawSync(data)
    const n = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(n.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(comp.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(n.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, n, comp)
    centrals.push(central, n)
    offset += 30 + n.length + comp.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

describe('goxf Mihomo assets', () => {
  it('pins one official asset per supported OS/arch', () => {
    expect(selectMihomoAsset('win32', 'x64')?.file).toBe(`mihomo-windows-amd64-v1-v${MIHOMO_VERSION}.zip`)
    expect(selectMihomoAsset('darwin', 'arm64')?.file).toBe(`mihomo-darwin-arm64-v${MIHOMO_VERSION}.gz`)
    expect(selectMihomoAsset('linux', 'x64')?.file.endsWith('.gz')).toBe(true)
    expect(selectMihomoAsset('freebsd', 'x64')).toBeNull()
    for (const a of Object.values(MIHOMO_ASSETS)) expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('accepts only archives whose size and SHA-256 match the pin', () => {
    const fake = Buffer.alloc(1000, 1)
    expect(matchPinnedAsset(fake, 'win32', 'x64')).toBeNull()
    expect(anyPinnedAsset(fake)).toBeNull()
  })

  it('unpacks the single engine exe from a zip and rejects unsafe or ambiguous archives', () => {
    const exe = Buffer.alloc(4096, 7)
    expect(extractZipExe(zip([['mihomo-windows-amd64-v1.exe', exe], ['LICENSE', Buffer.from('x')]]))).toEqual(exe)
    expect(() => extractZipExe(zip([['../mihomo.exe', exe]]))).toThrow(/不安全/)
    expect(() => extractZipExe(zip([['a/mihomo.exe', exe], ['b/mihomo.exe', exe]]))).toThrow(/多个/)
    expect(() => extractZipExe(zip([['readme.txt', exe]]))).toThrow(/没有/)
    expect(() => extractZipExe(Buffer.from('not a zip at all, definitely not'))).toThrow()
  })

  it('unpacks a gzip asset', () => {
    const bin = Buffer.alloc(8192, 3)
    expect(extractMihomoBinary(gzipSync(bin), 'mihomo-linux-amd64-v1.gz')).toEqual(bin)
  })

  it('reads `mihomo -v`', () => {
    expect(parseMihomoVersion('Mihomo Meta v1.19.33 linux arm64 with go1.26.10')).toBe('1.19.33')
    expect(parseMihomoVersion('garbage')).toBeNull()
  })

  // MIHOMO_ARCHIVE=/path/mihomo-linux-arm64-v1.19.33.gz: the real official asset verifies and unpacks.
  const real = process.env.MIHOMO_ARCHIVE
  it.runIf(real && existsSync(real))('verifies a real official archive', () => {
    const data = readFileSync(real!)
    const asset = anyPinnedAsset(data)
    expect(asset).not.toBeNull()
    const [platform, arch] = Object.entries(MIHOMO_ASSETS).find(([, a]) => a === asset)![0].split('-')
    expect(matchPinnedAsset(data, platform, arch)).toBe(asset)
    expect(extractMihomoBinary(data, asset!.file).length).toBeGreaterThan(1_000_000)
  })
})

describe('latest release', () => {
  const asset = (name: string, digest = `sha256:${'a'.repeat(64)}`) => ({
    name,
    browser_download_url: `https://github.com/MetaCubeX/mihomo/releases/download/v1.19.34/${name}`,
    size: 123,
    digest
  })
  it('picks this OS/arch asset of any version with its published digest', () => {
    const rel = { tag_name: 'v1.19.34', assets: [asset('mihomo-windows-amd64-v1-v1.19.34.zip.deb'), asset('mihomo-windows-amd64-v1-v1.19.34.zip'), asset('mihomo-linux-arm64-v1.19.34.gz')] }
    expect(pickReleaseAsset(rel, 'win32', 'x64')).toMatchObject({ version: '1.19.34', file: 'mihomo-windows-amd64-v1-v1.19.34.zip', sha256: 'a'.repeat(64) })
    expect(pickReleaseAsset(rel, 'linux', 'arm64')?.file).toBe('mihomo-linux-arm64-v1.19.34.gz')
  })
  it('refuses an asset without a sha256 digest', () => {
    expect(pickReleaseAsset({ assets: [asset('mihomo-linux-arm64-v1.19.34.gz', '')] }, 'linux', 'arm64')).toBeNull()
  })
  it('compares versions numerically', () => {
    expect(compareVersions('1.19.34', '1.19.33')).toBe(1)
    expect(compareVersions('1.19.9', '1.19.10')).toBe(-1)
    expect(compareVersions('1.19.33', '1.19.33')).toBe(0)
  })
  it('recognises official names in any version, not renamed files', () => {
    expect(assetNamePattern('win32', 'x64')!.test('mihomo-windows-amd64-v1-v1.20.0.zip')).toBe(true)
    expect(assetNamePattern('win32', 'x64')!.test('mihomo.zip')).toBe(false)
  })
})
