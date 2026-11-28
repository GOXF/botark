import { afterEach, expect, it, vi } from 'vitest'
import type { Bot } from '@/types'
import { useBotStore } from '@/store/botStore'
import { isGlobalAdmin, type CollabRoom } from './model'
import { addMemberToRoom, removeMember, setGroupAdministrator, setRoomAdministrator, updateRoomConfig, useRooms } from './roomStore'

const member = (name: string) => ({ name, botId: name, platform: 'dot' as const, accountId: name, cursor: 0 })

function setup() {
  const room: CollabRoom = { id: 'g', title: '店铺', brief: '', members: [member('A'), member('B')], mode: 'auto', limit: 8, messages: [] }
  useRooms.setState({ rooms: [room], speakers: {}, errors: {}, slackDestinations: {} })
  useBotStore.setState({ bots: ['A', 'B', 'C'].map((id) => ({ id, name: id, platformId: 'dot', accountIds: [id], activeAccountId: id } as Bot)),
    accounts: Object.fromEntries(['A', 'B', 'C'].map((id) => [id, { id, status: 'online' }])) as never })
}
const room = () => useRooms.getState().rooms.find((r) => r.id === 'g')!

afterEach(() => vi.restoreAllMocks())

it('group administrator: only this room, members stay editable, switching mode clears it', () => {
  setup()
  setGroupAdministrator('g', 'B')
  expect(room()).toMatchObject({ coordinatorId: 'B', adminScope: 'room' })
  expect(isGlobalAdmin(room())).toBe(false)
  expect(addMemberToRoom('g', 'C').ok).toBe(true)
  expect(room().members.map((m) => m.botId)).toEqual(['A', 'B', 'C'])

  updateRoomConfig('g', { mode: 'manual' })
  expect(room()).toMatchObject({ mode: 'manual', coordinatorId: undefined, adminScope: undefined })
})

it('group administrator leaving the room turns it back to plain relay', () => {
  setup()
  setGroupAdministrator('g', 'A')
  expect(removeMember('g', 'A').ok).toBe(true)
  expect(room().coordinatorId).toBeUndefined()
})

it('the global 管理员调度 room is untouched by a group administrator', () => {
  setup()
  setGroupAdministrator('g', 'A')
  const globalId = setRoomAdministrator('A', true)!
  const global = useRooms.getState().rooms.find((r) => r.id === globalId)!
  expect(global.id).not.toBe('g')
  expect(isGlobalAdmin(global)).toBe(true)
  expect(global.members.map((m) => m.botId)).toEqual(['A', 'B', 'C'])
  expect(addMemberToRoom(globalId, 'C').ok).toBe(false)
})
