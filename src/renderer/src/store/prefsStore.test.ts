import { describe, expect, it, vi } from 'vitest'
import { createLocaleSync, resolveInitialLocale } from './prefsStore'

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

describe('native locale synchronization', () => {
  it('sends the saved or initial preference and each language change, once', () => {
    const send = vi.fn()
    const sync = createLocaleSync(send)
    sync('zh')
    sync('zh')
    sync('en')
    sync('en')
    sync('zh')
    expect(send.mock.calls).toEqual([['zh'], ['en'], ['zh']])
  })
})
