import type { HarkChatMessage } from './harkClient'

export const HARK_ACTIVE_TOOL = /^(running|pending|active|started|waiting_for_input|awaiting_input)$/i
const TERMINAL_JOB = /^(completed|cancelled|failed|interrupted|cost_capped)$/i
/** After the reply, keep watching until Hark has been quiet this long… */
export const HARK_TAIL_IDLE_MS = 10_000
/** …but never longer than this. */
export const HARK_TAIL_CAP_MS = 30 * 60_000

/**
 * GOXF: Hark keeps the turn open after the visible reply (a run_subagent still
 * running, "等待任务完成。"). Busy while there is a live status line, a tool of
 * this turn still running, or a newer assistant message still streaming.
 */
export function harkTurnBusy(
  state: { narration: string | null; activeActivity: string | null; orderedMessages(): HarkChatMessage[] },
  earlierIds: ReadonlySet<string>
): boolean {
  if (state.narration?.trim() || state.activeActivity?.trim()) return true
  return state.orderedMessages().some(
    (m) =>
      !earlierIds.has(m.id) &&
      !/^user$/i.test(m.role) &&
      ((m.isStreaming === true && !TERMINAL_JOB.test(m.jobStatus ?? '')) ||
        Boolean(m.toolCalls?.some((tc) => HARK_ACTIVE_TOOL.test(tc.status))))
  )
}
