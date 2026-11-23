#!/usr/bin/env node
// GOXF fork: delta-update manifest for the portable folder (read by src/main/goxfUpdater.ts).
// Usage: node scripts/goxf-manifest.mjs <programDir> <version> <out.json>
// Lists every file under programDir except BotArk-Data: { path (forward slashes), sha256, size }.
import { createHash } from 'node:crypto'
import { createReadStream, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const [dir, version, out] = process.argv.slice(2)
if (!dir || !version || !out) {
  console.error('usage: goxf-manifest.mjs <programDir> <version> <out.json>')
  process.exit(1)
}

const sha256 = (path) =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })

const files = []
for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue
  const full = join(entry.parentPath ?? entry.path, entry.name)
  const path = relative(dir, full).split(sep).join('/')
  if (path === 'BotArk-Data' || path.startsWith('BotArk-Data/')) continue
  files.push({ path, sha256: await sha256(full), size: statSync(full).size })
}
if (files.length === 0) throw new Error(`no files under ${dir}`)
files.sort((a, b) => (a.path < b.path ? -1 : 1))
writeFileSync(out, JSON.stringify({ version, patchPrefix: 'resources/', files }, null, 1))
console.log(`manifest: ${files.length} files → ${out}`)
