import { usePromptSlashMenu } from './PromptSlashMenu'
import { WorkspaceTools } from '@/rooms/WorkspaceTools'
import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import type { AttachmentMeta } from '@adapters/types'
import { ArrowUp, CornerDownRight, Loader2, LogIn, Plus, PlugZap, Square, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { cn } from '@/lib/cn'
import { useBotStore } from '@/store/botStore'
import type { Bot, BotAccount } from '@/types'
import { t } from '@/lib/i18n'
import type { DraftAttachment } from './attachmentDraft'
import { composerDraft } from './goxfComposerDrafts'
import { clearIgnoreNote, useRecall, withIgnoreNote } from './goxfRecall'
import { ImageLightbox } from './ImageLightbox'
import { AttachmentChips } from './AttachmentChips'

interface ComposerProps {
  bot: Bot
  account: BotAccount | undefined
  typing?: boolean
  onSend: (text: string, attachments: AttachmentMeta[]) => void
  onCancel?: () => void
  onConnect: (accountId: string) => void
  onMuseLogin?: (accountId: string) => void
  onGrokLogin?: (accountId: string) => void
  onHarkLogin?: (accountId: string) => void
  onDotLogin?: (accountId: string) => void
  onAntigravityLogin?: (accountId: string) => void
  onCueLogin?: (accountId: string) => void
  /** The empty conversation already shows its own sign-in action. */
  hideNotice?: boolean
}

const MAX_HEIGHT_PX = 200

function ConnectionNotice({
  account,
  onConnect,
  onMuseLogin,
  onGrokLogin,
  onHarkLogin,
  onDotLogin,
  onAntigravityLogin,
  onCueLogin
}: {
  account: BotAccount
  onConnect: () => void
  onMuseLogin?: () => void
  onGrokLogin?: () => void
  onHarkLogin?: () => void
  onDotLogin?: () => void
  onAntigravityLogin?: () => void
  onCueLogin?: () => void
}) {
  const isError = account.status === 'error'
  const isMuse = account.platformId === 'meta-muse'
  const isGrok = account.platformId === 'grok'
  const isHark = account.platformId === 'hark'
  const isDot = account.platformId === 'dot'
  const isHermes = account.platformId === 'hermes'
  const isAntigravity = account.platformId === 'antigravity'
  const isCue = account.platformId === 'cue'
  const isDsBot = account.platformId === 'ds-bot'
  return (
    <div
      className={cn(
        'mb-2 flex animate-step-in flex-wrap items-center gap-2 rounded-xl border py-1.5 pr-1.5 pl-3',
        isError ? 'border-status-error/20 bg-status-error/5 text-status-error' : 'border-line bg-surface text-ink'
      )}
      role="status"
    >
      {isMuse || isHark || isDot || isAntigravity || isCue ? (
        <LogIn className="size-4 shrink-0 text-accent-600" aria-hidden />
      ) : (
        <PlugZap className="size-4 shrink-0 text-ink-muted" aria-hidden />
      )}
      <span className="min-w-0 flex-1 text-[13px]">
        {isError
          ? (account.statusDetail ?? '连接出错')
          : isMuse
            ? '登录 Muse 后即可发消息'
            : isGrok
              ? '登录 Grok Bot 后即可发消息'
              : isHark
                ? '登录 Hark 后即可发消息'
                : isDot
                  ? '登录 ChatGPT Dot 或在右侧导入 AT / RT 后即可发消息'
                  : account.platformId === 'gemini' ? t('Connect a Gemini API key to send messages')
                  : isHermes
                    ? '连接 Hermes API Server（hermes gateway）后即可发消息'
                    : isAntigravity
                      ? '登录 Google Antigravity（antigravity.google.com）后即可发消息'
                      : isCue
                        ? '登录 Cue（cue.im）后即可发消息'
                        : isDsBot
                          ? '连接 DS Bot（MCP Token / 加密配对链接 / DSH Web）后即可发消息'
                          : '账号未连接'}
      </span>
      {account.platformId === 'gemini' ? (
        <Button size="sm" onClick={() => useBotStore.getState().setSettingsOpen(true, 'gemini-accounts')}>
          {t('Configure Gemini connection')}
        </Button>
      ) : isMuse && onMuseLogin && !isError ? (
        <>
          <Button size="sm" variant="primary" onClick={onMuseLogin} disabled={account.pending}>
            {account.pending && <Loader2 className="animate-spin" aria-hidden />}
            {account.pending ? '登录中…' : '使用 Muse 登录'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onConnect} disabled={account.pending}>
            已完成登录
          </Button>
        </>
      ) : isHark && onHarkLogin && !isError ? (
        <>
          <Button size="sm" variant="primary" onClick={onHarkLogin} disabled={account.pending}>
            {account.pending && <Loader2 className="animate-spin" aria-hidden />}
            {account.pending ? (account.statusDetail ?? '处理中…') : '使用 Hark 登录'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onConnect} disabled={account.pending}>
            刷新会话
          </Button>
        </>
      ) : isDot && onDotLogin && !isError ? (
        <>
          <Button size="sm" variant="primary" onClick={onDotLogin} disabled={account.pending}>
            {account.pending && <Loader2 className="animate-spin" aria-hidden />}
            {account.pending ? '登录中…' : '使用 Dot 登录'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onConnect} disabled={account.pending}>
            刷新连接
          </Button>
        </>
      ) : isAntigravity && onAntigravityLogin && !isError ? (
        <>
          <Button size="sm" variant="primary" onClick={onAntigravityLogin} disabled={account.pending}>
            {account.pending && <Loader2 className="animate-spin" aria-hidden />}
            {account.pending ? '登录中…' : '使用 Antigravity 登录'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onConnect} disabled={account.pending}>
            刷新会话
          </Button>
        </>
      ) : isCue && onCueLogin && !isError ? (
        <>
          <Button size="sm" variant="primary" onClick={onCueLogin} disabled={account.pending}>
            {account.pending && <Loader2 className="animate-spin" aria-hidden />}
            {account.pending ? (account.statusDetail ?? '登录中…') : '使用 Cue 登录'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onConnect} disabled={account.pending}>
            刷新会话
          </Button>
        </>
      ) : isGrok && onGrokLogin ? (
        <>
          <Button size="sm" variant="primary" onClick={onGrokLogin} disabled={account.pending}>
            {account.pending && <Loader2 className="animate-spin" aria-hidden />}
            {account.pending ? '登录中…' : '使用 Grok Bot 登录'}
          </Button>
          <Button size="sm" variant="ghost" onClick={onConnect} disabled={account.pending}>
            刷新连接
          </Button>
        </>
      ) : (
        <Button size="sm" variant="secondary" onClick={onConnect} disabled={account.pending}>
          {account.pending && <Loader2 className="animate-spin" aria-hidden />}
          {account.pending ? '连接中' : isError ? '重试' : '连接'}
        </Button>
      )}
    </div>
  )
}

export function Composer({ bot, account, typing = false, onSend, onCancel, onConnect, onMuseLogin, onGrokLogin, onHarkLogin, onDotLogin, onAntigravityLogin, onCueLogin, hideNotice = false }: ComposerProps) {
  // GOXF: unsent text/attachments survive switching bots or pages.
  const [saved] = useState(() => composerDraft(bot.id))
  const [text, setTextState] = useState(saved.text)
  const setText = (next: string | ((prev: string) => string)) =>
    setTextState((prev) => (saved.text = typeof next === 'function' ? next(prev) : next))
  const [attachments, setAttachments] = useState<DraftAttachment[]>(saved.entries)
  const draft = saved.attachments
  useEffect(() => saved.bind(setAttachments), [saved])
  const [dragging, setDragging] = useState(false)
  // GOXF: click a pending image chip to view it full size before sending.
  const [preview, setPreview] = useState<{ src: string; name: string } | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const replyTarget = useBotStore((s) => s.replyingTo[bot.id])
  const setReplyTarget = useBotStore((s) => s.setReplyTarget)

  const connected = account?.status === 'online' || account?.status === 'busy' || account?.status === 'attention'
  const [multiline, setMultiline] = useState(false)
  const ignoreNext = useRecall((s) => Boolean(s.pending[bot.id]))
  const expanded = multiline || attachments.length > 0 || Boolean(replyTarget) || ignoreNext
  const hasContent = text.trim().length > 0 || attachments.length > 0
  const canSend = connected && hasContent && attachments.every((entry) => entry.status === 'ready')

  // GOXF 撤回: the recalled text comes back here.
  useEffect(() => {
    const refill = (e: Event) => {
      const { botId, text: next } = (e as CustomEvent<{ botId: string; text: string }>).detail
      if (botId !== bot.id) return
      setText(next)
      requestAnimationFrame(() => {
        resize()
        textareaRef.current?.focus()
      })
    }
    window.addEventListener('goxf:composer-refill', refill)
    return () => window.removeEventListener('goxf:composer-refill', refill)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id])

  // The palette asks for focus after jumping to a bot.
  useEffect(() => {
    const focus = () => textareaRef.current?.focus()
    window.addEventListener('bothub:focus-composer', focus)
    return () => window.removeEventListener('bothub:focus-composer', focus)
  }, [])

  const resize = () => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`
    setMultiline(el.scrollHeight > 40)
  }

  // Size the box for a restored draft.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (saved.text) requestAnimationFrame(resize) }, [])
  const prompts = usePromptSlashMenu(textareaRef, text, setText, resize, bot.name)

  const submit = () => {
    const sendable = draft.forSend()
    if (!connected || !sendable || (!text.trim() && sendable.length === 0)) return
    onSend(withIgnoreNote(bot.id, text), sendable)
    setText('')
    draft.clear()
    requestAnimationFrame(resize)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (prompts.handleKey(event)) return
    if (event.key === 'Escape' && replyTarget) {
      event.preventDefault()
      setReplyTarget(bot.id, null)
      return
    }
    // Respect IME composition (e.g. Chinese/Japanese input) before sending.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  const addFiles = (files: FileList | File[] | null) => {
    if (files) void draft.add(files)
  }

  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
    addFiles(event.dataTransfer.files)
  }

  return (
    <div className="shrink-0 px-6 pt-2 pb-5">
      <div className="mx-auto max-w-[860px] px-2">
        {preview && (
          <ImageLightbox
            src={preview.src}
            alt={preview.name}
            filename={preview.name}
            onSave={() => {
              const a = document.createElement('a')
              a.href = preview.src
              a.download = preview.name
              a.click()
            }}
            onClose={() => setPreview(null)}
          />
        )}
        {account && !connected && !hideNotice && (
          <ConnectionNotice
            account={account}
            onConnect={() => onConnect(account.id)}
            onMuseLogin={onMuseLogin ? () => onMuseLogin(account.id) : undefined}
            onGrokLogin={onGrokLogin ? () => onGrokLogin(account.id) : undefined}
            onHarkLogin={onHarkLogin ? () => onHarkLogin(account.id) : undefined}
            onDotLogin={onDotLogin ? () => onDotLogin(account.id) : undefined}
            onAntigravityLogin={onAntigravityLogin ? () => onAntigravityLogin(account.id) : undefined}
            onCueLogin={onCueLogin ? () => onCueLogin(account.id) : undefined}
          />
        )}

        <div
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files')) {
              event.preventDefault()
              setDragging(true)
            }
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cn(
            'relative border border-line-strong bg-surface p-[7px] shadow-card transition-[border-color,box-shadow,border-radius] duration-200',
            expanded ? 'rounded-[18px]' : 'rounded-[22px]',
            'focus-within:border-ink/20',
            dragging && 'border-accent-600 ring-4 ring-accent-100'
          )}
        >
          {ignoreNext && (
            <div className="mb-1.5 flex w-fit max-w-full items-center gap-1.5 rounded-full bg-hover py-0.5 pr-1 pl-2.5 text-[12px] text-ink-muted">
              <span className="truncate">发送时会先告诉 bot：忽略我上一条消息</span>
              <button
                type="button"
                aria-label="不附上"
                onClick={() => clearIgnoreNote(bot.id)}
                className="press-icon grid size-5 shrink-0 place-items-center rounded-full hover:bg-active hover:text-ink"
              >
                <X className="size-3" />
              </button>
            </div>
          )}
          {prompts.menu}
          {replyTarget && (
            <div className="mb-1.5 flex items-center justify-between gap-2 rounded-xl border border-line bg-sunken/50 px-2.5 py-1.5 text-[12px]">
              <div className="flex min-w-0 items-center gap-1.5">
                <CornerDownRight className="size-3.5 shrink-0 text-accent-600" aria-hidden />
                {replyTarget.thumb && <img src={replyTarget.thumb} alt="" className="size-7 shrink-0 rounded-md object-cover" />}
                <span className="shrink-0 font-medium text-ink-secondary">
                  {replyTarget.role === 'user' ? '引用自己' : `引用 ${bot.name}`}：
                </span>
                <span className="truncate text-ink">{replyTarget.quote}</span>
              </div>
              <button
                type="button"
                aria-label="取消引用"
                onClick={() => setReplyTarget(bot.id, null)}
                className="press-icon grid size-5 shrink-0 place-items-center rounded-full text-ink-muted hover:bg-active hover:text-ink"
              >
                <X className="size-3" />
              </button>
            </div>
          )}
          <AttachmentChips attachments={attachments} onRemove={(id) => draft.remove(id)} onPreview={setPreview} />

          <div className="flex items-end gap-1">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                addFiles(event.target.files)
                event.target.value = ''
              }}
            />
            <IconButton label={t('Attach files')} onClick={() => fileInputRef.current?.click()}>
              <Plus />
            </IconButton>
            {prompts.button}
            <WorkspaceTools
              key={bot.id + ':' + bot.activeAccountId}
              scope={bot.id + ':' + bot.activeAccountId}
              recipient={bot.name}
              variant="popover"
              hermesAccount={bot.platformId === 'hermes' ? bot.activeAccountId : undefined}
              append={({ label, text: result }) => {
                setText((prev) => [prev, `[${label}]\n${result}`].filter(Boolean).join('\n\n'))
                requestAnimationFrame(() => {
                  resize()
                  textareaRef.current?.focus()
                })
              }}
            />
            <textarea
              {...prompts.textareaProps}
              ref={textareaRef}
              value={text}
              rows={1}
              onChange={(event) => {
                prompts.sync(event.currentTarget)
                setText(event.target.value)
                resize()
              }}
              onKeyDown={onKeyDown}
              onPaste={(event) => {
                if (event.clipboardData.files.length > 0) {
                  event.preventDefault()
                  addFiles(event.clipboardData.files)
                }
              }}
              placeholder={t('Message {name}', { name: bot.name })}
              aria-label={`Message ${bot.name}`}
              className="block max-h-[200px] min-h-8 flex-1 resize-none bg-transparent px-1 py-[5px] text-[14px] leading-[22px] text-ink outline-none placeholder:text-ink-muted"
            />
            {typing && onCancel && !hasContent ? (
              <button
                type="button"
                onClick={onCancel}
                aria-label={t('Stop generating')}
                title={t('Stop generating')}
                className="press-icon grid size-8 shrink-0 place-items-center rounded-full bg-ink text-canvas hover:bg-ink/85"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!canSend}
                aria-label={t('Send message')}
                title={t('Send (Enter)')}
                className={cn(
                  'press-icon grid size-8 shrink-0 place-items-center rounded-full',
                  canSend ? 'bg-accent-600 text-white hover:bg-accent-700' : 'bg-hover text-ink-faint'
                )}
              >
                <ArrowUp className="size-4" strokeWidth={2.25} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
