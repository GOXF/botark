import type { BotActivity } from '@/types'

/**
 * Whether a live status line stays on screen.
 * muse.ai shows `activity_text` whenever it is non-empty, even outside its busy set
 * (e.g. "Waiting for cooldown" while a subagent runs) — see docs/museai/ACTIVITY.md §3.
 */
export function keepActivity(a: BotActivity | null): a is BotActivity {
  if (!a || a.code === 'idle' || a.code === 'online') return false
  return a.busy || Boolean(a.text) || (a.subagents ?? 0) > 0
}
