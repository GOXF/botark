import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { sanitizeOverrides, type ManualColumn } from '@/lib/boardStatus'
import { createSafeStorage } from '@/store/delivery'

/**
 * v21: 看板 states the user set by hand (drag or 标为…), kept only in BotArk
 * (localStorage), never sent to Hark. Keys: Hark `${projectKey}:${taskId}`,
 * other cards their card key (`b:<botId>` / `r:<roomId>`). A key stays until
 * 恢复自动 clears it.
 */
interface BoardOverrideState {
  overrides: Record<string, ManualColumn>
  setOverride: (id: string, column: ManualColumn) => void
  clearOverride: (id: string) => void
}

export const useBoardOverrides = create<BoardOverrideState>()(
  persist(
    (set) => ({
      overrides: {},
      setOverride: (id, column) => set((s) => (s.overrides[id] === column ? s : { overrides: { ...s.overrides, [id]: column } })),
      clearOverride: (id) =>
        set((s) => {
          if (!(id in s.overrides)) return s
          const { [id]: _, ...rest } = s.overrides
          return { overrides: rest }
        })
    }),
    {
      name: 'botark-board-overrides-v1',
      storage: createJSONStorage(() => createSafeStorage(() => (typeof localStorage === 'undefined' ? undefined : localStorage))),
      partialize: (s) => ({ overrides: s.overrides }),
      merge: (persisted, current) => ({
        ...current,
        overrides: sanitizeOverrides((persisted as { overrides?: unknown } | undefined)?.overrides)
      })
    }
  )
)
