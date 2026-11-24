import type { SlackBinding, SlackInbound } from '@shared/slack'

interface SlackMessageEvent {
  type?: string; subtype?: string; user?: string; bot_id?: string; channel?: string
  ts?: string; thread_ts?: string; text?: string; hidden?: boolean
}
export type RoutedSlackMessage = SlackInbound & { bindingGeneration?: number }
export type SlackBindingSnapshot = SlackBinding & { bindingGeneration?: number }

export function routeSlackMessage(bindings: readonly SlackBindingSnapshot[], event: SlackMessageEvent, botUser: string): RoutedSlackMessage | undefined {
  if (!['message', 'app_mention'].includes(event.type ?? '') || event.subtype || event.bot_id || event.hidden ||
    !event.user || event.user === botUser || !event.channel || !event.ts || !event.text) return
  const thread = event.thread_ts ?? event.ts
  const binding = bindings.find((b) => b.channel === event.channel && b.thread === thread) ??
    bindings.find((b) => b.channel === event.channel && !b.thread)
  if (!binding) return
  const text = event.text.replaceAll(`<@${botUser}>`, '').trim()
  if (!text) return
  return {
    channel: event.channel,
    roomId: binding.roomId,
    thread,
    fork: !binding.thread && Boolean(binding.defaultThread && binding.defaultThread !== thread),
    id: `slack-${event.channel}-${event.ts}`,
    user: event.user,
    text,
    ...(binding.bindingGeneration !== undefined ? { bindingGeneration: binding.bindingGeneration } : {})
  }
}

export function canPostToSlackBinding(
  binding: SlackBindingSnapshot,
  target: { channel?: string; thread?: string; bindingGeneration?: number }
): boolean {
  return (target.bindingGeneration === undefined || target.bindingGeneration === binding.bindingGeneration) &&
    (!target.channel || target.channel === binding.channel) &&
    (!target.thread || !binding.thread || target.thread === binding.thread)
}
export function splitSlackText(text: string): string[] {
  // Leave room under Slack's 40,000-character truncation threshold.
  const chars = Array.from(text)
  const parts: string[] = []
  for (let i = 0; i < chars.length; i += 12000) parts.push(chars.slice(i, i + 12000).join(''))
  return parts
}
