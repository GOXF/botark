import { desktopCopy, useDesktopLocale } from '@/lib/desktopCopy'
import { memo, useMemo, useState, type KeyboardEvent } from 'react'
import { Plus } from 'lucide-react'
import { ArkProjectStackSvg } from '@/components/ui/ArkGlyphs'
import { cn } from '@/lib/cn'
import { getBotStatus, lastMessage } from '@/lib/selectors'
import { useBotStore } from '@/store/botStore'
import { applyDropOutOfRoom, BOT_DRAG_MIME, isRoomMemberDrag, showRoomDndNotice } from '@/rooms/roomDnd'
import type { Bot } from '@/types'
import { BotListItem } from './BotListItem'
import { ConfigureSectionsDialog } from './ConfigureSectionsDialog'
import { GROUP_DRAG_MIME, SectionHeader } from './SectionHeader'
import { t } from '@/lib/i18n'

/** ↑/↓ move between rows; Enter opens the focused one. */
function moveBetweenRows(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
  if (event.altKey || event.metaKey || event.ctrlKey) return
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-bot-row]')]
  const index = rows.findIndex((row) => row === document.activeElement)
  if (index < 0) return
  const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)]
  if (next) {
    event.preventDefault()
    next.focus()
  }
}

export const BotRow = memo(function BotRow({ bot, layout }: { bot: Bot; layout: 'collapsed' | 'pinned' | 'expanded' }) {
  const status = useBotStore((s) => getBotStatus(bot, s.accounts))
  const typing = useBotStore((s) => s.typing[bot.id] === true)
  const activity = useBotStore((s) => s.activity[bot.activeAccountId])
  const last = useBotStore((s) => layout === 'expanded' && !typing && !activity?.busy
    ? lastMessage(s.messages[bot.id]) : undefined)
  const selected = useBotStore((s) => s.selectedBotId === bot.id)
  const selectBot = useBotStore((s) => s.selectBot)
  return (
    <BotListItem bot={bot} layout={layout} status={status} last={last} typing={typing}
      activity={activity} selected={selected} onSelect={selectBot} />
  )
})

export function BotList() {
  useDesktopLocale()
  const groups = useBotStore((s) => s.groups)
  const bots = useBotStore((s) => s.bots)
  const collapsed = useBotStore((s) => s.collapsedGroups)
  const sidebarCollapsed = useBotStore((s) => s.sidebarCollapsed)
  const toggleGroup = useBotStore((s) => s.toggleGroup)
  const addGroup = useBotStore((s) => s.addGroup)
  const reorderBot = useBotStore((s) => s.reorderBot)
  const reorderGroup = useBotStore((s) => s.reorderGroup)
  const [dragGroup, setDragGroup] = useState<string | null>(null)
  /** Section drop slot: insert before this group id (null = after the last section). */
  const [groupDropBefore, setGroupDropBefore] = useState<string | null | undefined>(undefined)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<string | null>(null)
  const [memberOver, setMemberOver] = useState(false)
  const pinnedBots = useMemo(() => bots.filter((b) => b.pinned), [bots])
  const [configureOpen, setConfigureOpen] = useState(false)

  // Always-on Grok-like section chrome — include empty sections so New section is visible.
  const sections = useMemo(() => groups.map((group) => ({
    group,
    bots: bots.filter((b) => b.groupId === group.id && !b.pinned)
  })), [bots, groups])

  // Compact Rail Mode (Grok Bot `isCollapsed`)
  if (sidebarCollapsed) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col items-center overflow-y-auto" onKeyDown={moveBetweenRows}>
        <div className="flex flex-col items-center gap-1.5 py-1">
          {pinnedBots.map((bot) => (
            <BotRow key={bot.id} bot={bot} layout="collapsed" />
          ))}
          {pinnedBots.length > 0 && sections.some((s) => s.bots.length > 0) && (
            <div className="my-1 h-px w-6 rounded-full bg-ink/10" aria-hidden />
          )}
          {sections
            .filter((s) => !collapsed[s.group.id])
            .map((s, idx) => (
              <div key={s.group.id} className="flex flex-col items-center gap-1">
                {idx > 0 && s.bots.length > 0 && (
                  <div className="my-0.5 h-px w-5 rounded-full bg-ink/10" aria-hidden />
                )}
                {s.bots.map((bot) => (
                  <BotRow key={bot.id} bot={bot} layout="collapsed" />
                ))}
              </div>
            ))}
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'relative flex h-full min-h-0 flex-col rounded-xl transition-colors',
        memberOver && 'bg-status-error/[0.06] ring-1 ring-status-error/40'
      )}
      onDragOver={(e) => {
        if (!isRoomMemberDrag(e.dataTransfer.types)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!memberOver) setMemberOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMemberOver(false)
      }}
      onDrop={(e) => {
        if (!isRoomMemberDrag(e.dataTransfer.types)) return
        e.preventDefault()
        setMemberOver(false)
        showRoomDndNotice(applyDropOutOfRoom(e.dataTransfer))
      }}
    >
      {memberOver && (
        <div className="pointer-events-none absolute inset-x-2 top-1 z-10 rounded-lg bg-status-error/90 px-2 py-1 text-center text-[11.5px] font-medium text-white shadow">{desktopCopy("松开即可将该 Bot 移出群聊", "Drop here to remove this bot from the group chat")}</div>
      )}
      {/* -ml-2 pl-2: room for the hover grip left of section headers without moving them */}
      <div className="-ml-2 min-h-0 flex-1 overflow-y-auto pl-2" onKeyDown={moveBetweenRows}>
        <div
          className="flex flex-col gap-2.5 px-0 pt-0.5"
          // Section drops land here too, so releasing in the gap on the insertion line still counts.
          onDragOver={(e) => dragGroup && e.preventDefault()}
          onDrop={(e) => {
            if (!dragGroup) return
            e.preventDefault()
            if (groupDropBefore !== undefined) reorderGroup(dragGroup, groupDropBefore)
            setDragGroup(null)
            setGroupDropBefore(undefined)
          }}
        >
          {/* Grok Bot Pinned Tiles Grid (`sand-pinned-grid`) */}
          {pinnedBots.length > 0 && (
            <section aria-label={t('Pinned')} className="px-0.5 pb-1">
              <div
                className={cn(
                  'grid gap-1.5',
                  pinnedBots.length === 1
                    ? 'grid-cols-2'
                    : pinnedBots.length === 2
                      ? 'grid-cols-2'
                      : 'grid-cols-3'
                )}
              >
                {pinnedBots.map((bot) => (
                  <div
                    key={bot.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'copy'
                      e.dataTransfer.setData('text/plain', bot.id)
                      e.dataTransfer.setData(BOT_DRAG_MIME, bot.id)
                    }}
                  >
                    <BotRow bot={bot} layout="pinned" />
                  </div>
                ))}
              </div>
            </section>
          )}

          {sections.map(({ group, bots: groupBots }, index) => {
            const isCollapsed = collapsed[group.id] === true
            const listId = `group-${group.id}`
            const nextId = sections[index + 1]?.group.id ?? null
            return (
              <section
                key={group.id}
                aria-labelledby={`${listId}-label`}
                className={cn(
                  'relative',
                  dragGroup === group.id && 'opacity-40',
                  dragGroup && groupDropBefore === group.id &&
                    cn('before:absolute before:inset-x-1 before:h-0.5 before:rounded-full before:bg-accent-600',
                      index === 0 ? 'before:-top-0.5' : 'before:-top-1.5'),
                  dragGroup && groupDropBefore === null && !nextId &&
                    'after:absolute after:inset-x-1 after:-bottom-1.5 after:h-0.5 after:rounded-full after:bg-accent-600'
                )}
                onDragOver={(e) => {
                  if (dragGroup && e.dataTransfer.types.includes(GROUP_DRAG_MIME)) {
                    e.preventDefault()
                    const rect = e.currentTarget.getBoundingClientRect()
                    setGroupDropBefore(e.clientY < rect.top + Math.min(rect.height / 2, 28) ? group.id : nextId)
                    return
                  }
                  if (dragId) e.preventDefault()
                }}
                onDrop={(e) => {
                  if (!dragId || e.defaultPrevented) return
                  e.preventDefault()
                  reorderBot(dragId, group.id, null)
                  setDragId(null)
                  setDropAt(null)
                }}
              >
                <SectionHeader
                  group={group}
                  botCount={groupBots.length}
                  collapsed={isCollapsed}
                  onToggle={() => toggleGroup(group.id)}
                  onDragStart={() => setDragGroup(group.id)}
                  onDragEnd={() => {
                    setDragGroup(null)
                    setGroupDropBefore(undefined)
                  }}
                />
                {!isCollapsed && (
                  <ul id={listId} className="mt-0.5 flex flex-col gap-0.5">
                    {groupBots.map((bot) => (
                      <li
                        key={bot.id}
                        draggable
                        onDragStart={(e) => {
                          setDragId(bot.id)
                          e.dataTransfer.effectAllowed = 'copyMove'
                          e.dataTransfer.setData('text/plain', bot.id)
                          e.dataTransfer.setData(BOT_DRAG_MIME, bot.id)
                        }}
                        onDragEnd={() => {
                          setDragId(null)
                          setDropAt(null)
                        }}
                        onDragOver={(e) => {
                          if (!dragId) return
                          e.preventDefault()
                          setDropAt(bot.id)
                        }}
                        onDrop={(e) => {
                          e.preventDefault()
                          if (dragId) reorderBot(dragId, group.id, bot.id)
                          setDragId(null)
                          setDropAt(null)
                        }}
                        className={cn(
                          'relative',
                          dragId === bot.id && 'opacity-40',
                          dropAt === bot.id &&
                            dragId !== bot.id &&
                            'before:absolute before:inset-x-2 before:-top-px before:h-0.5 before:rounded-full before:bg-accent-500'
                        )}
                      >
                        <BotRow bot={bot} layout="expanded" />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )
          })}
        </div>
      </div>

      <div className="mt-auto flex shrink-0 items-center justify-between gap-1 border-t border-ink/[0.05] px-1 pt-1.5 pb-0.5">
        <button
          type="button"
          onClick={() => addGroup()}
          className="press inline-flex h-7 items-center gap-1.5 rounded-full px-2 text-[12px] font-medium text-ink-muted transition-colors hover:bg-hover hover:text-ink-secondary"
        >
          <Plus className="size-3.5" aria-hidden />
          {t('New section')}
        </button>
        <button
          type="button"
          onClick={() => setConfigureOpen(true)}
          title={t('Configure sections')}
          aria-label={t('Configure sections')}
          className="press-icon grid size-7 place-items-center rounded-full text-ink-muted transition-colors hover:bg-hover hover:text-ink-secondary"
        >
          <ArkProjectStackSvg className="size-3.5" />
        </button>
      </div>

      <ConfigureSectionsDialog open={configureOpen} onOpenChange={setConfigureOpen} />
    </div>
  )
}
