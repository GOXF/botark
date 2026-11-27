import type { ReactNode } from 'react'
import { BotListItem } from '@/components/sidebar/BotListItem'
import { useHarkWork } from '@/services/harkWork'
import type { ConnectionStatus } from '@adapters/types'
import type { Bot, ChatMessage } from '@/types'

/**
 * v19：头像状态点。左 = 现在；右 = 方案：点放大到 12px，外圈 2.5px「挖空」描边，
 * 描边颜色跟着这一行的底色走（选中行也一样），所以无论头像什么颜色都和头像分得开。
 * 颜色按状态本身：蓝=进行中，橙=等你处理，绿=做完了没看，红=出错，灰=离线。
 * 故意让头像和点同色（蓝配蓝、绿配绿、橙配橙）来看边界。
 */
const NOW = new Date('2026-11-27T17:40:00+08:00').getTime()

function bot(id: string, name: string, color: string, unread = 0): Bot {
  return {
    id, name, emoji: '', avatarShape: 'blob', avatarColor: color, description: '', platformId: 'hark',
    groupId: 'default', accountIds: [`acc-${id}`], activeAccountId: `acc-${id}`, memory: [], notes: '',
    createdAt: 0, unread
  } as Bot
}
function msg(text: string, minsAgo: number): ChatMessage {
  return { id: `m${minsAgo}`, role: 'assistant', text, createdAt: NOW - minsAgo * 60_000 } as unknown as ChatMessage
}

useHarkWork.setState({
  projects: { 'acc-pt': { c1: { lastRun: NOW - 900_000, polled: true, working: false, since: 0, doneAt: NOW - 120_000 } } },
  seenAt: {}
})

interface Row { b: Bot; status: ConnectionStatus; last?: ChatMessage; typing?: boolean; selected?: boolean }
const ROWS: Row[] = [
  { b: bot('kf', '客服 · 进行中', 'blue'), status: 'online', typing: true },
  { b: bot('kf2', '违规 · 进行中（选中）', 'violet'), status: 'online', typing: true, selected: true },
  { b: bot('pj', '评价 · 等你处理', 'orange'), status: 'attention', last: msg('需要你确认一下回复口径。', 5) },
  { b: bot('pt', '品退 · 做完了没看', 'green'), status: 'online', last: msg('退货原因已汇总。', 2) },
  { b: bot('dp', '店铺线 · 出错', 'pink'), status: 'error', last: msg('连接失败', 12) },
  { b: bot('lx', '旧账号 · 离线', 'gray'), status: 'offline', last: msg('好的。', 300) }
]

function Column({ k, title, children }: { k: string; title: string; children: ReactNode }) {
  return (
    <div className={`v-${k} flex w-[320px] flex-col gap-2`}>
      <div className="px-1 text-[13px] font-semibold text-ink">{title}</div>
      <div className="flex flex-col rounded-2xl border border-line bg-canvas p-1.5">{children}</div>
    </div>
  )
}

export function V19StatusDotMock() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-6">
        {[{ k: 'final', t: '开工版：原尺寸点 + 跟底色走的描边' }].map((v) => (
          <Column key={v.k} k={v.k} title={v.t}>
            {ROWS.map((r) => (
              <BotListItem
                key={r.b.id}
                bot={r.b}
                status={r.status}
                last={r.last}
                typing={Boolean(r.typing)}
                selected={Boolean(r.selected)}
                onSelect={() => {}}
              />
            ))}
          </Column>
        ))}
      </div>
      <div className="px-1 text-[12px] text-ink-secondary">
        蓝 = 进行中（闪烁）· 橙 = 等你处理 · 绿 = 做完了没看 · 红 = 出错 · 灰 = 离线 · 在线空闲不画点
      </div>
    </div>
  )
}
