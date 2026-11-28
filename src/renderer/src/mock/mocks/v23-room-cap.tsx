import type { ReactNode } from 'react'
import { Plus } from 'lucide-react'
import { Section } from '@/components/info/Section'
import { BotAvatar } from '@/components/ui/Avatar'
import { NumberStepper } from '@/components/ui/Controls'
import { IconButton } from '@/components/ui/IconButton'
import { cn } from '@/lib/cn'

/**
 * v23：群聊「最多成员」可调。每个群一个设置，默认 6，范围 2–12，放在检查面板「成员」区头部下方。
 * 成员区标题显示「已有 / 上限」；上限不能低于当前人数；新建群聊时按全局上限 12 选人。
 */
const noop = () => undefined
const NAMES = ['飞鸽多店铺总控', '飞鸽多店铺千问', '客服', '店铺线', '海思库运维', 'DS Bot', 'Gemini 草稿', 'GitHub分组']
const COLORS = ['blue', 'violet', 'pink', 'green', 'orange', 'teal', 'gray', 'blue']

function Column({ title, caption, children }: { title: string; caption: string; children: ReactNode }) {
  return (
    <div className="flex w-[300px] flex-col gap-2">
      <div className="px-1 text-[13px] font-semibold text-ink">{title}</div>
      <div className="flex flex-col rounded-2xl border border-line bg-main py-2">{children}</div>
      <p className="px-1 text-[12px] text-ink-muted">{caption}</p>
    </div>
  )
}

function Member({ i }: { i: number }) {
  return (
    <li className="flex items-center gap-2.5 rounded-xl px-2 py-1.5">
      <BotAvatar emoji="" seed={`m${i}`} avatarShape="blob" avatarColor={COLORS[i]} platformId="meta-muse"
        status="online" size="xs" ringClassName="ring-main" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-ink">{NAMES[i]}</p>
        <p className="truncate text-[11px] text-ink-muted">Muse</p>
      </div>
    </li>
  )
}

function Members({ count, cap, min }: { count: number; cap: number; min?: boolean }) {
  const full = count >= cap
  return (
    <Section title="成员" tag={`${count}/${cap}`} flush
      action={<IconButton size="sm" label={full ? `群聊成员已达上限（${cap} 位）` : '添加成员'} disabled={full} onClick={noop}>
        <Plus aria-hidden /></IconButton>}>
      <div className="mx-4 mb-2 flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-ink-secondary">最多成员</span>
          <NumberStepper value={cap} onChange={noop} min={min ? count : 2} max={12} suffix="位" aria-label="最多成员" />
        </div>
        {min && <p className="text-[12px] text-ink-muted">已有 {count} 位成员，不能低于 {count}</p>}
      </div>
      <ul className="flex flex-col gap-0.5 px-2">
        {Array.from({ length: count }, (_, i) => <Member key={i} i={i} />)}
      </ul>
    </Section>
  )
}

function CreatePicker() {
  const picked = 7
  return (
    <div className="flex flex-col gap-2 px-3 py-1">
      <div className="text-center text-[15px] font-semibold text-ink">新建协作群聊</div>
      <div className="flex items-center justify-between px-0.5 text-[12px] text-ink-muted">
        <span>选择 2–12 位成员</span>
        <span className="tabular-nums">已选 {picked} / 最多 12</span>
      </div>
      <div className="grid grid-cols-1 gap-1.5">
        {NAMES.map((n, i) => {
          const checked = i < picked
          return (
            <div key={n} className={cn('flex items-center gap-2.5 rounded-2xl border px-3 py-2',
              checked ? 'border-ink/25 bg-active/70 shadow-hairline' : 'border-line bg-surface')}>
              <BotAvatar emoji="" seed={`m${i}`} avatarShape="blob" avatarColor={COLORS[i]} platformId="meta-muse" status="online" size="xs" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{n}</span>
              {checked
                ? <span className="grid size-5 shrink-0 place-items-center rounded-full bg-ink text-[10.5px] font-semibold text-canvas tabular-nums">{i + 1}</span>
                : <span className="size-4.5 shrink-0 rounded-full border border-line-strong" />}
            </div>
          )
        })}
      </div>
      <p className="text-[12px] text-ink-muted">建好后，群的「最多成员」默认取 6 与已选人数中较大的一个，可在成员区再调。</p>
    </div>
  )
}

export function V23RoomCapMock() {
  return (
    <div className="flex items-start gap-6">
      <Column title="1 默认：上限 6" caption="成员区标题显示「4/6」，「最多成员」默认 6，范围 2–12。"><Members count={4} cap={6} /></Column>
      <Column title="2 调高到 8" caption="已有 6 位，上限改成 8 后「添加成员」按钮重新可点。"><Members count={6} cap={8} /></Column>
      <Column title="3 不能低于现有人数" caption="减号在当前人数处变灰，下方一行说明原因；要降上限先移出成员。"><Members count={6} cap={6} min /></Column>
      <Column title="4 新建群聊：全局上限 12" caption="选人时按全局上限 12 计数，满 12 后其余卡片变灰。"><CreatePicker /></Column>
    </div>
  )
}
