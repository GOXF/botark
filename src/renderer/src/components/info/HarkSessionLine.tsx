import { useSyncExternalStore } from 'react'
import { getHarkSessionCheck, harkSessionLine, subscribeHarkSessionChecks } from '@adapters/hark/sessionCheck'
import { cn } from '@/lib/cn'

const TONE = {
  muted: 'text-ink-muted',
  ok: 'text-status-online',
  error: 'text-status-error',
  warn: 'text-status-attention'
} as const

/** The last Hark session check for an account, as one line (nothing until a check ran). */
export function HarkSessionLine({ accountId, className }: { accountId: string; className?: string }) {
  const check = useSyncExternalStore(subscribeHarkSessionChecks, () => getHarkSessionCheck(accountId))
  const line = harkSessionLine(check)
  if (!line) return null
  return (
    <span title={line.text} className={cn('block max-w-full truncate text-[12px] leading-4', TONE[line.tone], className)}>
      {line.text}
    </span>
  )
}
