/** GOXF: every update notice is the same card (icon, title + description, action, ×), stacked bottom-right. */
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'

const CARD =
  'no-drag pointer-events-auto flex w-85 max-w-[92vw] items-center gap-3 rounded-2xl border border-line-strong bg-main py-3 pr-2 pl-4 text-[13px] shadow-toast animate-toast-in'

export function Notice({ icon, title, desc, note, action, onDismiss, tip, error, leaving }: {
  icon?: ReactNode; title: string; desc?: string; note?: string; action?: ReactNode; onDismiss?: () => void; tip?: string
  error?: boolean; leaving?: boolean
}) {
  return (
    <div className={cn(CARD, leaving && 'pointer-events-none animate-scrim-out')} title={tip}>
      {icon && <span className={cn('shrink-0', error ? 'text-status-error' : 'text-accent-600')}>{icon}</span>}
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-ink">{title}</p>
        {desc && (
          <p className="line-clamp-2 text-caption text-ink-muted" title={desc}>
            {desc}
          </p>
        )}
        {note && <p className="mt-0.5 line-clamp-2 text-caption font-medium text-status-attention-ink">{note}</p>}
      </div>
      {action}
      {onDismiss && (
        <IconButton size="sm" label={t('Dismiss')} className="text-ink-muted" onClick={onDismiss}>
          <X />
        </IconButton>
      )}
    </div>
  )
}
