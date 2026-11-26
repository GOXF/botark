import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false }, session: {}, net: {}, BrowserWindow: class {} }))
import { parseHarkHistoryPage } from './harkClient'

describe('parseHarkHistoryPage', () => {
  it('reads a plain list, oldest first', () => {
    const page = parseHarkHistoryPage({
      messages: [
        { id: 'b', role: 'assistant', content: 'two', createdAt: 2000 },
        { id: 'a', role: 'user', content: 'one', createdAt: 1000 }
      ],
      hasMore: false
    })
    expect(page.messages.map((m) => m.id)).toEqual(['a', 'b'])
    expect(page.hasMore).toBe(false)
  })
  it('reads the records shape inside data', () => {
    const page = parseHarkHistoryPage({
      data: { messages: { x: { role: 'user', content: 'hi', timestamp: 5 } }, log: [{ id: 'x' }] }
    })
    expect(page.messages.map((m) => m.id)).toEqual(['x'])
    expect(page.hasMore).toBe(true)
  })
  it('an empty page means nothing older', () => {
    expect(parseHarkHistoryPage({ messages: [] }).hasMore).toBe(false)
  })
})
