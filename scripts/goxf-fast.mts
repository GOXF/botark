#!/usr/bin/env node
// GOXF fork: fast dev build (no electron-builder) for .github/workflows/goxf-portable.yml. Run with node ≥22.18 (type stripping).
//   plan <releases.json>                           → "mode=fast\nbase=<tag>" or "mode=full\nreason=…" (GITHUB_OUTPUT lines)
//   assemble <baseResources> <baseManifest> <version> <outDir>
//                                                  → <outDir>/resources (base resources, app.asar rebuilt from out/ +
//                                                    package.json, node_modules kept from the base asar) and
//                                                    <outDir>/manifest.json (runtime entries copied from the base manifest)
//   prune <releases.json>                          → dev tags to delete, one per line
// releases.json = GitHub /releases list. Pure helpers are unit-tested in src/main/goxfFastBuild.test.ts.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  PATCH_PREFIX,
  pickDeltaAssets,
  pickPortableZipAsset,
  type GitHubRelease,
  type ManifestFile
} from '../src/main/goxfUpdateLogic.ts'

type Pkg = Record<string, unknown>
const DEV_RE = /-goxf\.dev\./i
const KEEP_DEV = 5

const publishedMs = (r: GitHubRelease): number => Date.parse(r.published_at ?? '') || 0
const newestFirst = (rs: GitHubRelease[]): GitHubRelease[] => [...rs].sort((a, b) => publishedMs(b) - publishedMs(a))
const isFull = (r: GitHubRelease): boolean => pickPortableZipAsset(r.assets) !== null

/** Base of a fast build: newest published goxf release (stable or dev) with full zip + manifest + patch. */
export function pickBaseRelease(releases: GitHubRelease[]): GitHubRelease | null {
  return (
    newestFirst(releases).find(
      (r) => !r.draft && /-goxf\./i.test(r.tag_name ?? '') && isFull(r) && pickDeltaAssets(r.assets) !== null
    ) ?? null
  )
}

/** Paths whose change since the base needs a real electron-builder run (runtime, packaging, icons). */
const FULL_PATHS = /^(package-lock\.json|electron-builder\.config\.cjs|build\/.*)$/
const RUNTIME_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies', 'overrides'] as const

/** Why the change from base to head needs a full build, or null when a fast (app.asar only) build is enough. */
export function fullBuildReason(basePkg: Pkg, headPkg: Pkg, changedPaths: string[]): string | null {
  const path = changedPaths.find((p) => FULL_PATHS.test(p))
  if (path) return `${path} changed`
  const key = RUNTIME_KEYS.find((k) => JSON.stringify(basePkg[k] ?? null) !== JSON.stringify(headPkg[k] ?? null))
  return key ? `package.json ${key} changed` : null
}

const DROP_KEYS = new Set(['dist', 'gitHead', 'build', 'jspm', 'ava', 'xo', 'nyc', 'eslintConfig', 'contributors', 'bundleDependencies', 'tags', 'scripts', 'keywords', 'devDependencies'])
/** The app's package.json as electron-builder 26 writes it into app.asar (app-builder-lib fileTransformer cleanupPackageJson, isMain). */
export function builderPackageJson(pkg: Pkg): string {
  const deps = pkg.dependencies
  const dropBabel = deps != null && typeof deps === 'object' && !Object.keys(deps).some((k) => k.startsWith('babel'))
  const out: Pkg = {}
  for (const [k, v] of Object.entries(pkg)) {
    if (k.startsWith('_') || DROP_KEYS.has(k) || (dropBabel && k === 'babel')) continue
    out[k] = v
  }
  return JSON.stringify(out, null, 2)
}

/** Runtime (outside resources/) entries from the base manifest + the freshly built resources/ entries. */
export function mergeManifest(base: ManifestFile[], resources: ManifestFile[]): ManifestFile[] {
  return [...base.filter((f) => !f.path.startsWith(PATCH_PREFIX)), ...resources].sort((a, b) => (a.path < b.path ? -1 : 1))
}

/** Dev releases to delete: all but the newest KEEP_DEV, never the newest release that has a full zip. */
export function devReleasesToPrune(releases: GitHubRelease[]): string[] {
  const sorted = newestFirst(releases)
  const keepFull = sorted.find((r) => !r.draft && isFull(r))
  return sorted
    .filter((r) => r.prerelease && DEV_RE.test(r.tag_name ?? ''))
    .slice(KEEP_DEV)
    .filter((r) => r !== keepFull)
    .map((r) => r.tag_name!)
}

function plan(releasesFile: string): string {
  const base = pickBaseRelease(JSON.parse(readFileSync(releasesFile, 'utf8')) as GitHubRelease[])
  if (!base?.tag_name) return 'mode=full\nreason=no full release with manifest + patch to build on'
  const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8' })
  let reason: string | null
  try {
    const basePkg = JSON.parse(git('show', `${base.tag_name}:package.json`)) as Pkg
    const headPkg = JSON.parse(readFileSync('package.json', 'utf8')) as Pkg
    reason = fullBuildReason(basePkg, headPkg, git('diff', '--name-only', base.tag_name, 'HEAD').split('\n').filter(Boolean))
  } catch (error) {
    reason = `cannot diff against ${base.tag_name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
  }
  return reason ? `mode=full\nreason=${reason} since ${base.tag_name}` : `mode=fast\nbase=${base.tag_name}`
}

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
}

async function assemble(baseResources: string, baseManifest: string, version: string, outDir: string): Promise<void> {
  // shortcut: unpacked asar files (native modules) are not reproduced; their deps change → full build anyway.
  if (existsSync(join(baseResources, 'app.asar.unpacked'))) throw new Error('base has app.asar.unpacked; use a full build')
  const asar = await import('@electron/asar')
  const resources = join(outDir, 'resources')
  rmSync(outDir, { recursive: true, force: true })
  cpSync(baseResources, resources, { recursive: true })
  const app = mkdtempSync(join(tmpdir(), 'goxf-asar-'))
  asar.extractAll(join(baseResources, 'app.asar'), app)
  // electron-builder files: ['out/**/*', 'package.json'] + production node_modules (unchanged: deps match the base).
  rmSync(join(app, 'out'), { recursive: true, force: true })
  cpSync('out', join(app, 'out'), { recursive: true })
  writeFileSync(join(app, 'package.json'), builderPackageJson(JSON.parse(readFileSync('package.json', 'utf8')) as Pkg))
  await asar.createPackage(app, join(resources, 'app.asar'))
  rmSync(app, { recursive: true, force: true })

  const base = (JSON.parse(readFileSync(baseManifest, 'utf8')) as { files: ManifestFile[] }).files
  const fresh = listFiles(resources).map((p) => {
    const file = join(resources, ...p.split('/'))
    return { path: PATCH_PREFIX + p, sha256: sha256(file), size: statSync(file).size }
  })
  const files = mergeManifest(base, fresh)
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ version, patchPrefix: PATCH_PREFIX, files }, null, 1))
  console.error(`assembled: ${fresh.length} resources files, ${files.length} manifest entries`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...args] = process.argv.slice(2)
  if (cmd === 'plan' && args[0]) console.log(plan(args[0]))
  else if (cmd === 'prune' && args[0]) {
    const tags = devReleasesToPrune(JSON.parse(readFileSync(args[0], 'utf8')) as GitHubRelease[])
    if (tags.length) console.log(tags.join('\n'))
  } else if (cmd === 'assemble' && args.length === 4) await assemble(args[0], args[1], args[2], args[3])
  else {
    console.error('usage: goxf-fast.mts plan <releases.json> | prune <releases.json> | assemble <baseResources> <baseManifest> <version> <outDir>')
    process.exit(1)
  }
}
