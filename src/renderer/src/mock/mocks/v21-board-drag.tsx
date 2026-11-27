import type { ReactNode } from 'react'
import { Check, RotateCcw } from 'lucide-react'
import { COLUMN_STYLE, TaskCardView, type TaskCard } from '@/components/workspace/BoardView'
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/Menu'
import { BOARD_COLUMNS, type BoardColumn } from '@/lib/boardStatus'
import { cn } from '@/lib/cn'

/**
 * v21：看板卡片由你决定状态。拖到任意一列，或「⋯ / 右键 → 标为…」；
 * 手动设过的卡片右上角有「手动」，菜单里可「恢复自动」。只存在 BotArk 本地。
 */
const NOW = new Date('2026-11-27T19:00:00+08:00').getTime()
const ago = (min: number) => NOW - min * 60_000

function card(id: string, title: string, column: BoardColumn, mins: number, subtasks: TaskCard['subtasks'] = []): TaskCard {
  return { id, title, state: column === 'done' ? 'done' : column === 'run' ? 'working' : 'open', createdAt: ago(mins), subtasks, conversationId: 'c', column, projectKey: 'p', botId: 'b' }
}

const WAIT = [
  card('w1', '记得服务器里面两条带密钥的mcp链接也修改一下。同步更新一下', 'wait', 2880, [
    { id: 's1', kind: 'other', title: 'request_secret', status: 'waiting' }
  ]),
  card('w2', '不行，我要的是我在访问shop.haisiku.com.cn的时候他生产机有什么问题', 'wait', 24 * 60 * 17, [
    { id: 's2', kind: 'subagent', title: 'run_subagent', status: 'done' }
  ])
]
const RUN = [card('r1', '你截图这个「我的贡献/我的仓库」是 GitHub 新出的仓库页，第一版没挂上去', 'run', 6, [{ id: 's3', kind: 'subagent', title: 'run_subagent', status: 'running' }])]
const DONE = [
  card('d1', '也帮我写好，全程做一下', 'done', 1),
  card('d2', '从 shop.haisiku.com.cn 获取开发桥 token', 'done', 3 * 24 * 60, [{ id: 's4', kind: 'browser', title: 'browser', status: 'done' }])
]

function Column({ col, drop, children, count }: { col: BoardColumn; drop?: boolean; children: ReactNode; count: number }) {
  const label = BOARD_COLUMNS.find((c) => c.id === col)!.label
  return (
    <section className={cn('flex w-[270px] flex-col rounded-2xl bg-canvas/60', drop && 'bg-accent-50 ring-2 ring-accent-600/40')}>
      <header className="flex h-10 shrink-0 items-center gap-2 px-3">
        <span className={cn('size-2 rounded-full', COLUMN_STYLE[col].dot)} />
        <h3 className={cn('text-[13px] font-semibold', COLUMN_STYLE[col].head)}>{label}</h3>
        <span className="text-[12px] text-ink-muted">{count}</span>
      </header>
      <ol className="flex flex-col gap-2 px-2 pb-2">{children}</ol>
    </section>
  )
}

function Manual({ children }: { children: ReactNode }) {
  return (
    <div className="relative">
      {children}
      <span className="absolute right-3 bottom-3 rounded-full bg-accent-50 px-2 text-[11px] text-accent-700" title="你设的状态；菜单里可恢复自动">
        手动
      </span>
    </div>
  )
}

export function V21BoardDragMock() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-3" style={{ height: 600 }}>
        <Column col="wait" count={1}>
          <li>
            <TaskCardView task={WAIT[0]!} title="客服 · 慈云套餐对比与续费" selected={false} onClick={() => {}} />
          </li>
          {/* the card being dragged leaves a placeholder */}
          <li className="h-[118px] rounded-xl border border-dashed border-line-strong" />
        </Column>
        <Column col="run" count={1}>
          <li>
            <TaskCardView task={RUN[0]!} title="GitHub分组 · 主会话" selected={false} onClick={() => {}} />
          </li>
        </Column>
        <Column col="fail" count={0}>
          <li className="px-2 py-6 text-center text-[12px] text-ink-faint">没有</li>
        </Column>
        <Column col="done" count={3} drop>
          {/* drag ghost hovering the drop target */}
          <li className="relative">
            <div className="rotate-1 opacity-90 shadow-float">
              <TaskCardView task={{ ...WAIT[1]!, column: 'done' }} title="Hark 7 · 主会话" selected={false} onClick={() => {}} />
            </div>
          </li>
          <li>
            <Manual>
              <TaskCardView task={DONE[0]!} title="GitHub分组 · 主会话" selected={false} onClick={() => {}} />
            </Manual>
          </li>
          <li>
            <TaskCardView task={DONE[1]!} title="fulsome_smile.3b · 主会话" selected={false} onClick={() => {}} />
          </li>
        </Column>
        <div className="relative w-[300px]">
          <Menu open modal={false}>
            <MenuTrigger asChild>
              <span className="absolute top-[280px] left-2 size-1" />
            </MenuTrigger>
            <MenuContent side="right" align="start" className="w-52">
              <MenuLabel>标为…</MenuLabel>
              <MenuItem>
                <span className="size-2 rounded-full bg-status-attention" /> 等你处理
              </MenuItem>
              <MenuItem>
                <span className="size-2 rounded-full bg-status-busy" /> 进行中
              </MenuItem>
              <MenuItem>
                <span className="size-2 rounded-full bg-status-error" /> 失败
              </MenuItem>
              <MenuItem>
                <span className="size-2 rounded-full bg-status-online" /> 刚完成 <Check className="ml-auto" />
              </MenuItem>
              <MenuSeparator />
              <MenuItem>
                <RotateCcw /> 恢复自动
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </div>
      <p className="px-1 text-[12px] text-ink-secondary">
        拖动：「不行，我要的是…」从等你处理拖到刚完成，目标列高亮、原位置留虚线。右侧是卡片右键（或 ⋯）菜单：标为四种状态之一，当前状态打勾；手动设过的卡片右下角显示「手动」，「恢复自动」回到 Hark 给的状态。
      </p>
    </div>
  )
}
