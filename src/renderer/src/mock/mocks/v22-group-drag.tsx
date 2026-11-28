import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, ChevronRight, GripVertical, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { BotListItem } from '@/components/sidebar/BotListItem'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/Menu'
import { cn } from '@/lib/cn'
import { useBotStore } from '@/store/botStore'
import type { Bot, BotAccount } from '@/types'

/**
 * v22：侧栏分组可以拖动排序。悬停分组标题左侧出现抓手；拖动时整组收成一行标题，
 * 插入线标出落点；⋯ 菜单加「上移 / 下移」给键盘和精确操作；管理分组弹窗的行也能拖。
 */
function bot(id: string, name: string, color: string, groupId: string, unread = 0): Bot {
  return {
    id, name, emoji: '', avatarShape: 'blob', avatarColor: color, description: '', platformId: 'muse',
    groupId, accountIds: [`acc-${id}`], activeAccountId: `acc-${id}`, activeSessionId: 'c1', memory: [], notes: '',
    createdAt: 0, unread
  } as unknown as Bot
}
const acc = (id: string) => ({ id: `acc-${id}`, platformId: 'muse', status: 'online' }) as unknown as BotAccount

const GROUPS = [
  { id: 'g1', name: '工作区', bots: [bot('h', 'GitHub分组', 'blue', 'g1'), bot('kf', '客服', 'violet', 'g1', 2)] },
  { id: 'g2', name: '客户', bots: [bot('dp', '店铺线', 'pink', 'g2'), bot('hs', '海思库运维', 'green', 'g2')] },
  { id: 'g3', name: '实验', bots: [bot('ds', 'DS Bot', 'orange', 'g3'), bot('gm', 'Gemini 草稿', 'teal', 'g3')] },
  { id: 'g4', name: '归档', bots: [bot('old', '旧项目', 'gray', 'g4')] }
]

useBotStore.setState({
  bots: GROUPS.flatMap((g) => g.bots),
  groups: GROUPS.map(({ id, name }) => ({ id, name })),
  accounts: Object.fromEntries(GROUPS.flatMap((g) => g.bots).map((b) => [`acc-${b.id}`, acc(b.id)])),
  messages: {},
  typing: {},
  activity: {},
  selectedBotId: 'h'
} as never)

type Group = (typeof GROUPS)[number]

/** Copy of BotList SectionHeader markup, with the new grip slot at the left. */
function Header({ group, hover, grip, menu, ghost }: { group: Group; hover?: boolean; grip?: boolean; menu?: ReactNode; ghost?: boolean }) {
  const show = hover || ghost
  return (
    <div className={cn('group/section relative flex h-7 items-center gap-0.5', grip && 'pl-4')}>
      {grip && (
        <span
          aria-hidden
          className={cn(
            'absolute top-1/2 left-0 grid h-6 w-4 -translate-y-1/2 place-items-center rounded-md text-ink-muted',
            show ? 'opacity-100' : 'opacity-0',
            hover && 'cursor-grab bg-hover'
          )}
        >
          <GripVertical className="size-3" />
        </span>
      )}
      <div
        className={cn(
          'flex h-7 min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 text-left text-ink-muted',
          (hover || ghost) && 'bg-hover text-ink-secondary'
        )}
      >
        <span className="truncate text-[12px] font-medium tracking-tight">{group.name}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 pr-0.5">
          {ghost && <span className="text-[11px] tabular-nums opacity-70">{group.bots.length}</span>}
          <ChevronRight aria-hidden className={cn('size-3.5 shrink-0', ghost ? 'opacity-70' : 'rotate-90', show ? 'opacity-80' : 'opacity-0')} />
        </span>
      </div>
      {menu ?? (
        <span
          className={cn(
            'grid size-6 shrink-0 place-items-center rounded-full text-ink-muted',
            hover ? 'opacity-100' : 'opacity-0'
          )}
        >
          <MoreHorizontal className="size-3.5" />
        </span>
      )}
    </div>
  )
}

function Rows({ group }: { group: Group }) {
  return (
    <ul className="mt-0.5 flex flex-col gap-0.5">
      {group.bots.map((b) => (
        <li key={b.id}>
          <BotListItem bot={b} layout="expanded" status="online" last={undefined} typing={false} selected={b.id === 'h'} onSelect={() => {}} />
        </li>
      ))}
    </ul>
  )
}

function Sidebar({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <div className="flex w-[280px] shrink-0 flex-col gap-2">
      <p className="px-1 text-[13px] font-semibold text-ink">{title}</p>
      <div className="flex flex-col gap-2.5 rounded-2xl border border-line bg-canvas p-2">{children}</div>
      <p className="px-1 text-[12px] text-ink-muted">{note}</p>
    </div>
  )
}

/** 1 — hover: grip appears on 客户. */
function HoverState() {
  return (
    <Sidebar title="① 悬停分组标题" note="分组标题左侧出现抓手，鼠标变成可抓取；不悬停时不占视觉。">
      {GROUPS.map((g) => (
        <section key={g.id}>
          <Header group={g} grip hover={g.id === 'g2'} />
          <Rows group={g} />
        </section>
      ))}
    </Sidebar>
  )
}

/** 2 — dragging 实验 up between 工作区 and 客户. */
function DragState() {
  const [work, client, lab, archive] = GROUPS as [Group, Group, Group, Group]
  return (
    <Sidebar title="② 拖动「实验」向上" note="拖起的分组收成一行标题跟随鼠标；蓝色插入线标出松手位置，其他分组不动。">
      <section>
        <Header group={work} grip />
        <Rows group={work} />
      </section>
      {/* insertion line + ghost hovering over it */}
      <div className="relative -my-1.5 h-0">
        <div className="absolute inset-x-1 top-0 h-0.5 rounded-full bg-accent-600" />
        <div className="absolute inset-x-3 -top-10 z-10 rounded-lg bg-surface opacity-90 shadow-float ring-1 ring-line">
          <Header group={lab} grip ghost />
        </div>
      </div>
      <section>
        <Header group={client} grip />
        <Rows group={client} />
      </section>
      {/* origin: the dragged section left behind as a faded header */}
      <section className="opacity-40">
        <Header group={{ ...lab, bots: lab.bots }} grip ghost />
      </section>
      <section>
        <Header group={archive} grip />
        <Rows group={archive} />
      </section>
    </Sidebar>
  )
}

/** 3 — ⋯ menu with 上移 / 下移. */
function MenuState() {
  const [work, client, lab, archive] = GROUPS as [Group, Group, Group, Group]
  const menu = (
    <Menu open modal={false}>
      <MenuTrigger className="grid size-6 shrink-0 place-items-center rounded-full bg-hover text-ink">
        <MoreHorizontal className="size-3.5" />
      </MenuTrigger>
      <MenuContent align="start" side="bottom" className="min-w-44">
        <MenuItem disabled>
          <ArrowUp aria-hidden /> 上移
        </MenuItem>
        <MenuItem>
          <ArrowDown aria-hidden /> 下移
        </MenuItem>
        <MenuSeparator />
        <MenuItem>
          <Pencil aria-hidden /> 重命名
        </MenuItem>
        <MenuSeparator />
        <MenuItem danger>
          <Trash2 aria-hidden /> 删除分组
        </MenuItem>
      </MenuContent>
    </Menu>
  )
  return (
    <Sidebar title="③ ⋯ 菜单：上移 / 下移" note="给键盘和精确操作：第一个分组「上移」置灰，最后一个分组「下移」置灰。">
      <section>
        <Header group={work} grip hover menu={menu} />
        <Rows group={work} />
      </section>
      {[client, lab, archive].map((g) => (
        <section key={g.id}>
          <Header group={g} grip />
          <Rows group={g} />
        </section>
      ))}
    </Sidebar>
  )
}

/** 4 — 管理分组 dialog rows (copied from ConfigureSectionsDialog) with a grip. */
function DialogState() {
  const order = [GROUPS[0]!, GROUPS[2]!, GROUPS[1]!, GROUPS[3]!]
  return (
    <div className="ml-44 flex w-[340px] shrink-0 flex-col gap-2">
      <p className="px-1 text-[13px] font-semibold text-ink">④ 管理分组弹窗</p>
      <div className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 shadow-float">
        <div>
          <p className="text-[15px] font-semibold text-ink">管理分组</p>
          <p className="text-[13px] text-ink-secondary">按住左侧抓手拖动调整顺序。</p>
        </div>
        <ul className="flex flex-col gap-2">
          {order.map((g, i) => (
            <li
              key={g.id}
              className={cn(
                'relative flex items-center gap-2 rounded-xl border border-line bg-surface px-2.5 py-2',
                i === 1 && 'shadow-float ring-2 ring-accent-600/40'
              )}
            >
              <GripVertical aria-hidden className={cn('size-4 shrink-0 cursor-grab', i === 1 ? 'text-ink-secondary' : 'text-ink-muted')} />
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{g.name}</span>
              <span className="shrink-0 text-[12px] tabular-nums text-ink-muted">{g.bots.length}</span>
              <span className="grid size-7 shrink-0 place-items-center rounded-full text-ink-muted">
                <Trash2 className="size-4" />
              </span>
            </li>
          ))}
        </ul>
      </div>
      <p className="px-1 text-[12px] text-ink-muted">弹窗里的行也能拖；正在拖的行浮起并描边，其余行让位。</p>
    </div>
  )
}

export function V22GroupDragMock() {
  return (
    <div className="flex items-start gap-5">
      <HoverState />
      <DragState />
      <MenuState />
      <DialogState />
    </div>
  )
}
