import { describe, expect, it, vi } from 'vitest'
import { composerDraft } from './goxfComposerDrafts'

describe('composerDraft', () => {
  it('returns the same draft for a bot across remounts', () => {
    const a = composerDraft('bot-a')
    a.text = '写了一半'
    expect(composerDraft('bot-a').text).toBe('写了一半')
    expect(composerDraft('bot-b').text).toBe('')
  })

  it('keeps attachment changes made while unbound and replays them on bind', async () => {
    const d = composerDraft('bot-c')
    const first = vi.fn()
    const unbind = d.bind(first)
    unbind()
    await d.attachments.add([new File(['x'], 'shot.png', { type: 'image/png' })])
    expect(first).toHaveBeenCalledTimes(1)
    const second = vi.fn()
    d.bind(second)
    expect(second).toHaveBeenLastCalledWith([expect.objectContaining({ status: 'ready' })])
  })
})
