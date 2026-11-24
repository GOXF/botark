import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@/types'
import { IGNORE_NOTE, isRecalled, stripIgnoreNote } from './goxfRecall'

const msg = (text: string, createdAt: number): ChatMessage =>
  ({ id: 'm', botId: 'b', accountId: 'a', role: 'user', text, createdAt }) as ChatMessage

describe('goxfRecall', () => {
  const list = [{ text: '删掉文件', at: 1_000_000, until: 1_030_000 }]
  it('hides the recalled message and its platform copy', () => {
    expect(isRecalled(list, msg('删掉文件', 1_000_000))).toBe(true)
    expect(isRecalled(list, msg('删掉文件', 1_005_000))).toBe(true)
  })
  it('keeps a later re-send of the same text', () => {
    expect(isRecalled(list, msg('删掉文件', 1_040_000))).toBe(false)
    expect(isRecalled(list, msg(`${IGNORE_NOTE}\n删掉文件`, 1_010_000))).toBe(false)
  })
  it('strips the note for display', () => {
    expect(stripIgnoreNote(`${IGNORE_NOTE}\n你好`)).toBe('你好')
    expect(stripIgnoreNote('你好')).toBe('你好')
  })
})
