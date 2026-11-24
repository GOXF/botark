import { describe, expect, it } from 'vitest'
import { harkReplyRef, harkReplySnippet } from './harkClient'

describe('harkReplyRef', () => {
  it('reads every reply key spelling, string or object', () => {
    for (const key of ['replyTo', 'reply_to', 'replyToId', 'reply_to_id', 'inReplyTo', 'in_reply_to', 'replyToMessageId', 'parentMessageId']) {
      expect(harkReplyRef({ [key]: 'm1' })).toEqual({ id: 'm1' })
      expect(harkReplyRef({ [key]: { id: 'm2' } })).toEqual({ id: 'm2' })
    }
  })
  it('keeps an embedded quote, with or without id', () => {
    expect(harkReplyRef({ replyTo: { messageId: 'm3', text: 'hi' } })).toEqual({ id: 'm3', text: 'hi' })
    expect(harkReplyRef({ reply_to: { content: 'only text' } })).toEqual({ text: 'only text' })
  })
  it('ignores missing or empty targets', () => {
    expect(harkReplyRef({ content: 'x' })).toBeUndefined()
    expect(harkReplyRef({ replyTo: '', reply_to: {} })).toBeUndefined()
  })
})

describe('harkReplySnippet', () => {
  it('flattens text and keeps all of it', () => {
    expect(harkReplySnippet('  a\n\n b  ')).toBe('a b')
    expect(harkReplySnippet('x'.repeat(200))).toBe('x'.repeat(200))
  })
  it('names attachments when there is no text', () => {
    expect(harkReplySnippet('', [{ kind: 'image', name: 'p.png' }])).toBe('[图片]')
    expect(harkReplySnippet(' ', [{ kind: 'file', name: 'a.pdf' }])).toBe('[文件] a.pdf')
    expect(harkReplySnippet('', [])).toBe('')
  })
})
