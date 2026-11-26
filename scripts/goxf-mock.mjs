#!/usr/bin/env node
/**
 * GOXF design mockups: build the mock entry, serve it, screenshot each mock
 * in light and dark.
 *
 *   node scripts/goxf-mock.mjs <name> [more names…] [--out <dir>] [--no-build]
 *
 * Writes <out>/<name>-light.png and <out>/<name>-dark.png (default out: ./work/mock).
 * Mocks live in src/renderer/src/mock/mocks and are listed in mock/registry.ts.
 * Needs playwright + chromium: resolved from the repo, or from $GOXF_PLAYWRIGHT_DIR
 * (default /tmp/shot): `cd /tmp/shot && npm i playwright && npx playwright install chromium`.
 */
import { spawnSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { extname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const names = []
let out = resolve('work/mock')
let build = true
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') out = resolve(args[++i])
  else if (args[i] === '--no-build') build = false
  else names.push(args[i])
}
if (!names.length) {
  console.error('usage: node scripts/goxf-mock.mjs <name> [--out <dir>] [--no-build]')
  process.exit(1)
}

async function loadPlaywright() {
  const dirs = [process.cwd(), process.env.GOXF_PLAYWRIGHT_DIR || '/tmp/shot']
  for (const dir of dirs) {
    try {
      const path = createRequire(join(dir, 'package.json')).resolve('playwright')
      const mod = await import(pathToFileURL(path).href)
      return mod.chromium ? mod : mod.default
    } catch {}
  }
  throw new Error('playwright not found — install it in /tmp/shot (see header of this script)')
}

const dist = resolve('dist/mock')
if (build) {
  const vite = resolve('node_modules/.bin/vite')
  const r = spawnSync(vite, ['build', '--config', 'vite.mock.config.mts', '--logLevel', 'warn'], { stdio: 'inherit' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
if (!existsSync(join(dist, 'mock.html'))) throw new Error(`missing ${dist}/mock.html — run without --no-build`)

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' }
const server = createServer((req, res) => {
  const path = resolve(dist, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname))
  if (!path.startsWith(dist + sep) || !existsSync(path) || !statSync(path).isFile()) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' })
  createReadStream(path).pipe(res)
})
await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
const port = server.address().port

const { chromium } = await loadPlaywright()
const browser = await chromium.launch()
mkdirSync(out, { recursive: true })
let failed = false
try {
  for (const name of names) {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2, colorScheme: theme })
      const errors = []
      page.on('pageerror', (e) => errors.push(String(e)))
      await page.goto(`http://127.0.0.1:${port}/mock.html?mock=${encodeURIComponent(name)}&theme=${theme}&e2e=1`)
      const frame = page.locator('#mock-frame')
      try {
        await frame.waitFor({ timeout: 10_000 })
      } catch {
        console.error(`✗ ${name} (${theme}): no #mock-frame — unknown mock or render error`, errors.join('\n'))
        failed = true
        await page.close()
        continue
      }
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(700) // let entrance animations and the segmented thumb settle
      const file = join(out, `${name}-${theme}.png`)
      await frame.screenshot({ path: file, animations: 'disabled' })
      if (errors.length) console.warn(`! ${name} (${theme}) page errors:\n${errors.join('\n')}`)
      console.log(`✓ ${file}`)
      await page.close()
    }
  }
} finally {
  await browser.close()
  server.close()
}
process.exit(failed ? 1 : 0)
