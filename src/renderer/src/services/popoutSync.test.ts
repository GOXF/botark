import { describe, expect, it, vi } from 'vitest'
import type { PopoutPatch } from '@shared/goxfPopout'
import { useBotStore, type BotHubState } from '@/store/botStore'
import { popoutPatch, startPopoutClient } from './popoutSync'

describe('popoutPatch', () => {
  const base = useBotStore.getState()

  it('sends everything the first time, then only what changed', () => {
    const first = popoutPatch(null, base, ['b1'])!
    expect(Object.keys(first.keys)).toContain('bots')
    expect(first.messages).toEqual({ b1: [] })
    expect(popoutPatch(base, base, ['b1'])).toBeNull()

    const typing = { ...base, typing: { b1: true } } as BotHubState
    expect(popoutPatch(base, typing, ['b1'])).toEqual({ keys: { typing: { b1: true } } })
  })

  it('carries message lists only for popped bots', () => {
    const msg = [{ id: 'm1' }] as unknown as BotHubState['messages'][string]
    const next = { ...base, messages: { ...base.messages, b1: msg, b2: msg } } as BotHubState
    expect(popoutPatch(base, next, ['b1'])).toEqual({ keys: {}, messages: { b1: msg } })
  })
})

describe('startPopoutClient', () => {
  it('forwards store actions to the main window, keeps view-only ones local, applies patches', async () => {
    let onState: (patch: PopoutPatch) => void = () => {}
    const invoke = vi.fn(async () => ({ ok: true as const }))
    const ready = vi.fn()
    vi.stubGlobal('window', {
      electron: { goxfPopout: { invoke, ready, onState: (l: typeof onState) => ((onState = l), () => {}) } }
    })
    const stop = startPopoutClient('b1')
    expect(ready).toHaveBeenCalled()
    expect(useBotStore.getState().selectedBotId).toBe('b1')

    await useBotStore.getState().sendMessage('b1', 'hi')
    expect(invoke).toHaveBeenCalledWith('sendMessage', ['b1', 'hi'])

    useBotStore.getState().setActiveDocument(null)
    expect(invoke).toHaveBeenCalledTimes(1)

    onState({ keys: { typing: { b1: true } }, messages: { b1: [{ id: 'm1' }] } })
    expect(useBotStore.getState().typing).toEqual({ b1: true })
    expect(useBotStore.getState().messages['b1']).toEqual([{ id: 'm1' }])
    stop()
    vi.unstubAllGlobals()
  })
})
