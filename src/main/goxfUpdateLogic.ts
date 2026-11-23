/**
 * GOXF fork only: pure update logic (no Electron), unit-tested in goxfUpdateLogic.test.ts.
 *
 * Version scheme
 *   package.json "version"   = the upstream release this fork is based on (e.g. 0.12.0)
 *   package.json "goxfBuild" = fork build counter on top of that base (1, 2, 3, …)
 *   fork version / tag       = v<version>-goxf.<goxfBuild>   e.g. v0.12.0-goxf.1
 * "Upstream has an update"  → upstream latest tag > version
 * "My fork has an update"   → (base, build) of newest v*-goxf.* release > (version, goxfBuild)
 *
 * Channels (setting in BotArk-Data/goxf-update.json, default stable)
 *   stable = non-prerelease v*-goxf.N releases, compared by (base, build) as above
 *   test   = also CI prereleases v<ver>-goxf.dev.<sha> from every push to goxf/portable;
 *            newest by published_at, offered when it is a different build published after ours
 *            (our tag + build time are stamped into package.json by CI: goxfTag, goxfBuiltAt)
 */
import type { GoxfUpdateChannel } from '@shared/goxfUpdate'

export interface SemverTriple {
  major: number
  minor: number
  patch: number
}

export interface GoxfVersion {
  base: SemverTriple
  build: number
}

export interface ReleaseAsset {
  name: string
  browser_download_url: string
  size?: number
  /** GitHub sets 'uploaded' once the file is complete; 'new' while CI is still uploading. */
  state?: string
}

/** Offer only assets GitHub reports as fully uploaded (CI creates the release before its uploads finish). */
const isUploaded = (a: ReleaseAsset): boolean => (a.state === undefined || a.state === 'uploaded') && a.size !== 0

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

/** Next check delay: daily after a success; after failures 1h, 2h, 4h, then capped at 6h. */
export function nextCheckDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return DAY_MS
  return Math.min(HOUR_MS * 2 ** (consecutiveFailures - 1), 6 * HOUR_MS)
}

export interface GitHubRelease {
  tag_name?: string
  name?: string
  html_url?: string
  draft?: boolean
  prerelease?: boolean
  published_at?: string
  body?: string
  assets?: ReleaseAsset[]
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i
const GOXF_RE = /^v?(\d+)\.(\d+)\.(\d+)-goxf\.(\d+)$/i
const GOXF_DEV_RE = /^v?\d+\.\d+\.\d+-goxf\.dev\.[0-9a-f]+$/i

export type GoxfChannel = GoxfUpdateChannel
export const normalizeChannel = (raw: unknown): GoxfChannel => (raw === 'test' ? 'test' : 'stable')

/** Parse "v1.2.3" / "1.2.3" / "1.2.3-beta" → base triple (pre-release suffix ignored). */
export function parseSemver(v: string | undefined | null): SemverTriple | null {
  const m = SEMVER_RE.exec(String(v ?? '').trim())
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

export function compareSemver(a: SemverTriple, b: SemverTriple): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

/** True when `remote` is a strictly newer base version than `current`. Unparseable → false. */
export function isNewerSemver(remote: string, current: string): boolean {
  const r = parseSemver(remote)
  const c = parseSemver(current)
  if (!r || !c) return false
  return compareSemver(r, c) > 0
}

/** Parse "v0.12.0-goxf.3" → { base: 0.12.0, build: 3 }. Anything else → null. */
export function parseGoxfVersion(tag: string | undefined | null): GoxfVersion | null {
  const m = GOXF_RE.exec(String(tag ?? '').trim())
  if (!m) return null
  return {
    base: { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) },
    build: Number(m[4])
  }
}

export function formatGoxfVersion(version: string, goxfBuild: number): string {
  return `${version.replace(/^v/i, '')}-goxf.${goxfBuild}`
}

export function compareGoxf(a: GoxfVersion, b: GoxfVersion): number {
  return compareSemver(a.base, b.base) || a.build - b.build
}

/** goxfBuild from package.json: a positive integer, otherwise 0 (= "no fork build yet"). */
export function normalizeGoxfBuild(raw: unknown): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : typeof raw === 'number' ? raw : Number.NaN
  return Number.isInteger(n) && n > 0 ? n : 0
}

/** Newest published (non-draft, non-prerelease) v*-goxf.* release in a releases list. */
export function pickLatestGoxfRelease(
  releases: GitHubRelease[] | null | undefined
): { release: GitHubRelease; version: GoxfVersion; versionText: string } | null {
  let best: { release: GitHubRelease; version: GoxfVersion; versionText: string } | null = null
  for (const release of releases ?? []) {
    if (!release || release.draft || release.prerelease) continue
    const parsed = parseGoxfVersion(release.tag_name)
    if (!parsed) continue
    if (!best || compareGoxf(parsed, best.version) > 0) {
      best = { release, version: parsed, versionText: String(release.tag_name).replace(/^v/i, '') }
    }
  }
  return best
}

/** The portable x64 exe among a release's assets (prefers "*Portable*x64*.exe"). */
export function pickPortableAsset(assets: ReleaseAsset[] | null | undefined): ReleaseAsset | null {
  const exes = (assets ?? []).filter(
    (a) => a && typeof a.name === 'string' && /\.exe$/i.test(a.name) && /portable/i.test(a.name) && a.browser_download_url && isUploaded(a)
  )
  return exes.find((a) => /x64/i.test(a.name)) ?? exes[0] ?? null
}

/** The portable x64 zip (unpack-and-run folder build), e.g. "BotArk-Portable-0.12.0-goxf.2-win-x64.zip". */
export function pickPortableZipAsset(assets: ReleaseAsset[] | null | undefined): ReleaseAsset | null {
  const zips = (assets ?? []).filter(
    (a) =>
      a && typeof a.name === 'string' && /\.zip$/i.test(a.name) && !/^patch-/i.test(a.name) && /portable/i.test(a.name) && a.browser_download_url && isUploaded(a)
  )
  return zips.find((a) => /x64/i.test(a.name)) ?? zips[0] ?? null
}

/** Delta assets next to the zip: "manifest-<zip name>.json" + "patch-<zip name>.zip". Both or nothing. */
export function pickDeltaAssets(
  assets: ReleaseAsset[] | null | undefined,
  zip: ReleaseAsset | null
): { manifest: ReleaseAsset; patch: ReleaseAsset } | null {
  if (!zip) return null
  const stem = zip.name.replace(/\.zip$/i, '')
  const find = (name: string) => (assets ?? []).find((a) => a?.name === name && a.browser_download_url && isUploaded(a))
  const manifest = find(`manifest-${stem}.json`)
  const patch = find(`patch-${stem}.zip`)
  return manifest && patch ? { manifest, patch } : null
}

const publishedMs = (r: GitHubRelease): number => Date.parse(r.published_at ?? '') || 0

/**
 * Release to offer on the test channel: newest non-draft goxf release (stable or dev) by published_at,
 * when its tag differs from ours and it was published after we were built. Without a build time
 * (local build) only a stable tag newer by (base, build) counts.
 */
export function pickTestChannelRelease(
  releases: GitHubRelease[] | null | undefined,
  own: { tag: string; builtAt: string | null; current: GoxfVersion | null }
): GitHubRelease | null {
  let best: GitHubRelease | null = null
  for (const r of releases ?? []) {
    if (!r || r.draft) continue
    const tag = String(r.tag_name ?? '')
    if (!GOXF_RE.test(tag) && !GOXF_DEV_RE.test(tag)) continue
    if (!best || publishedMs(r) > publishedMs(best)) best = r
  }
  if (!best || best.tag_name?.replace(/^v/i, '') === own.tag.replace(/^v/i, '')) return null
  const built = Date.parse(own.builtAt ?? '')
  if (built) return publishedMs(best) > built ? best : null
  const parsed = parseGoxfVersion(best.tag_name)
  return parsed && own.current && compareGoxf(parsed, own.current) > 0 ? best : null
}

/** How this copy runs: single portable exe, unpacked zip folder, or neither. */
export type PortableKind = 'exe' | 'zip' | null

export interface PromptInput {
  /** package.json version (upstream base), e.g. "0.12.0". */
  version: string
  goxfBuild: number
  /** Upstream /releases/latest payload (null when the check failed or found nothing). */
  upstreamLatest: GitHubRelease | null
  /** GOXF /releases list (null when the check failed). */
  forkReleases: GitHubRelease[] | null
  /** 'exe' = electron-builder portable launcher, 'zip' = unpacked folder with BotArk-Data next to it. */
  portable: PortableKind
  platform: string
  /** Default 'stable'. */
  channel?: GoxfChannel
  /** Our own release tag (package.json goxfTag, else v<version>-goxf.<goxfBuild>). */
  buildTag?: string
  /** When CI built us (package.json goxfBuiltAt), ISO time; null for local builds. */
  builtAt?: string | null
  upstreamRepo?: string
  forkRepo?: string
}

export interface PromptDecision {
  upstream: { version: string; url: string } | null
  portable: {
    version: string
    url: string
    canSelfUpdate: boolean
    asset: ReleaseAsset | null
    delta: { manifest: ReleaseAsset; patch: ReleaseAsset } | null
  } | null
}

/** Decide which of the two prompts to show. Both can be present at once. */
export function decideUpdatePrompts(input: PromptInput): PromptDecision {
  const upstreamRepo = input.upstreamRepo ?? 'qybaihe/botark'
  const forkRepo = input.forkRepo ?? 'GOXF/botark'
  const decision: PromptDecision = { upstream: null, portable: null }

  const up = input.upstreamLatest
  if (up && !up.draft && !up.prerelease) {
    const remote = String(up.tag_name || up.name || '').replace(/^v/i, '').trim()
    if (remote && isNewerSemver(remote, input.version)) {
      decision.upstream = {
        version: remote,
        url: up.html_url || `https://github.com/${upstreamRepo}/releases/tag/v${remote}`
      }
    }
  }

  const base = parseSemver(input.version)
  const current: GoxfVersion | null = base ? { base, build: input.goxfBuild } : null
  let release: GitHubRelease | null = null
  if (input.channel === 'test') {
    release = pickTestChannelRelease(input.forkReleases, {
      tag: input.buildTag || `v${formatGoxfVersion(input.version, input.goxfBuild)}`,
      builtAt: input.builtAt ?? null,
      current
    })
  } else {
    const latest = pickLatestGoxfRelease(input.forkReleases)
    if (latest && current && compareGoxf(latest.version, current) > 0) release = latest.release
  }
  if (release) {
    const versionText = String(release.tag_name).replace(/^v/i, '')
    // Each build kind replaces itself with the same kind of asset.
    const asset = input.portable === 'zip' ? pickPortableZipAsset(release.assets) : pickPortableAsset(release.assets)
    decision.portable = {
      version: versionText,
      url: release.html_url || `https://github.com/${forkRepo}/releases/tag/v${versionText}`,
      canSelfUpdate: input.portable !== null && input.platform === 'win32' && asset !== null,
      asset,
      delta: input.portable === 'zip' ? pickDeltaAssets(release.assets, asset) : null
    }
  }
  return decision
}

/** Escape a value for a single-quoted PowerShell string literal. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * PowerShell script that swaps the portable exe once BotArk has exited:
 *   1. wait for the app process (pid) to exit
 *   2. retry moving the old exe aside (the portable launcher holds it until it finishes cleanup)
 *   3. move the downloaded exe into the old path (shortcuts keep working), relaunch it
 *   4. on any failure roll back and relaunch the old exe; finally clean up backup + itself
 */
export function buildReplaceScript(opts: { oldExe: string; newExe: string; pid: number; logFile: string }): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$old = ${psQuote(opts.oldExe)}`,
    `$new = ${psQuote(opts.newExe)}`,
    `$log = ${psQuote(opts.logFile)}`,
    '$backup = "$old.old"',
    `$appPid = ${Math.trunc(opts.pid)}`,
    'function Log($m) { try { Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date -Format s), $m) } catch {} }',
    "Log 'BotArk portable update: waiting for app to exit'",
    'try { Wait-Process -Id $appPid -Timeout 90 -ErrorAction SilentlyContinue } catch {}',
    '$moved = $false',
    'for ($i = 0; $i -lt 240; $i++) {',
    '  try {',
    '    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }',
    '    Move-Item -LiteralPath $old -Destination $backup -Force',
    '    $moved = $true; break',
    '  } catch { Start-Sleep -Milliseconds 500 }',
    '}',
    'if (-not $moved) {',
    "  Log 'old exe still locked after 120s; leaving the download next to it and relaunching old exe'",
    '  Start-Process -FilePath $old -WorkingDirectory (Split-Path -LiteralPath $old)',
    '  exit 1',
    '}',
    'try {',
    '  Move-Item -LiteralPath $new -Destination $old -Force',
    '} catch {',
    '  Log ("swap failed: " + $_.Exception.Message + "; rolling back")',
    '  try { Move-Item -LiteralPath $backup -Destination $old -Force } catch {}',
    '  Start-Process -FilePath $old -WorkingDirectory (Split-Path -LiteralPath $old)',
    '  exit 1',
    '}',
    "Log 'swapped; relaunching'",
    'Start-Process -FilePath $old -WorkingDirectory (Split-Path -LiteralPath $old)',
    'Start-Sleep -Seconds 8',
    'try { Remove-Item -LiteralPath $backup -Force } catch { Log ("could not remove backup: " + $_.Exception.Message) }',
    'try { Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force } catch {}',
    ''
  ].join('\r\n')
}

/**
 * PowerShell script that updates an unpacked (zip) portable folder once BotArk has exited:
 *   1. wait for the app process (pid) to exit, unpack the zip into a staging folder
 *   2. move every old top-level entry except BotArk-Data aside (retry while files are still locked)
 *   3. move the new entries in (the zip's own BotArk-Data, if any, is ignored), relaunch the exe
 *   4. on any failure put the old entries back and relaunch; finally clean up staging, backup, zip, itself
 */
export function buildZipReplaceScript(opts: {
  appDir: string
  zipFile: string
  exeName: string
  pid: number
  logFile: string
}): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$app = ${psQuote(opts.appDir)}`,
    `$zip = ${psQuote(opts.zipFile)}`,
    `$exe = Join-Path $app ${psQuote(opts.exeName)}`,
    `$log = ${psQuote(opts.logFile)}`,
    "$keep = @('BotArk-Data', '.botark-update-stage', '.botark-update-old', (Split-Path -Leaf $zip))",
    "$stage = Join-Path $app '.botark-update-stage'",
    "$backup = Join-Path $app '.botark-update-old'",
    `$appPid = ${Math.trunc(opts.pid)}`,
    'function Log($m) { try { Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date -Format s), $m) } catch {} }',
    'function Relaunch { Start-Process -FilePath $exe -WorkingDirectory $app }',
    "Log 'BotArk zip update: waiting for app to exit'",
    'try { Wait-Process -Id $appPid -Timeout 90 -ErrorAction SilentlyContinue } catch {}',
    'try {',
    '  foreach ($d in @($stage, $backup)) { if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force } }',
    '  Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force',
    '} catch {',
    '  Log ("unpack failed: " + $_.Exception.Message)',
    '  Relaunch; exit 1',
    '}',
    '# A zip with a single top-level folder: use that folder as the new app root.',
    '$src = $stage',
    '$top = @(Get-ChildItem -LiteralPath $stage -Force)',
    'if ($top.Count -eq 1 -and $top[0].PSIsContainer) { $src = $top[0].FullName }',
    "if (-not (Test-Path -LiteralPath (Join-Path $src (Split-Path -Leaf $exe)))) {",
    "  Log 'zip does not contain the app exe; aborting'",
    '  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue',
    '  Relaunch; exit 1',
    '}',
    'New-Item -ItemType Directory -Path $backup -Force | Out-Null',
    '$old = @(Get-ChildItem -LiteralPath $app -Force | Where-Object { $keep -notcontains $_.Name -and $_.FullName -ne $zip })',
    '$movedOut = @()',
    "$phase = 'out'",
    'try {',
    '  foreach ($item in $old) {',
    '    $ok = $false',
    '    for ($i = 0; $i -lt 120; $i++) {',
    '      try { Move-Item -LiteralPath $item.FullName -Destination $backup -Force; $ok = $true; break } catch { Start-Sleep -Milliseconds 500 }',
    '    }',
    '    if (-not $ok) { throw ("still locked: " + $item.Name) }',
    '    $movedOut += $item.Name',
    '  }',
    "  $phase = 'in'",
    "  foreach ($item in @(Get-ChildItem -LiteralPath $src -Force | Where-Object { $_.Name -ne 'BotArk-Data' })) {",
    '    Move-Item -LiteralPath $item.FullName -Destination $app -Force',
    '  }',
    '} catch {',
    '  Log ("swap failed: " + $_.Exception.Message + "; rolling back")',
    '  # Only once every old entry was out did new ones come in; drop those before restoring.',
    "  if ($phase -eq 'in') {",
    '    foreach ($item in @(Get-ChildItem -LiteralPath $app -Force | Where-Object { $keep -notcontains $_.Name -and $_.FullName -ne $zip })) {',
    '      try { Remove-Item -LiteralPath $item.FullName -Recurse -Force } catch {}',
    '    }',
    '  }',
    '  foreach ($name in $movedOut) { try { Move-Item -LiteralPath (Join-Path $backup $name) -Destination $app -Force } catch {} }',
    '  Relaunch; exit 1',
    '}',
    "Log 'swapped; relaunching'",
    'Relaunch',
    'Start-Sleep -Seconds 8',
    'foreach ($d in @($stage, $backup)) { try { Remove-Item -LiteralPath $d -Recurse -Force } catch { Log ("cleanup: " + $_.Exception.Message) } }',
    'try { Remove-Item -LiteralPath $zip -Force } catch {}',
    'try { Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force } catch {}',
    ''
  ].join('\r\n')
}

/**
 * Delta update. CI ships, next to the full zip:
 *   manifest-<zip>.json  every file of the program folder (BotArk-Data excluded): { path, sha256, size }
 *   patch-<zip>.zip      the whole resources/ folder (app.asar, app.asar.unpacked, …): what changes between our builds
 * Everything outside resources/ is the Electron runtime. If every runtime file on disk matches the manifest,
 * only the patch is downloaded and only resources/ files whose sha256 differs are replaced; otherwise full zip.
 */
export const PATCH_PREFIX = 'resources/'

export interface ManifestFile {
  path: string
  sha256: string
  size: number
}

/** Validate a downloaded manifest (trust boundary): relative forward-slash paths only, sha256 hex. */
export function parseManifest(raw: unknown): ManifestFile[] | null {
  const files = (raw as { files?: unknown } | null)?.files
  if (!Array.isArray(files) || files.length === 0) return null
  const out: ManifestFile[] = []
  for (const f of files as Array<Partial<ManifestFile>>) {
    const path = f?.path
    if (typeof path !== 'string' || !path || path.startsWith('/') || /\\|^[a-z]:|(^|\/)\.\.?(\/|$)/i.test(path)) return null
    if (typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(f.sha256)) return null
    out.push({ path, sha256: f.sha256.toLowerCase(), size: Number(f.size) || 0 })
  }
  return out
}

export type DeltaPlan = { mode: 'patch'; changed: ManifestFile[] } | { mode: 'full'; reason: string }

/** local: path → sha256 of the file on disk (null = missing). */
export function planDelta(files: ManifestFile[], local: Record<string, string | null>): DeltaPlan {
  const changed: ManifestFile[] = []
  for (const f of files) {
    const same = local[f.path]?.toLowerCase() === f.sha256
    if (f.path.startsWith(PATCH_PREFIX)) {
      if (!same) changed.push(f)
    } else if (!same) {
      return { mode: 'full', reason: `runtime file differs: ${f.path}` }
    }
  }
  // goxfBuild lives in app.asar, so a real update always changes something here.
  if (changed.length === 0) return { mode: 'full', reason: 'patch would change nothing' }
  return { mode: 'patch', changed }
}

/**
 * PowerShell script that applies a delta once BotArk has exited:
 *   1. wait for the app (pid), unpack the patch zip into a staging folder
 *   2. check every file to replace against its manifest sha256 (abort before touching anything on mismatch)
 *   3. per file: move the old one into a backup folder (retry while locked), move the new one in
 *   4. on any failure restore the backed-up files, drop the added ones, relaunch; finally clean up
 */
export function buildDeltaReplaceScript(opts: {
  appDir: string
  patchZip: string
  files: Array<{ path: string; sha256: string }>
  exeName: string
  pid: number
  logFile: string
}): string {
  const list = opts.files.map((f) => `  @{ p = ${psQuote(f.path.replace(/\//g, '\\'))}; h = ${psQuote(f.sha256)} }`)
  return [
    "$ErrorActionPreference = 'Stop'",
    `$app = ${psQuote(opts.appDir)}`,
    `$zip = ${psQuote(opts.patchZip)}`,
    `$exe = Join-Path $app ${psQuote(opts.exeName)}`,
    `$log = ${psQuote(opts.logFile)}`,
    "$stage = Join-Path $app '.botark-update-stage'",
    "$backup = Join-Path $app '.botark-update-old'",
    `$appPid = ${Math.trunc(opts.pid)}`,
    '$files = @(',
    list.join(',\r\n'),
    ')',
    'function Log($m) { try { Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date -Format s), $m) } catch {} }',
    'function Relaunch { Start-Process -FilePath $exe -WorkingDirectory $app }',
    'function Parent($p) { New-Item -ItemType Directory -Path (Split-Path -Parent $p) -Force | Out-Null }',
    `Log 'BotArk delta update (${opts.files.length} files): waiting for app to exit'`,
    'try { Wait-Process -Id $appPid -Timeout 90 -ErrorAction SilentlyContinue } catch {}',
    'try {',
    '  foreach ($d in @($stage, $backup)) { if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force } }',
    '  Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force',
    '  foreach ($f in $files) {',
    '    $s = Join-Path $stage $f.p',
    '    if (-not (Test-Path -LiteralPath $s)) { throw ("missing in patch: " + $f.p) }',
    '    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $s).Hash -ne $f.h) { throw ("sha256 mismatch: " + $f.p) }',
    '  }',
    '} catch {',
    '  Log ("patch rejected: " + $_.Exception.Message)',
    '  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue',
    '  Relaunch; exit 1',
    '}',
    '$done = @()',
    'try {',
    '  foreach ($f in $files) {',
    '    $dst = Join-Path $app $f.p',
    '    $bak = Join-Path $backup $f.p',
    '    $hadOld = Test-Path -LiteralPath $dst',
    '    if ($hadOld) {',
    '      Parent $bak',
    '      $ok = $false',
    '      for ($i = 0; $i -lt 120; $i++) {',
    '        try { Move-Item -LiteralPath $dst -Destination $bak -Force; $ok = $true; break } catch { Start-Sleep -Milliseconds 500 }',
    '      }',
    '      if (-not $ok) { throw ("still locked: " + $f.p) }',
    '    }',
    '    $done += @{ dst = $dst; bak = $bak; hadOld = $hadOld }',
    '    Parent $dst',
    '    Move-Item -LiteralPath (Join-Path $stage $f.p) -Destination $dst -Force',
    '  }',
    '} catch {',
    '  Log ("swap failed: " + $_.Exception.Message + "; rolling back")',
    '  foreach ($d in $done) {',
    '    try { if (Test-Path -LiteralPath $d.dst) { Remove-Item -LiteralPath $d.dst -Force } } catch {}',
    '    if ($d.hadOld) { try { Move-Item -LiteralPath $d.bak -Destination $d.dst -Force } catch { Log ("restore failed: " + $d.dst) } }',
    '  }',
    '  Relaunch; exit 1',
    '}',
    "Log 'delta applied; relaunching'",
    'Relaunch',
    'Start-Sleep -Seconds 8',
    'foreach ($d in @($stage, $backup)) { try { Remove-Item -LiteralPath $d -Recurse -Force } catch { Log ("cleanup: " + $_.Exception.Message) } }',
    'try { Remove-Item -LiteralPath $zip -Force } catch {}',
    'try { Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force } catch {}',
    ''
  ].join('\r\n')
}
