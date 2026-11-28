import { desktopCopy, useDesktopLocale } from '@/lib/desktopCopy'
import { useEffect, useState } from 'react'
import { getPlatform } from '@adapters/platforms'
import { adapterRegistry } from '@adapters/registry'
import { ArrowRightLeft, ArrowUpRight, Pencil, Plus, RotateCcw, Trash2, UserMinus, X } from 'lucide-react'
import { Section } from '@/components/info/Section'
import { AddRoomMembersDialog } from './AddRoomMembersDialog'
import { PaneHeader } from '@/components/layout/PaneHeader'
import {
  ArkExportDocSvg,
  ArkRelayOrbSvg,
  ArkSlackWeaveSvg,
  ArkWorkspaceVaultSvg
} from '@/components/ui/ArkGlyphs'
import { BotAvatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { NumberStepper } from '@/components/ui/Controls'
import { IconButton } from '@/components/ui/IconButton'
import { InlineEdit } from '@/components/ui/InlineEdit'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Select } from '@/components/ui/Select'
import { cn } from '@/lib/cn'
import { shortcutLabel } from '@/lib/shortcuts'
import { useBotStore } from '@/store/botStore'
import { isGlobalAdmin, roomRecipient, type CollabRoom } from './model'
import { RoomAvatarCluster } from './RoomAvatarCluster'
import { exportRoomMarkdownFile } from './roomExport'
export { exportRoomMarkdownFile }
import {
  clearRoomTranscript,
  deleteRoom,
  moveMemberToRoom,
  removeMember,
  renameRoom,
  roomSlackDestination,
  setGroupAdministrator,
  updateRoomConfig,
  useRooms
} from './roomStore'
import { encodeRoomMemberDrag, ROOM_MEMBER_DRAG_MIME } from './roomDnd'
import { SlackPanel } from './SlackPanel'
import { HandoffPanel } from './HandoffViews'
import { WorkspaceTools } from './WorkspaceTools'

type RoomTab = 'overview' | 'workspace' | 'slack' | 'handoff'

export function RoomInspectorPanel({ room }: { room: CollabRoom }) {
  useDesktopLocale()
  const toggleInfoPanel = useBotStore((s) => s.toggleInfoPanel)
  const bots = useBotStore((s) => s.bots)
  const accounts = useBotStore((s) => s.accounts)
  const selectBot = useBotStore((s) => s.selectBot)
  const speaker = useRooms((s) => s.speakers[room.id])
  const audience = useRooms((s) => s.externalAudiences[room.id])
  const slackDestination = roomSlackDestination(room)
  const allRooms = useRooms((s) => s.rooms)
  const [tab, setTab] = useState<RoomTab>('overview')
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [adding, setAdding] = useState(false)
  const [movingBotId, setMovingBotId] = useState<string | null>(null)
  const [targetRoomId, setTargetRoomId] = useState('')
  const [memberFeedback, setMemberFeedback] = useState<{
    kind: 'error' | 'success'
    text: string
  } | null>(null)

  useEffect(() => {
    setEditing(false)
    setConfirmDelete(false)
    setMovingBotId(null)
    setTargetRoomId('')
    setMemberFeedback(null)
  }, [room.id])

  const otherRooms = allRooms.filter((r) => r.id !== room.id && !r.coordinatorId)
  const hermesAccount = room.members.find((m) => m.platform === 'hermes')?.accountId

  return (
    <>
      <PaneHeader className="pr-3">
        <IconButton
          label={desktopCopy("关闭", "Close")}
          shortcut={shortcutLabel('I')}
          className="no-drag ml-auto"
          onClick={toggleInfoPanel}
        >
          <X />
        </IconButton>
      </PaneHeader>

      <div className="min-h-0 flex-1 overflow-y-auto pb-5">
        {/* Quiet Room Hero */}
        <div className="flex items-center gap-3 px-4 pb-3">
          <RoomAvatarCluster
            members={room.members}
            speakingName={speaker}
            size="md"
            ringClassName="ring-main"
          />
          <div className="min-w-0 flex-1">
            {editing ? (
              <InlineEdit
                value={room.title}
                label={desktopCopy("群聊名称", "Group chat name")}
                className="h-7 text-[15px] font-semibold"
                onCommit={(next) => renameRoom(room.id, next)}
                onDone={() => setEditing(false)}
              />
            ) : (
              <p className="truncate text-[15px] leading-5 font-semibold tracking-tight text-ink">
                {room.title}
              </p>
            )}
            <p className="mt-0.5 text-[12px] text-ink-muted">{room.members.length}{desktopCopy(" 位成员", " Members")}</p>
          </div>
          <IconButton label={desktopCopy("重命名", "Rename")} className="shrink-0" onClick={() => setEditing(true)}>
            <Pencil />
          </IconButton>
        </div>

        {/* Gliding Tabs */}
        <div className="px-4 pb-1">
          <SegmentedControl<RoomTab>
            value={tab}
            onValueChange={setTab}
            fullWidth
            size="xs"
            aria-label={desktopCopy("协作设置", "Collaboration Settings")}
            options={((opts) => (opts.length > 3 ? opts.map(({ icon: _icon, ...o }) => o) : opts))([
              // Four tabs don't fit the narrow panel with icons ("工…" / "Sla…"), so drop the icons then.
              { value: 'overview' as const, label: desktopCopy("编排", "Coordination"), icon: <ArkRelayOrbSvg /> },
              { value: 'workspace' as const, label: desktopCopy("工作区", "Workspace"), icon: <ArkWorkspaceVaultSvg /> },
              ...(isGlobalAdmin(room) ? [] : [{ value: 'slack' as const, label: 'Slack', icon: <ArkSlackWeaveSvg /> }]),
              { value: 'handoff' as const, label: '交接', icon: undefined }
            ])}
          />
        </div>

        <div key={`${room.id}:${tab}`} className="animate-veil-in">
          {tab === 'overview' && (
            <>
              <Section title={desktopCopy("调度", "Coordination")}>
                <div className="flex flex-col gap-2.5 text-[12px]">
                  {isGlobalAdmin(room) ? <p>{desktopCopy("管理员可向已添加的 Bot 分派任务，回复在此汇总。", "The coordinator can delegate to added bots. Their replies appear here.")}</p> : <>
                    <SegmentedControl<CollabRoom['mode'] | 'admin'>
                      value={room.coordinatorId ? 'admin' : room.mode}
                      onValueChange={(mode) => mode === 'admin'
                        ? setGroupAdministrator(room.id, room.members[0]!.botId)
                        : updateRoomConfig(room.id, { mode })}
                      fullWidth
                      size="xs"
                      // Three options don't fit the narrow panel with an icon ("自主…"), so none carries one.
                      options={[
                        { value: 'auto', label: desktopCopy("自主接力", "Automatic handoff") },
                        { value: 'manual', label: desktopCopy("手动 @", "Manual @mentions") },
                        { value: 'admin', label: '群管理员' }
                      ]}
                    />
                    {room.coordinatorId && (
                      <>
                        <div className="flex items-center justify-between gap-2">
                          <span className="shrink-0 whitespace-nowrap text-[12px] text-ink-secondary">管理员</span>
                          <Select value={room.coordinatorId} onValueChange={(id) => setGroupAdministrator(room.id, id)}
                            size="xs" variant="field" aria-label="群管理员"
                            options={room.members.map((m) => ({ value: m.botId, label: m.name }))} />
                        </div>
                        <p className="text-[11px] text-ink-muted">发到本群的消息先交给管理员，由它分派给本群成员并汇总。只管本群。</p>
                      </>
                    )}
                  </>}

                  <div className="flex items-center justify-between">
                    <span className="text-[12px] text-ink-secondary">{desktopCopy("单轮上限", "Per-turn limit")}</span>
                    <NumberStepper
                      value={room.limit}
                      onChange={(limit) => updateRoomConfig(room.id, { limit })}
                      min={1}
                      max={24}
                      suffix={desktopCopy("轮", " rounds")}
                      aria-label={desktopCopy("单轮上限", "Per-turn limit")}
                    />
                  </div>
                </div>
              </Section>

              <Section title={desktopCopy("成员", "Members")} count={room.members.length} flush
                action={<IconButton size="sm" label={isGlobalAdmin(room) ? '管理员调度自动同步 Bot 列表' : '添加成员'}
                  disabled={isGlobalAdmin(room)} onClick={() => setAdding(true)}><Plus aria-hidden /></IconButton>}>
                <AddRoomMembersDialog roomId={room.id} open={adding} onOpenChange={setAdding} />
                {memberFeedback && (
                  <p
                    role={memberFeedback.kind === 'error' ? 'alert' : 'status'}
                    className={cn(
                      'mx-4 mb-2 rounded-lg px-2.5 py-1.5 text-[11.5px]',
                      memberFeedback.kind === 'error'
                        ? 'bg-status-error/10 text-status-error'
                        : 'bg-status-online/10 text-status-online-ink'
                    )}
                  >
                    {memberFeedback.text}
                  </p>
                )}
                <ul className="flex flex-col gap-0.5 px-2">
                  {room.members.map((m) => {
                    const bot = bots.find((b) => b.id === m.botId)
                    const acc = accounts[m.accountId]
                    const adapterStatus = adapterRegistry.get(m.platform)?.getStatus(m.accountId)
                    const status =
                      acc?.status && acc.status !== 'offline'
                        ? acc.status
                        : adapterStatus && adapterStatus !== 'offline'
                          ? adapterStatus
                          : (acc?.status ?? 'offline')
                    const isSpeaking = speaker === m.name
                    const platform = getPlatform(m.platform)
                    const isMoving = movingBotId === m.botId
                    const cannotRemove = isGlobalAdmin(room) || room.members.length <= 1
                    const eligibleTargets = otherRooms.filter(
                      (r) =>
                        r.members.length < 6 &&
                        !r.members.some(
                          (tm) =>
                            tm.botId === m.botId ||
                            tm.name.toLowerCase() === m.name.toLowerCase()
                        )
                    )
                    return (
                      <li
                        key={m.botId}
                        draggable={!cannotRemove && !isMoving}
                        title={cannotRemove ? undefined : desktopCopy("拖到 Bot 列表可移出，拖到其他群聊可转移", "Drag to the bot list to remove this member, or to another group chat to move them.")}
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = 'move'
                          e.dataTransfer.setData(ROOM_MEMBER_DRAG_MIME, encodeRoomMemberDrag(room.id, m.botId))
                          e.dataTransfer.setData('text/plain', m.name)
                        }}
                        className={cn(
                          'group flex cursor-grab flex-col gap-2 rounded-xl px-2 py-1.5 transition-colors active:cursor-grabbing',
                          isSpeaking ? 'bg-accent-50/70' : 'hover:bg-hover'
                        )}
                      >
                        <div className="flex items-center gap-2.5">
                          <BotAvatar
                            emoji={bot?.emoji ?? '🤖'}
                            seed={bot?.id ?? m.botId}
                            avatar={bot?.avatar}
                            avatarShape={bot?.avatarShape}
                            avatarColor={bot?.avatarColor}
                            platformId={m.platform}
                            status={status}
                            isWorking={isSpeaking}
                            size="xs"
                            ringClassName="ring-main"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] font-medium text-ink">{m.name}</p>
                            <p className="truncate text-[11px] text-ink-muted">
                              {platform.name}
                              {acc?.handle && acc.handle !== m.name ? ` · ${acc.handle}` : ''}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                            {bot && (
                              <button
                                type="button"
                                title={desktopCopy("打开 {0}", "Open {0}", [(m.name)])}
                                aria-label={desktopCopy("打开 {0}", "Open {0}", [(m.name)])}
                                onClick={() => selectBot(bot.id)}
                                className="press-icon grid size-6 place-items-center rounded-full text-ink-muted hover:bg-active hover:text-ink"
                              >
                                <ArrowUpRight className="size-3.5" />
                              </button>
                            )}
                            <button
                              type="button"
                              title={
                                cannotRemove
                                  ? desktopCopy("群聊至少保留一位成员", "A group chat must keep at least one member.")
                                  : desktopCopy("将 {0} 移动到其他群组", "Move {0} to another group", [(m.name)])
                              }
                              aria-label={desktopCopy("移动 {0}", "Move {0}", [(m.name)])}
                              disabled={cannotRemove}
                              onClick={() => {
                                setMemberFeedback(null)
                                if (isMoving) {
                                  setMovingBotId(null)
                                  setTargetRoomId('')
                                  return
                                }
                                setMovingBotId(m.botId)
                                setTargetRoomId(eligibleTargets[0]?.id ?? '')
                              }}
                              className={cn(
                                'press-icon grid size-6 place-items-center rounded-full hover:bg-active hover:text-ink',
                                isMoving ? 'bg-active text-ink' : 'text-ink-muted',
                                cannotRemove && 'opacity-50'
                              )}
                            >
                              <ArrowRightLeft className="size-3.5" />
                            </button>
                            <button
                              type="button"
                              title={isGlobalAdmin(room) ? desktopCopy("管理员调度自动同步 Bot 列表", "Bots are synced automatically in coordinator-managed chats.") : cannotRemove ? desktopCopy("群聊至少保留一位成员", "A group chat must keep at least one member.") : `移出 ${m.name}`}
                              aria-label={`移出 ${m.name}`}
                              disabled={cannotRemove}
                              onClick={() => {
                                const res = removeMember(room.id, m.botId)
                                if (!res.ok) {
                                  setMemberFeedback({
                                    kind: 'error',
                                    text: res.error ?? desktopCopy("无法移出成员", "Couldn’t remove the member.")
                                  })
                                } else {
                                  if (isMoving) {
                                    setMovingBotId(null)
                                    setTargetRoomId('')
                                  }
                                  setMemberFeedback({
                                    kind: 'success',
                                    text: desktopCopy("已将 {0} 移出当前群聊", "Removed {0} from the current group chat.", [(m.name)])
                                  })
                                }
                              }}
                              className={cn(
                                'press-icon grid size-6 place-items-center rounded-full text-ink-muted hover:bg-status-error/15 hover:text-status-error',
                                cannotRemove && 'opacity-50'
                              )}
                            >
                              <UserMinus className="size-3.5" />
                            </button>
                          </div>
                        </div>

                        {isMoving && (
                          <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-2 text-[11.5px]">
                            {otherRooms.length === 0 ? (
                              <span className="text-ink-muted">{desktopCopy("暂无其他群聊可转移", "No other group chats are available.")}</span>
                            ) : (
                              <>
                                <Select
                                  size="xs"
                                  aria-label={`选择 ${m.name} 的目标群聊`}
                                  value={targetRoomId}
                                  onValueChange={setTargetRoomId}
                                  options={otherRooms.map((r) => {
                                    const dup = r.members.some(
                                      (tm) =>
                                        tm.botId === m.botId ||
                                        tm.name.toLowerCase() === m.name.toLowerCase()
                                    )
                                    const reason = dup ? desktopCopy("已存在", "Exists") : ''
                                    return { value: r.id, label: r.title, description: reason || undefined, disabled: Boolean(reason) }
                                  })}
                                />
                                <div className="flex items-center justify-end gap-1.5">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => {
                                      setMovingBotId(null)
                                      setTargetRoomId('')
                                    }}
                                    className="h-6 px-2 text-[11px]"
                                  >{desktopCopy("取消", "Cancel")}</Button>
                                  <Button
                                    size="sm"
                                    variant="primary"
                                    disabled={!targetRoomId}
                                    onClick={() => {
                                      const target = otherRooms.find((r) => r.id === targetRoomId)
                                      const res = moveMemberToRoom(room.id, m.botId, targetRoomId)
                                      if (!res.ok) {
                                        setMemberFeedback({
                                          kind: 'error',
                                          text: res.error ?? desktopCopy("转移成员失败", "Couldn’t move the member.")
                                        })
                                      } else {
                                        setMovingBotId(null)
                                        setTargetRoomId('')
                                        setMemberFeedback({
                                          kind: 'success',
                                          text: `已将 ${m.name} 转移到「${target?.title ?? desktopCopy("目标群聊", "Destination group chat")}」`
                                        })
                                      }
                                    }}
                                    className="h-6 px-2.5 text-[11px]"
                                  >{desktopCopy("确认转移", "Confirm move")}</Button>
                                </div>
                              </>
                            )}
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </Section>

              <Section title={desktopCopy("操作", "Actions")}>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={room.messages.length === 0}
                    onClick={() => exportRoomMarkdownFile(room)}
                    className="flex-1"
                  >
                    <ArkExportDocSvg className="size-3.5" />{desktopCopy("导出", "Export")}</Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={room.messages.length === 0}
                    onClick={() => clearRoomTranscript(room.id)}
                    title={desktopCopy("清空对话", "Clear conversation")}
                  >
                    <RotateCcw className="size-3.5" />{desktopCopy("清空", "Clear")}</Button>
                  <Button
                    size="sm"
                    variant={confirmDelete ? 'danger-confirm' : 'danger'}
                    onClick={() => {
                      if (!confirmDelete) {
                        setConfirmDelete(true)
                        return
                      }
                      deleteRoom(room.id)
                    }}
                    onBlur={() => setConfirmDelete(false)}
                  >
                    <Trash2 className="size-3.5" />
                    {confirmDelete ? desktopCopy("确认", "Confirm") : desktopCopy("删除", "Delete")}
                  </Button>
                </div>
              </Section>
            </>
          )}

          {tab === 'workspace' && (
            <WorkspaceTools
              scope={room.id}
              recipient={roomRecipient(room, slackDestination ? `Slack ${slackDestination.channel}` : audience)}
              hermesAccount={hermesAccount}
              variant="inspector"
              append={(reference) =>
                window.dispatchEvent(
                  new CustomEvent('botark:room-append-draft', {
                    detail: { roomId: room.id, reference }
                  })
                )
              }
            />
          )}

          {tab === 'handoff' && <HandoffPanel room={room} />}

          {tab === 'slack' && !room.coordinatorId &&
            (room.slackParent ? (
              <Section title={desktopCopy("Slack 线程", "Slack Thread")}>
                <p className="font-mono text-[11.5px] text-ink-secondary">
                  {room.slackChannel} · {room.slackThread}
                </p>
              </Section>
            ) : (
              <SlackPanel id={room.id} variant="inspector" />
            ))}
        </div>
      </div>
    </>
  )
}
