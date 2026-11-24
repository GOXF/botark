import { beforeEach, describe, expect, it } from 'vitest'
import { leaf, leafBot, leaves } from '@/lib/paneTree'
import { usePanes } from './paneStore'

beforeEach(() => {
  const first = leaf(null, 'L1')
  usePanes.setState({ tree: first, focusedId: 'L1', stash: null, view: 'sessions' })
})

describe('paneStore tabs', () => {
  it('Ctrl-click / middle drop adds a tab; the bot moves out of the pane it was in', () => {
    const s = usePanes.getState()
    s.place('a')
    const right = s.split('L1', 'right', 'b')
    usePanes.getState().addTab(right, 'a')
    const ls = leaves(usePanes.getState().tree)
    // L1 lost its only tab and closed; the right pane holds b and a, a shown
    expect(ls).toHaveLength(1)
    expect(ls[0]!.tabs.map((t) => t.botId)).toEqual(['b', 'a'])
    expect(leafBot(ls[0]!)).toBe('a')
  })

  it('place focuses a background tab of the bot instead of opening it twice', () => {
    const s = usePanes.getState()
    s.place('a')
    s.addTab('L1', 'b')
    usePanes.getState().place('a')
    const l = leaves(usePanes.getState().tree)[0]!
    expect(l.tabs).toHaveLength(2)
    expect(leafBot(l)).toBe('a')
  })

  it('a Hark tab pinned to a project lets the same bot open in a second pane', () => {
    const s = usePanes.getState()
    s.place('h')
    const t = leaves(usePanes.getState().tree)[0]!.tabs[0]!
    usePanes.getState().setTabConversation('L1', t.id, 'P1')
    usePanes.getState().split('L1', 'right', 'h')
    const ls = leaves(usePanes.getState().tree)
    expect(ls.map(leafBot)).toEqual(['h', 'h'])
    expect(ls[0]!.tabs[0]!.conversationId).toBe('P1')
    expect(ls[1]!.tabs[0]!.conversationId).toBeUndefined()
  })

  it('restores the maximized pane with its tabs', () => {
    const s = usePanes.getState()
    s.place('a')
    const r = s.split('L1', 'right', 'b')
    usePanes.getState().toggleMaximize(r)
    usePanes.getState().addTab(r, 'c')
    // adding a tab ends the maximize (stash cleared) and keeps the split
    expect(usePanes.getState().stash).toBeNull()
  })
})
