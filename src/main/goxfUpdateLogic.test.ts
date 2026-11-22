import { describe, expect, it } from 'vitest'
import {
  buildReplaceScript,
  buildZipReplaceScript,
  decideUpdatePrompts,
  formatGoxfVersion,
  isNewerSemver,
  normalizeGoxfBuild,
  parseGoxfVersion,
  pickLatestGoxfRelease,
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

describe('buildZipReplaceScript', () => {
  const s = buildZipReplaceScript({
    appDir: 'D:\\工具\\BotArk',
    zipFile: 'D:\\工具\\BotArk\\.botark-update.zip',
    exeName: 'BotArk.exe',
    pid: 42,
    logFile: 'D:\\工具\\BotArk\\BotArk-Data\\portable-update.log'
  })
  it('never touches the data folder or the downloaded zip', () => {
    expect(s).toContain("$keep = @('BotArk-Data'")
    expect(s).toContain('(Split-Path -Leaf $zip)')
    expect(s).toContain("Where-Object { $_.Name -ne 'BotArk-Data' }")
  })
  it('moves old files out before new ones in, and rolls back on failure', () => {
    expect(s.indexOf("$phase = 'in'")).toBeGreaterThan(s.indexOf('-Destination $backup'))
    expect(s).toMatch(/rolling back/)
    expect(s).toContain('$appPid = 42')
    expect(s).toContain("$app = 'D:\\工具\\BotArk'")
  })
  it('refuses a zip without the app exe', () => {
    expect(s).toContain('zip does not contain the app exe')
  })
})
