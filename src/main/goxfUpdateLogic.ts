/**
 * GOXF fork only: pure update logic (no Electron), unit-tested in goxfUpdateLogic.test.ts.
 *
 * Version scheme
 *   package.json "version"   = the upstream release this fork is based on (e.g. 0.12.0)
 *   package.json "goxfBuild" = fork build counter on top of that base (1, 2, 3, …)
 *   fork version / tag       = v<version>-goxf.<goxfBuild>   e.g. v0.12.0-goxf.1
 * "Upstream has an update"  → upstream latest tag > version
 * "My fork has an update"   → (base, build) of newest v*-goxf.* release > (version, goxfBuild)
 */

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
}

export interface GitHubRelease {
  tag_name?: string
  name?: string
  html_url?: string
  draft?: boolean
  prerelease?: boolean
  body?: string
  assets?: ReleaseAsset[]
}

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i
const GOXF_RE = /^v?(\d+)\.(\d+)\.(\d+)-goxf\.(\d+)$/i

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
    (a) => a && typeof a.name === 'string' && /\.exe$/i.test(a.name) && /portable/i.test(a.name) && a.browser_download_url
  )
  return exes.find((a) => /x64/i.test(a.name)) ?? exes[0] ?? null
}

/** The portable x64 zip (unpack-and-run folder build), e.g. "BotArk-Portable-0.12.0-goxf.2-win-x64.zip". */
export function pickPortableZipAsset(assets: ReleaseAsset[] | null | undefined): ReleaseAsset | null {
  const zips = (assets ?? []).filter(
    (a) => a && typeof a.name === 'string' && /\.zip$/i.test(a.name) && /portable/i.test(a.name) && a.browser_download_url
  )
  return zips.find((a) => /x64/i.test(a.name)) ?? zips[0] ?? null
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
  upstreamRepo?: string
  forkRepo?: string
}

export interface PromptDecision {
  upstream: { version: string; url: string } | null
  portable: { version: string; url: string; canSelfUpdate: boolean; asset: ReleaseAsset | null } | null
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

  const latest = pickLatestGoxfRelease(input.forkReleases)
  const base = parseSemver(input.version)
  if (latest && base) {
    const current: GoxfVersion = { base, build: input.goxfBuild }
    if (compareGoxf(latest.version, current) > 0) {
      // Each build kind replaces itself with the same kind of asset.
      const asset =
        input.portable === 'zip'
          ? pickPortableZipAsset(latest.release.assets)
          : pickPortableAsset(latest.release.assets)
      decision.portable = {
        version: latest.versionText,
        url: latest.release.html_url || `https://github.com/${forkRepo}/releases/tag/v${latest.versionText}`,
        canSelfUpdate: input.portable !== null && input.platform === 'win32' && asset !== null,
        asset
      }
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
