import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { createSafeStorage } from './delivery'
import {
  closeLeaf,
  equalize,
  findLeaf,
  isPaneNode,
  leaf,
  leafOfBot,
  leaves,
  paneId,
  pruneBots,
  setLeafBot,
  setRatio,
  splitLeaf,
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
  /** Put a bot on screen: focus its pane if it has one, else load it into the focused pane. */
  place: (botId: string) => void
  replace: (leafId: string, botId: string) => void
  split: (leafId: string, side: SplitSide, botId?: string | null) => string
  close: (leafId: string) => void
  resize: (splitId: string, ratio: number) => void
  equalizeAll: () => void
  toggleMaximize: (leafId: string) => void
  prune: (alive: (botId: string) => boolean) => void
  saveScroll: (botId: string, top: number | null) => void
}

const first = leaf(null)

export const usePanes = create<PaneState>()(
  persist(
    (set, get) => ({
      view: 'board',
      startView: 'board',
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
        const own = leafOfBot(tree, botId)
        if (own) {
          if (own.id !== focusedId) set({ focusedId: own.id })
          return
        }
        const target = findLeaf(tree, focusedId) ?? leaves(tree)[0]!
        set({ tree: setLeafBot(tree, target.id, botId), focusedId: target.id })
      },
      replace: (leafId, botId) => {
        let tree = get().tree
        const own = leafOfBot(tree, botId)
        if (own && own.id !== leafId) tree = closeLeaf(tree, own.id)
        set({ tree: setLeafBot(tree, leafId, botId), focusedId: leafId })
      },
      split: (leafId, side, botId = null) => {
        let tree = get().tree
        if (botId) {
          const own = leafOfBot(tree, botId)
          if (own?.id === leafId) return leafId
          if (own) tree = closeLeaf(tree, own.id)
        }
        if (!findLeaf(tree, leafId)) return get().focusedId
        const id = paneId()
        set({ tree: splitLeaf(tree, leafId, side, botId, id), focusedId: id, stash: null })
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
          // Keep whatever the maximized pane switched to.
          const current = findLeaf(tree, focusedId)
          let restored = stash.tree
          const back = findLeaf(restored, stash.focusedId)
          if (current?.botId && back && back.botId !== current.botId) {
            const dup = leafOfBot(restored, current.botId)
            if (dup) restored = setLeafBot(restored, dup.id, null)
            restored = setLeafBot(restored, back.id, current.botId)
          }
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
      saveScroll: (botId, top) => {
        if (get().scroll[botId] === top) return
        set({ scroll: { ...get().scroll, [botId]: top } })
      }
    }),
    {
      name: 'botark-panes-v1',
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
        const tree = isPaneNode(p.tree) ? p.tree : current.tree
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
  return new Set(leaves(tree).flatMap((l) => (l.botId ? [l.botId] : [])))
}
