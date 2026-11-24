import { cn } from '@/lib/cn'

/** v24: the track behind 看板 · 会话 · 协作, shared with the merged chat header. */
export const VIEW_TRACK = 'no-drag flex min-w-0 items-center rounded-full bg-hover p-0.5'

/** v24: selected = the bot capsule's look; unselected = plain muted text. */
export function ViewTab({ label, selected, onClick }: { label: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={cn(
        'no-drag press h-10 shrink-0 rounded-full px-3.5 font-medium',
        selected
          ? 'border-[0.5px] border-line-strong bg-main px-4 text-[14px] text-ink shadow-float'
          : 'text-[13px] text-ink-muted hover:text-ink'
      )}
    >
      {label}
    </button>
  )
}
