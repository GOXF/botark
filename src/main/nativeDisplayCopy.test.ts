import { beforeEach, describe, expect, it, vi } from 'vitest'

const getLocale = vi.hoisted(() => vi.fn<() => string>())
vi.mock('electron', () => ({ app: { getLocale } }))

let display: typeof import('./nativeDisplayCopy')
beforeEach(async () => {
  getLocale.mockReset()
  vi.resetModules()
  display = await import('./nativeDisplayCopy')
})

describe('native display copy', () => {
  it('selects English for an English system locale', () => {
    getLocale.mockReturnValue('en-US')
    expect(display.nativeDisplayCopy('取消', 'Cancel')).toBe('Cancel')
  })

  it('retains Simplified Chinese when the native locale is Chinese', () => {
    getLocale.mockReturnValue('zh-CN')
    expect(display.nativeDisplayCopy('允许一次', 'Allow once')).toBe('允许一次')
  })

  it('preserves dynamic values when the native locale is not ready', () => {
    getLocale.mockImplementation(() => { throw new Error('app not ready') })
    expect(display.nativeDisplayCopy('目录：{0}', 'Folder: {0}', ['/tmp/test & notes'])).toBe('Folder: /tmp/test & notes')
  })
  it.each([
    ['zh-CN', 'en', 'Cancel'],
    ['en-US', 'zh', '取消']
  ])('uses the app preference (%s system, %s app)', (system, locale, expected) => {
    getLocale.mockReturnValue(system)
    expect(display.setNativeDisplayLocale(locale)).toBe(true)
    expect(display.nativeDisplayCopy('取消', 'Cancel')).toBe(expected)
    expect(display.setNativeDisplayLocale(locale)).toBe(false)
    expect(display.setNativeDisplayLocale({ locale })).toBe(false)
    expect(display.nativeDisplayCopy('取消', 'Cancel')).toBe(expected)
  })

})
