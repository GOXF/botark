import { create } from 'zustand'

/** GOXF: the Hark project open in the 任务 page's right panel (rendered in AppShell's aside, like the chat's). */
export interface BoardPicked {
  botId: string
  botName: string
  accountId: string
  conversationId: string
  working: boolean
  title: string
  taskId?: string
}

export const useBoardDetail = create<{ picked?: BoardPicked; setPicked: (p?: BoardPicked) => void }>((set) => ({
  picked: undefined,
  setPicked: (picked) => set({ picked })
}))
