import { useState } from 'react'
import { ArrowRight, Check, CircleDashed, Loader2, X } from 'lucide-react'
import { Section } from '@/components/info/Section'
import { MarkdownText } from '@/components/chat/MarkdownText'
import { Button } from '@/components/ui/Button'
import { SwitchPill } from '@/components/ui/Controls'
import { TextInput } from '@/components/ui/Field'
import { MENU_SURFACE } from '@/components/ui/Menu'
import { cn } from '@/lib/cn'
import type { CollabRoom, RoomMessage } from './model'
import { clock, handOffFinal, handoffSteps, openHandoffSource } from './handoff'
import { RoomAvatarCluster } from './RoomAvatarCluster'
import { useRooms } from './roomStore'

/** 交给其他群组: pick a group, add a note, optionally let its administrator start. */
export function HandoffPicker({ room, message, onClose }: {
  room: CollabRoom
  message: RoomMessage
  onClose: () => void
}) {
  const others = useRooms((s) => s.rooms).filter((r) => r.id !== room.id && !r.slackParent)
  const speakers = useRooms((s) => s.speakers)
  const [targetId, setTargetId] = useState(others[0]?.id ?? '')
  const [note, setNote] = useState('')
  const [autoStart, setAutoStart] = useState(true)
  const [error, setError] = useState('')
  const target = others.find((r) => r.id === targetId)
  // A manual-@ group without an administrator has nobody to route an unaddressed requirement to.
  const canAutoStart = Boolean(target && (target.coordinatorId || target.mode === 'auto'))

  const submit = () => {
    const res = handOffFinal(room.id, message.id, targetId, { note, autoStart: autoStart && canAutoStart })
    if (res.ok) onClose()
    else setError(res.error ?? '交接失败')
  }

  return (
    <div
      role="dialog"
      aria-label="交给其他群组"
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      className={cn('absolute top-full left-0 z-30 mt-2 flex w-80 flex-col gap-2 p-3', MENU_SURFACE, 'animate-pop-lift')}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-[13.5px] font-semibold text-ink">交给其他群组</h3>
        <button type="button" aria-label="关闭" onClick={onClose} className="press-icon grid size-6 place-items-center rounded-full text-ink-muted hover:bg-hover hover:text-ink">
          <X className="size-3.5" />
        </button>
      </div>
      {others.length === 0 ? (
        <p className="py-2 text-[12px] text-ink-muted">还没有其他群组，先新建一个再交接。</p>
      ) : (
        <div role="radiogroup" aria-label="目标群组" className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
          {others.map((r) => {
            const picked = r.id === targetId
            return (
              <button
                key={r.id}
                type="button"
                role="radio"
                aria-checked={picked}
                onClick={() => setTargetId(r.id)}
                className={cn('flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors', picked ? 'bg-accent-50' : 'hover:bg-hover')}
              >
                <RoomAvatarCluster members={r.members} size="xs" ringClassName="ring-surface" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-ink">{r.title}</p>
                  <p className="text-[11.5px] text-ink-muted">{r.members.length} 位成员 · {speakers[r.id] ? '进行中' : '空闲'}</p>
                </div>
                <span className={cn('grid size-4 shrink-0 place-items-center rounded-full border', picked ? 'border-accent-600 bg-accent-600 text-white' : 'border-line-strong')}>
                  {picked && <Check className="size-3" strokeWidth={3} />}
                </span>
              </button>
            )
          })}
        </div>
      )}
      <TextInput
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && target) submit() }}
        placeholder="附言（可选）：重点看哪里"
        aria-label="附言"
        className="h-8 text-[12.5px]"
      />
      <label className="flex items-center gap-2 text-[12px] text-ink-secondary">
        <SwitchPill size="sm" checked={autoStart && canAutoStart} disabled={!canAutoStart} onCheckedChange={setAutoStart} aria-label="自动开工" />
        {target && !canAutoStart
          ? `${target.title}是手动 @ 模式，收到后由你点名`
          : `由${target?.title ?? '对方'}${target?.coordinatorId ? '管理员' : ''}自动开工`}
      </label>
      {error && <p role="alert" className="text-[12px] text-status-error">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onClose}>取消</Button>
        <Button size="sm" variant="primary" disabled={!target} onClick={submit}>
          交给{target?.title ?? '群组'}
        </Button>
      </div>
    </div>
  )
}

/** A requirement handed over from another group, with its quoted [FINAL]. */
export function HandoffMessage({ message }: { message: RoomMessage }) {
  const source = useRooms((s) => s.rooms.find((r) => r.id === message.handoff?.roomId))
  const original = source?.messages.some((m) => m.id === message.handoff?.messageId)
  const ref = message.references?.[0]
  return (
    <article className="mx-auto w-full max-w-[780px] animate-veil-in">
      <div className="mb-1 flex items-center gap-2 text-[12.5px]">
        {source && <RoomAvatarCluster members={source.members} size="xs" ringClassName="ring-main" />}
        <span className="font-semibold tracking-tight text-ink">{message.author}</span>
        <span className="rounded-full bg-accent-50 px-1.5 py-px text-[11px] font-medium text-accent-600">需求</span>
        <span className="text-[11.5px] text-ink-muted">{clock(message.createdAt)}</span>
      </div>
      <div className="max-w-[min(100%,560px)] rounded-2xl border border-line bg-surface px-4 py-3 shadow-soft">
        <p className="mb-2 text-[14px] leading-[22px] font-medium whitespace-pre-wrap break-words text-ink">{message.text}</p>
        {ref && (
          <div className="rounded-lg border-l-[3px] border-status-online bg-sunken px-3 py-2">
            <div className="mb-1 flex items-center justify-between gap-2 text-[11.5px] text-ink-muted">
              <span className="truncate">{ref.label}</span>
              {source && original && message.handoff && (
                <button
                  type="button"
                  onClick={() => openHandoffSource(message.handoff!.roomId, message.handoff!.messageId)}
                  className="press inline-flex shrink-0 items-center gap-0.5 text-accent-600 hover:underline"
                >
                  查看原消息 <ArrowRight className="size-3" />
                </button>
              )}
            </div>
            <div className="max-h-64 overflow-y-auto text-[13px] leading-[21px] text-ink">
              <MarkdownText text={ref.text} />
            </div>
          </div>
        )}
      </div>
    </article>
  )
}

/** 交接链 开发组 → 评审组 in the room header. */
export function HandoffBreadcrumb({ room }: { room: CollabRoom }) {
  const rooms = useRooms((s) => s.rooms)
  const chain = room.handoffChain
  if (!chain || chain.length < 2) return null
  return (
    <span className="hidden min-w-0 items-center gap-1 truncate text-[11.5px] text-ink-muted lg:inline-flex" aria-label="交接链">
      交接链
      {chain.map((id, i) => (
        <span key={id} className="inline-flex items-center gap-1">
          {i > 0 && <ArrowRight className="size-3" aria-hidden />}
          <span className={cn('rounded-md px-1.5 py-0.5', id === room.id ? 'bg-accent-50 font-medium text-accent-600' : 'bg-hover text-ink-secondary')}>
            {rooms.find((r) => r.id === id)?.title ?? '已删除'}
          </span>
        </span>
      ))}
    </span>
  )
}

const RULES = ['只有 [FINAL] 定稿能交出', '对方收到带引用的需求，可点回原消息', '对方定稿后可再交下一组']

/** Right panel tab 交接: the chain with status/time, plus the rules. */
export function HandoffPanel({ room }: { room: CollabRoom }) {
  const rooms = useRooms((s) => s.rooms)
  const speakers = useRooms((s) => s.speakers)
  const steps = handoffSteps(room, rooms, speakers)
  return (
    <>
      <Section title="交接链" count={steps ? steps.length : undefined}>
        {!steps ? (
          <p className="text-[12px] text-ink-muted">还没有交接。在 [FINAL] 定稿下点「交给其他群组」开始。</p>
        ) : (
          <ol className="flex flex-col">
            {steps.map((step, i) => (
              <li key={step.key} className="relative flex gap-2.5 pb-4 last:pb-0">
                {i < steps.length - 1 && <span aria-hidden className="absolute top-5 bottom-0 left-[7px] w-px bg-line" />}
                <span className="mt-0.5 grid size-4 shrink-0 place-items-center">
                  {step.status === 'done' ? (
                    <span className="grid size-4 place-items-center rounded-full bg-status-online text-white"><Check className="size-2.5" strokeWidth={3.5} /></span>
                  ) : step.status === 'active' ? (
                    <Loader2 className={cn('size-4 text-status-busy', speakers[step.roomId ?? ''] && 'animate-spin')} />
                  ) : (
                    <CircleDashed className="size-4 text-ink-faint" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-1.5 text-[12.5px]">
                    <span className={cn('font-semibold', step.roomId === room.id ? 'text-accent-600' : 'text-ink')}>{step.title}</span>
                    <span className="truncate text-[11.5px] text-ink-muted">{step.who}</span>
                    <span className="ml-auto shrink-0 text-[11px] tabular-nums text-ink-muted">{clock(step.at)}</span>
                  </div>
                  {step.note && <p className="mt-0.5 line-clamp-2 text-[12px] text-ink-secondary">{step.note}</p>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Section>
      <Section title="交接规则">
        <ul className="flex list-disc flex-col gap-1 pl-4 text-[12px] text-ink-secondary">
          {RULES.map((r) => <li key={r}>{r}</li>)}
        </ul>
      </Section>
    </>
  )
}
