import type { SlackBridge, SlackInbound, SlackState } from '@shared/slack'
import { roomRunFinished, roomSlackDestination, submitBrief, useRooms } from './roomStore'
import { freshRoomSession, isHumanRoomMessage, type CollabRoom } from './model'
import { isToolRequest } from './toolRequests'

interface QueuedSlackMessage {
  event: SlackInbound & { bindingGeneration?: number }
  onRecorded?: () => void
}

const inboxes = new Map<string, QueuedSlackMessage[]>()

async function drainInbox(roomId: string, inbox: QueuedSlackMessage[]) {
  try {
    while (inbox.length > 0) {
      const finished = roomRunFinished(roomId)
      if (finished) {
        await finished
        continue
      }
      const room = useRooms.getState().rooms.find((r) => r.id === roomId)
      if (!room || room.coordinatorId) break
      const { event, onRecorded } = inbox.shift()!
      const run = submitBrief(roomId, event.text, {
        author: 'Slack ' + event.user,
        messageId: event.id,
        slackDestination: { channel: event.channel, thread: event.thread, bindingGeneration: event.bindingGeneration }
      })
      if (useRooms.getState().rooms.find((r) => r.id === roomId)?.messages.some((m) => m.id === event.id)) {
        onRecorded?.()
      }
      await run
    }
  } finally {
    inboxes.delete(roomId)
  }
}

export function receiveSlackMessage(event: QueuedSlackMessage['event'], onRecorded?: () => void): boolean {
  const rooms = useRooms.getState().rooms
  const parent = rooms.find((r) => r.id === event.roomId)
  if (!parent || parent.coordinatorId) return false
  const id = event.fork ? event.roomId + '/slack/' + event.channel + '/' + event.thread : parent.id
  let room = rooms.find((r) => r.id === id)
  if (!room) {
    const fork: CollabRoom = { ...parent, id, title: parent.title + ' · ' + event.text.slice(0, 40),
      pinned: undefined, messages: [], brief: '', finalId: undefined, slackParent: parent.id, slackThread: event.thread, slackChannel: event.channel,
      members: parent.members.map((m) => ({ ...m, ...freshRoomSession(m.platform) })) }
    useRooms.setState((s) => ({ rooms: [...s.rooms, fork], externalAudiences: { ...s.externalAudiences, [id]: 'Slack ' + event.channel } }))
    room = fork
  }
  if (room.messages.some((m) => m.id === event.id)) {
    onRecorded?.()
    return true
  }
  const inbox = inboxes.get(id)
  if (inbox) {
    const queued = inbox.find((message) => message.event.id === event.id)
    if (queued) queued.onRecorded ??= onRecorded
    else inbox.push({ event, onRecorded })
  } else {
    const pending = [{ event, onRecorded }]
    inboxes.set(id, pending)
    void drainInbox(id, pending)
  }
  return true
}

function publishNew(bridge: SlackBridge, room: CollabRoom, previousLength: number) {
  const destination = roomSlackDestination(room)
  if (!destination) return
  for (const message of room.messages.slice(previousLength)) {
    if (message.id.startsWith('slack-') || (!message.authorBotId && message.author.startsWith('Slack ')) ||
      message.localOnly || (!isHumanRoomMessage(message) && isToolRequest(message.text))) continue
    const post = {
      op: 'post' as const, roomId: room.slackParent ?? room.id,
      channel: destination.channel, thread: destination.thread, text: `[${message.author}] ${message.text}`,
      ...(destination.bindingGeneration !== undefined ? { bindingGeneration: destination.bindingGeneration } : {})
    }
    void bridge.request(post).catch((e) => useRooms.setState((s) => ({
        errors: { ...s.errors, [room.id]: `Slack 同步失败：${e instanceof Error ? e.message : String(e)}` }
      })))
  }
}
let unsubscribe: (() => void) | undefined

export function applySlackConnection(bridge: SlackBridge, connection: Omit<SlackState, 'bindings'> & {
  bindings: Array<SlackState['bindings'][number] & { bindingGeneration?: number }>
}) {
  unsubscribe?.()
  unsubscribe = undefined
  if (connection.connected) sessionStorage.setItem('botark.slack.connected', '1')
  else sessionStorage.removeItem('botark.slack.connected')
  const destinations = connection.connected ? Object.fromEntries(connection.bindings.map((b) => [b.roomId, {
    channel: b.channel, thread: b.thread ?? b.defaultThread, bindingGeneration: b.bindingGeneration
  }])) : {}
  const audiences: Record<string, string> = {}
  for (const room of useRooms.getState().rooms) {
    const binding = destinations[room.slackParent ?? room.id]
    const channel = binding && (room.slackChannel ?? binding.channel)
    if (channel) audiences[room.id] = 'Slack ' + channel
  }
  useRooms.setState({ externalAudiences: audiences, slackDestinations: destinations })
  if (!connection.connected) return
  const off = bridge.onMessage((msg) => {
    receiveSlackMessage(msg, () => { void bridge.request({ op: 'received', id: msg.id }).catch(() => {}) })
  })
  const stop = useRooms.subscribe((state, before) => {
    if (state.rooms === before.rooms) return
    for (const [index, room] of state.rooms.entries()) {
      if (room === before.rooms[index]) continue
      if (room.coordinatorId || !destinations[room.slackParent ?? room.id]) continue
      const previous = before.rooms[index]
      const old = previous?.id === room.id ? previous : before.rooms.find((r) => r.id === room.id)
      if (old && room.messages.length > old.messages.length) publishNew(bridge, room, old.messages.length)
    }
  })
  unsubscribe = () => { off(); stop() }
}
