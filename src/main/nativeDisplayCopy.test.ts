import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nativeDisplayCopy } from './nativeDisplayCopy'

const getLocale = vi.hoisted(() => vi.fn<() => string>())
vi.mock('electron', () => ({ app: { getLocale } }))

beforeEach(() => { getLocale.mockReset() })

describe('native display copy', () => {
  it('selects English for an English system locale', () => {
    getLocale.mockReturnValue('en-US')
    expect(nativeDisplayCopy('取消', 'Cancel')).toBe('Cancel')
  })

  it('retains Simplified Chinese when the native locale is Chinese', () => {
    getLocale.mockReturnValue('zh-CN')
    expect(nativeDisplayCopy('允许一次', 'Allow once')).toBe('允许一次')
  })

  it('preserves dynamic values when the native locale is not ready', () => {
    getLocale.mockImplementation(() => { throw new Error('app not ready') })
    expect(nativeDisplayCopy('目录：{0}', 'Folder: {0}', ['/tmp/test & notes'])).toBe('Folder: /tmp/test & notes')
  })
})
