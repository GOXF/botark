import { describe, expect, it } from 'vitest'
import { resolveInitialLocale } from './prefsStore'

describe('initial display language', () => {
  it('matches supported system languages in preference order', () => {
    expect(resolveInitialLocale(['en-GB', 'zh-CN'])).toBe('en')
    expect(resolveInitialLocale(['zh-Hant-TW', 'en-US'])).toBe('zh')
    expect(resolveInitialLocale(['fr-CA', 'ZH_cn', 'en-US'])).toBe('zh')
  })

  it('falls back to English for unsupported or absent preferences', () => {
    expect(resolveInitialLocale(['ko-KR', 'fr-FR'])).toBe('en')
    expect(resolveInitialLocale([])).toBe('en')
  })
})
