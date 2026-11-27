import { HarkBrowserCard } from '../hark/HarkBrowserCard'
import { HarkAskCards, useHarkAsks } from '../hark/HarkAskCard'
import { MuseBrowserCard } from '../muse/MuseBrowserCard'
import { lazy, memo, Suspense, useCallback, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { AttachmentMeta, PlatformId } from '@adapters/types'
import { ArkDrawerToggleSvg } from '@/components/ui/ArkGlyphs'
import { BotAvatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { getPlatformInspector } from '@/components/info/platformInspector'
const OnboardingStage = lazy(() =>
  import('@/components/onboarding/OnboardingGuide').then(({ OnboardingStage }) => ({ default: OnboardingStage }))
)
import { getBotAccounts } from '@/lib/selectors'
import { useBotStore } from '@/store/botStore'
import type { Bot, BotAccount, ChatMessage } from '@/types'
import { ChatHeader } from './ChatHeader'
import { Composer } from './Composer'
import { TranscriptSearchBar } from './TranscriptSearchBar'
import { focusChatMessage, MessageList } from './MessageList'
import { WebSessionPane } from './WebSessionPane'
import { DocumentCanvasPane } from './NativeDocumentDialog'
import { ShareConversationDialog } from './ShareConversationDialog'
import { t } from '@/lib/i18n'
import { ChatApprovals } from './ApprovalCard'

const NO_MESSAGES: ChatMessage[] = []
const NO_ACCOUNTS: BotAccount[] = []
const ChatComposer = memo(Composer)
const ChatWebSession = memo(WebSessionPane)
const MUSE_BROWSER_HINT = /浏览器|云电脑|(?:^|[_\W])(?:browser|computer|open[_ ]url|navigate|screenshot)(?=$|[_\W])/i

const STARTERS = [
  t('What can you help me with?'),
  t('Draft a short status update for the team'),
  t('Brainstorm five names for a side project')
]

const PLATFORM_LOGIN_LABELS: Record<PlatformId, string> = {
  'meta-muse': '使用 Muse 登录',
  grok: '使用 Grok Bot 登录',
  hark: '使用 Hark 登录',
  dot: '使用 ChatGPT Dot 登录',
  hermes: '配置 Hermes 连接',
  antigravity: '使用 Antigravity 登录',
  cue: '使用 Cue 登录',
  'ds-bot': '配置 DS Bot 连接'
}

function ConversationIntro({
  bot,
  canSend,
  needsPlatformLogin,
  onPick,
  onPlatformLogin,
  onOpenInspector
}: {
  bot: Bot
  canSend: boolean
  needsPlatformLogin: boolean
  onPick: (text: string) => void
  onPlatformLogin?: () => void
  onOpenInspector?: () => void
}) {
  return (
    <div className="flex min-h-0 flex-1 animate-veil-in flex-col items-center justify-center gap-5 px-8 pb-6 text-center">
      <div className="flex flex-col items-center gap-3">
        <BotAvatar
          emoji={bot.emoji}
          seed={bot.id}
          avatar={bot.avatar}
          avatarShape={bot.avatarShape}
          avatarColor={bot.avatarColor}
          platformId={bot.platformId}
          followPointer
          size="lg"
        />
        <h2 className="text-[17px] leading-6 font-medium tracking-tight text-ink">{bot.name}</h2>
      </div>
      {needsPlatformLogin && onPlatformLogin ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button variant="primary" size="lg" onClick={onPlatformLogin}>
            {t(PLATFORM_LOGIN_LABELS[bot.platformId])}
          </Button>
          {bot.platformId !== 'meta-muse' && onOpenInspector && (
            <Button variant="secondary" size="lg" onClick={onOpenInspector}>
              <ArkDrawerToggleSvg side="right" className="size-4" />
              {t('Import token in right panel')}
            </Button>
          )}
        </div>
      ) : (
        <div className="flex max-w-xl flex-wrap justify-center gap-2">
          {STARTERS.map((starter) => (
            <Button key={starter} size="sm" disabled={!canSend} onClick={() => onPick(starter)} className="h-8 text-[13px] font-normal">
              {starter}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * One conversation. Without `botId` it shows the selected bot (single view);
 * GOXF v13 panes pass their own bot, and only the focused pane (`focused`)
 * owns the web view, the document canvas and the share dialog.
 */
export function ChatArea({
  botId: paneBotId,
  focused = true,
  compact = false,
  headerExtra,
  merged = false,
  headerLeading
}: { botId?: string | null; focused?: boolean; compact?: boolean; headerExtra?: ReactNode; merged?: boolean; headerLeading?: ReactNode } = {}) {
  const shownId = useBotStore((s) => (paneBotId === undefined ? s.selectedBotId : paneBotId))
  const bot = useBotStore((s) => s.bots.find((b) => b.id === shownId))
  const sessionError = useBotStore((s) => shownId ? s.hermesSessionErrors[shownId] : undefined)
  const chatActionError = useBotStore((s) => shownId ? s.chatActionErrors[shownId] : undefined)
  const accounts = useBotStore(useShallow((s) => bot ? getBotAccounts(bot, s.accounts) : NO_ACCOUNTS))
  const messages = useBotStore((s) => (shownId ? s.messages[shownId] : undefined) ?? NO_MESSAGES)
  const typing = useBotStore((s) => (shownId ? s.typing[shownId] === true : false))
  const sendMessage = useBotStore((s) => s.sendMessage)
  const retryMessage = useBotStore((s) => s.retryMessage)
  const cancelGeneration = useBotStore((s) => s.cancelGeneration)
  const connectAccount = useBotStore((s) => s.connectAccount)
  const openMuseLogin = useBotStore((s) => s.openMuseLogin)
  const openGrokLogin = useBotStore((s) => s.openGrokLogin)
  const openHarkLogin = useBotStore((s) => s.openHarkLogin)
  const openDotLogin = useBotStore((s) => s.openDotLogin)
  const openAntigravityLogin = useBotStore((s) => s.openAntigravityLogin)
  const openCueLogin = useBotStore((s) => s.openCueLogin)
  const webSessionOpen = useBotStore((s) => s.webSessionOpen)
  const harkSideOpen = useBotStore((s) => s.harkSideOpen)
  const hasBots = useBotStore((s) => s.bots.length > 0)
  const infoPanelOpen = useBotStore((s) => s.infoPanelOpen)
  const toggleInfoPanel = useBotStore((s) => s.toggleInfoPanel)
  const activeDocument = useBotStore((s) => s.activeDocument)
  const setActiveDocument = useBotStore((s) => s.setActiveDocument)

  const activeAccount = accounts.find((account) => account.id === bot?.activeAccountId)
  const botId = bot?.id

  const onSend = useCallback(
    (text: string, attachments: AttachmentMeta[] = []) => {
      if (botId) void sendMessage(botId, text, attachments)
    },
    [botId, sendMessage]
  )
  const onRetry = useCallback(
    (messageId: string) => {
      if (botId) void retryMessage(botId, messageId)
    },
    [botId, retryMessage]
  )
  const onCancel = useCallback(() => {
    if (botId) void cancelGeneration(botId).catch((error: unknown) => console.error('[bothub] Could not stop generation', error))
  }, [botId, cancelGeneration])
  const onConnect = useCallback((accountId: string) => void connectAccount(accountId), [connectAccount])
  const onMuseLogin = useCallback((accountId: string) => void openMuseLogin(accountId), [openMuseLogin])
  const onGrokLogin = useCallback((accountId: string) => void openGrokLogin(accountId), [openGrokLogin])
  const onHarkLogin = useCallback((accountId: string) => void openHarkLogin(accountId), [openHarkLogin])
  const onDotLogin = useCallback((accountId: string) => void openDotLogin(accountId), [openDotLogin])
  const onAntigravityLogin = useCallback(
    (accountId: string) => void openAntigravityLogin(accountId),
    [openAntigravityLogin]
  )
  const onCueLogin = useCallback(
    (accountId: string) => void openCueLogin(accountId, false),
    [openCueLogin]
  )

  // Hooks stay above the early returns: a pane switches between empty and a bot.
  const harkAsks = useHarkAsks(activeAccount?.id ?? '', bot?.platformId === 'hark' ? bot.activeSessionId : undefined)

  if (!bot && paneBotId !== undefined && hasBots) {
    return (
      <div className="flex min-h-0 flex-1 animate-veil-in flex-col items-center justify-center gap-1.5 px-6 text-center">
        <p className="text-[13px] font-medium text-ink-secondary">空白格</p>
        <p className="text-[12.5px] text-ink-muted">点左侧会话放进来，或把会话拖到这里</p>
      </div>
    )
  }

  if (!bot) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="drag-region h-[52px] shrink-0" />
        {hasBots ? (
          <div className="flex flex-1 animate-veil-in flex-col items-center justify-center gap-4 pb-[52px]">
            <p className="text-[13px] text-ink-muted">{t('Select a bot')}</p>
          </div>
        ) : (
          <Suspense fallback={null}>
            <OnboardingStage />
          </Suspense>
        )}
      </div>
    )
  }

  // Signed-out accounts on all 4 platforms offer direct partition login; errors and approvals surface as themselves.
  const needsPlatformLogin = !!activeAccount && activeAccount.status === 'offline'

  const triggerActiveAccountLogin = () => {
    if (!activeAccount) return
    switch (bot.platformId) {
      case 'meta-muse':
        return onMuseLogin(activeAccount.id)
      case 'grok':
        return onGrokLogin(activeAccount.id)
      case 'hark':
        return onHarkLogin(activeAccount.id)
      case 'dot':
        return onDotLogin(activeAccount.id)
      case 'hermes':
        useBotStore.getState().setSettingsOpen(true, 'hermes-accounts')
        return
      case 'antigravity':
        return onAntigravityLogin(activeAccount.id)
      case 'cue':
        return onCueLogin(activeAccount.id)
      case 'ds-bot':
        useBotStore.getState().setSettingsOpen(true, 'ds-bot-accounts')
        return
    }
  }

  const canSend =
    activeAccount?.status === 'online' ||
    activeAccount?.status === 'busy' ||
    activeAccount?.status === 'attention'
  const showWebSession =
    focused && webSessionOpen && !!activeAccount && getPlatformInspector(bot.platformId).supportsWebSession
  const latestMuseReply = bot.platformId === 'meta-muse'
    ? messages.findLast((message) => message.role === 'bot' && message.accountId === activeAccount?.id)
    : undefined
  const latestMessage = messages.at(-1)
  const museBrowserHint = Boolean(latestMessage && latestMessage.accountId === activeAccount?.id && (
    latestMessage.richWidgets?.some((widget) => widget.kind === 'session_card' && widget.cardType !== 'vault') ||
    latestMessage.tools?.some((tool) => MUSE_BROWSER_HINT.test(`${tool.name} ${tool.toolType ?? ''}`)) ||
    MUSE_BROWSER_HINT.test(latestMessage.text)
  ))

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatHeader key={JSON.stringify([bot.id, bot.activeAccountId])} bot={bot} showTranscriptSearch={!showWebSession}
          compact={compact} extra={headerExtra} merged={merged} leading={headerLeading} />
        {sessionError && (
          <p role="alert" className="mx-6 my-2 text-[13px] text-status-error">
            {t('Could not start a new conversation. {reason}', { reason: sessionError })}
          </p>
        )}
        {chatActionError && <p role="alert" className="mx-6 my-2 text-[13px] text-status-error">{chatActionError}</p>}
        {showWebSession && activeAccount ? (
          <ChatWebSession key={`${bot.id}:${activeAccount.id}`} bot={bot} account={activeAccount} />
        ) : (
          <>
            <TranscriptSearchBar key={JSON.stringify([bot.id, bot.activeAccountId, bot.activeSessionId, bot.hermesSessionKey, bot.selectedAgentId])}
              conversationId={bot.id} messages={messages} focusMessage={focusChatMessage} />
            {bot.platformId === 'meta-muse' && activeAccount && canSend && (
              <MuseBrowserCard accountId={activeAccount.id} sessionId={bot.activeSessionId}
                replyId={latestMuseReply?.id} typing={typing} activeHint={museBrowserHint} />
            )}
            {messages.length === 0 && !typing ? (
              <ConversationIntro
                bot={bot}
                canSend={canSend}
                needsPlatformLogin={needsPlatformLogin}
                onPick={(text) => onSend(text)}
                onPlatformLogin={activeAccount ? triggerActiveAccountLogin : undefined}
                onOpenInspector={() => {
                  if (!infoPanelOpen) toggleInfoPanel()
                }}
              />
            ) : (
              <MessageList bot={bot} messages={messages} accounts={accounts} typing={typing} onRetry={onRetry} />
            )}
            {/* GOXF: browser card, approvals and asks share one dock under the messages. It is capped and
                scrolls on its own, so however many piled up the composer always stays on screen. */}
            <div className="max-h-[45%] shrink-0 overflow-y-auto overscroll-contain">
              {/* GOXF v10: Hark's browser sits at the end of the conversation, like hark.com. */}
              {bot.platformId === 'hark' && activeAccount && canSend && (
                <HarkBrowserCard key={JSON.stringify([activeAccount.id, bot.activeSessionId])}
                  accountId={activeAccount.id} sessionId={bot.activeSessionId} attention={harkAsks.length > 0} />
              )}
              {(bot.platformId === 'meta-muse' || bot.platformId === 'grok') && activeAccount && (
                <ChatApprovals
                  accountId={activeAccount.id}
                  platformId={bot.platformId}
                  agentId={bot.selectedAgentId}
                />
              )}
              {bot.platformId === 'hark' && activeAccount && (
                <div className="mx-auto w-full max-w-[860px] shrink-0 px-8">
                  {/* Same column as the Hark bubbles and the browser card (past the avatar, at most 600). */}
                  <HarkAskCards accountId={activeAccount.id} sessionId={bot.activeSessionId} asks={harkAsks} className="ml-[38px] max-w-[600px]" />
                </div>
              )}
            </div>
            <ChatComposer
              key={bot.id}
              bot={bot}
              account={activeAccount}
              typing={typing}
              onSend={onSend}
              onCancel={onCancel}
              onConnect={onConnect}
              onMuseLogin={onMuseLogin}
              onGrokLogin={onGrokLogin}
              onHarkLogin={onHarkLogin}
              onDotLogin={onDotLogin}
              onAntigravityLogin={onAntigravityLogin}
              onCueLogin={onCueLogin}
              hideNotice={needsPlatformLogin && messages.length === 0 && !typing}
            />
          </>
        )}
      </div>
      {focused && harkSideOpen && bot.platformId === 'hark' && !showWebSession && (
        <div id="hark-side-slot" className="flex min-h-0 w-[48%] min-w-[420px] shrink-0 flex-col border-l border-line/60 bg-[#0b0f14]" />
      )}
      {focused && activeDocument && !showWebSession && (
        <DocumentCanvasPane
          target={activeDocument}
          onClose={() => setActiveDocument(null)}
          onOpenNestedDoc={(next) => setActiveDocument(next)}
        />
      )}
      {focused && <ShareConversationDialog bot={bot} messages={messages} />}
    </div>
  )
}
