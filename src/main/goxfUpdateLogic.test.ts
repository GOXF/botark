import { describe, expect, it } from 'vitest'
import {
  buildReplaceScript,
  isUpdateLockFresh,
  decideUpdatePrompts,
  formatGoxfVersion,
  isNewerSemver,
  nextCheckDelayMs,
  normalizeGoxfBuild,
  parseGoxfVersion,
  parseManifest,
  pickDeltaAssets,
  pickLatestGoxfRelease,
  planDelta,
  pickPortableAsset,
  pickPortableZipAsset,
  psQuote,
  type GitHubRelease,
  type PromptInput
} from './goxfUpdateLogic'

const exe = (name: string) => ({ name, browser_download_url: `https://dl/${name}` })
const forkRelease = (tag: string, extra: Partial<GitHubRelease> = {}): GitHubRelease => ({
  tag_name: tag,
  html_url: `https://github.com/GOXF/botark/releases/tag/${tag}`,
  assets: [exe(`BotArk-Portable-${tag.slice(1)}-x64.exe`)],
  ...extra
})
const input = (over: Partial<PromptInput> = {}): PromptInput => ({
  version: '0.12.0',
  goxfBuild: 1,
  upstreamLatest: null,
  forkReleases: null,
  portable: 'exe',
  platform: 'win32',
  ...over
})

describe('versions', () => {
  it('parses fork tags and nothing else', () => {
    expect(parseGoxfVersion('v0.12.0-goxf.3')).toEqual({ base: { major: 0, minor: 12, patch: 0 }, build: 3 })
    expect(parseGoxfVersion('v0.12.0')).toBeNull()
    expect(parseGoxfVersion('v0.12.0-beta.1')).toBeNull()
  })
  it('compares base versions numerically', () => {
    expect(isNewerSemver('0.13.0', '0.12.9')).toBe(true)
    expect(isNewerSemver('0.10.0', '0.9.0')).toBe(true)
    expect(isNewerSemver('0.12.0', '0.12.0')).toBe(false)
    expect(isNewerSemver('garbage', '0.12.0')).toBe(false)
  })
  it('formats and normalizes the fork build', () => {
    expect(formatGoxfVersion('v0.12.0', 2)).toBe('0.12.0-goxf.2')
    expect(normalizeGoxfBuild('3')).toBe(3)
    expect(normalizeGoxfBuild(-1)).toBe(0)
    expect(normalizeGoxfBuild(undefined)).toBe(0)
  })
})

describe('pickLatestGoxfRelease', () => {
  it('takes the newest published fork release, skipping drafts, prereleases and upstream tags', () => {
    const latest = pickLatestGoxfRelease([
      forkRelease('v0.12.0-goxf.2'),
      forkRelease('v0.12.0-goxf.9', { draft: true }),
      forkRelease('v0.12.0-goxf.8', { prerelease: true }),
      forkRelease('v0.13.0'),
      forkRelease('v0.12.0-goxf.10'),
      forkRelease('v0.11.5-goxf.40')
    ])
    expect(latest?.versionText).toBe('0.12.0-goxf.10')
  })
  it('returns null for nothing usable', () => {
    expect(pickLatestGoxfRelease(null)).toBeNull()
    expect(pickLatestGoxfRelease([forkRelease('v1.0.0')])).toBeNull()
  })
})

describe('pickPortableAsset', () => {
  it('prefers the x64 portable exe and ignores the installer', () => {
    const assets = [
      exe('BotArk-Setup-0.12.0-x64.exe'),
      exe('BotArk-Portable-0.12.0-goxf.1-arm64.exe'),
      exe('BotArk-Portable-0.12.0-goxf.1-x64.exe')
    ]
    expect(pickPortableAsset(assets)?.name).toBe('BotArk-Portable-0.12.0-goxf.1-x64.exe')
    expect(pickPortableAsset([exe('BotArk-Setup-0.12.0-x64.exe')])).toBeNull()
  })
})

describe('pickPortableZipAsset', () => {
  it('picks the portable zip, not blockmaps or other archives', () => {
    const assets = [
      exe('BotArk-0.12.0-x64.zip'),
      exe('BotArk-Portable-0.12.0-goxf.1-x64.exe'),
      exe('BotArk-Portable-0.12.0-goxf.1-win-x64.zip')
    ]
    expect(pickPortableZipAsset(assets)?.name).toBe('BotArk-Portable-0.12.0-goxf.1-win-x64.zip')
    expect(pickPortableZipAsset([exe('BotArk-0.12.0-x64.zip')])).toBeNull()
  })
})

describe('decideUpdatePrompts', () => {
  it('shows nothing when both sides are current', () => {
    const d = decideUpdatePrompts(
      input({ upstreamLatest: { tag_name: 'v0.12.0' }, forkReleases: [forkRelease('v0.12.0-goxf.1')] })
    )
    expect(d).toEqual({ upstream: null, portable: null })
  })
  it('shows the upstream prompt for a newer upstream release only', () => {
    const d = decideUpdatePrompts(input({ upstreamLatest: { tag_name: 'v0.13.0', html_url: 'https://u' } }))
    expect(d.upstream).toEqual({ version: '0.13.0', url: 'https://u' })
    expect(d.portable).toBeNull()
  })
  it('ignores an upstream prerelease or draft', () => {
    expect(decideUpdatePrompts(input({ upstreamLatest: { tag_name: 'v0.13.0', prerelease: true } })).upstream).toBeNull()
    expect(decideUpdatePrompts(input({ upstreamLatest: { tag_name: 'v0.13.0', draft: true } })).upstream).toBeNull()
  })
  it('shows the portable prompt for a newer fork build and allows self-update on Windows portable', () => {
    const d = decideUpdatePrompts(input({ forkReleases: [forkRelease('v0.12.0-goxf.2')] }))
    expect(d.portable?.version).toBe('0.12.0-goxf.2')
    expect(d.portable?.canSelfUpdate).toBe(true)
  })
  it('a fork build on a newer base beats a higher build number on the old base', () => {
    const d = decideUpdatePrompts(input({ goxfBuild: 7, forkReleases: [forkRelease('v0.13.0-goxf.1')] }))
    expect(d.portable?.version).toBe('0.13.0-goxf.1')
  })
  it('never offers an older fork build', () => {
    const d = decideUpdatePrompts(input({ version: '0.13.0', goxfBuild: 1, forkReleases: [forkRelease('v0.12.0-goxf.5')] }))
    expect(d.portable).toBeNull()
  })
  it('falls back to opening the page when self-update is impossible', () => {
    const rel = [forkRelease('v0.12.0-goxf.2')]
    expect(decideUpdatePrompts(input({ portable: null, forkReleases: rel })).portable?.canSelfUpdate).toBe(false)
    expect(decideUpdatePrompts(input({ platform: 'darwin', forkReleases: rel })).portable?.canSelfUpdate).toBe(false)
    const noAsset = [forkRelease('v0.12.0-goxf.2', { assets: [exe('BotArk-Setup-0.12.0-x64.exe')] })]
    expect(decideUpdatePrompts(input({ forkReleases: noAsset })).portable?.canSelfUpdate).toBe(false)
  })
  it('a zip build updates itself from the zip asset, an exe build from the exe', () => {
    const rel = [
      forkRelease('v0.12.0-goxf.2', {
        assets: [exe('BotArk-Portable-0.12.0-goxf.2-x64.exe'), exe('BotArk-Portable-0.12.0-goxf.2-win-x64.zip')]
      })
    ]
    const zip = decideUpdatePrompts(input({ portable: 'zip', forkReleases: rel })).portable
    expect(zip?.canSelfUpdate).toBe(true)
    expect(zip?.asset?.name).toMatch(/\.zip$/)
    expect(decideUpdatePrompts(input({ portable: 'exe', forkReleases: rel })).portable?.asset?.name).toMatch(/\.exe$/)
    const exeOnly = [forkRelease('v0.12.0-goxf.2')]
    expect(decideUpdatePrompts(input({ portable: 'zip', forkReleases: exeOnly })).portable?.canSelfUpdate).toBe(false)
  })
  it('can show both prompts at once', () => {
    const d = decideUpdatePrompts(
      input({ upstreamLatest: { tag_name: 'v0.13.0' }, forkReleases: [forkRelease('v0.12.0-goxf.2')] })
    )
    expect(d.upstream?.version).toBe('0.13.0')
    expect(d.portable?.version).toBe('0.12.0-goxf.2')
  })
})

describe('buildReplaceScript', () => {
  it('quotes paths safely for PowerShell', () => {
    expect(psQuote("C:\\it's\\BotArk.exe")).toBe("'C:\\it''s\\BotArk.exe'")
  })
  it('embeds the paths and pid, uses CRLF, and rolls back on failure', () => {
    const s = buildReplaceScript({
      oldExe: 'D:\\工具\\BotArk.exe',
      newExe: 'D:\\工具\\.BotArk.exe.new',
      pid: 1234.9,
      logFile: 'D:\\工具\\BotArk-Data\\portable-update.log'
    })
    expect(s).toContain("$old = 'D:\\工具\\BotArk.exe'")
    expect(s).toContain('$appPid = 1234')
    expect(s).toContain('\r\n')
    expect(s).toMatch(/rolling back/)
    expect(s.indexOf('Move-Item -LiteralPath $old -Destination $backup')).toBeLessThan(
      s.indexOf('Move-Item -LiteralPath $new -Destination $old')
    )
  })
})

describe('release readiness and check cadence', () => {
  it('ignores assets GitHub has not finished uploading', () => {
    const url = 'https://x/BotArk-Portable-0.12.1-goxf.2-win-x64.zip'
    expect(pickPortableZipAsset([{ name: 'BotArk-Portable-0.12.1-goxf.2-win-x64.zip', browser_download_url: url, state: 'new' }])).toBeNull()
    expect(pickPortableZipAsset([{ name: 'BotArk-Portable-0.12.1-goxf.2-win-x64.zip', browser_download_url: url, state: 'uploaded', size: 5 }])?.browser_download_url).toBe(url)
  })
  it('checks daily, backs off 1h→2h→4h→6h after failures', () => {
    const h = 60 * 60 * 1000
    expect([0, 1, 2, 3, 4, 9].map((n) => nextCheckDelayMs(n))).toEqual([24 * h, h, 2 * h, 4 * h, 6 * h, 6 * h])
    const m = 60 * 1000
    expect([0, 1, 2, 3, 9].map((n) => nextCheckDelayMs(n, 'test'))).toEqual([10 * m, 10 * m, 20 * m, 40 * m, h])
  })
})


const sha = (c: string) => c.repeat(64)
const zipAssets = (v: string) =>
  ['', 'manifest-', 'patch-'].map((p) => {
    const name = `${p}BotArk-Portable-${v}-win-x64.${p === 'manifest-' ? 'json' : 'zip'}`
    return { name, browser_download_url: `https://dl/${name}`, size: 10, state: 'uploaded' }
  })

describe('delta assets', () => {
  it('pairs manifest + patch with the full zip, never takes the patch as the full zip', () => {
    const assets = zipAssets('0.12.1-goxf.4').reverse()
    const zip = pickPortableZipAsset(assets)
    expect(zip?.name).toBe('BotArk-Portable-0.12.1-goxf.4-win-x64.zip')
    expect(pickDeltaAssets(assets)?.patch.name).toBe('patch-BotArk-Portable-0.12.1-goxf.4-win-x64.zip')
    expect(pickDeltaAssets(assets.filter((a) => !a.name.startsWith('manifest-')))).toBeNull()
    // fast CI build: manifest + patch only
    expect(pickDeltaAssets(assets.filter((a) => /^(manifest|patch)-/.test(a.name)))?.manifest.name).toBe(
      'manifest-BotArk-Portable-0.12.1-goxf.4-win-x64.json'
    )
  })
})

describe('parseManifest', () => {
  it('accepts relative forward-slash paths with sha256', () => {
    expect(parseManifest({ files: [{ path: 'resources/app.asar', sha256: sha('A'), size: 3 }] })).toEqual([
      { path: 'resources/app.asar', sha256: sha('a'), size: 3 }
    ])
  })
  it('rejects traversal, absolute, backslash paths and bad hashes', () => {
    for (const path of ['../x', 'a/../b', '/etc/x', 'C:/x', 'a\\b', './x', ''])
      expect(parseManifest({ files: [{ path, sha256: sha('a'), size: 1 }] }), path).toBeNull()
    expect(parseManifest({ files: [{ path: 'x', sha256: 'abc', size: 1 }] })).toBeNull()
    expect(parseManifest({ files: [] })).toBeNull()
    expect(parseManifest(null)).toBeNull()
  })
})

describe('planDelta', () => {
  const files = [
    { path: 'BotArk.exe', sha256: sha('1'), size: 1 },
    { path: 'resources/app.asar', sha256: sha('2'), size: 1 },
    { path: 'resources/app.asar.unpacked/x.node', sha256: sha('3'), size: 1 },
    { path: 'resources/new.txt', sha256: sha('4'), size: 1 }
  ]
  it('patches only changed or missing resources/ files when the runtime matches', () => {
    const plan = planDelta(files, {
      'BotArk.exe': sha('1'),
      'resources/app.asar': sha('9'),
      'resources/app.asar.unpacked/x.node': sha('3').toUpperCase(),
      'resources/new.txt': null
    })
    expect(plan).toEqual({ mode: 'patch', changed: [files[1], files[3]] })
  })
  it('falls back to full when a runtime file differs or is missing', () => {
    expect(planDelta(files, { 'BotArk.exe': sha('0') }).mode).toBe('full')
    expect(planDelta(files, {}).mode).toBe('full')
  })
  it('falls back to full when nothing would change', () => {
    const local = Object.fromEntries(files.map((f) => [f.path, f.sha256]))
    expect(planDelta(files, local)).toEqual({ mode: 'full', reason: 'patch would change nothing' })
  })
})

describe('update channels', () => {
  const dev = (sha7: string, at: string, extra: Partial<GitHubRelease> = {}) =>
    forkRelease(`v0.12.1-goxf.dev.${sha7}`, { prerelease: true, published_at: at, ...extra })
  const stable = (n: number, at: string) => forkRelease(`v0.12.1-goxf.${n}`, { published_at: at })
  const releases = [stable(4, '2026-11-20T00:00:00Z'), dev('abc1234', '2026-11-22T00:00:00Z'), dev('def5678', '2026-11-21T00:00:00Z')]
  const base = { version: '0.12.1', goxfBuild: 4, portable: 'zip' as const, forkReleases: releases }

  it('stable ignores dev prereleases', () => {
    expect(decideUpdatePrompts(input({ ...base, builtAt: '2026-11-19T00:00:00Z' })).portable).toBeNull()
    expect(decideUpdatePrompts(input({ ...base, goxfBuild: 3 })).portable?.version).toBe('0.12.1-goxf.4')
  })
  it('test picks the newest by published date when it is another build published after ours', () => {
    const d = decideUpdatePrompts(input({ ...base, channel: 'test', buildTag: 'v0.12.1-goxf.4', builtAt: '2026-11-19T00:00:00Z' }))
    expect(d.portable?.version).toBe('0.12.1-goxf.dev.abc1234')
  })
  it('test offers nothing when the newest is our own build or older than us', () => {
    expect(
      decideUpdatePrompts(input({ ...base, channel: 'test', buildTag: 'v0.12.1-goxf.dev.abc1234', builtAt: '2026-11-21T23:00:00Z' })).portable
    ).toBeNull()
    expect(
      decideUpdatePrompts(input({ ...base, channel: 'test', buildTag: 'v0.12.1-goxf.dev.zzz', builtAt: '2026-11-23T00:00:00Z' })).portable
    ).toBeNull()
  })
  it('test skips drafts; without a build time only a newer stable tag counts', () => {
    const rs = [dev('abc1234', '2026-11-22T00:00:00Z', { draft: true }), stable(5, '2026-11-21T00:00:00Z')]
    expect(decideUpdatePrompts(input({ ...base, forkReleases: rs, channel: 'test' })).portable?.version).toBe('0.12.1-goxf.5')
    expect(decideUpdatePrompts(input({ ...base, channel: 'test' })).portable).toBeNull()
  })
})

describe('patch-only (fast CI) dev releases on the test channel', () => {
  const full = (tag: string, at: string) =>
    forkRelease(tag, { prerelease: true, published_at: at, assets: [exe(`BotArk-Portable-${tag.slice(1)}-x64.exe`), ...zipAssets(tag.slice(1))] })
  const fast = (tag: string, at: string) =>
    forkRelease(tag, { prerelease: true, published_at: at, assets: zipAssets(tag.slice(1)).filter((a) => /^(manifest|patch)-/.test(a.name)) })
  const releases = [
    fast('v0.12.1-goxf.dev.fff0002', '2026-11-23T08:00:00Z'),
    fast('v0.12.1-goxf.dev.fff0001', '2026-11-22T08:00:00Z'),
    full('v0.12.1-goxf.dev.aaa0001', '2026-11-21T08:00:00Z')
  ]
  const test = { version: '0.12.1', goxfBuild: 4, channel: 'test' as const, forkReleases: releases, platform: 'win32' }
  const fromFast1 = { buildTag: 'v0.12.1-goxf.dev.fff0001', builtAt: '2026-11-22T07:55:00Z' }

  it('a zip folder is offered the newest patch-only release as a delta, with no fallback newer than itself', () => {
    const p = decideUpdatePrompts(input({ ...test, ...fromFast1, portable: 'zip' })).portable
    expect(p?.version).toBe('0.12.1-goxf.dev.fff0002')
    expect(p?.asset).toBeNull()
    expect(p?.delta?.patch.name).toBe('patch-BotArk-Portable-0.12.1-goxf.dev.fff0002-win-x64.zip')
    expect(p?.canSelfUpdate).toBe(true)
    expect(p?.fallback).toBeNull()
  })
  it('falls back to the newest full zip published after our build', () => {
    const p = decideUpdatePrompts(input({ ...test, portable: 'zip', buildTag: 'v0.12.1-goxf.4', builtAt: '2026-11-20T08:00:00Z' })).portable
    expect(p?.version).toBe('0.12.1-goxf.dev.fff0002')
    expect(p?.fallback?.version).toBe('0.12.1-goxf.dev.aaa0001')
    expect(p?.fallback?.asset.name).toBe('BotArk-Portable-0.12.1-goxf.dev.aaa0001-win-x64.zip')
  })
  it('exe and non-portable builds skip patch-only releases', () => {
    const own = { buildTag: 'v0.12.1-goxf.4', builtAt: '2026-11-20T08:00:00Z' }
    expect(decideUpdatePrompts(input({ ...test, ...own, portable: 'exe' })).portable?.version).toBe('0.12.1-goxf.dev.aaa0001')
    expect(decideUpdatePrompts(input({ ...test, ...own, portable: null })).portable?.version).toBe('0.12.1-goxf.dev.aaa0001')
    expect(decideUpdatePrompts(input({ ...test, ...fromFast1, portable: 'exe' })).portable).toBeNull()
  })
  it('a full release has no fallback', () => {
    const p = decideUpdatePrompts(input({ ...test, forkReleases: [releases[2]], portable: 'zip', builtAt: '2026-11-20T08:00:00Z' })).portable
    expect(p?.asset?.name).toMatch(/\.zip$/)
    expect(p?.fallback).toBeNull()
  })
})

describe('update lock', () => {
  it('is fresh for under 3 minutes', () => {
    expect(isUpdateLockFresh(0, 179_000)).toBe(true)
    expect(isUpdateLockFresh(0, 180_000)).toBe(false)
  })
})
