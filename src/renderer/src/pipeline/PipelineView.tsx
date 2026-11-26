import { useState, type ReactNode } from 'react'
import { Check, ChevronLeft, ChevronRight, Circle, HelpCircle, Loader2, Plus, Trash2 } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { BotAvatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Field, TextInput } from '@/components/ui/Field'
import { IconButton } from '@/components/ui/IconButton'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/Menu'
import { Select } from '@/components/ui/Select'
import { activityPhrase, formatShortTime } from '@/components/sidebar/BotListItem'
import { cn } from '@/lib/cn'
import { RoomAvatarCluster } from '@/rooms/RoomAvatarCluster'
import { useRooms } from '@/rooms/roomStore'
import { useBotStore } from '@/store/botStore'
import { lastReject, needsMe, STAGES, type Executor, type PipelineTask, type Stage } from './model'
import {
  adminRoom,
  confirmAssign,
  createTask,
  deleteTask,
  executorCandidates,
  finishDev,
  passGate,
  rejectGate,
  releaseTask,
  skipSuggest,
  usePipeline
} from './pipelineStore'

const HEAD: Record<Stage, string> = {
  need: 'bg-ink-faint',
  assign: 'bg-status-attention',
  dev: 'bg-status-busy',
  review: 'bg-status-busy',
  confirm: 'bg-status-attention',
  live: 'bg-status-online'
}

const BOX = 'rounded-lg bg-hover px-2.5 py-1.5 text-[12px] leading-4.5 text-ink-secondary'
const clip = (s?: string) => (s ?? '').replace(/\s+/g, ' ').trim()

function ExecutorLine({ ex, time }: { ex?: Executor; time: number }) {
  const bot = useBotStore((s) => (ex?.kind === 'bot' ? s.bots.find((b) => b.id === ex.id) : undefined))
  const room = useRooms((s) => (ex?.kind === 'room' ? s.rooms.find((r) => r.id === ex.id) : undefined))
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[13px]">
      {!ex ? (
        <>
          <HelpCircle aria-hidden className="size-4 text-ink-faint" />
          <span className="text-ink-muted">未分配</span>
        </>
      ) : (
        <>
          {bot ? (
            <BotAvatar emoji={bot.emoji} seed={bot.id} avatar={bot.avatar} avatarShape={bot.avatarShape} avatarColor={bot.avatarColor} platformId={bot.platformId} size="xs" />
          ) : room ? (
            <RoomAvatarCluster members={room.members.slice(0, 3)} size="xs" />
          ) : null}
          <span className="min-w-0 truncate font-medium text-ink">{bot?.name ?? room?.title ?? ex.name}</span>
          <span className="shrink-0 rounded-full bg-hover px-1.5 text-[11px] text-ink-muted">{ex.kind === 'room' ? '群组' : 'Bot'}</span>
        </>
      )}
      <span className="ml-auto shrink-0 text-[11px] text-ink-muted">{formatShortTime(time)}</span>
    </span>
  )
}

/** Six segments, one per stage; filled up to where the card is. */
function Progress({ task }: { task: PipelineTask }) {
  const at = STAGES.findIndex((s) => s.id === task.stage)
  const done = task.stage === 'live' && task.releasedAt
  return (
    <span aria-hidden className="flex gap-1">
      {STAGES.map((s, i) => (
        <span key={s.id} className={cn('h-0.75 flex-1 rounded-full', i <= at ? (done ? 'bg-status-online' : 'bg-accent-600') : 'bg-hover')} />
      ))}
    </span>
  )
}

/** 当前一步 for a card in 开发: who is speaking in the group, or what the bot is doing. */
function DevStep({ ex }: { ex?: Executor }) {
  const speaker = useRooms((s) => (ex?.kind === 'room' ? s.speakers[ex.id] : undefined))
  const turn = useRooms((s) => (ex?.kind === 'room' ? s.turnProgress[ex.id] : undefined))
  const live = useBotStore((s) => {
    if (ex?.kind !== 'bot') return ''
    const bot = s.bots.find((b) => b.id === ex.id)
    return activityPhrase(bot ? s.activity[bot.activeAccountId] : undefined) || (s.typing[ex.id] ? '正在回复' : '')
  })
  const text = speaker ? `${speaker} 正在发言` : live
  return (
    <span className="flex min-w-0 flex-col gap-0.5 text-[12px] leading-4.5">
      <span className={cn('flex min-w-0 items-center gap-1.5', text ? 'text-status-busy-ink' : 'text-ink-muted')}>
        {text && <Loader2 aria-hidden className="size-3 shrink-0 animate-spin" />}
        <span className="truncate">{text || '等待执行者回复'}</span>
      </span>
      {turn && <span className="text-ink-muted">第 {turn.turn} / {turn.limit} 轮</span>}
    </span>
  )
}

function RejectInput({ onDone }: { onDone: (reason?: string) => void }) {
  const [reason, setReason] = useState('')
  return (
    <TextInput
      autoFocus
      value={reason}
      placeholder="一句话说明打回原因，回车确认"
      className="h-8 text-[12px]"
      onChange={(e) => setReason(e.target.value)}
      onBlur={() => !reason.trim() && onDone()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDone()
        if (e.key === 'Enter' && reason.trim()) onDone(reason)
      }}
    />
  )
}

function Gate({ task, children }: { task: PipelineTask; children?: ReactNode }) {
  const [rejecting, setRejecting] = useState(false)
  if (rejecting) return <RejectInput onDone={(reason) => { setRejecting(false); if (reason) rejectGate(task.id, reason) }} />
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Button size="sm" variant="primary" className="bg-status-online hover:bg-status-online/90" onClick={() => passGate(task.id)}>
        <Check />通过
      </Button>
      <Button size="sm" variant="danger" className="border border-status-error/40" onClick={() => setRejecting(true)}>
        <ChevronLeft />打回
      </Button>
      {children}
    </span>
  )
}

function Card({ task, onRelease }: { task: PipelineTask; onRelease: (t: PipelineTask) => void }) {
  const busy = usePipeline((s) => s.busy[task.id])
  const selectBot = useBotStore((s) => s.selectBot)
  const back = task.stage === 'dev' ? lastReject(task) : undefined
  const gate = task.stage === 'assign' || task.stage === 'review' || task.stage === 'confirm'
  const sug = task.suggestion
  const hasAdmin = useRooms((s) => s.rooms.some((r) => r.coordinatorId))
  return (
    <li
      className={cn(
        'group flex flex-col gap-2 rounded-xl border bg-main p-3 shadow-soft',
        gate ? 'border-status-attention/60' : back ? 'border-status-error/40' : 'border-line'
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{task.title}</span>
        <IconButton label="删除任务" size="sm" className="hidden size-5 group-hover:inline-flex [&_svg]:size-3.5" onClick={() => deleteTask(task.id)}>
          <Trash2 />
        </IconButton>
        <span className="shrink-0 rounded-full bg-hover px-1.5 text-[11px] text-ink-muted">#{task.num}</span>
      </span>
      <ExecutorLine ex={task.executor} time={task.updatedAt} />
      <Progress task={task} />

      {task.stage === 'need' && (
        <>
          <span className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
            {busy && <Loader2 aria-hidden className="size-3 animate-spin text-status-busy" />}
            {busy ?? (hasAdmin ? '待管理员拆分' : task.detail ? clip(task.detail) : '等排期')}
          </span>
          {!busy && (
            <Button size="sm" className="self-start" onClick={() => skipSuggest(task.id)}>
              去分配
            </Button>
          )}
        </>
      )}

      {task.stage === 'assign' && (
        <>
          <span className="text-[12px] font-medium text-status-attention-ink">{sug ? '管理员建议分配' : '请选择执行者'}</span>
          {sug && (
            <span className={BOX}>
              管理员：{sug.plan.length ? `拆 ${sug.plan.length} 步` : '不拆分'}
              {sug.executor ? ` → ${sug.executor.name}` : '，未指定执行者'}
            </span>
          )}
          <span className="flex flex-wrap items-center gap-1.5">
            {sug?.executor && (
              <Button size="sm" variant="primary" onClick={() => confirmAssign(task.id, sug.executor!)}>
                <Check />确认分配
              </Button>
            )}
            <Menu>
              <MenuTrigger asChild>
                <Button size="sm">{sug?.executor ? '改给…' : '分配给…'}</Button>
              </MenuTrigger>
              <MenuContent align="start" className="max-h-72 overflow-y-auto">
                {executorCandidates().map((c) => (
                  <MenuItem key={`${c.kind}:${c.id}`} hint={c.kind === 'room' ? '群组' : 'Bot'} onSelect={() => confirmAssign(task.id, c)}>
                    {c.name}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          </span>
        </>
      )}

      {task.stage === 'dev' && (
        <>
          {back ? (
            <span className="flex flex-col gap-0.5 text-[12px] leading-4.5">
              <span className="text-status-error">已打回 · 第 {task.round} 轮修改中</span>
              <span className="line-clamp-2 text-ink-muted">你：{back.reason}</span>
            </span>
          ) : (
            <DevStep ex={task.executor} />
          )}
          {sug?.plan.length ? <span className="text-[12px] text-ink-muted">共 {sug.plan.length} 步</span> : null}
          <Button size="sm" className="self-start" onClick={() => finishDev(task.id)}>
            开发完成，提交 Review
          </Button>
        </>
      )}

      {task.stage === 'review' && (
        <>
          <span className="text-[12px] font-medium text-status-attention-ink">等你过关卡</span>
          <span className={BOX}>
            {busy ? (
              <span className="flex items-center gap-1.5"><Loader2 aria-hidden className="size-3 animate-spin" />{busy}</span>
            ) : task.review ? (
              <>
                <span className="block font-medium text-ink">评审组 [FINAL] 定稿</span>
                <span className="line-clamp-3">{clip(task.review)}</span>
              </>
            ) : (
              <span className="line-clamp-3">{clip(task.output) || '没有开发产出摘要'}</span>
            )}
          </span>
          <Gate task={task}>
            {task.reviewRoomId && (
              <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-accent-600 hover:text-accent-700" onClick={() => selectBot(task.reviewRoomId!)}>
                查看评审
              </Button>
            )}
          </Gate>
        </>
      )}

      {task.stage === 'confirm' && (
        <>
          <span className="text-[12px] font-medium text-status-attention-ink">等你真机确认</span>
          {task.output && <span className={cn(BOX, 'line-clamp-3 bg-status-attention/10 text-status-attention-ink')}>{clip(task.output)}</span>}
          <Gate task={task} />
        </>
      )}

      {task.stage === 'live' &&
        (task.releasedAt ? (
          <span className="flex items-center gap-1.5 text-[12px] text-status-online-ink">
            <Check aria-hidden className="size-3" />已上线 · {formatShortTime(task.releasedAt)}
          </span>
        ) : (
          <>
            <span className="text-[12px] text-ink-secondary">人工确认已通过</span>
            <Button size="sm" className="self-start bg-ink text-main hover:bg-ink/85" onClick={() => onRelease(task)}>
              <Circle />确认上线
            </Button>
          </>
        ))}
    </li>
  )
}

function NewTaskDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [review, setReview] = useState('')
  const rooms = useRooms(useShallow((s) => s.rooms.filter((r) => !r.coordinatorId)))
  const submit = () => {
    if (!createTask(title, detail, review)) return
    setTitle('')
    setDetail('')
    onOpenChange(false)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="新任务"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>取消</Button>
          <Button variant="primary" disabled={!title.trim()} onClick={submit}>创建</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="需求" htmlFor="pipeline-title">
          <TextInput id="pipeline-title" autoFocus value={title} placeholder="一句话说清要做什么" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        </Field>
        <Field label="说明（可选）" htmlFor="pipeline-detail">
          <textarea
            id="pipeline-detail"
            value={detail}
            rows={4}
            onChange={(e) => setDetail(e.target.value)}
            className="w-full rounded-lg border border-line-strong bg-surface p-2.5 text-ui text-ink shadow-soft outline-none focus:border-accent-300 focus:ring-3 focus:ring-accent-100"
          />
        </Field>
        <Field label="评审组（可选）" hint="开发完成后把产出交给这个群组评审，它的 [FINAL] 显示在 Review 关卡上。">
          <Select value={review} onValueChange={setReview} options={[{ value: '', label: '不需要' }, ...rooms.map((r) => ({ value: r.id, label: r.title }))]} />
        </Field>
      </div>
    </Dialog>
  )
}

function ReleaseDialog({ task, onClose }: { task?: PipelineTask; onClose: () => void }) {
  const hook = usePipeline((s) => s.releaseHook)
  return (
    <Dialog
      open={Boolean(task)}
      onOpenChange={(open) => !open && onClose()}
      title={task ? `确认上线 #${task.num}？` : ''}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={() => { if (task) releaseTask(task.id); onClose() }}>确认上线</Button>
        </>
      }
    >
      <Field label="上线动作（可选）" htmlFor="pipeline-hook" hint="填 http(s) 地址（如 CI 发布页），确认后在浏览器打开；留空只标记为已上线。">
        <TextInput id="pipeline-hook" value={hook} placeholder="https://" onChange={(e) => usePipeline.setState({ releaseHook: e.target.value })} />
      </Field>
    </Dialog>
  )
}

/**
 * GOXF 任务流水线: task cards flow 需求→分配→开发→Review→人工确认→上线.
 * Review and 人工确认 are gates (orange): 通过 or 打回 with a one-line reason.
 */
export function PipelineView({ toggle }: { toggle: ReactNode }) {
  const { tasks, mineOnly } = usePipeline(useShallow((s) => ({ tasks: s.tasks, mineOnly: s.mineOnly })))
  useRooms((s) => s.rooms) // re-render when the administrator room appears or goes
  const admin = adminRoom()
  const owner = useBotStore((s) => (admin ? s.bots.find((b) => b.id === admin.coordinatorId) : undefined))
  const [creating, setCreating] = useState(false)
  const [releasing, setReleasing] = useState<PipelineTask>()
  const shown = mineOnly ? tasks.filter(needsMe) : tasks

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-3 px-4">
        {toggle}
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-muted">
          管理员调度
          {owner ? (
            <>
              <BotAvatar emoji={owner.emoji} seed={owner.id} avatar={owner.avatar} avatarShape={owner.avatarShape} avatarColor={owner.avatarColor} platformId={owner.platformId} size="xs" />
              <span className="truncate font-medium text-ink">{owner.name}</span>
              <span className="shrink-0 rounded-full bg-status-online/10 px-1.5 text-[11px] text-status-online-ink">自动拆分 · 建议分配</span>
            </>
          ) : (
            <span>未开启，手动分配</span>
          )}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <Button size="sm" className={cn(mineOnly && 'bg-accent-600/10 text-accent-600')} aria-pressed={mineOnly} onClick={() => usePipeline.setState({ mineOnly: !mineOnly })}>
            只看要我处理的
          </Button>
          <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
            <Plus />新任务
          </Button>
        </span>
      </div>
      <div className="flex min-h-0 flex-1 gap-1 overflow-x-auto px-4 pb-4">
        {STAGES.map((stage, i) => {
          const list = shown.filter((t) => t.stage === stage.id).sort((a, b) => b.updatedAt - a.updatedAt)
          return (
            <div key={stage.id} className="flex min-w-50 flex-1 items-stretch gap-1">
              <section aria-label={stage.label} className="flex min-w-0 flex-1 flex-col rounded-2xl bg-canvas/60">
                <header className="flex h-10 shrink-0 items-center gap-2 px-3">
                  <span className={cn('size-2 rounded-full', HEAD[stage.id])} />
                  <h3 className="text-[13px] font-semibold text-ink">{stage.label}</h3>
                  <span className="text-[12px] text-ink-muted">{list.length}</span>
                  {stage.gate && <span className="ml-auto rounded-full bg-status-attention/15 px-1.5 text-[11px] text-status-attention-ink">关卡</span>}
                </header>
                <ol className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                  {list.map((t) => <Card key={t.id} task={t} onRelease={setReleasing} />)}
                  {list.length === 0 && <li className="px-2 py-6 text-center text-[12px] text-ink-faint">没有</li>}
                </ol>
              </section>
              {i < STAGES.length - 1 && <ChevronRight aria-hidden className="mt-3 size-3.5 shrink-0 text-ink-faint" />}
            </div>
          )
        })}
      </div>
      <NewTaskDialog open={creating} onOpenChange={setCreating} />
      <ReleaseDialog task={releasing} onClose={() => setReleasing(undefined)} />
    </div>
  )
}
