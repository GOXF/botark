#!/usr/bin/env node
/**
 * GOXF design-scale check (fork-only, no deps).
 *
 * The fork converges type / radius / shadow / color across the app WITHOUT
 * editing upstream component files: off-scale utility classes are remapped by
 * unlayered override rules in src/renderer/src/styles/goxf-scale.css.
 *
 * This script scans src/renderer/src/**\/*.tsx (tests excluded) and reports
 * every text-[Npx] / text-<named> / rounded-* / shadow-* / palette color class
 * that is neither on the allowed scale nor covered by a selector in
 * goxf-scale.css. Run after every upstream merge:
 *
 *   npm run design:check            # report, exit 1 on violations
 *   npm run design:check -- --write # regenerate goxf-scale.css from MAPPING
 *
 * If a new value appears upstream: add it to MAPPING below (nearest allowed
 * value), then run with --write and commit the regenerated CSS.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(HERE, '..')
export const RENDERER_DIR = path.join(REPO_ROOT, 'src/renderer/src')
export const SCALE_CSS = path.join(RENDERER_DIR, 'styles/goxf-scale.css')

/* ------------------------------------------------------------------ scale */

/** Allowed arbitrary font sizes (px). 10 is reserved for unread badges. */
export const ALLOWED_TEXT_PX = new Set(['10', '11', '12', '13', '14', '15', '17', '28'])
/** Allowed named font sizes: xs=12, sm=14, ui=14, caption=12. */
export const ALLOWED_TEXT_NAMED = new Set(['xs', 'sm', 'ui', 'caption'])
export const ALLOWED_RADIUS = new Set(['none', 'sm', 'md', 'lg', 'xl', '2xl', 'full'])
/**
 * Arbitrary radii upstream uses on purpose (pill composer 22→18 morph, segmented
 * controls, board cards…). Tolerated as-is, NOT remapped; a new value fails the
 * check so someone decides whether it maps to a token.
 */
export const ALLOWED_RADIUS_ARBITRARY = new Set(['3px', '4px', '9px', '10px', '11px', '12px', '14px', '18px', '20px', '22px'])
export const ALLOWED_SHADOW = new Set(['soft', 'float', 'hairline', 'card', 'pop', 'toast', 'dialog', 'none'])
/** Neutral palette colors tolerated anywhere (media overlays, on-dark text). */
export const ALLOWED_PALETTE = new Set(['black', 'white'])
/** Individually reviewed exceptions (exact class, any variant). */
export const ALLOWED_EXCEPTIONS = new Set([
  'bg-[#0b0f14]' // ChatArea: dark backdrop of the embedded Hark browser side slot
])

/**
 * Off-scale class -> replacement declaration(s).
 * Keys are bare utility names (no variant / important modifier).
 */
const fs_ = (px) => ({ 'font-size': `${px}px` })
const radius = (name) => ({ 'border-radius': `var(--radius-${name})` })
const SOFT = { '--tw-shadow': 'var(--shadow-soft)' }
const tint = (token, pct) => ({
  'background-color': `color-mix(in oklab, var(--color-${token}) ${pct}%, transparent)`
})
export const MAPPING = {
  // font sizes
  'text-[9px]': fs_(11),
  'text-[9.5px]': fs_(11),
  'text-[10.5px]': fs_(11),
  'text-[11.5px]': fs_(12),
  'text-[12.5px]': fs_(13),
  'text-[13.5px]': fs_(14),
  'text-[14.5px]': fs_(15),
  'text-[16px]': fs_(15),
  'text-[18px]': fs_(17),
  'text-[20px]': fs_(17),
  'text-[22px]': fs_(17),
  'text-[26px]': fs_(28),
  'text-[30px]': fs_(28),
  'text-[32px]': fs_(28),
  'text-lg': fs_(17), // 18px named size; line-height left as Tailwind sets it
  // radius
  rounded: radius('md'),
  'rounded-3xl': radius('2xl'),
  'rounded-xs': radius('sm'),
  // shadows (only --tw-shadow is swapped, so rings etc. still compose)
  shadow: SOFT,
  'shadow-2xs': SOFT,
  'shadow-xs': SOFT,
  'shadow-sm': SOFT,
  // palette colors -> status tokens
  'text-amber-400': { color: 'var(--color-status-attention-ink)' },
  'text-amber-500': { color: 'var(--color-status-attention)' },
  'text-amber-600': { color: 'var(--color-status-attention-ink)' },
  'bg-amber-500/15': tint('status-attention', 15),
  'text-orange-400': { color: 'var(--color-status-attention-ink)' },
  'text-orange-600': { color: 'var(--color-status-attention-ink)' },
  'bg-orange-500/15': tint('status-attention', 15),
  'text-emerald-600': { color: 'var(--color-status-online-ink)' }
}

/** Overlay tokens (also consumed by fork files: bg-overlay, text-on-overlay…). */
export const OVERLAY_TOKENS = {
  '--color-overlay': 'rgb(0 0 0 / 0.6)',
  '--color-overlay-strong': 'rgb(0 0 0 / 0.82)',
  '--color-on-overlay': '#fff',
  '--color-on-overlay-muted': 'rgb(255 255 255 / 0.7)'
}

/* -------------------------------------------------------------- variants */

const BREAKPOINTS = { sm: '40rem', md: '48rem', lg: '64rem', xl: '80rem', '2xl': '96rem' }
const PSEUDO = {
  hover: ':hover',
  focus: ':focus',
  'focus-visible': ':focus-visible',
  'focus-within': ':focus-within',
  active: ':active',
  disabled: ':disabled',
  placeholder: '::placeholder',
  before: '::before',
  after: '::after'
}

/** Returns { media: string[], wrap(sel) } or null when the variant is unsupported. */
function variantPart(v) {
  if (BREAKPOINTS[v]) return { media: [`(width >= ${BREAKPOINTS[v]})`], wrap: (s) => s }
  if (v === 'dark') return { media: [], wrap: (s) => `${s}:where([data-theme=dark], [data-theme=dark] *)` }
  const group = /^group-(hover|focus|focus-visible|focus-within|active)(?:\/([\w-]+))?$/.exec(v)
  if (group) {
    const g = group[2] ? `.group\\/${group[2]}` : '.group'
    const media = group[1] === 'hover' ? ['(hover: hover)'] : []
    return { media, wrap: (s) => `${s}:is(:where(${g})${PSEUDO[group[1]]} *)` }
  }
  if (PSEUDO[v]) {
    const media = v === 'hover' ? ['(hover: hover)'] : []
    return { media, wrap: (s) => `${s}${PSEUDO[v]}` }
  }
  return null
}

/* ---------------------------------------------------------------- parsing */

const PALETTE =
  'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone|black|white'
const COLOR_PROPS = 'bg|text|border(?:-[trblxyse])?|ring|ring-offset|outline|fill|stroke|from|via|to|divide|decoration|placeholder|caret|accent|shadow'

const RE_TEXT_PX = /^text-\[(\d+(?:\.\d+)?)px\]$/
const RE_TEXT_NAMED = /^text-(xs|sm|base|lg|xl|[2-9]xl|ui|caption)$/
const RE_ROUNDED = /^rounded(?:-(?:t|r|b|l|s|e|tl|tr|br|bl|ss|se|es|ee))?(?:-([a-z0-9]+|\[[^\]]+\]))?$/
const RE_SHADOW = /^shadow(?:-([a-z0-9]+|\[[^\]]+\]))?$/
const RE_PALETTE = new RegExp(`^(?:${COLOR_PROPS})-(${PALETTE})(?:-\\d{2,3})?(?:\\/\\d+)?$`)
const RE_ARB_COLOR = new RegExp(`^(?:${COLOR_PROPS})-\\[(?:#|rgb|hsl|oklch|oklab|color)[^\\]]*\\]$`)

/** Split a candidate token into { variants, important, base }. */
export function splitToken(raw) {
  let tok = raw
  let important = false
  // split variants on ':' outside brackets
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of tok) {
    if (ch === '[') depth++
    if (ch === ']') depth--
    if (ch === ':' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  let base = parts.pop()
  if (base.startsWith('!')) {
    important = true
    base = base.slice(1)
  }
  if (base.endsWith('!')) {
    important = true
    base = base.slice(0, -1)
  }
  return { variants: parts, important, base }
}

/** Classify a base utility: null (not a design class), 'ok', or 'offscale'. */
export function classify(base) {
  if (ALLOWED_EXCEPTIONS.has(base)) return 'ok'
  let m
  if ((m = RE_TEXT_PX.exec(base))) return ALLOWED_TEXT_PX.has(m[1]) ? 'ok' : 'offscale'
  if ((m = RE_TEXT_NAMED.exec(base))) return ALLOWED_TEXT_NAMED.has(m[1]) ? 'ok' : 'offscale'
  if ((m = RE_ROUNDED.exec(base))) {
    if (m[1] && ALLOWED_RADIUS.has(m[1])) return 'ok'
    if (m[1] && m[1].startsWith('[') && ALLOWED_RADIUS_ARBITRARY.has(m[1].slice(1, -1))) return 'ok'
    return 'offscale'
  }
  if ((m = RE_SHADOW.exec(base))) {
    if (!m[1]) return 'offscale'
    if (ALLOWED_SHADOW.has(m[1])) return 'ok'
    // shadow-<palette> (shadow color) is handled by the palette branch below
    if (!RE_PALETTE.test(base)) return 'offscale'
  }
  if ((m = RE_PALETTE.exec(base))) return ALLOWED_PALETTE.has(m[1]) ? 'ok' : 'offscale'
  if (RE_ARB_COLOR.test(base)) return 'offscale'
  return null
}

const TOKEN_RE = /[!\w\-:./[\]#%(),&=@]+/g
const CANDIDATE_RE = /(?:^|:|!)(?:text|rounded|shadow|bg|border|ring|outline|fill|stroke|from|via|to|divide|decoration|placeholder|caret|accent)\b/

function listTsx(dir) {
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules' || ent.name === '__tests__') continue
      out.push(...listTsx(p))
    } else if (ent.name.endsWith('.tsx') && !/\.(test|spec)\.tsx$/.test(ent.name)) out.push(p)
  }
  return out.sort()
}

/** Every design-relevant class occurrence: { file, line, token, variants, important, base, status }. */
export function scanUsages(rootDir = RENDERER_DIR) {
  const hits = []
  for (const file of listTsx(rootDir)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((text, i) => {
      for (const m of text.matchAll(TOKEN_RE)) {
        let tok = m[0].replace(/^[(,]+|[),.]+$/g, '')
        if (!CANDIDATE_RE.test(tok)) continue
        const { variants, important, base } = splitToken(tok)
        const status = classify(base)
        if (!status) continue
        hits.push({ file: path.relative(REPO_ROOT, file), line: i + 1, token: tok, variants, important, base, status })
      }
    })
  }
  return hits
}

/* -------------------------------------------------------------------- CSS */

export function escapeClass(cls) {
  return cls.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`)
}

export function ruleFor(token) {
  const { variants, important, base } = splitToken(token)
  const decl = MAPPING[base]
  if (!decl) return null
  let sel = `.${escapeClass(token)}`
  const media = []
  // Tailwind applies variants inside-out; order is irrelevant for the ones we support.
  for (const v of variants) {
    const part = variantPart(v)
    if (!part) return null
    sel = part.wrap(sel)
    media.push(...part.media)
  }
  const imp = important ? ' !important' : ''
  const body = Object.entries(decl)
    .map(([k, val]) => `${k}: ${val}${imp};`)
    .join(' ')
  let css = `${sel} { ${body} }`
  for (const q of media.reverse()) css = `@media ${q} { ${css} }`
  return { css, depth: variants.length }
}

/** Selectors (as class strings, unescaped) present in goxf-scale.css. */
export function coveredTokens(cssPath = SCALE_CSS) {
  if (!fs.existsSync(cssPath)) return new Set()
  const css = fs.readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const set = new Set()
  for (const m of css.matchAll(/\.((?:\\.|[a-zA-Z0-9_-])+)/g)) set.add(m[1].replace(/\\(.)/g, '$1'))
  return set
}

export function generateCss(hits = scanUsages()) {
  // every mapped base class always gets a rule; variant/important forms only when used
  const tokens = [...new Set([...Object.keys(MAPPING), ...hits.filter((h) => h.status === 'offscale').map((h) => h.token)])]
  const rules = tokens
    .map((t) => ({ t, r: ruleFor(t) }))
    .filter((x) => x.r)
    .sort((a, b) => a.r.depth - b.r.depth || a.t.localeCompare(b.t))
  const theme = Object.entries(OVERLAY_TOKENS)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n')
  return `/*
 * GOXF design scale — GENERATED by scripts/goxf-design-check.mjs --write.
 * Do not edit by hand: change MAPPING in the script and regenerate.
 *
 * These rules are deliberately UNLAYERED so they beat Tailwind's layered
 * utilities and converge upstream's off-scale classes onto the fork's scale
 * without touching upstream component files. Variant rules come last so
 * e.g. sm:text-[32px] still overrides the base size at that breakpoint.
 */
@theme {
  /* Overlay tokens: text/surfaces on dark media overlays. */
${theme}
}

${rules.map((x) => x.r.css).join('\n')}
`
}

/* ------------------------------------------------------------------ check */

export function runCheck({ rootDir = RENDERER_DIR, cssPath = SCALE_CSS } = {}) {
  const hits = scanUsages(rootDir)
  const covered = coveredTokens(cssPath)
  const violations = []
  for (const h of hits) {
    if (h.status !== 'offscale') continue
    if (!MAPPING[h.base]) violations.push({ ...h, reason: 'not on scale and no MAPPING entry' })
    else if (!ruleFor(h.token)) violations.push({ ...h, reason: `unsupported variant "${h.variants.join(':')}"` })
    else if (!covered.has(h.token)) violations.push({ ...h, reason: 'mapped but missing from goxf-scale.css (run with --write)' })
  }
  return { hits, violations }
}

function main() {
  const args = process.argv.slice(2)
  if (args.includes('--write')) {
    fs.writeFileSync(SCALE_CSS, generateCss())
    console.log(`wrote ${path.relative(REPO_ROOT, SCALE_CSS)}`)
  }
  const { hits, violations } = runCheck()
  const offscale = hits.filter((h) => h.status === 'offscale').length
  if (violations.length === 0) {
    console.log(`design:check OK — ${hits.length} design classes scanned, ${offscale} off-scale all remapped by goxf-scale.css`)
    return
  }
  console.error(`design:check FAILED — ${violations.length} unmapped design class use(s):`)
  for (const v of violations) console.error(`  ${v.file}:${v.line}  ${v.token}  (${v.reason})`)
  process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
