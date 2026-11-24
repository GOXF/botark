import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { createId } from '@shared/id'
import { stripFinalPrefix } from '@/rooms/model'
import { submitBrief, useRooms } from '@/rooms/roomStore'
import { createSafeStorage } from '@/store/delivery'
import { useBotStore } from '@/store/botStore'
import {
  assign,
  devPrompt,
  newTask,
  parseSuggestion,
  pass,
  reject,
  release,
  setReview,
  splitPrompt,
  submitDev,
  toAssign,
  type Executor,
  type PipelineTask
} from './model'

export type BoardMode = 'status' | 'pipeline'

interface PipelineState {
  tasks: PipelineTask[]
  nextNum: number
  mode: BoardMode
  mineOnly: boolean
  /** Optional http(s) address opened when a task goes live. */
  releaseHook: string
  /** Transient: what is running for a task right now (管理员拆分中 / 评审组评审中). */
  busy: Record<string, string | undefined>
}

const STAGE_IDS = new Set(['need', 'assign', 'dev', 'review', 'confirm', 'live'])

export const usePipeline = create<PipelineState>()(
  persist(
    (): PipelineState => ({ tasks: [], nextNum: 1, mode: 'status', mineOnly: false, releaseHook: '', busy: {} }),
    {
      name: 'botark-pipeline-v1',
      storage: createJSONStorage(() =>
        createSafeStorage(() => (typeof localStorage === 'undefined' ? undefined : localStorage))
      ),
      partialize: (s) => ({ tasks: s.tasks, nextNum: s.nextNum, mode: s.mode, mineOnly: s.mineOnly, releaseHook: s.releaseHook }),
      merge: (persisted, current) => {
        const raw = (persisted && typeof persisted === 'object' ? persisted : {}) as Partial<PipelineState>
        const tasks = Array.isArray(raw.tasks)
          ? raw.tasks.filter((t): t is PipelineTask =>
              Boolean(t && typeof t.id === 'string' && typeof t.title === 'string' && STAGE_IDS.has(t.stage))
            ).map((t) => ({ ...t, round: t.round || 1, rejects: Array.isArray(t.rejects) ? t.rejects : [] }))
          : []
        return {
          ...current,
          tasks,
          nextNum: Math.max(typeof raw.nextNum === 'number' ? raw.nextNum : 1, ...tasks.map((t) => t.num + 1)),
          mode: raw.mode === 'pipeline' ? 'pipeline' : 'status',
          mineOnly: raw.mineOnly === true,
          releaseHook: typeof raw.releaseHook === 'string' ? raw.releaseHook : ''
        }
      }
    }
  )
)

const taskById = (id: string) => usePipeline.getState().tasks.find((t) => t.id === id)

function edit(id: string, fn: (t: PipelineTask) => PipelineTask) {
  usePipeline.setState((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? fn(t) : t)) }))
}

function setBusy(id: string, label?: string) {
  usePipeline.setState((s) => ({ busy: { ...s.busy, [id]: label } }))
}

/** The administrator's coordination room (管理员调度), if one is switched on. */
export function adminRoom() {
  return useRooms.getState().rooms.find((r) => r.coordinatorId)
}

/** Every bot, and every group chat that is not the administrator's. */
export function executorCandidates(): Executor[] {
  return [
    ...useBotStore.getState().bots.map((b) => ({ kind: 'bot' as const, id: b.id, name: b.name.trim() || b.id })),
    ...useRooms.getState().rooms.filter((r) => !r.coordinatorId).map((r) => ({ kind: 'room' as const, id: r.id, name: r.title }))
  ]
}

/** Run one brief in a room and return its [FINAL] (or last bot post) after the brief. */
async function roomAnswer(roomId: string, text: string, references?: { label: string; text: string }[]): Promise<string | undefined> {
  const before = useRooms.getState().rooms.find((r) => r.id === roomId)?.messages.length ?? 0
  await submitBrief(roomId, text, references ? { references } : undefined)
  const room = useRooms.getState().rooms.find((r) => r.id === roomId)
  if (!room) return undefined
  const fresh = room.messages.slice(before + 1)
  const final = fresh.find((m) => m.id === room.finalId) ?? fresh.filter((m) => m.authorBotId).pop()
  return final ? stripFinalPrefix(final.text) : undefined
}

// submitBrief stops a room's running turn, so briefs to one room go one at a time.
const roomQueues = new Map<string, Promise<unknown>>()
function queued<T>(roomId: string, job: () => Promise<T>): Promise<T> {
  const next = (roomQueues.get(roomId) ?? Promise.resolve()).catch(() => {}).then(job)
  roomQueues.set(roomId, next)
  return next
}

export function createTask(title: string, detail: string, reviewRoomId?: string): string | undefined {
  if (!title.trim()) return undefined
  const id = createId('task')
  usePipeline.setState((s) => ({
    tasks: [...s.tasks, newTask(id, s.nextNum, title, detail, Date.now(), reviewRoomId || undefined)],
    nextNum: s.nextNum + 1
  }))
  if (adminRoom()) void suggest(id)
  return id
}

/** 管理员调度: ask the administrator to split the task and name an executor. */
export async function suggest(id: string) {
  const room = adminRoom()
  const task = taskById(id)
  if (!room || !task || task.stage !== 'need') return
  setBusy(id, '管理员拆分中')
  try {
    const candidates = executorCandidates()
    const answer = await queued(room.id, () => roomAnswer(room.id, splitPrompt(task, candidates)))
    edit(id, (t) => toAssign(t, answer ? parseSuggestion(answer, candidates) : undefined, Date.now()))
  } finally {
    setBusy(id)
  }
}

/** Skip the administrator and pick the executor by hand. */
export function skipSuggest(id: string) {
  edit(id, (t) => toAssign(t, undefined, Date.now()))
}

function dispatch(id: string) {
  const task = taskById(id)
  const ex = task?.executor
  if (!task || task.stage !== 'dev' || !ex) return
  const text = devPrompt(task)
  if (ex.kind === 'bot') {
    void useBotStore.getState().sendMessage(ex.id, text)
    return
  }
  const round = task.round
  void queued(ex.id, () => roomAnswer(ex.id, text)).then((output) => {
    const now = taskById(id)
    // A group's [FINAL] for this round finishes 开发 on its own.
    if (output && now?.stage === 'dev' && now.round === round) finishDev(id, output)
  })
}

export function confirmAssign(id: string, executor: Executor) {
  edit(id, (t) => assign(t, executor, Date.now()))
  dispatch(id)
}

/** 开发 → Review. Without an output, take the bot's latest reply. */
export function finishDev(id: string, output?: string) {
  const task = taskById(id)
  if (!task || task.stage !== 'dev') return
  let text = output
  if (!text && task.executor?.kind === 'bot') {
    const last = useBotStore.getState().messages[task.executor.id]?.filter((m) => m.role === 'bot').pop()
    text = last?.text
  }
  edit(id, (t) => submitDev(t, text, Date.now()))
  void runReview(id)
}

async function runReview(id: string) {
  const task = taskById(id)
  const roomId = task?.reviewRoomId
  if (!task || !roomId || !useRooms.getState().rooms.some((r) => r.id === roomId)) return
  setBusy(id, '评审组评审中')
  try {
    const review = await queued(roomId, () =>
      roomAnswer(roomId, `请评审任务 #${task.num}：${task.title}。以 [FINAL] 开头给出结论和建议。`, [
        { label: '需求', text: task.detail || task.title },
        ...(task.output ? [{ label: '开发产出', text: task.output }] : [])
      ])
    )
    if (review) edit(id, (t) => setReview(t, review, Date.now()))
  } finally {
    setBusy(id)
  }
}

export function passGate(id: string) {
  edit(id, (t) => pass(t, Date.now()))
}

/** 打回: back to 开发 with the reason as the next round, and tell the executor. */
export function rejectGate(id: string, reason: string) {
  const before = taskById(id)
  edit(id, (t) => reject(t, reason, Date.now()))
  if (taskById(id)?.round !== before?.round) dispatch(id)
}

/** 上线: mark it, then open the user's release address if they set one. */
export function releaseTask(id: string) {
  edit(id, (t) => release(t, Date.now()))
  const hook = usePipeline.getState().releaseHook.trim()
  if (/^https?:\/\//i.test(hook) && typeof window !== 'undefined') window.open(hook, '_blank', 'noopener,noreferrer')
}

export function deleteTask(id: string) {
  usePipeline.setState((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }))
}
