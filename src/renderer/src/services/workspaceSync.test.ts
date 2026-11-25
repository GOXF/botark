import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeTab, findLeaf, leaf, leaves } from '@/lib/paneTree'
import { useBotStore } from '@/store/botStore'
import { usePanes } from '@/store/paneStore'
import type { Bot } from '@/types'
import { startWorkspaceSync } from './workspaceSync'
import { HARK_DRAFT_SESSION } from '@shared/harkProjects'

const bot = (id: string, platformId: string, activeSessionId?: string) =>
  ({ id, name: id, platformId, accountIds: ['acc'], activeAccountId: 'acc', activeSessionId }) as unknown as Bot

let stop: () => void
// Like the real one: the bot's active conversation becomes the one asked for.
const switchConversation = vi.fn(async (botId: string, conversationId: string) => {
  useBotStore.setState((s) => ({ bots: s.bots.map((b) => (b.id === botId ? { ...b, activeSessionId: conversationId } : b)) }))
})

beforeEach(() => {
  switchConversation.mockClear()
  usePanes.setState({ tree: leaf(null, 'L1'), focusedId: 'L1', stash: null, view: 'sessions' })
  useBotStore.setState({ bots: [bot('m', 'meta-muse', 'S1'), bot('d', 'dot')], selectedBotId: null, switchConversation })
  stop = startWorkspaceSync()
})
afterEach(() => stop())

const focusedTab = () => {
  const s = usePanes.getState()
  return activeTab(findLeaf(s.tree, s.focusedId)!)
}

describe('workspaceSync: tab ↔ conversation (Issue #7)', () => {
  it('pins a focused tab to the bot’s active conversation', () => {
    usePanes.getState().place('m')
    expect(focusedTab()?.conversationId).toBe('S1')
  })

  it('a bot without conversations stays bot-only', () => {
    usePanes.getState().place('d')
    expect(focusedTab()?.conversationId).toBeUndefined()
  })

  it('focusing a tab pinned to another conversation switches the bot to it', () => {
    usePanes.getState().place('m')
    usePanes.getState().split('L1', 'right', 'm', 'S2')
    expect(switchConversation).toHaveBeenLastCalledWith('m', 'S2')
    // back to the first pane → back to S1
    usePanes.getState().focus('L1')
    expect(switchConversation).toHaveBeenLastCalledWith('m', 'S1')
    expect(leaves(usePanes.getState().tree).map((l) => activeTab(l)?.conversationId)).toEqual(['S1', 'S2'])
  })

  it('switching conversation in the focused tab re-pins it', () => {
    usePanes.getState().place('m')
    useBotStore.setState({ bots: [bot('m', 'meta-muse', 'S3'), bot('d', 'dot')] })
    expect(focusedTab()?.conversationId).toBe('S3')
    expect(switchConversation).not.toHaveBeenCalled()
  })

  it('新建项目 in a split unpins the tab so the draft shows, then pins the new project', () => {
    useBotStore.setState({ bots: [bot('h', 'hark', 'P1')] })
    usePanes.getState().place('h')
    usePanes.getState().split('L1', 'right', null)
    usePanes.getState().focus('L1')
    expect(focusedTab()?.conversationId).toBe('P1')
    useBotStore.setState({ bots: [bot('h', 'hark', HARK_DRAFT_SESSION)] })
    expect(focusedTab()?.conversationId).toBeUndefined()
    useBotStore.setState({ bots: [bot('h', 'hark', 'P2')] })
    expect(focusedTab()?.conversationId).toBe('P2')
  })
})
