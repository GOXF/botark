import { useBotStore } from '@/store/botStore'
import { isHumanRoomMessage, stripFinalPrefix, type CollabRoom, type RoomMessage } from './model'
import { submitBrief, useRooms } from './roomStore'

/** 群组之间交接: a group's [FINAL] becomes another group's quoted requirement. */

export const isFinalMessage = (room: CollabRoom, message: RoomMessage) =>
  message.id === room.finalId || message.final === true

export const clock = (at?: number) =>
  at ? new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''

export function handOffFinal(
  sourceId: string,
  messageId: string,
  targetId: string,
  { note, autoStart }: { note: string; autoStart: boolean }
): { ok: boolean; error?: string } {
  const { rooms } = useRooms.getState()
  const source = rooms.find((r) => r.id === sourceId)
  const target = rooms.find((r) => r.id === targetId)
  const final = source?.messages.find((m) => m.id === messageId)
  if (!source || !target || !final) return { ok: false, error: '未找到群组或消息' }
  if (sourceId === targetId) return { ok: false, error: '不能交给本组' }
  if (!isFinalMessage(source, final)) return { ok: false, error: '只有 [FINAL] 定稿能交出' }

  const chain = [...(source.handoffChain ?? [sourceId]).filter((id) => id !== targetId), targetId]
  const inChain = new Set(chain)
  useRooms.setState((s) => ({
    rooms: s.rooms.map((r) => inChain.has(r.id)
      ? { ...r, handoffChain: chain, ...(r.id === targetId ? { handoffUnread: true } : {}) }
      : r)
  }))
  void submitBrief(targetId, note, {
    author: `${source.title} 交来需求`,
    references: [{
      label: `引用 · ${source.title} ${final.author} 的定稿 [FINAL] ${clock(final.createdAt)}`.trim(),
      text: stripFinalPrefix(final.text)
    }],
    handoff: { roomId: sourceId, messageId },
    start: autoStart
  })
  return { ok: true }
}

export function markHandoffRead(roomId: string) {
  if (!useRooms.getState().rooms.find((r) => r.id === roomId)?.handoffUnread) return
  useRooms.setState((s) => ({
    rooms: s.rooms.map((r) => (r.id === roomId ? { ...r, handoffUnread: undefined } : r))
  }))
}

/** Scroll target for 查看原消息; RoomView consumes it once the source group renders. */
let pendingFocus: { roomId: string; messageId: string } | undefined

export function openHandoffSource(roomId: string, messageId: string) {
  pendingFocus = { roomId, messageId }
  useBotStore.getState().selectBot(roomId)
}

export function takePendingFocus(roomId: string): string | undefined {
  if (pendingFocus?.roomId !== roomId) return undefined
  const { messageId } = pendingFocus
  pendingFocus = undefined
  return messageId
}

export interface HandoffStep {
  key: string
  title: string
  who: string
  note: string
  status: 'done' | 'active' | 'pending'
  at?: number
  roomId?: string
}

const firstLine = (text: string) =>
  (stripFinalPrefix(text).split('\n').find((l) => l.trim()) ?? '').replace(/\*\*|__|`/g, '').replace(/^[\s#>*-]+/, '').trim()

/** 交接链 for the right panel: 需求 → each group → 人工确认. */
export function handoffSteps(
  room: CollabRoom,
  rooms: CollabRoom[],
  speakers: Record<string, string | undefined>
): HandoffStep[] | undefined {
  const chain = room.handoffChain
  if (!chain?.length) return undefined
  const origin = rooms.find((r) => r.id === chain[0])
  const ask = origin?.messages.find((m) => isHumanRoomMessage(m) && !m.handoff)
  const steps: HandoffStep[] = [
    { key: 'ask', title: '需求', who: '你', note: ask ? firstLine(ask.text) : '', status: 'done', at: ask?.createdAt }
  ]
  let lastDone = false
  chain.forEach((id, i) => {
    const r = rooms.find((x) => x.id === id)
    if (!r) {
      steps.push({ key: id, title: '已删除的群组', who: '', note: '', status: 'pending' })
      lastDone = false
      return
    }
    const incoming = i === 0 ? -1 : r.messages.findLastIndex((m) => m.handoff?.roomId === chain[i - 1])
    const finalIdx = r.messages.findIndex((m) => m.id === r.finalId)
    const final = finalIdx > incoming ? r.messages[finalIdx] : undefined
    lastDone = Boolean(final)
    steps.push(final
      ? { key: id, roomId: id, title: r.title, who: `${final.author} 定稿`, note: firstLine(final.text), status: 'done', at: final.createdAt }
      : {
          key: id, roomId: id, title: r.title,
          who: speakers[id] ? '读需求中' : i === 0 ? '进行中' : '待开工',
          note: incoming >= 0 ? firstLine(r.messages[incoming]!.text) : '',
          status: 'active', at: incoming >= 0 ? r.messages[incoming]!.createdAt : undefined
        })
  })
  const last = rooms.find((r) => r.id === chain.at(-1))
  steps.push({
    key: 'confirm', title: '人工确认', who: '你',
    note: `${last?.title ?? '最后一组'}定稿后回到你这里`,
    status: lastDone ? 'active' : 'pending'
  })
  return steps
}
