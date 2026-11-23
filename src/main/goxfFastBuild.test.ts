import { describe, expect, it } from 'vitest'
import { builderPackageJson, devReleasesToPrune, fullBuildReason, mergeManifest, pickBaseRelease } from '../../scripts/goxf-fast.mts'
import type { GitHubRelease } from './goxfUpdateLogic'

const asset = (name: string) => ({ name, browser_download_url: `https://dl/${name}`, size: 1, state: 'uploaded' })
const rel = (tag: string, at: string, kind: 'full' | 'fast', extra: Partial<GitHubRelease> = {}): GitHubRelease => {
  const stem = `BotArk-Portable-${tag.slice(1)}-win-x64`
  const names = [`manifest-${stem}.json`, `patch-${stem}.zip`, ...(kind === 'full' ? [`${stem}.zip`] : [])]
  return { tag_name: tag, published_at: at, prerelease: /dev/.test(tag), assets: names.map(asset), ...extra }
}
const sha = (c: string) => c.repeat(64)

describe('pickBaseRelease', () => {
  it('takes the newest release with a full zip, stable or dev, skipping fast and draft ones', () => {
    const rs = [
      rel('v0.13.0-goxf.dev.fff0001', '2026-11-23T09:00:00Z', 'fast'),
      rel('v0.13.0-goxf.dev.ddd0001', '2026-11-23T08:30:00Z', 'full', { draft: true }),
      rel('v0.13.0-goxf.6', '2026-11-23T06:00:00Z', 'full'),
      rel('v0.13.0-goxf.dev.aaa0001', '2026-11-23T08:00:00Z', 'full')
    ]
    expect(pickBaseRelease(rs)?.tag_name).toBe('v0.13.0-goxf.dev.aaa0001')
  })
  it('needs manifest + patch next to the zip', () => {
    const noPatch = rel('v0.13.0-goxf.6', '2026-11-23T06:00:00Z', 'full')
    noPatch.assets = noPatch.assets!.filter((a) => !a.name.startsWith('patch-'))
    expect(pickBaseRelease([noPatch])).toBeNull()
  })
})

describe('fullBuildReason', () => {
  const pkg = { version: '0.13.0', goxfBuild: 6, dependencies: { ws: '^8' }, devDependencies: { electron: '45.2.1' } }
  it('fast when only sources and non-runtime package.json fields changed', () => {
    expect(fullBuildReason(pkg, { ...pkg, goxfBuild: 7, scripts: { x: 'y' } }, ['src/main/a.ts', 'package.json', '.github/workflows/x.yml'])).toBeNull()
  })
  it('full for dependency, electron, lockfile, builder config or build/ changes', () => {
    expect(fullBuildReason(pkg, { ...pkg, dependencies: { ws: '^9' } }, [])).toBe('package.json dependencies changed')
    expect(fullBuildReason(pkg, { ...pkg, devDependencies: { electron: '46.0.0' } }, [])).toBe('package.json devDependencies changed')
    for (const p of ['package-lock.json', 'electron-builder.config.cjs', 'build/icon.png']) {
      expect(fullBuildReason(pkg, pkg, ['src/x.ts', p])).toBe(`${p} changed`)
    }
    expect(fullBuildReason(pkg, pkg, ['src/build/x.ts'])).toBeNull()
  })
})

describe('builderPackageJson', () => {
  it('drops what electron-builder drops from the main package.json, keeps the rest in order', () => {
    const out = builderPackageJson({
      name: 'botark', version: '0.13.0', scripts: { a: 'b' }, keywords: ['x'], devDependencies: { e: '1' },
      build: {}, _id: 'x', babel: {}, dependencies: { ws: '^8' }, goxfTag: 'v0.13.0-goxf.dev.abc1234'
    })
    expect(out).toBe(JSON.stringify({ name: 'botark', version: '0.13.0', dependencies: { ws: '^8' }, goxfTag: 'v0.13.0-goxf.dev.abc1234' }, null, 2))
  })
})

describe('mergeManifest', () => {
  it('keeps runtime entries from the base, takes resources/ from the new build', () => {
    const base = [
      { path: 'BotArk.exe', sha256: sha('a'), size: 1 },
      { path: 'resources/app.asar', sha256: sha('b'), size: 2 },
      { path: 'resources/old.txt', sha256: sha('c'), size: 3 }
    ]
    const fresh = [{ path: 'resources/app.asar', sha256: sha('d'), size: 4 }]
    expect(mergeManifest(base, fresh)).toEqual([base[0], fresh[0]])
  })
})

describe('devReleasesToPrune', () => {
  it('keeps the newest 5 dev releases and always the newest release with a full zip', () => {
    const rs = [
      ...[1, 2, 3, 4, 5, 6].map((i) => rel(`v0.13.0-goxf.dev.fff000${i}`, `2026-11-23T0${i}:30:00Z`, 'fast')),
      rel('v0.13.0-goxf.dev.aaa0001', '2026-11-23T00:00:00Z', 'full'),
      rel('v0.13.0-goxf.dev.aaa0000', '2026-11-22T00:00:00Z', 'full'),
      rel('v0.13.0-goxf.5', '2026-11-21T00:00:00Z', 'full')
    ]
    expect(devReleasesToPrune(rs).sort()).toEqual(['v0.13.0-goxf.dev.aaa0000', 'v0.13.0-goxf.dev.fff0001'])
  })
  it('never touches stable releases', () => {
    const rs = [1, 2, 3, 4, 5, 6].map((i) => rel(`v0.13.0-goxf.${i}`, `2026-11-23T0${i}:00:00Z`, 'full'))
    expect(devReleasesToPrune(rs)).toEqual([])
  })
})
