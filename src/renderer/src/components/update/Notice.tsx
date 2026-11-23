/** GOXF: every update notice is the same card (icon, title + description, action, ×), stacked bottom-right. */
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'

const CARD =
  'no-drag pointer-events-auto flex w-[340px] max-w-[92vw] items-center gap-3 rounded-3xl border border-line-strong bg-main py-3 pr-2 pl-4 text-[13px] shadow-toast animate-toast-in'

export function Notice({ icon, title, desc, action, onDismiss, tip, error, leaving }: {
  icon?: ReactNode; title: string; desc?: string; action?: ReactNode; onDismiss?: () => void; tip?: string
  error?: boolean; leaving?: boolean
}) {
  return (
    <div className={cn(CARD, leaving && 'pointer-events-none animate-scrim-out')} title={tip}>
      {icon && <span className={cn('shrink-0', error ? 'text-status-error' : 'text-accent-600')}>{icon}</span>}
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-ink">{title}</p>
        {desc && <p className="text-ink-secondary">{desc}</p>}
      </div>
      {action}
      {onDismiss && (
        <button
          type="button"
          className="press-icon grid size-6 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-hover hover:text-ink"
          aria-label={t('Dismiss')}
          onClick={onDismiss}
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}
