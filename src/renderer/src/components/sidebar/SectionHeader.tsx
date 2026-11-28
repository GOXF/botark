import { useState, type DragEvent } from 'react'
import { ArrowDown, ArrowUp, ChevronRight, GripVertical, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { InlineEdit } from '@/components/ui/InlineEdit'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/Menu'
import { cn } from '@/lib/cn'
import { useBotStore } from '@/store/botStore'
import type { BotGroup } from '@/types'
import { t } from '@/lib/i18n'

/** Drag payload: a sidebar section (value = group id). Distinct from bot drags. */
export const GROUP_DRAG_MIME = 'application/x-botark-group'

/** Drag image = this header alone, floating (padding keeps the shadow inside the captured box). */
function setHeaderGhost(e: DragEvent<HTMLElement>) {
  const header = e.currentTarget
  const rect = header.getBoundingClientRect()
  const wrap = document.createElement('div')
  wrap.className = 'fixed -top-96 left-0 p-2'
  const ghost = header.cloneNode(true) as HTMLElement
  ghost.className = cn(header.className, 'rounded-lg bg-surface opacity-90 shadow-float ring-1 ring-line')
  ghost.style.width = `${rect.width}px`
  wrap.append(ghost)
  document.body.append(wrap)
  e.dataTransfer.setDragImage(wrap, e.clientX - rect.left + 8, e.clientY - rect.top + 8)
  requestAnimationFrame(() => wrap.remove())
}

export function SectionHeader({
  group,
  botCount,
  collapsed,
  onToggle,
  onDragStart,
  onDragEnd
}: {
  group: BotGroup
  botCount: number
  collapsed: boolean
  onToggle: () => void
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const renameGroup = useBotStore((s) => s.renameGroup)
  const removeGroup = useBotStore((s) => s.removeGroup)
  const reorderGroup = useBotStore((s) => s.reorderGroup)
  const groups = useBotStore((s) => s.groups)
  const [renaming, setRenaming] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const only = groups.length <= 1
  const index = groups.findIndex((g) => g.id === group.id)
  const listId = `group-${group.id}`

  return (
    <div
      className="group/section relative flex h-7 items-center gap-0.5"
      draggable={!renaming}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData(GROUP_DRAG_MIME, group.id)
        setHeaderGhost(e)
        onDragStart()
      }}
      onDragEnd={onDragEnd}
    >
      {!renaming && (
        <span
          aria-hidden
          className="absolute top-1/2 -left-2 grid h-6 w-3 -translate-y-1/2 cursor-grab place-items-center text-ink-muted opacity-0 group-hover/section:opacity-100"
        >
          <GripVertical className="size-3" />
        </span>
      )}
      {renaming ? (
        <div className="flex min-w-0 flex-1 items-center px-1.5">
          <InlineEdit
            value={group.name === 'Workspace' ? t('Workspace') : group.name}
            label={t('Section name')}
            maxLength={40}
            className="h-7 w-full text-[12px] font-medium"
            onCommit={(name) => renameGroup(group.id, name)}
            onDone={() => setRenaming(false)}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls={listId}
          className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 text-left text-ink-muted transition-colors hover:bg-hover hover:text-ink-secondary"
        >
          <span
            id={`${listId}-label`}
            className="truncate text-[12px] font-medium tracking-tight"
            title={t('Double-click to rename')}
            onDoubleClick={(e) => {
              e.stopPropagation()
              setRenaming(true)
            }}
          >
            {group.name === 'Workspace' ? t('Workspace') : group.name || t('Unallocated')}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1 pr-0.5">
            {collapsed && botCount > 0 && (
              <span className="text-[11px] tabular-nums opacity-70">{botCount}</span>
            )}
            <ChevronRight
              aria-hidden
              className={cn(
                'size-3.5 shrink-0 transition-transform duration-150',
                !collapsed ? 'rotate-90 opacity-0 group-hover/section:opacity-80' : 'opacity-70'
              )}
            />
          </span>
        </button>
      )}

      {!renaming && (
        <Menu open={menuOpen} onOpenChange={setMenuOpen}>
          <MenuTrigger
            aria-label={`Section actions for ${group.name}`}
            className={cn(
              'press-icon grid size-6 shrink-0 place-items-center rounded-full text-ink-muted',
              'opacity-0 group-hover/section:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100',
              'hover:bg-hover hover:text-ink data-[state=open]:bg-hover'
            )}
          >
            <MoreHorizontal className="size-3.5" />
          </MenuTrigger>
          <MenuContent align="start" side="bottom" className="min-w-44">
            <MenuItem disabled={index <= 0} onSelect={() => reorderGroup(group.id, groups[index - 1]?.id ?? group.id)}>
              <ArrowUp aria-hidden /> {t('Move up')}
            </MenuItem>
            <MenuItem
              disabled={index >= groups.length - 1}
              onSelect={() => reorderGroup(group.id, groups[index + 2]?.id ?? null)}
            >
              <ArrowDown aria-hidden /> {t('Move down')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={() => setRenaming(true)}>
              <Pencil aria-hidden /> {t('Rename')}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              danger
              disabled={only}
              onSelect={() => {
                if (!only) removeGroup(group.id)
              }}
            >
              <Trash2 aria-hidden /> {only ? t('Keep one section') : t('Delete section')}
            </MenuItem>
          </MenuContent>
        </Menu>
      )}
    </div>
  )
}
