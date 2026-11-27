import { BoardView } from '@/components/workspace/BoardView'
import { useBoardOverrides } from '@/store/boardOverrideStore'
import { useBotStore } from '@/store/botStore'
import { usePanes } from '@/store/paneStore'
import { usePipeline } from '@/pipeline/pipelineStore'
import type { Bot, BotAccount, ChatMessage } from '@/types'

/** v21 final UI: the real 看板 (BoardView) on a fake Hark bridge, with one card set by hand. */
const NOW = Date.now()
const min = (m: number) => NOW - m * 60_000

function bot(id: string, name: string, platformId: string, color: string, unread = 0): Bot {
  return {
    id, name, emoji: '', avatarShape: 'blob', avatarColor: color, description: '', platformId,
    groupId: 'default', accountIds: [`acc-${id}`], activeAccountId: `acc-${id}`, activeSessionId: 'c1', memory: [], notes: '',
    createdAt: 0, unread
  } as unknown as Bot
}
const acc = (id: string, status: BotAccount['status'], statusDetail?: string) =>
  ({ id: `acc-${id}`, platformId: 'muse', status, statusDetail }) as unknown as BotAccount
const msg = (text: string, m: number): ChatMessage => ({ id: `m${m}`, role: 'bot', text, createdAt: min(m) }) as unknown as ChatMessage

const SNAP = {
  requests: {
    u1: { state: 'open', title: '记得服务器里面两条带密钥的mcp链接也修改一下。同步更新一下', awaitsPerson: true },
    u2: { state: 'open', title: '不行，我要的是我在访问shop.haisiku.com.cn的时候他生产机有什么问题', awaitsPerson: true },
    u3: { state: 'working', title: '你截图这个「我的贡献/我的仓库」是 GitHub 新出的仓库页' },
    u4: { state: 'completed', title: '也帮我写好，全程做一下', doneTitle: '也帮我写好，全程做一下' }
  },
  messages: [
    { id: 'u1', role: 'user', createdAt: min(50) },
    { id: 'a1', role: 'assistant', triggeredBy: 'u1', toolCalls: [{ dispatchId: 'd1', name: 'request_secret', status: 'waiting', detail: 'request_secret' }] },
    { id: 'u2', role: 'user', createdAt: min(40) },
    { id: 'a2', role: 'assistant', triggeredBy: 'u2', toolCalls: [{ dispatchId: 'd2', name: 'run_subagent', status: 'completed', detail: 'run_subagent' }] },
    { id: 'u3', role: 'user', createdAt: min(6) },
    { id: 'a3', role: 'assistant', triggeredBy: 'u3', toolCalls: [{ dispatchId: 'd3', name: 'run_subagent', status: 'running', detail: 'run_subagent' }] },
    { id: 'u4', role: 'user', createdAt: min(1) }
  ],
  activeWork: [{ dispatchId: 'd3', messageId: 'a3', state: 'working' }]
}

;(window as unknown as { electron: unknown }).electron = {
  platform: 'web',
  hark: {
    rpc: async ({ op }: { op: string }) =>
      op === 'listConversations' ? { ok: true, data: [{ id: 'c1', title: '主会话' }] } : op === 'conversationSnapshot' ? { ok: true, data: SNAP } : { ok: false }
  }
}

useBotStore.setState({
  bots: [bot('h', 'GitHub分组', 'hark', 'blue'), bot('kf', '客服', 'muse', 'violet', 2), bot('dp', '店铺线', 'muse', 'pink')],
  accounts: { 'acc-kf': acc('kf', 'online'), 'acc-dp': acc('dp', 'error', '连接失败：令牌过期'), 'acc-h': acc('h', 'online') },
  messages: { kf: [msg('退货原因已汇总，发你了。', 3)], dp: [msg('连接失败', 12)] },
  typing: {},
  activity: {},
  selectedBotId: 'h'
} as never)
usePanes.setState({ scope: 'all' } as never)
usePipeline.setState({ mode: 'status' })
// u2 (等你处理 by Hark) was dragged to 刚完成; 店铺线 (失败) was marked 进行中.
useBoardOverrides.setState({ overrides: { 'h|acc-h|c1:u2': 'done', 'b:dp': 'run' } })

export function V21BoardDragRealMock() {
  return (
    <div className="flex flex-col bg-main" style={{ height: 640, width: 1180 }}>
      <BoardView />
    </div>
  )
}
