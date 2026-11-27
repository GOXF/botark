import { useEffect, useState } from 'react'
import * as RadixDialog from '@radix-ui/react-dialog'
import { getPlatform } from '@adapters/platforms'
import type { PlatformId } from '@adapters/types'
import {
  ArrowLeft,
  ArrowRight,
  Compass,
  FolderOpen,
  Layers,
  MessageSquare,
  Plus,
  Settings,
  X
} from 'lucide-react'
import { getPlatformInspector } from '@/components/info/platformInspector'
import { ArkDrawerToggleSvg, ArkPromptSparkSvg, ArkRelayOrbSvg } from '@/components/ui/ArkGlyphs'
import { Button } from '@/components/ui/Button'
import { GrokBotMark, type BotColorId, type BotShape } from '@/components/ui/GrokBotMark'
import { IconButton } from '@/components/ui/IconButton'
import { PlatformGlyph } from '@/components/ui/PlatformGlyph'
import { runtimePlatform } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { useT } from '@/lib/i18n'
import { useOverlayLock } from '@/lib/overlay'
import { shortcutLabel } from '@/lib/shortcuts'
import { useBotStore } from '@/store/botStore'

import { hasSeenOnboarding, markOnboardingSeen } from './onboardingState'
export { hasSeenOnboarding, markOnboardingSeen }

type StepId = 'workspace' | 'accounts' | 'workbench'

const STEPS: Array<{ id: StepId; indexLabel: string; title: string }> = [
  { id: 'workspace', indexLabel: '01', title: "Workspace layout" },
  { id: 'accounts', indexLabel: '02', title: "Import and manage accounts" },
  { id: 'workbench', indexLabel: '03', title: "Right-side workbench" }
]

interface PlatformGuideItem {
  id: PlatformId
  title: string
  settingsTab:
    | 'grok-accounts'
    | 'muse-accounts'
    | 'hark-accounts'
    | 'dot-accounts'
    | 'gemini-accounts'
    | 'hermes-accounts'
    | 'antigravity-accounts'
    | 'cue-accounts'
    | 'ds-bot-accounts'
  accountRule: string
  importMethods: string
  workbenchCards: Array<{ title: string; summary: string }>
  shape: BotShape
  color: BotColorId
  grokState: string
}

const PLATFORM_GUIDE_ITEMS: PlatformGuideItem[] = [
  {
    id: 'grok',
    title: 'Grok Bot',
    settingsTab: 'grok-accounts',
    accountRule: "One sign-in lists every bot in the account in the sidebar.",
    importMethods: "Sign in in a pop-up or browser, or import existing credentials.",
    workbenchCards: [
      { title: "Sessions and subagent tasks", summary: "Review past chats, background tasks, and automations." },
      { title: "Memory and skills library", summary: "Edit the current bot’s long-term memory and skills." },
      { title: "Sandbox computer and files", summary: "Browse generated files, the cloud sandbox, and connectors." },
      { title: "Manage all bots", summary: "Create or clone bots, or start a group chat under the same account." }
    ],
    shape: 'blob',
    color: 'blue',
    grokState: 'happy'
  },
  {
    id: 'meta-muse',
    title: 'Meta Muse',
    settingsTab: 'muse-accounts',
    accountRule: "Connect separate Muse accounts and import a list of email addresses in bulk.",
    importMethods: "Sign in in a pop-up, import using email codes, or assign a proxy from the pool.",
    workbenchCards: [
      { title: "Usage and action approvals", summary: "Check usage and review requests that need approval." },
      { title: "Sessions and scheduled tasks", summary: "Switch between past sessions and manage recurring tasks." },
      { title: "File library and cloud computer", summary: "Preview or download files and open the built-in web view." },
      { title: "Goals and long-term memory", summary: "Manage the assistant’s goals, memory, and connectors." }
    ],
    shape: 'sparkle',
    color: 'violet',
    grokState: 'working'
  },
  {
    id: 'hark',
    title: 'Hark',
    settingsTab: 'hark-accounts',
    accountRule: "Each Hark account has its own assistant. Connect more than one work account.",
    importMethods: "Sign in with Google or email, or import a session cookie.",
    workbenchCards: [
      { title: "Home cards and past sessions", summary: "Jump to past tasks and suggested workflows." },
      { title: "Scheduled checks", summary: "View and manage recurring checks." },
      { title: "Cloud browser activity", summary: "Follow browser activity and view generated files." },
      { title: "Service connectors", summary: "Manage authorized workspace apps and devices." }
    ],
    shape: 'crystal',
    color: 'cyan',
    grokState: 'thinking'
  },
  {
    id: 'dot',
    title: 'ChatGPT Dot',
    settingsTab: 'dot-accounts',
    accountRule: "Import or switch between ChatGPT Dot accounts individually or in bulk.",
    importMethods: "Sign in in a browser window or import token or JSON records.",
    workbenchCards: [
      { title: "Account status and role switching", summary: "Switch roles and chat modes under the current account." },
      { title: "Goals and memory transfer", summary: "Edit goals and transfer memory when switching accounts." },
      { title: "Pages and file library", summary: "Browse and manage pages and images from conversations." }
    ],
    shape: 'star',
    color: 'orange',
    grokState: 'streaming'
  },
  {
    id: 'gemini',
    title: 'Google Gemini',
    settingsTab: 'gemini-accounts',
    accountRule: "API keys, models, and local chats are saved separately for each account.",
    importMethods: "Get an API key from Google AI Studio, test the connection, and choose a model.",
    workbenchCards: [
      { title: "Multimodal chat and search", summary: "Attach images, PDFs, audio, or text and see citations from Google Search." },
      { title: "Sessions and usage", summary: "Switch local sessions and inspect token usage for the last turn." }
    ],
    shape: 'sparkle',
    color: 'blue',
    grokState: 'thinking'
  },
  {
    id: 'hermes',
    title: 'Hermes',
    settingsTab: 'hermes-accounts',
    accountRule: "Connect more than one local or remote Hermes Agent instance.",
    importMethods: "Detect a local Hermes service or enter a server URL and API key.",
    workbenchCards: [
      { title: "Streaming chat and tool activity", summary: "Follow streamed replies, tool calls, and images in the session." },
      { title: "Safety approvals", summary: "Review and approve or deny requests for high-risk commands." },
      { title: "Sessions, schedules, and skills", summary: "Manage chat history, scheduled jobs, installed skills, and toolsets." }
    ],
    shape: 'clover',
    color: 'green',
    grokState: 'working'
  },
  {
    id: 'antigravity',
    title: 'Antigravity',
    settingsTab: 'antigravity-accounts',
    accountRule: "Connect Google accounts in separate profiles.",
    importMethods: "Sign in to Antigravity with Google in the built-in browser.",
    workbenchCards: [
      { title: "Live Cascade chat", summary: "Follow replies, tool calls, and cloud task progress." },
      { title: "Models and quotas", summary: "See plan limits and switch between available Gemini models." },
      { title: "Cloud sessions, sandboxes, and agents", summary: "Manage Cascade sessions, Capsules workspaces, and custom agents." }
    ],
    shape: 'crystal',
    color: 'blue',
    grokState: 'streaming'
  },
  {
    id: 'cue',
    title: 'Cue',
    settingsTab: 'cue-accounts',
    accountRule: "A Cue account lists its agents and supports a desktop session or Manus API key.",
    importMethods: "Sign in in the app or browser, or import existing credentials.",
    workbenchCards: [
      { title: "Streaming chat and tool progress", summary: "Follow live replies and updates, attach images, and stop a response." },
      { title: "Past sessions, schedules, and skills", summary: "Review chat history, recurring tasks, and agent skills." },
      { title: "Session files, cloud computer, and web view", summary: "Browse files and connectors or open the cloud computer in the web view." }
    ],
    shape: 'sparkle',
    color: 'violet',
    grokState: 'working'
  },
  {
    id: 'ds-bot',
    title: 'DS Bot',
    settingsTab: 'ds-bot-accounts',
    accountRule: "A DS Bot instance lists the team’s bots and group chats.",
    importMethods: "Connect with an MCP token, an encrypted pairing link, or DSH Web or Docker.",
    workbenchCards: [
      { title: "Streaming chat and bot sync", summary: "Chat one-on-one or in groups and send images." },
      { title: "Tool approvals and questions", summary: "Review action requests and answer questions in the sidebar." },
      { title: "Memory, schedules, and usage", summary: "Manage long-term memory, recurring tasks, and token usage." }
    ],
    shape: 'blob',
    color: 'blue',
    grokState: 'happy'
  }
]

function FullScreenGuideBody({
  isOverlay,
  onClose
}: {
  isOverlay: boolean
  onClose?: () => void
}) {
  const tr = useT()
  const setAddBotOpen = useBotStore((s) => s.setAddBotOpen)
  const setSettingsOpen = useBotStore((s) => s.setSettingsOpen)
  const setOnboardingOpen = useBotStore((s) => s.setOnboardingOpen)

  const [step, setStep] = useState<StepId>('workspace')
  const [selectedPlatform, setSelectedPlatform] = useState<PlatformId>('grok')
  const [pokeSignal, setPokeSignal] = useState(0)

  const stepIndex = STEPS.findIndex((s) => s.id === step)
  const activeSpec =
    PLATFORM_GUIDE_ITEMS.find((p) => p.id === selectedPlatform) ?? PLATFORM_GUIDE_ITEMS[0]!
  const inspectorTabs = getPlatformInspector(selectedPlatform).tabs

  useEffect(() => {
    markOnboardingSeen()
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return
      if (
        !onClose &&
        document.querySelector('[role="dialog"][data-state="open"]')
      ) return
      if (e.key === 'ArrowRight' && stepIndex < STEPS.length - 1) {
        e.preventDefault()
        setStep(STEPS[stepIndex + 1]!.id)
        setPokeSignal((n) => n + 1)
      } else if (e.key === 'ArrowLeft' && stepIndex > 0) {
        e.preventDefault()
        setStep(STEPS[stepIndex - 1]!.id)
        setPokeSignal((n) => n + 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [stepIndex, onClose])

  const dismissAndAddBot = (platformId?: PlatformId) => {
    markOnboardingSeen()
    setOnboardingOpen(false)
    onClose?.()
    setAddBotOpen(true, platformId ?? null)
  }

  const dismissAndOpenSettings = (
    tab:
      | 'overview'
      | 'grok-accounts'
      | 'muse-accounts'
      | 'hark-accounts'
      | 'dot-accounts'
      | 'gemini-accounts'
      | 'hermes-accounts'
      | 'antigravity-accounts'
      | 'cue-accounts'
      | 'ds-bot-accounts'
  ) => {
    markOnboardingSeen()
    setOnboardingOpen(false)
    onClose?.()
    setSettingsOpen(true, tab)
  }

  return (
    <div className="flex h-full w-full flex-col bg-canvas text-ink select-none">
      {/* Top Bar (respects macOS traffic lights when full-screen overlay) */}
      <header
        className={cn(
          'drag-region flex h-[60px] shrink-0 items-center justify-between border-b border-line/70 px-6',
          isOverlay && runtimePlatform === 'darwin' && 'pl-[92px]'
        )}
      >
        <div className="no-drag flex items-center gap-2.5">
          <button
            type="button"
            onClick={() => setPokeSignal((n) => n + 1)}
            className="press grid size-8 place-items-center rounded-xl bg-surface ring-1 ring-line"
          >
            <GrokBotMark
              seed={`guide-${step}-${selectedPlatform}`}
              shape={activeSpec.shape}
              color={activeSpec.color}
              grokState={activeSpec.grokState}
              followPointer
              pokeSignal={pokeSignal}
              sizePx={24}
            />
          </button>
          <span className="text-[14px] font-semibold tracking-tight text-ink">{tr("BotArk guide")}</span>
        </div>

        {/* Step Pills */}
        <nav className="no-drag flex items-center gap-1 rounded-full bg-sunken p-1" aria-label={tr("Guide steps")}>
          {STEPS.map((item) => {
            const active = item.id === step
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setStep(item.id)
                  setPokeSignal((n) => n + 1)
                }}
                className={cn(
                  'flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-all',
                  active
                    ? 'bg-surface text-ink shadow-soft'
                    : 'text-ink-secondary hover:text-ink'
                )}
              >
                <span className="font-mono text-[11px] opacity-60">{item.indexLabel}</span>
                <span>{tr(item.title)}</span>
              </button>
            )
          })}
        </nav>

        <div className="no-drag flex items-center gap-2">
          {onClose ? (
            <IconButton label={tr("Close guide")} onClick={onClose}>
              <X />
            </IconButton>
          ) : (
            <Button size="sm" variant="primary" onClick={() => dismissAndAddBot('grok')}>
              <Plus className="size-3.5" /> {tr("Add account")}
            </Button>
          )}
        </div>
      </header>

      {/* Main Full-Screen Stage */}
      <main className="flex min-h-0 flex-1 overflow-y-auto px-6 py-8 sm:px-12">
        <div className="mx-auto my-auto w-full max-w-[1040px]">
          {step === 'workspace' && (
            <div key="workspace" className="grid animate-veil-in items-center gap-10 lg:grid-cols-[1fr_1.25fr]">
              {/* Left Explanation */}
              <div className="flex flex-col gap-6">
                <div className="inline-flex w-fit items-center gap-2 rounded-full bg-surface px-3 py-1 text-[12.5px] font-medium text-ink-secondary ring-1 ring-line">
                  <ArkPromptSparkSvg className="size-3.5 text-accent-600" />
                  {tr("Step 1 · The three-panel workspace")}
                </div>
                <h1 className="text-[28px] leading-[1.25] font-semibold tracking-tight text-ink sm:text-[32px]">
                  {tr("Chat with one bot or a group and open the workbench when you need it.")}
                </h1>
                <div className="flex flex-col gap-3.5 text-[14px] leading-6 text-ink-secondary">
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg bg-surface font-mono text-[12px] font-semibold text-ink ring-1 ring-line">
                      1
                    </span>
                    <p>
                      <strong className="font-semibold text-ink">{tr("Organize bots on the left")}</strong>
                      {tr(": Pin your favorite bots, organize them into sections, and start cross-platform group chats.")}
                    </p>
                  </div>
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg bg-surface font-mono text-[12px] font-semibold text-ink ring-1 ring-line">
                      2
                    </span>
                    <p>
                      <strong className="font-semibold text-ink">{tr("Chat in the center")}</strong>
                      {tr(": Follow streaming replies and use approved workspace or tool context.")}
                    </p>
                  </div>
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg bg-surface font-mono text-[12px] font-semibold text-ink ring-1 ring-line">
                      3
                    </span>
                    <p>
                      <strong className="font-semibold text-ink">{tr("Open the workbench on the right")}</strong>
                      {tr(": Press ")}<kbd className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono text-[12px] text-ink">{shortcutLabel('I')}</kbd>{tr(" to show or hide controls for the current bot or group.")}
                    </p>
                  </div>
                </div>
              </div>

              {/* Right Interactive Visual Mockup of 3-Column Layout */}
              <div className="overflow-hidden rounded-3xl border border-line bg-surface p-3 shadow-float">
                <div className="grid h-[380px] grid-cols-[156px_1fr_176px] gap-2.5 rounded-2xl bg-canvas p-2.5">
                  {/* Mock Left Sidebar */}
                  <div className="flex flex-col justify-between rounded-xl border border-line bg-surface p-2.5">
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between px-1 pb-1">
                        <span className="text-[11px] font-semibold text-ink-muted">{tr("Left · Bot list")}</span>
                        <span className="grid size-5 place-items-center rounded-full bg-accent-50 text-[12px] font-bold text-accent-600">
                          +
                        </span>
                      </div>
                      {[
                        { name: 'Researcher', tag: 'Grok', active: true, shape: 'blob' as BotShape, color: 'blue' as BotColorId },
                        { name: 'Code Helper', tag: 'Grok', active: false, shape: 'sparkle' as BotShape, color: 'violet' as BotColorId },
                        { name: 'Daily Brief', tag: 'Grok', active: false, shape: 'gem' as BotShape, color: 'green' as BotColorId },
                        { name: 'Meta Muse', tag: 'Muse', active: false, shape: 'crystal' as BotShape, color: 'magenta' as BotColorId },
                        { name: 'Orbit Dot', tag: 'Dot', active: false, shape: 'star' as BotShape, color: 'orange' as BotColorId }
                      ].map((row) => (
                        <div
                          key={row.name}
                          className={cn(
                            'flex items-center gap-2 rounded-lg px-2 py-1.5 text-[12px]',
                            row.active ? 'bg-active font-medium text-ink' : 'text-ink-secondary'
                          )}
                        >
                          <GrokBotMark seed={row.name} shape={row.shape} color={row.color} sizePx={18} />
                          <span className="min-w-0 flex-1 truncate">{row.name}</span>
                        </div>
                      ))}
                    </div>

                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium text-ink-secondary">
                        <ArkRelayOrbSvg className="size-3.5 text-accent-600" />
                        <span>{tr("Collaboration room")}</span>
                      </div>
                      <div className="flex items-center gap-1.5 rounded-lg bg-sunken px-2 py-1.5 text-[11.5px] font-medium text-ink">
                        <Settings className="size-3.5 text-ink-secondary" />
                        <span>{tr("Settings & accounts")}</span>
                      </div>
                    </div>
                  </div>

                  {/* Mock Center Chat */}
                  <div className="flex flex-col justify-between rounded-xl border border-line bg-main p-3">
                    <div className="flex items-center justify-between border-b border-line/60 pb-2">
                      <span className="text-[12px] font-semibold text-ink">Researcher</span>
                      <ArkDrawerToggleSvg active className="size-4 text-accent-600" />
                    </div>
                    <div className="flex flex-col items-center gap-2.5 py-4 text-center">
                      <GrokBotMark
                        seed="center-hero"
                        shape="blob"
                        color="blue"
                        grokState="happy"
                        followPointer
                        sizePx={56}
                      />
                      <span className="text-[13px] font-medium text-ink">{tr("Center · Live chat")}</span>
                    </div>
                    <div className="flex h-9 items-center rounded-xl border border-line bg-surface px-3 text-[12px] text-ink-muted">
                      {tr("Type a message to start…")}
                    </div>
                  </div>

                  {/* Mock Right Workbench */}
                  <div className="flex flex-col gap-2 rounded-xl border border-accent/35 bg-accent-50/20 p-2.5">
                    <span className="px-1 text-[11px] font-semibold text-accent-600">{tr("Right · Workbench")}</span>
                    <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface p-1 text-center text-[11px] font-medium text-ink">
                      <span className="rounded bg-sunken py-1">{tr("Overview")}</span>
                      <span className="py-1 text-ink-muted">{tr("File library")}</span>
                    </div>
                    {["Session history", "Subagent tasks", "Memory and skills", "All bots"].map((card) => (
                      <div
                        key={card}
                        className="rounded-lg border border-line bg-surface px-2.5 py-2 text-[11.5px] font-medium text-ink"
                      >
                        {tr(card)}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {step === 'accounts' && (
            <div key="accounts" className="flex animate-veil-in flex-col gap-5">
              <div className="flex flex-col gap-2.5">
                <div className="inline-flex w-fit items-center gap-2 rounded-full bg-surface px-3 py-1 text-[12px] font-medium text-ink-secondary ring-1 ring-line">
                  <ArkRelayOrbSvg className="size-3.5 text-accent-600" />
                  {tr("Step 2 · Connect and organize accounts")}
                </div>
                <h1 className="text-[26px] leading-[1.25] font-semibold tracking-tight text-ink sm:text-[30px]">
                  {tr("Connect accounts from either of two places.")}
                </h1>
              </div>

              {/* Two Compact Entry Capsules */}
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => dismissAndAddBot()}
                  className="group press flex items-center gap-3.5 rounded-2xl border border-line/80 bg-surface p-3.5 text-left transition-all hover:border-line-strong hover:shadow-soft"
                >
                  <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-50 text-accent-600">
                    <Plus className="size-4.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-[14.5px] font-semibold text-ink">{tr("Top left: + New")}</h3>
                      <kbd className="rounded-md border border-line bg-canvas px-1.5 py-0.5 font-mono text-[11px] text-ink-secondary">
                        {shortcutLabel('N')}
                      </kbd>
                    </div>
                    <p className="mt-0.5 truncate text-[12.5px] text-ink-secondary">
                      {tr("Sign in, authorize in your browser, import credentials, or create a group chat.")}
                    </p>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => dismissAndOpenSettings('overview')}
                  className="group press flex items-center gap-3.5 rounded-2xl border border-line/80 bg-surface p-3.5 text-left transition-all hover:border-line-strong hover:shadow-soft"
                >
                  <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-sunken text-ink">
                    <Settings className="size-4.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-[14.5px] font-semibold text-ink">{tr("Bottom left: Settings & accounts")}</h3>
                      <ArrowRight className="size-4 text-ink-muted transition-transform group-hover:translate-x-0.5" />
                    </div>
                    <p className="mt-0.5 truncate text-[12.5px] text-ink-secondary">
                      {tr("See account health, import accounts, and manage the proxy pool and mobile sync.")}
                    </p>
                  </div>
                </button>
              </div>

              {/* Balanced 3x2 Grid for All 6 Native Platforms */}
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {PLATFORM_GUIDE_ITEMS.map((item) => {
                  const descriptor = getPlatform(item.id)
                  return (
                    <div
                      key={item.id}
                      className="flex flex-col justify-between gap-3 rounded-2xl border border-line/80 bg-surface p-4"
                    >
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2.5">
                          <PlatformGlyph platform={descriptor} size="md" />
                          <span className="text-[14.5px] font-semibold text-ink">{tr(item.title)}</span>
                        </div>
                        <p className="line-clamp-2 text-[12.5px] leading-[18px] text-ink-secondary">
                          {tr(item.importMethods)}
                        </p>
                      </div>

                      <div className="flex items-center gap-2 pt-0.5">
                        <Button
                          size="sm"
                          variant="primary"
                          className="flex-1"
                          onClick={() => dismissAndAddBot(item.id)}
                        >
                          {tr("Add now")}
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => dismissAndOpenSettings(item.settingsTab)}
                        >
                          {tr("Account management")}
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {step === 'workbench' && (
            <div key="workbench" className="grid animate-veil-in items-center gap-10 lg:grid-cols-[1fr_1.15fr]">
              {/* Left: Platform Switcher & Clean Explanation */}
              <div className="flex flex-col gap-6">
                <div className="inline-flex w-fit items-center gap-2 rounded-full bg-surface px-3 py-1 text-[12.5px] font-medium text-ink-secondary ring-1 ring-line">
                  <ArkDrawerToggleSvg active className="size-3.5 text-accent-600" />
                  {tr("Step 3 · The right-side workbench")}
                </div>
                <h1 className="text-[28px] leading-[1.25] font-semibold tracking-tight text-ink sm:text-[32px]">
                  {tr("The workbench adapts to the current bot.")}
                </h1>
                <p className="text-[14.5px] leading-6 text-ink-secondary">
                  {tr("Use the workbench to switch chats, view subtasks, manage memory, download files, or manage other bots on the account.")}
                </p>

                {/* Interactive Platform Selector */}
                <div className="flex flex-wrap gap-2">
                  {PLATFORM_GUIDE_ITEMS.map((item) => {
                    const active = item.id === selectedPlatform
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          setSelectedPlatform(item.id)
                          setPokeSignal((n) => n + 1)
                        }}
                        className={cn(
                          'flex items-center gap-2 rounded-xl border px-3.5 py-2 text-[13.5px] font-medium transition-all',
                          active
                            ? 'border-ink bg-ink text-surface shadow-soft'
                            : 'border-line bg-surface text-ink hover:bg-hover'
                        )}
                      >
                        <PlatformGlyph platform={getPlatform(item.id)} size="sm" />
                        <span>{tr(item.title)}</span>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Right: Full-Size Clean Right-Side Workbench Preview */}
              <div className="overflow-hidden rounded-3xl border border-line bg-surface p-6 shadow-float">
                <div className="flex items-center justify-between pb-4">
                  <div className="flex items-center gap-3">
                    <GrokBotMark
                      seed={`workbench-${activeSpec.id}`}
                      shape={activeSpec.shape}
                      color={activeSpec.color}
                      grokState={activeSpec.grokState}
                      followPointer
                      pokeSignal={pokeSignal}
                      sizePx={42}
                    />
                    <div>
                      <h3 className="text-[16px] font-semibold text-ink">{activeSpec.title}</h3>
                      <p className="text-[12.5px] text-ink-secondary">{tr("Online · Workbench")}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <span className="inline-flex h-7 items-center gap-1 rounded-lg border border-line bg-canvas px-2.5 text-[12px] font-medium text-ink">
                      <MessageSquare className="size-3.5 text-ink-secondary" />
                      {tr("New conversation")}
                    </span>
                    <span className="inline-flex h-7 items-center gap-1 rounded-lg border border-line bg-canvas px-2.5 text-[12px] font-medium text-ink">
                      <FolderOpen className="size-3.5 text-ink-secondary" />
                      {tr("File library")}
                    </span>
                  </div>
                </div>

                {/* Clean Inspector Tabs */}
                <div className="mb-4 flex rounded-xl bg-sunken p-1">
                  {inspectorTabs.map((tab, idx) => (
                    <div
                      key={tab.id}
                      className={cn(
                        'flex-1 rounded-lg py-1.5 text-center text-[12.5px] font-medium',
                        idx === 0 ? 'bg-surface text-ink shadow-soft' : 'text-ink-secondary'
                      )}
                    >
                      {tr(tab.label)}
                    </div>
                  ))}
                </div>

                {/* Clean Section Cards */}
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {activeSpec.workbenchCards.map((card) => (
                    <div
                      key={card.title}
                      className="flex flex-col gap-1 rounded-2xl border border-line bg-canvas p-3.5"
                    >
                      <div className="flex items-center gap-1.5 text-[13.5px] font-semibold text-ink">
                        <Layers className="size-3.5 text-accent-600" />
                        <span>{tr(card.title)}</span>
                      </div>
                      <p className="text-[12.5px] leading-5 text-ink-secondary">{tr(card.summary)}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* Bottom Bar */}
      <footer className="flex h-[68px] shrink-0 items-center justify-between border-t border-line/70 px-6 sm:px-12">
        <div>
          {stepIndex > 0 ? (
            <Button
              variant="ghost"
              onClick={() => {
                setStep(STEPS[stepIndex - 1]!.id)
                setPokeSignal((n) => n + 1)
              }}
            >
              <ArrowLeft className="size-4" /> {tr("Previous step")}
            </Button>
          ) : onClose ? (
            <Button variant="ghost" onClick={onClose}>
              {tr("Skip guide")}
            </Button>
          ) : null}
        </div>

        <div className="flex items-center gap-2.5">
          {stepIndex < STEPS.length - 1 ? (
            <Button
              size="lg"
              variant="primary"
              onClick={() => {
                setStep(STEPS[stepIndex + 1]!.id)
                setPokeSignal((n) => n + 1)
              }}
            >
              {tr("Next: {step}", { step: tr(STEPS[stepIndex + 1]!.title) })}
              <ArrowRight className="size-4" />
            </Button>
          ) : (
            <>
              <Button
                size="lg"
                variant="secondary"
                onClick={() => dismissAndOpenSettings('grok-accounts')}
              >
                <Settings className="size-4" /> {tr("Open account management")}
              </Button>
              <Button
                size="lg"
                variant="primary"
                onClick={() => (onClose ? onClose() : dismissAndAddBot('grok'))}
              >
                {onClose ? tr("Get started") : tr("Add your first account")}
              </Button>
            </>
          )}
        </div>
      </footer>
    </div>
  )
}

/**
 * Full-screen welcome stage rendered when the workspace has zero bots.
 */
export function OnboardingStage() {
  return (
    <div className="fixed inset-0 z-40">
      <FullScreenGuideBody isOverlay />
    </div>
  )
}

/**
 * Full-screen interactive product guide launchable anytime from Sidebar, Settings, or `⌘K`.
 */
export function OnboardingDialog() {
  const open = useBotStore((s) => s.onboardingOpen)
  const setOpen = useBotStore((s) => s.setOnboardingOpen)
  const tr = useT()
  useOverlayLock(open)

  return (
    <RadixDialog.Root open={open} onOpenChange={setOpen}>
      <RadixDialog.Portal>
        <RadixDialog.Content
          aria-describedby={undefined}
          data-onboarding-dialog
          className="fixed inset-0 z-50 animate-veil-in outline-none"
        >
          <RadixDialog.Title className="sr-only">{tr('BotArk guide')}</RadixDialog.Title>
          <FullScreenGuideBody isOverlay onClose={() => setOpen(false)} />
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

export { Compass as OnboardingIcon }
