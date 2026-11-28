import type { ReactNode } from 'react'
import { Section } from '@/components/info/Section'
import { NumberStepper } from '@/components/ui/Controls'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Select } from '@/components/ui/Select'
import { ArkPromptSparkSvg } from '@/components/ui/ArkGlyphs'

/**
 * v22：A 群管理员 + C「协作调度」置顶。
 * 左 = 群聊「编排」页调度区（方案）：第三个选项「群管理员」，选中后挑一位本群成员；成员照常增减。
 * 右 = Muse 概览（方案）：「协作调度」固定在第一栏，不再被挤到连接器列表后面。
 */
const noop = () => undefined
const MEMBERS = ['飞鸽多店铺总控', '飞鸽多店铺千问自…', '飞鸽多店铺', '飞鸽多店铺 · 47_br…', '悟天Muse']

function Column({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex w-[300px] flex-col gap-2">
      <div className="px-1 text-[13px] font-semibold text-ink">{title}</div>
      <div className="flex flex-col rounded-2xl border border-line bg-main py-2">{children}</div>
    </div>
  )
}

function Scheduling({ admin, now = false }: { admin: boolean; now?: boolean }) {
  return (
    <Section title="调度">
      <div className="flex flex-col gap-2.5 text-[12px]">
        <SegmentedControl<'auto' | 'manual' | 'admin'>
          value={admin ? 'admin' : 'auto'}
          onValueChange={noop}
          fullWidth
          size="xs"
          // Three options don't fit the narrow panel with an icon ("自主…"), so drop it then — same rule as the tabs.
          options={now
            ? [{ value: 'auto', label: '自主接力', icon: <ArkPromptSparkSvg /> }, { value: 'manual', label: '手动 @' }]
            : [{ value: 'auto', label: '自主接力' }, { value: 'manual', label: '手动 @' }, { value: 'admin', label: '群管理员' }]}
        />
        {admin && (
          <>
            <div className="flex items-center justify-between gap-2">
              <span className="shrink-0 whitespace-nowrap text-[12px] text-ink-secondary">管理员</span>
              <Select value="0" onValueChange={noop} size="xs" variant="field" aria-label="群管理员"
                options={MEMBERS.map((m, i) => ({ value: String(i), label: m }))} />
            </div>
            <p className="text-[11px] text-ink-muted">发到本群的消息先交给管理员，由它分派给本群成员并汇总。只管本群。</p>
          </>
        )}
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-ink-secondary">单轮上限</span>
          <NumberStepper value={8} onChange={noop} min={1} max={24} suffix="轮" aria-label="单轮上限" />
        </div>
      </div>
    </Section>
  )
}

function MuseOverview() {
  return (
    <>
      <Section title="协作调度">
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={false} onChange={noop} />
          设为管理员
        </label>
      </Section>
      <Section title="额度管理"><p className="text-[12px] text-ink-muted">用量不可用</p></Section>
      <Section title="审批"><p className="text-[12px] text-ink-muted">没有待审批事项</p></Section>
      <Section title="会话" count={1}><p className="text-[12px] text-ink-muted">分析微信文章链接</p></Section>
    </>
  )
}

export function V22RoomAdminMock() {
  return (
    <div className="flex gap-6">
      <Column title="A 现在：只有两种"><Scheduling admin={false} now /></Column>
      <Column title="A 方案：选「群管理员」"><Scheduling admin /></Column>
      <Column title="C 方案：Muse 概览，协作调度在第一栏"><MuseOverview /></Column>
    </div>
  )
}
