import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { createSafeStorage } from './delivery'
import {
  closeLeaf,
  closeTab,
  equalize,
  findBot,
  findLeaf,
  findTab,
  leaf,
  leafBot,
  leaves,
  moveTab,
  openTab,
  paneId,
  pruneBots,
  readPaneNode,
  replaceLeaf,
  selectTab,
  setRatio,
  setTabConversation,
  showInLeaf,
  splitLeaf,
  tab,
  type PaneNode,
  type SplitSide
} from '@/lib/paneTree'

/** GOXF v12: the three top-level pages. */
export type WorkspaceView = 'board' | 'sessions' | 'collab'

interface PaneState {
  view: WorkspaceView
  /** Page shown at launch; 'last' = whatever was open when the app closed. */
  startView: WorkspaceView | 'last'
  tree: PaneNode
  focusedId: string
  /** The layout before ⤢ maximize, restored by the same button. */
  stash: { tree: PaneNode; focusedId: string } | null
  /** botId → last scroll offset (null = stuck to bottom). */
  scroll: Record<string, number | null>
  setView: (view: WorkspaceView) => void
  setStartView: (view: WorkspaceView | 'last') => void
  focus: (leafId: string) => void
  /** Put a bot on screen: focus its tab if it has one, else swap it into the focused pane's active tab. */
  place: (botId: string) => void
  /** Open a bot (or one of its conversations) as a new tab; an identical tab elsewhere moves here. */
  addTab: (leafId: string, botId: string, conversationId?: string) => void
  selectTab: (leafId: string, tabId: string) => void
  closeTab: (leafId: string, tabId: string) => void
  moveTab: (fromLeafId: string, tabId: string, toLeafId: string, zone: SplitSide | 'center') => void
  /** Pin a tab to a conversation (undefined = follow the bot). */
  setTabConversation: (leafId: string, tabId: string, conversationId: string | undefined) => void
  split: (leafId: string, side: SplitSide, botId?: string | null, conversationId?: string) => string
  close: (leafId: string) => void
  resize: (splitId: string, ratio: number) => void
  equalizeAll: () => void
  toggleMaximize: (leafId: string) => void
  prune: (alive: (botId: string) => boolean) => void
  saveScroll: (botId: string, top: number | null) => void
  /** One-line notice in the top bar (e.g. why a split was refused). */
  notice?: string
  say: (notice?: string) => void
}

const first = leaf(null)

export const usePanes = create<PaneState>()(
  persist(
    (set, get) => ({
      view: 'board',
      startView: 'sessions',
      tree: first,
      focusedId: first.id,
      stash: null,
      scroll: {},
      setView: (view) => set({ view }),
      setStartView: (startView) => set({ startView }),
      focus: (leafId) => {
        if (findLeaf(get().tree, leafId)) set({ focusedId: leafId })
      },
      place: (botId) => {
        const { tree, focusedId } = get()
        const own = findBot(tree, botId)
        if (own) {
          const next = selectTab(tree, own.leaf.id, own.tab.id)
          if (next !== tree || own.leaf.id !== focusedId) set({ tree: next, focusedId: own.leaf.id })
          return
        }
        const target = findLeaf(tree, focusedId) ?? leaves(tree)[0]!
        set({ tree: showInLeaf(tree, target.id, botId), focusedId: target.id })
      },
      addTab: (leafId, botId, conversationId) => {
        let tree = get().tree
        const own = findTab(tree, botId, conversationId)
        if (own && own.leaf.id !== leafId) tree = closeTab(tree, own.leaf.id, own.tab.id)
        if (!findLeaf(tree, leafId)) return
        set({ tree: openTab(tree, leafId, own?.tab ?? tab(botId, conversationId)), focusedId: leafId, stash: null })
      },
      selectTab: (leafId, tabId) => set({ tree: selectTab(get().tree, leafId, tabId), focusedId: leafId }),
      closeTab: (leafId, tabId) => {
        const { focusedId } = get()
        const next = closeTab(get().tree, leafId, tabId)
        const ids = leaves(next).map((l) => l.id)
        set({ tree: next, focusedId: ids.includes(focusedId) ? focusedId : ids[0]! })
      },
      moveTab: (fromLeafId, tabId, toLeafId, zone) => {
        const { tree, leafId } = moveTab(get().tree, fromLeafId, tabId, toLeafId, zone)
        if (tree !== get().tree) set({ tree, focusedId: leafId, stash: null })
      },
      setTabConversation: (leafId, tabId, conversationId) => {
        const next = setTabConversation(get().tree, leafId, tabId, conversationId)
        if (next !== get().tree) set({ tree: next })
      },
      split: (leafId, side, botId = null, conversationId) => {
        let tree = get().tree
        if (botId) {
          const own = findTab(tree, botId, conversationId)
          if (own?.leaf.id === leafId && own.leaf.tabs.length === 1) return leafId
          if (own) tree = closeTab(tree, own.leaf.id, own.tab.id)
        }
        if (!findLeaf(tree, leafId)) return get().focusedId
        const id = paneId()
        set({ tree: splitLeaf(tree, leafId, side, botId ? tab(botId, conversationId) : null, id), focusedId: id, stash: null })
        return id
      },
      close: (leafId) => {
        const { tree, focusedId } = get()
        const next = closeLeaf(tree, leafId)
        const ids = leaves(next).map((l) => l.id)
        set({ tree: next, focusedId: ids.includes(focusedId) ? focusedId : ids[0]! })
      },
      resize: (splitId, ratio) => set({ tree: setRatio(get().tree, splitId, ratio) }),
      equalizeAll: () => set({ tree: equalize(get().tree) }),
      toggleMaximize: (leafId) => {
        const { tree, stash, focusedId } = get()
        if (stash) {
          // Keep whatever the maximized pane switched to (its tabs come back with it).
          const current = findLeaf(tree, focusedId)
          const restored = current ? replaceLeaf(stash.tree, stash.focusedId, current) : stash.tree
          set({ tree: restored, focusedId: stash.focusedId, stash: null })
          return
        }
        const target = findLeaf(tree, leafId)
        if (!target || leaves(tree).length < 2) return
        set({ stash: { tree, focusedId: leafId }, tree: { ...target }, focusedId: target.id })
      },
      prune: (alive) => {
        const { tree, stash } = get()
        const next = pruneBots(tree, alive)
        const nextStash = stash ? { ...stash, tree: pruneBots(stash.tree, alive) } : null
        if (next !== tree || nextStash?.tree !== stash?.tree) set({ tree: next, stash: nextStash })
      },
      notice: undefined,
      say: (notice) => {
        set({ notice })
        if (notice) setTimeout(() => { if (get().notice === notice) set({ notice: undefined }) }, 2600)
      },
      saveScroll: (botId, top) => {
        if (get().scroll[botId] === top) return
        set({ scroll: { ...get().scroll, [botId]: top } })
      }
    }),
    {
      name: 'botark-panes-v1',
      // v1: the opening view defaults to 会话 (user 2026-11-24); old saves only ever held the 'board' default.
      version: 1,
      migrate: (persisted, from) => {
        const p = (persisted ?? {}) as Partial<PaneState>
        return (from < 1 && p.startView === 'board' ? { ...p, startView: 'sessions' } : p) as PaneState
      },
      storage: createJSONStorage(() =>
        createSafeStorage(() => (typeof localStorage === 'undefined' ? undefined : localStorage))
      ),
      partialize: (s) => ({
        view: s.view,
        startView: s.startView,
        tree: s.stash ? s.stash.tree : s.tree,
        focusedId: s.stash ? s.stash.focusedId : s.focusedId,
        scroll: s.scroll
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PaneState>
        const tree = readPaneNode(p.tree) ?? current.tree
        const ids = leaves(tree).map((l) => l.id)
        const startView = p.startView ?? current.startView
        const view = startView === 'last' ? (p.view ?? current.view) : startView
        return {
          ...current,
          startView,
          view,
          tree,
          focusedId: p.focusedId && ids.includes(p.focusedId) ? p.focusedId : ids[0]!,
          scroll: p.scroll && typeof p.scroll === 'object' ? p.scroll : {}
        }
      }
    }
  )
)

export function paneCount(): number {
  return leaves(usePanes.getState().tree).length
}

/** Bots whose conversation is on screen right now (the 会话 page's panes). */
export function visibleBotIds(): Set<string> {
  const { view, tree } = usePanes.getState()
  if (view !== 'sessions') return new Set()
  return new Set(leaves(tree).flatMap((l) => leafBot(l) ?? []))
}
