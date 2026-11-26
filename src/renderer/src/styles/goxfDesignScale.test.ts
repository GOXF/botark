import { describe, expect, it } from 'vitest'
import {
  classify,
  coveredTokens,
  escapeClass,
  generateCss,
  ruleFor,
  runCheck
} from '../../../../scripts/goxf-design-check.mjs'

// GOXF: upstream's off-scale design classes must all be remapped by
// styles/goxf-scale.css. Fails after an upstream merge introduces a new value;
// fix with `npm run design:check -- --write` (after extending MAPPING if needed).
describe('goxf design scale', () => {
  it('has no unmapped off-scale design classes in renderer .tsx', () => {
    const { violations } = runCheck()
    const report = violations.map((v) => `${v.file}:${v.line} ${v.token} (${v.reason})`)
    expect(report).toEqual([])
  })

  it('goxf-scale.css is up to date with the mapping', () => {
    const covered = coveredTokens()
    const expected = generateCss()
    for (const m of expected.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.((?:\\.|[a-zA-Z0-9_-])+)/g)) {
      expect(covered.has(m[1].replace(/\\(.)/g, '$1'))).toBe(true)
    }
  })

  it('classifies the scale', () => {
    expect(classify('text-[12px]')).toBe('ok')
    expect(classify('text-[10px]')).toBe('ok')
    expect(classify('text-[11.5px]')).toBe('offscale')
    expect(classify('rounded')).toBe('offscale')
    expect(classify('rounded-tl-md')).toBe('ok')
    expect(classify('shadow-soft')).toBe('ok')
    expect(classify('shadow-xs')).toBe('offscale')
    expect(classify('bg-white/15')).toBe('ok')
    expect(classify('text-amber-600')).toBe('offscale')
    expect(classify('transition-shadow')).toBe(null)
  })

  it('escapes selectors and wraps variants', () => {
    expect(escapeClass('sm:text-[11.5px]')).toBe('sm\\:text-\\[11\\.5px\\]')
    expect(ruleFor('sm:text-[32px]')?.css).toBe('@media (width >= 40rem) { .sm\\:text-\\[32px\\] { font-size: 28px; } }')
    expect(ruleFor('hover:shadow-xs')?.css).toContain('.hover\\:shadow-xs:hover')
    expect(ruleFor('!text-[11.5px]')?.css).toContain('font-size: 12px !important')
  })
})
