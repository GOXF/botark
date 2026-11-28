import { useState } from 'react'
import { GripVertical, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { IconButton } from '@/components/ui/IconButton'
import { cn } from '@/lib/cn'
import { useBotStore } from '@/store/botStore'
import { t } from '@/lib/i18n'
import { GROUP_DRAG_MIME } from './SectionHeader'

interface ConfigureSectionsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Local-only section editor (Grok "Configure sections" chrome).
 * Renames / deletes workspace groups; does not call any host sidebar APIs.
 */
export function ConfigureSectionsDialog({ open, onOpenChange }: ConfigureSectionsDialogProps) {
  const groups = useBotStore((s) => s.groups)
  const bots = useBotStore((s) => s.bots)
  const renameGroup = useBotStore((s) => s.renameGroup)
  const removeGroup = useBotStore((s) => s.removeGroup)
  const addGroup = useBotStore((s) => s.addGroup)
  const reorderGroup = useBotStore((s) => s.reorderGroup)
  const [dragId, setDragId] = useState<string | null>(null)
  /** Insert before this group id (null = end). */
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined)
  const endDrag = () => {
    setDragId(null)
    setDropBefore(undefined)
  }
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const openChange = (next: boolean) => {
    if (next) {
      const nextDrafts: Record<string, string> = {}
      for (const g of useBotStore.getState().groups) nextDrafts[g.id] = g.name
      setDrafts(nextDrafts)
    }
    onOpenChange(next)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={openChange}
      title={t('Configure sections')}
      description={t('Drag the handle to reorder.')}
      showDescription
      className="max-w-[380px]"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              const id = addGroup()
              setDrafts((d) => ({ ...d, [id]: useBotStore.getState().groups.find((g) => g.id === id)?.name ?? t('New section') }))
            }}
          >
            <Plus className="size-3.5" aria-hidden />
            {t('New section')}
          </Button>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {t('Done')}
          </Button>
        </div>
      }
    >
      <ul className="flex flex-col gap-2">
        {groups.map((group, index) => {
          const count = bots.filter((b) => b.groupId === group.id).length
          const only = groups.length <= 1
          const nextId = groups[index + 1]?.id ?? null
          return (
            <li
              key={group.id}
              className={cn(
                'relative flex items-center gap-2 rounded-xl border border-line bg-surface px-2.5 py-2',
                dragId === group.id && 'opacity-40',
                dragId && dropBefore === group.id &&
                  'before:absolute before:inset-x-1 before:-top-[5px] before:h-0.5 before:rounded-full before:bg-accent-600',
                dragId && dropBefore === null && !nextId &&
                  'after:absolute after:inset-x-1 after:-bottom-[5px] after:h-0.5 after:rounded-full after:bg-accent-600'
              )}
              onDragOver={(e) => {
                if (!dragId || !e.dataTransfer.types.includes(GROUP_DRAG_MIME)) return
                e.preventDefault()
                const rect = e.currentTarget.getBoundingClientRect()
                setDropBefore(e.clientY < rect.top + rect.height / 2 ? group.id : nextId)
              }}
              onDrop={(e) => {
                if (!dragId) return
                e.preventDefault()
                if (dropBefore !== undefined) reorderGroup(dragId, dropBefore)
                endDrag()
              }}
            >
              {/* Only the grip is draggable, so the name input keeps normal text selection. */}
              <span
                draggable
                aria-hidden
                className="-ml-1 grid h-6 w-4 shrink-0 cursor-grab place-items-center text-ink-muted"
                onDragStart={(e) => {
                  const row = e.currentTarget.parentElement
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData(GROUP_DRAG_MIME, group.id)
                  if (row) e.dataTransfer.setDragImage(row, 16, row.offsetHeight / 2)
                  setDragId(group.id)
                }}
                onDragEnd={endDrag}
              >
                <GripVertical className="size-4" />
              </span>
              <input
                value={drafts[group.id] ?? group.name}
                aria-label={`Section name for ${group.name}`}
                maxLength={40}
                onChange={(event) => setDrafts((d) => ({ ...d, [group.id]: event.target.value }))}
                onBlur={() => {
                  const next = (drafts[group.id] ?? group.name).trim()
                  if (next) renameGroup(group.id, next)
                  else setDrafts((d) => ({ ...d, [group.id]: group.name }))
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') (event.target as HTMLInputElement).blur()
                }}
                className="min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none"
              />
              <span className="shrink-0 text-[12px] tabular-nums text-ink-muted">{count}</span>
              <IconButton
                label={only ? t('Keep at least one section') : count > 0 ? t('Bots move to another section') : t('Delete section')}
                disabled={only}
                onClick={() => {
                  removeGroup(group.id)
                  setDrafts((d) => {
                    const { [group.id]: _drop, ...rest } = d
                    return rest
                  })
                }}
              >
                <Trash2 />
              </IconButton>
            </li>
          )
        })}
      </ul>
    </Dialog>
  )
}
