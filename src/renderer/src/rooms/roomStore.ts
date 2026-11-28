import { create } from 'zustand'
import { persist, type PersistStorage } from 'zustand/middleware'
import { adapterRegistry } from '@adapters/registry'
import { AdapterError, type AttachmentMeta, type ConnectionStatus, type MuseMediaPart, type MuseToolCall, type SendReceipt } from '@adapters/types'
import { createId } from '@shared/id'
import { getBridge } from '@/lib/bridge'
import { cancelPlatformTurn, useBotStore } from '@/store/botStore'
import { createSafeStorage } from '@/store/delivery'
import type { Bot } from '@/types'
import {
  classifyRoomReply,
  freshRoomSession,
  isGlobalAdmin,
  isHumanRoomMessage,
  mentions,
  normalizeMentionName,
  refusesRoomFrame,
  roomRecipient,
  turnPrompt,
  type CollabRoom,
  type RoomMember,
  type RoomMessage,
  type RoomReference
} from './model'
import { requestedTool } from './toolRequests'
import { snapshotMembers, teamStatusBlock } from './adminContext'

export interface RoomTurnProgress {
  turn: number
  limit: number
}

interface SlackDestination {
  channel: string
  thread?: string
  bindingGeneration?: number
}

interface RoomState {
  externalAudiences: Record<string, string | undefined>
  slackDestinations: Record<string, SlackDestination | undefined>
  rooms: CollabRoom[]
  speakers: Record<string, string | undefined>
  turnProgress: Record<string, RoomTurnProgress | undefined>
  /** GOXF: tool calls of the reply being written right now, per room. */
  liveTools: Record<string, MuseToolCall[] | undefined>
  errors: Record<string, string | undefined>
}

function roomStorageBacking(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

let storedRooms: {
  backing: Storage
  name: string
  value: string | null
  rooms?: CollabRoom[]
  version?: number
} | undefined
const safeRoomStorage = createSafeStorage(roomStorageBacking, () => { storedRooms = undefined })
const roomStorage: PersistStorage<Pick<RoomState, 'rooms'>> = {
  getItem(name) {
    const backing = roomStorageBacking()
    const value = safeRoomStorage.getItem(name)
    storedRooms = backing ? { backing, name, value } : undefined
    return value ? JSON.parse(value) : null
  },
  setItem(name, item) {
    const backing = roomStorageBacking()
    if (!backing) return
    const previous = storedRooms?.backing === backing && storedRooms.name === name ? storedRooms : undefined
    if (previous?.rooms === item.state.rooms && previous.version === item.version) return
    // Picture data stays in memory only: localStorage is small, and the member already received it.
    const value = JSON.stringify(item, (key, v) =>
      key === 'dataBase64' ? undefined
        : key === 'media' && Array.isArray(v) ? v.filter((part: MuseMediaPart) => !part.path?.startsWith('data:'))
          : v)
    storedRooms = { backing, name, value, rooms: item.state.rooms, version: item.version }
    if (value !== previous?.value) safeRoomStorage.setItem(name, value)
  },
  removeItem(name) {
    storedRooms = undefined
    safeRoomStorage.removeItem(name)
  }
}

export const useRooms = create<RoomState>()(
  persist(
    (): RoomState => ({
      rooms: [],
      speakers: {},
      turnProgress: {},
      liveTools: {},
      errors: {},
      slackDestinations: {},
      externalAudiences: {}
    }),
    {
      name: 'botark-collaboration-rooms',
      storage: roomStorage,
      partialize: (s) => ({ rooms: s.rooms }),
      onRehydrateStorage: () => (state) => {
        if (state && storedRooms) {
          storedRooms.rooms = state.rooms
          storedRooms.version = 0
        }
      },
      merge: (persisted, current) => {
        const raw = persisted && typeof persisted === 'object' ? (persisted as { rooms?: unknown }) : {}
        const safeRooms = Array.isArray(raw.rooms)
          ? raw.rooms
              .filter((r): r is Record<string, unknown> => Boolean(r && typeof r === 'object' && typeof (r as { id?: unknown }).id === 'string'))
              .map((r) => ({
                id: String(r.id),
                title: typeof r.title === 'string' && r.title.trim() ? r.title : '协作讨论',
                pinned: typeof r.pinned === 'boolean' ? r.pinned : undefined,
                members: Array.isArray(r.members) ? (r.members as RoomMember[]) : [],
                messages: Array.isArray(r.messages) ? (r.messages as RoomMessage[]).map((m) =>
                  r.finalId && m?.id === r.finalId ? { ...m, final: true } : m
                ) : [],
                mode: r.mode === 'manual' ? ('manual' as const) : ('auto' as const),
                limit: typeof r.limit === 'number' && r.limit > 0 ? r.limit : 6,
                brief: typeof r.brief === 'string' ? r.brief : '',
                coordinatorId: typeof r.coordinatorId === 'string' ? r.coordinatorId : undefined,
                adminScope: r.adminScope === 'room' && typeof r.coordinatorId === 'string' ? ('room' as const) : undefined,
                slackParent: typeof r.slackParent === 'string' ? r.slackParent : undefined,
                slackChannel: typeof r.slackChannel === 'string' ? r.slackChannel : undefined,
                slackThread: typeof r.slackThread === 'string' ? r.slackThread : undefined,
                finalId: typeof r.finalId === 'string' ? r.finalId : undefined,
                createdAt: typeof r.createdAt === 'number' ? r.createdAt : undefined,
                handoffChain: Array.isArray(r.handoffChain) ? r.handoffChain.filter((x): x is string => typeof x === 'string') : undefined,
                handoffUnread: r.handoffUnread === true ? true : undefined
              }))
          : []
        return { ...current, rooms: safeRooms }
      }
    }
  )
)

const isConnectedStatus = (status?: ConnectionStatus) =>
  status === 'online' || status === 'attention' || status === 'busy'

function turnLockKey(member: Pick<RoomMember, 'accountId' | 'agentId'>): string {
  return member.agentId ? `${member.accountId}::${member.agentId}` : member.accountId
}

/**
 * Publish the workspace over HTTP so a member that refuses the external
 * `[TOOL]` protocol can still read and write it with its own web tools.
 * Returns the prompt fragment to append, or an empty string when the portal
 * could not be started.
 */
async function openWorkspacePortal(scope: string): Promise<string> {
  const bridge = getBridge()?.workspacePortal
  if (!bridge) return ''
  try {
    const state = await bridge.manage({ op: 'open', scope })
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('botark:workspace-portal-updated', { detail: { scope } }))
    }
    if (!state.running || !state.entryUrl) return ''
    return (
      `\n\n本机工作区已挂载为在线文档：${state.entryUrl}\n` +
      '需要查看、搜索或修改工作区时，用你的网页抓取工具打开这个地址，按页面上的说明操作即可。'
    )
  } catch {
    return ''
  }
}

function findBotForMember(member: RoomMember, bots: Bot[], occupiedIds: ReadonlySet<string>): Bot | undefined {
  return (
    bots.find((b) => b.id === member.botId) ??
    bots.find(
      (b) =>
        !occupiedIds.has(b.id) &&
        b.platformId === member.platform &&
        (b.activeAccountId === member.accountId || b.accountIds?.includes(member.accountId)) &&
        (!member.agentId || b.selectedAgentId === member.agentId)
    )
  )
}

function reconcileRoomMemberList(
  members: RoomMember[],
  bots: Bot[],
  accounts: Record<string, { handle?: string } | undefined>
): { members: RoomMember[]; changed: boolean } {
  let changed = false
  const usedNames = new Set<string>()
  const occupiedIds = new Set(members.map((member) => member.botId))
  const next = members.map((member) => {
    const bot = findBotForMember(member, bots, occupiedIds)
    if (!bot) {
      usedNames.add(normalizeMentionName(member.name))
      return member
    }
    const nextBotId = bot.id || member.botId
    occupiedIds.add(nextBotId)
    const nextAccountId =
      bot.activeAccountId ||
      (bot.accountIds?.includes(member.accountId) ? member.accountId : bot.accountIds?.[0]) ||
      member.accountId
    const nextAgentId = bot.selectedAgentId
    const rawName = bot.name?.trim()
    let nextName = member.name
    if (rawName) {
      const handle = accounts[nextAccountId]?.handle?.trim()
      const escapedRaw = rawName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const matchesWithHandle =
        Boolean(handle) && member.name.toLowerCase() === `${rawName} · ${handle}`.toLowerCase()
      const matchesWithNum = new RegExp(`^${escapedRaw} \\(\\d+\\)$`, 'i').test(member.name)
      if (
        member.name.toLowerCase() === rawName.toLowerCase() ||
        matchesWithHandle ||
        matchesWithNum
      ) {
        nextName = member.name
      } else {
        nextName = rawName
      }
      if (usedNames.has(normalizeMentionName(nextName))) {
        if (handle && !usedNames.has(normalizeMentionName(`${rawName} · ${handle}`))) {
          nextName = `${rawName} · ${handle}`
        } else {
          let n = 2
          while (usedNames.has(normalizeMentionName(`${rawName} (${n})`))) n++
          nextName = `${rawName} (${n})`
        }
      }
    }
    usedNames.add(normalizeMentionName(nextName))
    const resetSession = nextAccountId !== member.accountId || nextAgentId !== member.agentId
    if (
      nextBotId !== member.botId ||
      nextAccountId !== member.accountId ||
      nextAgentId !== member.agentId ||
      nextName !== member.name
    ) {
      changed = true
      return {
        ...member,
        botId: nextBotId,
        accountId: nextAccountId,
        agentId: nextAgentId,
        name: nextName,
        ...(resetSession ? freshRoomSession(member.platform) : {})
      }
    }
    return member
  })
  return { members: changed ? next : members, changed }
}

function initialMember(bot: Bot): RoomMember {
  return {
    botId: bot.id, platform: bot.platformId, accountId: bot.activeAccountId,
    agentId: bot.selectedAgentId, name: bot.name.trim() || bot.id, ...freshRoomSession(bot.platformId)
  }
}

function revokeCoordination(room: CollabRoom): CollabRoom {
  stopRoom(room.id)
  return {
    ...room, coordinatorId: undefined, mode: 'manual',
    members: room.members.filter((m) => m.botId === room.coordinatorId)
  }
}

export function setRoomAdministrator(botId: string, enabled: boolean) {
  const existing = useRooms.getState().rooms.find((r) => isGlobalAdmin(r) && r.coordinatorId === botId)
  if (existing) {
    if (!enabled) update(existing.id, revokeCoordination)
    return existing.id
  }
  const { bots, accounts } = useBotStore.getState()
  const owner = bots.find((b) => b.id === botId)
  if (!enabled || !owner) return
  const members = [owner, ...bots.filter((b) => b !== owner)].map(initialMember)
  const room: CollabRoom = {
    id: createId('room'), title: owner.name + ' · 管理员调度', coordinatorId: owner.id,
    members: reconcileRoomMemberList(members, bots, accounts).members,
    messages: [], brief: '', mode: 'auto', limit: 8, createdAt: Date.now()
  }
  useRooms.setState((s) => ({ rooms: [...s.rooms, room] }))
  return room.id
}

function reconcileRooms(targetRoomId?: string) {
  const { bots, accounts } = useBotStore.getState()
  const { rooms } = useRooms.getState()
  let anyChanged = false
  const nextRooms = rooms.map((room) => {
    if (targetRoomId && room.id !== targetRoomId) return room
    let members = room.members
    if (room.coordinatorId && !isGlobalAdmin(room) && !members.some((m) => m.botId === room.coordinatorId)) {
      // A group chat's administrator left the room: back to plain relay.
      anyChanged = true
      stopRoom(room.id)
      room = { ...room, coordinatorId: undefined, adminScope: undefined }
    }
    if (isGlobalAdmin(room)) {
      const owner = bots.find((b) => b.id === room.coordinatorId)
      const original = members.find((m) => m.botId === room.coordinatorId)
      if (!owner || owner.activeAccountId !== original?.accountId || owner.selectedAgentId !== original?.agentId) {
        anyChanged = true
        return revokeCoordination(room)
      }
      const roster = [owner, ...bots.filter((b) => b !== owner)].map((b) =>
        members.find((m) => m.botId === b.id) ?? initialMember(b)
      )
      if (roster.length !== members.length || roster.some((m, i) => m !== members[i])) {
        stopRoom(room.id)
        members = roster
      }
    }
    const res = reconcileRoomMemberList(members, bots, accounts)
    if (!res.changed && members === room.members) return room
    anyChanged = true
    if (res.members.some((m, i) => m.accountId !== members[i]!.accountId || m.agentId !== members[i]!.agentId)) {
      stopRoom(room.id)
    }
    return { ...room, members: res.members }
  })
  if (anyChanged) {
    useRooms.setState({ rooms: nextRooms })
  }
}

useBotStore.subscribe((state, prev) => {
  if (state.bots !== prev.bots) {
    reconcileRooms()
  }
})

const pendingTurns = new Map<string, Promise<unknown>>()
type RoomRun = {
  controller: AbortController
  finished: Promise<void>
  finish: () => void
  slackDestination?: SlackDestination
  /** The running turn queue and who is answering now, so a follow-up can join this round. */
  queue?: Array<{ member: RoomMember; trigger: RoomMessage; handoff?: RoomMessage }>
  speaker?: RoomMember
}
const runs = new Map<string, RoomRun>()
const activeAccounts = new Set<string>()
const roomById = (id: string) => useRooms.getState().rooms.find((r) => r.id === id)

export const roomRunFinished = (id: string) => runs.get(id)?.finished

export function roomSlackDestination(room: CollabRoom): SlackDestination | undefined {
  if (isGlobalAdmin(room)) return
  const binding = useRooms.getState().slackDestinations[room.slackParent ?? room.id]
  const active = runs.get(room.id)
  if (active) return active.slackDestination
  if (binding && room.slackChannel) return { ...binding, channel: room.slackChannel, thread: room.slackThread }
  return binding
}

function update(id: string, fn: (room: CollabRoom) => CollabRoom) {
  useRooms.setState((s) => ({ rooms: s.rooms.map((r) => (r.id === id ? fn(r) : r)) }))
}

function recordHandoff(roomId: string, post: RoomMessage, botId: string) {
  update(roomId, (room) => ({ ...room, messages: room.messages.map((message) =>
    message.id === post.id && !message.handoffBotIds?.includes(botId)
      ? { ...message, handoffBotIds: [...(message.handoffBotIds ?? []), botId] }
      : message
  ) }))
}

export function stopRoom(id: string) {
  const run = runs.get(id)
  runs.delete(id)
  run?.controller.abort()
  run?.finish()
  useRooms.setState((s) => ({
    speakers: { ...s.speakers, [id]: undefined },
    turnProgress: { ...s.turnProgress, [id]: undefined },
    liveTools: { ...s.liveTools, [id]: undefined }
  }))
}

function setError(id: string, error?: string) {
  useRooms.setState((s) => ({ errors: { ...s.errors, [id]: error } }))
}

export function renameRoom(id: string, title: string) {
  const trimmed = title.trim()
  if (!trimmed) return
  update(id, (r) => ({ ...r, title: trimmed }))
}

export function togglePinRoom(id: string) {
  update(id, (room) => ({ ...room, pinned: !room.pinned }))
}

export function updateRoomConfig(
  id: string,
  patch: Partial<Pick<CollabRoom, 'mode' | 'limit'>>
) {
  update(id, (r) => ({
    ...r,
    ...(patch.mode && !isGlobalAdmin(r) ? { mode: patch.mode, coordinatorId: undefined, adminScope: undefined } : {}),
    ...(patch.limit !== undefined
      ? { limit: Math.max(1, Math.min(24, Math.round(patch.limit))) }
      : {})
  }))
}

/** GOXF: make one member this group chat's own administrator (only this room). */
export function setGroupAdministrator(id: string, botId: string) {
  const room = roomById(id)
  if (!room || isGlobalAdmin(room) || !room.members.some((m) => m.botId === botId)) return
  if (room.coordinatorId === botId) return
  stopRoom(id)
  update(id, (r) => ({ ...r, coordinatorId: botId, adminScope: 'room' }))
}

export function clearRoomTranscript(id: string) {
  stopRoom(id)
  setError(id, undefined)
  update(id, (r) => ({
    ...r,
    messages: [],
    finalId: undefined,
    brief: '',
    members: r.members.map((m) => ({ ...m, ...freshRoomSession(m.platform) }))
  }))
}

export function deleteRoom(id: string) {
  stopRoom(id)
  const toRemove = new Set(
    useRooms
      .getState()
      .rooms.filter((r) => r.id === id || r.slackParent === id)
      .map((r) => r.id)
  )
  for (const rid of toRemove) stopRoom(rid)
  useRooms.setState((s) => ({
    rooms: s.rooms.filter((r) => !toRemove.has(r.id))
  }))
  const workspace = getBridge()?.workspace
  if (workspace) {
    // The IPC handler disposes the workspace scope alongside the deleted room.
    const dispose = { op: 'dispose' } as { op: 'dispose' } & Parameters<typeof workspace.manage>[1]
    for (const rid of toRemove) {
      void workspace.manage(rid, dispose).catch((error) => console.error('[room] workspace cleanup failed', error))
    }
  }
  const botState = useBotStore.getState()
  if (botState.selectedBotId && toRemove.has(botState.selectedBotId)) {
    const remainingRoom = useRooms.getState().rooms[0]?.id
    const firstBot = botState.bots[0]?.id ?? null
    botState.selectBot(remainingRoom ?? firstBot)
  }
}

export function addRoom(title: string, ids: string[], mode: CollabRoom['mode'], limit: number) {
  const { bots, accounts } = useBotStore.getState()
  const usedNames = new Set<string>()
  const members: RoomMember[] = [...new Set(ids)].map((id) => {
    const bot = bots.find((b) => b.id === id)
    const storeStatus = bot ? accounts[bot.activeAccountId]?.status : undefined
    const adapterStatus = bot
      ? adapterRegistry.get(bot.platformId)?.getStatus(bot.activeAccountId)
      : undefined
    if (!bot || (!isConnectedStatus(storeStatus) && !isConnectedStatus(adapterStatus))) {
      throw new Error('请选择已连接的 Bot')
    }
    const rawBase = bot.name?.trim() || accounts[bot.activeAccountId]?.displayName?.trim() || id
    let candidate = rawBase
    if (usedNames.has(normalizeMentionName(candidate))) {
      const handle = accounts[bot.activeAccountId]?.handle?.trim()
      if (handle && !usedNames.has(normalizeMentionName(`${rawBase} · ${handle}`))) {
        candidate = `${rawBase} · ${handle}`
      } else {
        let n = 2
        while (usedNames.has(normalizeMentionName(`${rawBase} (${n})`))) n++
        candidate = `${rawBase} (${n})`
      }
    }
    usedNames.add(normalizeMentionName(candidate))
    return {
      botId: id,
      platform: bot.platformId,
      accountId: bot.activeAccountId,
      name: candidate,
      agentId: bot.selectedAgentId,
      ...freshRoomSession(bot.platformId)
    }
  })
  if (members.length < 2) throw new Error('请至少选择 2 位成员')
  if (!Number.isInteger(limit) || limit < 1 || limit > 24) throw new Error('轮数应为 1–24')
  const room: CollabRoom = {
    id: createId('room'),
    title: title.trim() || members.map((m) => m.name).join(' · '),
    members,
    messages: [],
    mode,
    limit,
    brief: '',
    createdAt: Date.now()
  }
  useRooms.setState((s) => ({ rooms: [...s.rooms, room] }))
  return room
}

/** A group chat's administrator leaving the room turns the room back to plain relay. */
const dropAdmin = (r: CollabRoom, botId: string) =>
  r.coordinatorId === botId && !isGlobalAdmin(r) ? { coordinatorId: undefined, adminScope: undefined } : {}

export function removeMember(roomId: string, botId: string): { ok: boolean; error?: string } {
  const room = roomById(roomId)
  if (!room) return { ok: false, error: '未找到该群聊' }
  if (isGlobalAdmin(room)) return { ok: false, error: '管理员调度自动同步 Bot 列表' }
  if (!room.members.some((m) => m.botId === botId)) {
    return { ok: false, error: '该成员不在当前群聊中' }
  }
  if (room.members.length <= 1) {
    return { ok: false, error: '群聊至少需要保留一位成员' }
  }
  if (runs.has(roomId) || useRooms.getState().speakers[roomId]) {
    stopRoom(roomId)
  }
  useRooms.setState((s) => ({
    rooms: s.rooms.map((r) =>
      r.id === roomId ? { ...r, members: r.members.filter((m) => m.botId !== botId), ...dropAdmin(r, botId) } : r
    ),
    errors: { ...s.errors, [roomId]: undefined }
  }))
  return { ok: true }
}

/** Add a sidebar bot to an existing group chat (used by drag-and-drop). */
export function addMemberToRoom(roomId: string, botId: string): { ok: boolean; error?: string } {
  const room = roomById(roomId)
  if (!room) return { ok: false, error: '未找到该群聊' }
  if (isGlobalAdmin(room)) return { ok: false, error: '管理员调度自动同步 Bot 列表' }
  if (room.members.some((m) => m.botId === botId)) {
    return { ok: false, error: '该 Bot 已在群聊中' }
  }
  const { bots, accounts } = useBotStore.getState()
  const bot = bots.find((b) => b.id === botId)
  if (!bot) return { ok: false, error: '未找到该 Bot' }
  const storeStatus = accounts[bot.activeAccountId]?.status
  const adapterStatus = adapterRegistry.get(bot.platformId)?.getStatus(bot.activeAccountId)
  if (!isConnectedStatus(storeStatus) && !isConnectedStatus(adapterStatus)) {
    return { ok: false, error: '请先连接该 Bot 再加入群聊' }
  }

  const usedNames = new Set(room.members.map((m) => normalizeMentionName(m.name)))
  const rawBase = bot.name?.trim() || accounts[bot.activeAccountId]?.displayName?.trim() || botId
  let name = rawBase
  if (usedNames.has(normalizeMentionName(name))) {
    const handle = accounts[bot.activeAccountId]?.handle?.trim()
    if (handle && !usedNames.has(normalizeMentionName(`${rawBase} · ${handle}`))) {
      name = `${rawBase} · ${handle}`
    } else {
      let n = 2
      while (usedNames.has(normalizeMentionName(`${rawBase} (${n})`))) n++
      name = `${rawBase} (${n})`
    }
  }

  if (runs.has(roomId) || useRooms.getState().speakers[roomId]) {
    stopRoom(roomId)
  }
  const member: RoomMember = {
    botId,
    platform: bot.platformId,
    accountId: bot.activeAccountId,
    name,
    agentId: bot.selectedAgentId,
    ...freshRoomSession(bot.platformId)
  }
  useRooms.setState((s) => ({
    rooms: s.rooms.map((r) => (r.id === roomId ? { ...r, members: [...r.members, member] } : r)),
    errors: { ...s.errors, [roomId]: undefined }
  }))
  return { ok: true }
}

export function moveMemberToRoom(
  sourceRoomId: string,
  botId: string,
  targetRoomId: string
): { ok: boolean; error?: string } {
  if (sourceRoomId === targetRoomId) {
    return { ok: false, error: '目标群聊不能与当前群聊相同' }
  }
  const source = roomById(sourceRoomId)
  if (!source) return { ok: false, error: '未找到源群聊' }
  const target = roomById(targetRoomId)
  if (!target) return { ok: false, error: '未找到目标群聊' }
  if (isGlobalAdmin(source) || isGlobalAdmin(target)) return { ok: false, error: '管理员调度自动同步 Bot 列表' }
  const member = source.members.find((m) => m.botId === botId)
  if (!member) return { ok: false, error: '该成员不在当前群聊中' }
  if (source.members.length <= 1) {
    return { ok: false, error: '当前群聊至少需要保留一位成员' }
  }
  if (target.members.some((m) => m.botId === botId)) {
    return { ok: false, error: '目标群聊中已包含该 Bot' }
  }
  if (target.members.some((m) => normalizeMentionName(m.name) === normalizeMentionName(member.name))) {
    return { ok: false, error: `目标群聊中已存在同名成员「${member.name}」` }
  }

  if (runs.has(sourceRoomId) || useRooms.getState().speakers[sourceRoomId]) {
    stopRoom(sourceRoomId)
  }
  if (runs.has(targetRoomId) || useRooms.getState().speakers[targetRoomId]) {
    stopRoom(targetRoomId)
  }

  const movedMember: RoomMember = {
    ...member,
    ...freshRoomSession(member.platform)
  }

  useRooms.setState((s) => ({
    rooms: s.rooms.map((r) => {
      if (r.id === sourceRoomId) {
        return { ...r, members: r.members.filter((m) => m.botId !== botId), ...dropAdmin(r, botId) }
      }
      if (r.id === targetRoomId) {
        return { ...r, members: [...r.members, movedMember] }
      }
      return r
    }),
    errors: {
      ...s.errors,
      [sourceRoomId]: undefined,
      [targetRoomId]: undefined
    }
  }))
  return { ok: true }
}

export const NO_REPLY_ERROR = '已送达，但没有收到回复'

/** GOXF: how long a group turn waits in silence for a reply once the member took the message. */
export const ROOM_REPLY_TIMEOUT_MS = 10 * 60_000
/** GOXF: after a delivered turn went unanswered, a reply that still turns up is put in the group. */
const LATE_REPLY_WINDOW_MS = 20 * 60_000

/** GOXF: a turn that failed, and whether the member had already taken the message. */
export class RoomTurnError extends Error {
  constructor(message: string, readonly delivered: boolean) {
    super(message)
    this.name = 'RoomTurnError'
  }
}

/** The line posted in the group when a member did not answer: delivered and silent reads differently from not delivered. */
export function roomFailureNotice(name: string, delivered: boolean): string {
  return delivered ? `${name} 已收到消息，本轮还没有回复。` : `${name} 本轮未送达。`
}

/**
 * GOXF: a member took the message but the turn gave up waiting. If its reply
 * still arrives, post it in the group and clear the "no reply" marks, instead
 * of leaving a delivered message looking undelivered.
 */
function watchLateReply(
  roomId: string,
  member: RoomMember,
  adapter: NonNullable<ReturnType<typeof adapterRegistry.get>>,
  conversationId: string,
  triggerId: string
) {
  const texts = new Map<string, string>()
  let settle: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    clearTimeout(expire)
    clearTimeout(settle)
    unsubscribe()
  }
  const post = () => {
    stop()
    const text = [...texts.values()].join('\n\n').trim()
    if (!text) return
    update(roomId, (r) => {
      const trigger = r.messages.find((m) => m.id === triggerId)
      const failure = trigger?.failures?.find((f) => f.botId === member.botId)
      return {
        ...r,
        messages: [
          ...r.messages
            .filter((m) => !(failure?.noticeId && m.id === failure.noticeId))
            .map((m) => m.id === triggerId && m.failures
              ? { ...m, failures: m.failures.filter((f) => f.botId !== member.botId) }
              : m),
          { id: createId('post'), author: member.name, authorBotId: member.botId, text, createdAt: Date.now() }
        ]
      }
    })
  }
  const unsubscribe = adapter.onMessage((m) => {
    if (m.conversationId !== conversationId || m.accountId !== member.accountId || !m.text.trim()) return
    texts.set(m.id, m.text)
    clearTimeout(settle)
    settle = setTimeout(post, 3_000)
  })
  const expire = setTimeout(stop, LATE_REPLY_WINDOW_MS)
}

async function memberReply(room: CollabRoom, member: RoomMember, trigger: RoomMessage, signal: AbortSignal) {
  const adapter = adapterRegistry.get(member.platform)
  const bot = useBotStore
    .getState()
    .bots.find((b) => b.id === member.botId && b.accountIds.includes(member.accountId))
  const lockKey = turnLockKey(member)
  if (!bot || !adapter || activeAccounts.has(lockKey)) {
    throw new Error(`@${member.name} 正忙或已断开连接`)
  }
  let status = adapter.getStatus(member.accountId)
  if (status !== 'online' && status !== 'attention') {
    if (status !== 'busy' && typeof adapter.connect === 'function') {
      try {
        const next = await adapter.connect(member.accountId)
        signal.throwIfAborted()
        status = next
        if (next === 'online' || next === 'attention') {
          useBotStore.getState().setAccountStatus?.(member.accountId, next)
        }
      } catch (err) {
        if (signal.aborted) throw err
      }
    }
  }
  if ((status !== 'online' && status !== 'attention') || activeAccounts.has(lockKey)) {
    throw new Error(`@${member.name} 正忙或已断开连接`)
  }
  activeAccounts.add(lockKey)
  const conversationId = 'room-turn-' + createId('turn')
  let accepted = false
  const replies = new Map<string, string>()
  const tools = new Map<string, MuseToolCall>()
  const media: MuseMediaPart[] = []
  const addTools = (list?: MuseToolCall[]) => {
    if (!list?.length) return
    for (const tool of list) tools.set(tool.id, tool)
    useRooms.setState((s) => ({ liveTools: { ...s.liveTools, [room.id]: [...tools.values()] } }))
  }
  const stopMessages = adapter.onMessage((m) => {
    if (m.conversationId !== conversationId || m.accountId !== member.accountId) return
    if (m.text.trim()) replies.set(m.id, m.text)
    addTools(m.tools)
    for (const part of m.media ?? []) if (!media.some((x) => x.path === part.path)) media.push(part)
  })
  // Running tools arrive on the live deltas.
  const stopDeltas = typeof adapter.subscribe === 'function'
    ? adapter.subscribe((event) => {
      if (event.type === 'message_delta' && event.conversationId === conversationId && event.accountId === member.accountId)
        addTools(event.tools)
    })
    : undefined
  const unsubscribe = () => {
    stopMessages()
    stopDeltas?.()
  }
  let sessionId = member.sessionId
  const hermesSessionKey = member.platform === 'hermes'
    ? member.hermesSessionKey || `${room.id}-${member.botId}` : undefined
  const cancel = () => {
    // Gemini's adapter aborts this exact room request via the supplied signal.
    if (member.platform === 'gemini') return
    void cancelPlatformTurn({
      ...bot,
      activeAccountId: member.accountId,
      activeSessionId: sessionId,
      selectedAgentId: member.agentId
    }).catch(() => {})
  }
  try {
    if (!sessionId && member.platform === 'hark') {
      const res = await getBridge()?.hark.rpc({
        accountId: member.accountId,
        op: 'createConversation',
        title: room.title
      })
      if (!res?.ok) throw new Error(res?.message ?? 'Hark unavailable')
      sessionId = (res.data as { conversationId: string }).conversationId
    } else if (!sessionId && member.platform === 'meta-muse') {
      try {
        sessionId = (await getBridge()?.muse.startSession(member.accountId))?.sessionId ?? undefined
      } catch (err) {
        // Never brick the entire collaboration room if `session.start` fails or is unsupported
        // on a specific Muse VM: fall back to `chat.stream` allocating/returning `receipt.sessionId`.
        console.warn('[room] muse.startSession failed; falling back to chat.stream session allocation', err)
        sessionId = undefined
      }
    }
    signal.throwIfAborted()
    if (sessionId && sessionId !== member.sessionId)
      update(room.id, (r) => ({
        ...r,
        members: r.members.map((m) => (m.botId === member.botId ? { ...m, sessionId } : m))
      }))
    const contextMember = member.sessionId || hermesSessionKey ? member : { ...member, cursor: 0 }
    let prompt = turnPrompt(room, contextMember, trigger)
    // GOXF: the administrator sees what each teammate is doing, so it can summarise and reassign.
    if (member.botId === room.coordinatorId) {
      const team = teamStatusBlock(snapshotMembers(room.members, member.botId))
      if (team) prompt += '\n\n' + team
    }
    if (refusesRoomFrame(member.platform)) {
      // Hark refuses another app's tool protocol: upstream's plain-language frame (in turnPrompt)
      // plus the hardened workspace portal it can reach with its own web tools.
      const portal = await openWorkspacePortal(room.id)
      if (portal) prompt += portal
    } else {
      const hub = getBridge()?.workspace
      const workspace = hub ? await hub.manage(room.id, { op: 'status' }) : undefined
      if (workspace?.tools.length) {
        prompt +=
          '\n\nTo request one workspace tool, reply with [TOOL] followed by JSON {"name":"…","args":{…}}. A person approves each call. ' +
          'Use paths relative to the workspace directory and use "." for the workspace root (never "/workspace" or "~/workspace"). Available tools: ' +
          JSON.stringify(workspace.tools.map((t) => ({ name: t.name, description: t.description, schema: t.inputSchema })))
      }
    }
    signal.throwIfAborted()
    signal.addEventListener('abort', cancel, { once: true })
    const receipt = await new Promise<SendReceipt>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason ?? new Error('Aborted'))
        return
      }
      const onAbort = () => {
        reject(signal.reason ?? new Error('Aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      adapter
        .sendMessage({
          conversationId,
          sessionId,
          accountId: member.accountId,
          agentId: member.agentId,
          hermesSessionKey,
          text: prompt,
          replyTimeoutMs: ROOM_REPLY_TIMEOUT_MS,
          onAccepted: () => { accepted = true },
          ...(trigger.attachments?.some((file) => file.dataBase64)
            ? { attachments: trigger.attachments.filter((file) => file.dataBase64) }
            : {}),
          signal
        })
        .then(
          (res) => {
            accepted = true
            signal.removeEventListener('abort', onAbort)
            resolve(res)
          },
          (err) => {
            signal.removeEventListener('abort', onAbort)
            reject(err)
          }
        )
    })
    signal.throwIfAborted()
    const text = [...replies.values()].join('\n\n')
    if (!text && !media.length) {
      watchLateReply(room.id, member, adapter, conversationId, trigger.id)
      throw new RoomTurnError(NO_REPLY_ERROR, true)
    }
    return {
      text, sessionId: receipt.sessionId || sessionId, hermesSessionKey,
      tools: [...tools.values()], media
    }
  } catch (error) {
    if (signal.aborted || error instanceof RoomTurnError) throw error
    // An adapter's 'no-reply' means the platform took the message even when onAccepted never fired.
    const delivered = accepted || (error instanceof AdapterError && error.code === 'no-reply')
    if (delivered) watchLateReply(room.id, member, adapter, conversationId, trigger.id)
    throw new RoomTurnError(error instanceof Error ? error.message : String(error), delivered)
  } finally {
    unsubscribe()
    useRooms.setState((s) => ({ liveTools: { ...s.liveTools, [room.id]: undefined } }))
    activeAccounts.delete(lockKey)
    signal.removeEventListener('abort', cancel)
  }
}

/** GOXF: drop messages and keep each member's read cursor on the same next message. */
function removeMessages(id: string, drop: (message: RoomMessage, index: number) => boolean) {
  update(id, (r) => {
    const gone = r.messages.map(drop)
    const shift = (cursor: number) => cursor - gone.slice(0, cursor).filter(Boolean).length
    return {
      ...r,
      messages: r.messages.filter((_, i) => !gone[i]),
      members: r.members.map((m) => (m.cursor ? { ...m, cursor: shift(m.cursor) } : m)),
      finalId: r.finalId && r.messages.some((m, i) => gone[i] && m.id === r.finalId) ? undefined : r.finalId
    }
  })
}

/** GOXF 撤回: stop the round, take the message out, and give its text back to the composer. */
export function recallRoomMessage(id: string, messageId: string): RoomMessage | undefined {
  const message = roomById(id)?.messages.find((m) => m.id === messageId)
  if (!message || !isHumanRoomMessage(message)) return undefined
  stopRoom(id)
  setError(id)
  removeMessages(id, (m) => m.id === messageId)
  return message
}

/** GOXF 再发一次: post the same message again; the failed copy and its "no reply" notices go away. */
export function resendRoomMessage(id: string, messageId: string) {
  const room = roomById(id)
  const index = room?.messages.findIndex((m) => m.id === messageId) ?? -1
  const message = room?.messages[index]
  if (!room || !message) return
  const noticeIds = new Set((message.failures ?? []).flatMap((f) => f.noticeId ? [f.noticeId] : []))
  // Older failures carry no noticeId: match their notice by its text.
  const names = new Set((message.failures ?? []).filter((f) => !f.noticeId).map((f) => `${f.name} 本轮未取得回复。`))
  stopRoom(id)
  removeMessages(id, (m, i) => m.id === messageId ||
    (i > index && Boolean(m.notice) && (noticeIds.has(m.id) || names.has(m.text))))
  void submitBrief(id, message.text, {
    author: message.author,
    references: message.references ?? [],
    attachments: message.attachments ?? []
  })
}

export async function submitBrief(
  id: string,
  input: string,
  { author = 'User', messageId = createId('post'), references = [], attachments = [], slackDestination, handoff, start = true, followUp = false }: {
    author?: string
    messageId?: string
    references?: RoomReference[]
    attachments?: AttachmentMeta[]
    slackDestination?: SlackDestination
    handoff?: RoomMessage['handoff']
    /** false: only post the requirement, nobody starts on it. */
    start?: boolean
    /** GOXF: typed while a round runs — goes to whoever is answering (or the administrator) next, without interrupting. */
    followUp?: boolean
  } = {}
) {
  reconcileRooms(id)
  const room = roomById(id)
  const text = input.trim() || (attachments.length ? '请看图片。' : references.length ? '请查看随附资料。' : '')
  if (!room || !text) return
  const message: RoomMessage = {
    id: messageId, author, text, createdAt: Date.now(),
    ...(references.length ? { references } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(handoff ? { handoff } : {})
  }
  if (!start) {
    update(id, (r) => ({ ...r, brief: text, finalId: undefined, messages: [...r.messages, message] }))
    return
  }
  const live = followUp ? runs.get(id) : undefined
  // An @ in the follow-up still starts a new round for the named members.
  const target = live?.queue && (room.members.find((m) => m.botId === room.coordinatorId) ??
    (mentions(text, room.members).length ? undefined : live.speaker))
  if (live?.queue && target) {
    update(id, (r) => ({ ...r, brief: text, finalId: undefined, messages: [...r.messages, message] }))
    const rest = live.queue.filter(({ member }) => member.botId !== target.botId)
    live.queue.splice(0, live.queue.length, { member: target, trigger: message }, ...rest)
    return
  }
  stopRoom(id)
  setError(id)
  const controller = new AbortController()
  let finish!: () => void
  const finished = new Promise<void>((resolve) => { finish = resolve })
  const destination = slackDestination ?? roomSlackDestination(room)
  const run: RoomRun = { controller, finished, finish, slackDestination: destination }
  const signal = controller.signal
  runs.set(id, run)
  try {
    update(id, (r) => ({ ...r, brief: text, finalId: undefined, messages: [...r.messages, message] }))
    const coordinator = room.members.find((m) => m.botId === room.coordinatorId)
    const initial = coordinator ? [coordinator] : mentions(text, room.members)
    if (!initial.length && room.mode === 'auto') {
      const { accounts } = useBotStore.getState()
      const first = room.members.find((member) => {
        const status = adapterRegistry.get(member.platform)?.getStatus(member.accountId)
        return status === 'online' || status === 'attention'
      }) ?? room.members.find((member) => isConnectedStatus(accounts[member.accountId]?.status))
        ?? room.members[0]
      if (first) initial.push(first)
    }
    const queue: Array<{ member: RoomMember; trigger: RoomMessage; handoff?: RoomMessage }> =
      initial.map((member) => ({ member, trigger: message }))
    run.queue = queue
    if (room.members.length === 0) {
      setError(id, '群聊没有可对话的成员')
      return
    }
    if (!queue.length && room.mode === 'manual') {
      setError(
        id,
        `当前为「手动 @」模式，请用 @成员名 指定回复的成员（如 @${room.members[0]?.name ?? '成员'}）`
      )
      return
    }
    const failed = new Set<string>()
    const toolRecovery = new Set<string>()
    const isQueued = (botId: string) => queue.some(({ member }) => member.botId === botId)
    for (let turn = 0; queue.length; turn++) {
      const pendingKey = JSON.stringify([id, turnLockKey(queue[0]!.member)])
      const previous = pendingTurns.get(pendingKey)
      if (previous) await previous.catch(() => {})
      signal.throwIfAborted()
      const current = roomById(id)
      if (!current) break
      if (turn >= current.limit) {
        setError(id, `已达 ${current.limit} 轮上限，待回复：${queue.map(({ member }) => '@' + member.name).join('、')}`)
        break
      }
      const next = queue.shift()!
      const member = current.members.find((m) => m.botId === next.member.botId)
      if (!member) continue
      const isCoordinator = member.botId === coordinator?.botId
      run.speaker = member
      if (next.handoff) recordHandoff(id, next.handoff, member.botId)
      useRooms.setState((s) => ({
        speakers: { ...s.speakers, [id]: member.name },
        turnProgress: { ...s.turnProgress, [id]: { turn: turn + 1, limit: current.limit } }
      }))
      const pending = memberReply(current, member, next.trigger, signal)
      pendingTurns.set(pendingKey, pending)
      let reply: Awaited<typeof pending>
      try {
        reply = await pending
      } catch (error) {
        signal.throwIfAborted()
        if (isCoordinator) throw error
        failed.add(member.botId)
        const detail = error instanceof Error ? error.message : String(error)
        const delivered = error instanceof RoomTurnError && error.delivered
        const notice: RoomMessage = {
          id: createId('post'), author: 'BotArk', notice: true,
          text: roomFailureNotice(member.name, delivered), createdAt: Date.now()
        }
        // GOXF: a human message shows who did not answer under itself, with 再发一次.
        if (isHumanRoomMessage(next.trigger)) {
          const failure = { botId: member.botId, name: member.name, error: detail, delivered, noticeId: notice.id }
          update(id, (r) => ({
            ...r,
            messages: r.messages.map((m) => m.id === next.trigger.id
              ? { ...m, failures: [...(m.failures ?? []).filter((f) => f.botId !== member.botId), failure] }
              : m)
          }))
        } else {
          setError(id, `@${member.name}：${detail}`)
        }
        // A delivered turn was read: move the cursor so the next turn does not resend the same history.
        const read = (delivered || detail === NO_REPLY_ERROR) && member.sessionId
        update(id, (r) => ({
          ...r,
          messages: [...r.messages, notice],
          members: read ? r.members.map((m) => m.botId === member.botId ? { ...m, cursor: r.messages.length + 1 } : m) : r.members
        }))
        if (coordinator && !isQueued(coordinator.botId)) queue.push({ member: coordinator, trigger: notice })
        continue
      } finally {
        if (pendingTurns.get(pendingKey) === pending) pendingTurns.delete(pendingKey)
      }
      signal.throwIfAborted()
      const latest = roomById(id)
      if (!latest) break
      // Use the roster from the prompt to resolve names, then deliver by current bot ID.
      const classified = classifyRoomReply(reply.text, member.botId, current.members, latest)
      const currentMembers = new Map(latest.members.map((m) => [m.botId, m]))
      const targets = classified.kind === 'post' ? classified.botIds : []
      const done = classified.kind === 'final'
      const toolRequest = classified.kind === 'tool'
      const post: RoomMessage = {
        id: createId('post'),
        author: member.name,
        authorBotId: member.botId,
        ...(done ? { final: true } : {}),
        ...(toolRequest ? { localOnly: true } : {}),
        text: classified.text,
        ...(reply.tools.length ? { tools: reply.tools } : {}),
        ...(reply.media.length ? { media: reply.media } : {}),
        createdAt: Date.now()
      }
      const appendPost = Boolean(post.text || targets.length || reply.media.length)
      const cursor = reply.sessionId || reply.hermesSessionKey ? latest.messages.length + Number(appendPost) : 0
      const storedMember = currentMembers.get(member.botId)
      const members = storedMember && (storedMember.cursor !== cursor || storedMember.sessionId !== reply.sessionId ||
        storedMember.hermesSessionKey !== reply.hermesSessionKey)
        ? latest.members.map((m) => m === storedMember ? {
          ...m, cursor, sessionId: reply.sessionId, hermesSessionKey: reply.hermesSessionKey
        } : m)
        : latest.members
      update(id, (r) => ({
        ...r,
        finalId: done ? post.id : undefined,
        messages: appendPost ? [...r.messages, post] : r.messages,
        members
      }))
      // A follow-up typed during this turn still gets its answer.
      if (done && !queue.some(({ trigger }) => isHumanRoomMessage(trigger))) break
      if (toolRequest) {
        let resultText: string
        let toolFailed = false
        let requestedToolName: string | undefined
        try {
          signal.throwIfAborted()
          const tool = requestedTool(post.text)
          if (!tool) throw new Error('无效的工具请求')
          requestedToolName = tool.name
          if (turn + 1 >= latest.limit) {
            setError(id, `已达 ${latest.limit} 轮上限，工具 ${tool.name} 尚未执行。`)
            break
          }
          const bridge = getBridge()?.workspace
          if (!bridge) throw new Error('工作区不可用')
          const recipient = roomRecipient(latest, destination ? `Slack ${destination.channel}` : undefined)
          resultText = await bridge.run(id, tool.name, tool.args, recipient)
        } catch (error) {
          signal.throwIfAborted()
          const toolError = `工具请求失败：${error instanceof Error ? error.message : String(error)}`
          resultText = destination && requestedToolName ? '工具请求失败。请使用已有信息继续。' : toolError
          toolFailed = true
          setError(id, `@${member.name}：${toolError}`)
        }
        signal.throwIfAborted()
        const result: RoomMessage = {
          id: createId('post'), author: 'Tool', text: resultText, createdAt: Date.now(),
          ...(toolFailed ? { localOnly: true } : {}),
          ...(!toolFailed && requestedToolName ? { references: [{ label: 'Requested tool', text: requestedToolName }] } : {})
        }
        update(id, (r) => ({
          ...r,
          messages: [...r.messages, result]
        }))
        if (!toolFailed) {
          queue.unshift({ member, trigger: result })
        } else if (coordinator && !isCoordinator) {
          if (!isQueued(coordinator.botId)) queue.push({ member: coordinator, trigger: result })
        } else if (!queue.length && turn + 1 < latest.limit && !toolRecovery.has(member.botId)) {
          toolRecovery.add(member.botId)
          queue.push({ member, trigger: result })
        }
        continue
      }
      for (const botId of targets) {
        const target = currentMembers.get(botId)
        if (!target || botId === member.botId || failed.has(botId)) continue
        const queued = queue.find(({ member }) => member.botId === botId)
        if (queued) {
          queued.trigger = post
          queued.handoff = post
        } else {
          queue.push({ member: target, trigger: post, handoff: post })
        }
      }
    }
  } catch (e) {
    if (!signal.aborted) setError(id, e instanceof Error ? e.message : String(e))
  } finally {
    if (runs.get(id) === run) {
      runs.delete(id)
      useRooms.setState((s) => ({
        speakers: { ...s.speakers, [id]: undefined },
        turnProgress: { ...s.turnProgress, [id]: undefined },
        liveTools: { ...s.liveTools, [id]: undefined }
      }))
    }
    finish()
  }
}
