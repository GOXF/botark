import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { usePanes, type WorkspaceView } from '@/store/paneStore'
import {
  Activity,
  ArrowLeft,
  Download,
  FileUp,
  FolderPlus,
  Globe,
  KeyRound,
  LayoutDashboard,
  LogOut,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  ShieldAlert,
  Shuffle,
  Smartphone,
  Sparkles,
  Trash2,
  Users
} from 'lucide-react'
import { adapterRegistry } from '@adapters/registry'
import { listGrokAuthAccountIds } from '@adapters/grokbot/tokenStore'
import type { PlatformId } from '@adapters/types'
import type { MuseProxyPoolItemView, MuseProxyScheme, MuseProxyView } from '@shared/ipc'
import { getPlatform } from '@adapters/platforms'
import { createId } from '@shared/id'
import { SecurityVaultCenter } from '@/components/info/SecurityVaultCard'
import { PaneHeader } from '@/components/layout/PaneHeader'
import { MuseBatchImport } from '@/components/add-bot/MuseBatchImport'
import { ArkMobileLinkSvg, ArkRelayOrbSvg } from '@/components/ui/ArkGlyphs'
import { BotAvatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { NumberStepper, SwitchPill } from '@/components/ui/Controls'
import { Dialog } from '@/components/ui/Dialog'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/Menu'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { GoxfChannelRow } from '@/components/update/GoxfChannelRow'
import { Select } from '@/components/ui/Select'
import { StatusBadge } from '@/components/ui/Status'
import { getBridge } from '@/lib/bridge'
import { cn } from '@/lib/cn'
import { useT, t } from '@/lib/i18n'
import { useAccountLayout, type AccountLayout } from '@/lib/goxfAccountLayout'
import { importHarkCredentialsForAccount } from '@/lib/harkCredentialImport'
import { platformIcon } from '@/lib/platformIcons'
import { clearVaultCredentials } from '@/lib/vaultClient'
import { HermesAccountsSettingsPanel } from '@/components/hermes/HermesAccountsSettingsPanel'
import { MobileSyncSettingsPanel } from '@/components/mobile-sync/MobileSyncSettingsPanel'
import { McpSettingsSection } from '@/components/settings/McpSettingsSection'
import { NEW_ROOM_ID } from '@/rooms/RoomView'
import { stopRoom, useRooms } from '@/rooms/roomStore'
import { autoAssignProxyPool, useBotStore } from '@/store/botStore'
import { usePrefsStore, type Locale, type ThemePref } from '@/store/prefsStore'
import type { Bot } from '@/types'

type SettingsTab =
  | 'overview'
  | 'muse-accounts'
  | 'dot-accounts'
  | 'grok-accounts'
  | 'hark-accounts'
  | 'hermes-accounts'
  | 'antigravity-accounts'
  | 'cue-accounts'
  | 'mcp-hub'
  | 'mobile-sync'
  | 'proxy-pool'
  | 'general'

interface DotStoredMeta {
  accountId: string
  handle?: string
  displayName?: string
  planType?: string
  activeDotId?: string
  roomId?: string
  mode?: 'dot' | 'native'
  model?: string
  effort?: string
  hasRefreshToken?: boolean
  expiresAtMs?: number
  updatedAt?: number
  hasProxy?: boolean
}

const PROXY_PLACEHOLDER = `# 支持每行一个代理（自动识别格式）：
https://user:pass@proxy.example.com:443
http://user:pass@127.0.0.1:7890
socks5://user:pass@127.0.0.1:1080
socks5h://127.0.0.1:1080
192.168.1.10:1080:username:password
127.0.0.1:7890`

const PLATFORM_LABELS: Record<PlatformId, string> = {
  'meta-muse': 'Meta Muse',
  dot: 'ChatGPT Dot',
  grok: 'Grok Bot',
  hark: 'Hark Pro',
  hermes: 'Hermes',
  antigravity: 'Antigravity',
  cue: 'Cue (Manus)'
}

// Settings tabs that render a .goxf-acc-list (the grid/list toggle only applies there).
const ACC_LIST_TABS: string[] = ['overview', 'muse-accounts', 'dot-accounts', 'grok-accounts', 'hark-accounts', 'antigravity-accounts']

const PURGED_VAULT_STORES = new Set([
  'proxy', 'proxy-pool', 'grok-tokens', 'dot-tokens', 'cue-tokens', 'hermes-accounts', 'secrets-vault'
])

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function purgeCredentials() {
  const state = useBotStore.getState()
  const bridge = getBridge()
  const accounts = Object.values(state.accounts)
  const failures: string[] = []
  const attempt = async (step: string, action: () => unknown | Promise<unknown>) => {
    try {
      await action()
      return true
    } catch (error) {
      failures.push(`${step} — ${errorMessage(error)}`)
      return false
    }
  }

  // Stop room turns before clearing their accounts and persisted transcript.
  const rooms = useRooms.getState().rooms
  await Promise.all(rooms.map((room) => attempt(room.title, () => stopRoom(room.id))))
  await attempt(t('Collaboration rooms'), () => {
    useRooms.setState({ rooms: [], speakers: {}, turnProgress: {}, errors: {}, externalAudiences: {} })
    localStorage.removeItem('botark-collaboration-rooms')
    if (localStorage.getItem('botark-collaboration-rooms') !== null) {
      throw new Error(t('Could not remove the saved collaboration rooms'))
    }
  })
  useBotStore.setState((current) => ({
    activeDocument: null,
    webSessionOpen: false,
    webSessionByBot: {},
    webSessionTargetUrl: null,
    ...(rooms.some((room) => room.id === current.selectedBotId) ? { selectedBotId: null } : {})
  }))

  const partitionIds = new Set(accounts.map((account) => account.id))
  const proxyIds = new Set(partitionIds)
  const muse = bridge?.muse
  if (muse?.listProxyPool) {
    await attempt(t('Proxy pool'), async () => {
      for (const item of await muse.listProxyPool()) {
        for (const id of item.assignedAccountIds) {
          proxyIds.add(id)
          partitionIds.add(id)
        }
      }
    })
  }

  const authBridges = {
    grok: bridge?.grok,
    dot: bridge?.dot,
    hark: bridge?.hark,
    hermes: bridge?.hermes,
    antigravity: bridge?.antigravity,
    cue: bridge?.cue
  }
  const grokSessionIds = listGrokAuthAccountIds()
  for (const id of grokSessionIds) {
    partitionIds.add(id)
    proxyIds.add(id)
  }

  // The store drains account connections and invalidates their pending work.
  // Verify the cleanup through the bridge because the store only reports
  // per-account failures via UI state.
  await Promise.all(accounts.map(({ id, platformId }) =>
    attempt(`${PLATFORM_LABELS[platformId]} (${id})`, () => state.signOutAccount(id))
  ))
  const grokAdapter = adapterRegistry.get('grok') as { clearAuth?: (accountId: string) => void } | undefined
  await Promise.all(grokSessionIds.map((id) =>
    attempt(`Grok Bot (${id})`, () => grokAdapter?.clearAuth?.(id))
  ))

  const signedOutIds = new Set<string>()
  await Promise.all(accounts.map(async (account) => {
    const { id, platformId } = account
    const label = `${PLATFORM_LABELS[platformId]} (${id})`
    const cleared = await attempt(label, async () => {
      if (!bridge) return
      if (platformId === 'meta-muse' && muse?.signOut) {
        await muse.signOut(id)
        partitionIds.delete(id)
        return
      }
      const auth = platformId === 'meta-muse' ? undefined : authBridges[platformId]
      if (!auth?.clearAuth) throw new Error(t('Desktop credential cleanup is unavailable'))
      const status = await auth.clearAuth(id)
      if (status?.signedIn) throw new Error(t('The account is still signed in'))
    })
    if (platformId === 'hermes') partitionIds.delete(id)
    if (cleared) signedOutIds.add(id)
  }))

  if (bridge) {
    await Promise.all([...partitionIds].map((id) => attempt(t('Browser session for {account}', { account: id }), async () => {
      if (!bridge.webViews?.clearPartition) throw new Error(t('Desktop credential cleanup is unavailable'))
      await bridge.webViews.clearPartition(id)
    })))
    // Include retained pool assignments and platform records outside the current Bot list.
    await Promise.all((['dot', 'grok', 'cue', 'hermes'] as const).map(async (platform) => {
      const auth = authBridges[platform]
      if (!auth?.clearAuth) return
      await attempt(PLATFORM_LABELS[platform], async () => {
        if ((await auth.clearAuth('*')).signedIn) throw new Error(t('The account is still signed in'))
      })
    }))
    if (muse?.setProxy) {
      await Promise.all([...proxyIds].map((id) => attempt(t('Proxy for {account}', { account: id }), async () => {
        const proxy = await muse.setProxy(id, { mode: 'system' })
        if (proxy.mode !== 'system' || proxy.hasPassword) throw new Error(t('Proxy credentials are still present'))
      })))
    }
    await attempt(t('Proxy pool'), async () => {
      if (!muse?.clearProxyPool) throw new Error(t('Desktop credential cleanup is unavailable'))
      if ((await muse.clearProxyPool()).length) throw new Error(t('Proxy credentials are still present'))
    })
  }

  await attempt(t('Security vault'), clearVaultCredentials)
  const vault = bridge?.vault
  if (vault?.status) {
    await attempt(t('Security vault'), async () => {
      const { stores } = await vault.status()
      for (const store of stores) {
        if (PURGED_VAULT_STORES.has(store.id) && (store.entryCount > 0 || (store.exists && store.modeOctal === null))) {
          failures.push(t('Could not verify that {file} is empty', { file: store.fileName }))
        }
      }
    })
  }
  if (signedOutIds.size) {
    useBotStore.setState((current) => {
      const accounts = { ...current.accounts }
      for (const id of signedOutIds) {
        const account = accounts[id]
        if (account) accounts[id] = { ...account, status: 'offline', statusDetail: 'Signed out', unread: 0 }
      }
      return { accounts }
    })
  }
  if (failures.length) throw new Error(t('Cleanup completed with errors') + '\n' + failures.join('\n'))
}

export function SettingsView() {
  const [accLayout, setAccLayout] = useAccountLayout()
  const tr = useT()
  const settingsTab = useBotStore((s) => s.settingsTab)
  const setSettingsOpen = useBotStore((s) => s.setSettingsOpen)
  const setOnboardingOpen = useBotStore((s) => s.setOnboardingOpen)
  const groups = useBotStore((s) => s.groups)
  const bots = useBotStore((s) => s.bots)
  const roomCount = useRooms((s) => settingsTab === 'overview' ? s.rooms.length : 0)
  const accounts = useBotStore((s) => s.accounts)
  const addBot = useBotStore((s) => s.addBot)
  const selectBot = useBotStore((s) => s.selectBot)
  const connectAccount = useBotStore((s) => s.connectAccount)
  const openMuseLogin = useBotStore((s) => s.openMuseLogin)
  const openGrokLogin = useBotStore((s) => s.openGrokLogin)
  const openHarkLogin = useBotStore((s) => s.openHarkLogin)
  const openDotLogin = useBotStore((s) => s.openDotLogin)
  const renameAccount = useBotStore((s) => s.renameAccount)
  const renameBot = useBotStore((s) => s.renameBot)
  const addGroup = useBotStore((s) => s.addGroup)
  const renameGroup = useBotStore((s) => s.renameGroup)
  const removeGroup = useBotStore((s) => s.removeGroup)
  const moveBotToGroup = useBotStore((s) => s.moveBotToGroup)
  const togglePinBot = useBotStore((s) => s.togglePinBot)
  const setGrokAccessToken = useBotStore((s) => s.setGrokAccessToken)
  const syncGrokAccountBots = useBotStore((s) => s.syncGrokAccountBots)
  const signOutAccount = useBotStore((s) => s.signOutAccount)
  const removeBot = useBotStore((s) => s.removeBot)

  const theme = usePrefsStore((s) => s.theme)
  const setTheme = usePrefsStore((s) => s.setTheme)
  const locale = usePrefsStore((s) => s.locale)
  const setLocale = usePrefsStore((s) => s.setLocale)

  const [pool, setPool] = useState<MuseProxyPoolItemView[]>([])
  const [accountProxies, setAccountProxies] = useState<Record<string, MuseProxyView>>({})
  const [dotMetaMap, setDotMetaMap] = useState<Record<string, DotStoredMeta>>({})
  const [rawProxyText, setRawProxyText] = useState('')
  const [defaultMode, setDefaultMode] = useState<MuseProxyScheme>('socks5')
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState<string>()
  const [error, setError] = useState<string>()
  const [batchOpen, setBatchOpen] = useState(false)
  const [testingIds, setTestingIds] = useState<ReadonlySet<string>>(new Set())
  const proxyAssignPlatforms = usePrefsStore((s) => s.proxyAssignPlatforms)
  const setProxyAssignPlatforms = usePrefsStore((s) => s.setProxyAssignPlatforms)
  const proxyPerProxyLimit = usePrefsStore((s) => s.proxyPerProxyLimit)
  const setProxyPerProxyLimit = usePrefsStore((s) => s.setProxyPerProxyLimit)

  // Overview filters & inline editing
  const [searchQuery, setSearchQuery] = useState('')
  const [platformFilter, setPlatformFilter] = useState<
    'all' | 'meta-muse' | 'dot' | 'grok' | 'hark' | 'hermes' | 'antigravity'
  >('all')
  const [statusFilter, setStatusFilter] = useState<'all' | 'online' | 'offline'>('all')
  const [editingBotId, setEditingBotId] = useState<string | null>(null)
  const [editingBotName, setEditingBotName] = useState('')

  // Platform credential import states
  const [grokTokenInput, setGrokTokenInput] = useState('')
  const [grokRefreshInput, setGrokRefreshInput] = useState('')
  const [grokTargetAccountId, setGrokTargetAccountId] = useState<string>('__new__')

  const [dotRawInput, setDotRawInput] = useState('')
  const [dotRefreshInput, setDotRefreshInput] = useState('')
  const [dotTargetAccountId, setDotTargetAccountId] = useState<string>('__new__')
  const [dotMigrateMemory, setDotMigrateMemory] = useState(true)

  const [harkRawInput, setHarkRawInput] = useState('')
  const [harkTargetAccountId, setHarkTargetAccountId] = useState<string>('__new__')

  // Group management states
  const [newGroupName, setNewGroupName] = useState('')
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)
  const [editingGroupName, setEditingGroupName] = useState('')

  // Security confirmation states
  const [confirmWipeCreds, setConfirmWipeCreds] = useState(false)
  const [confirmResetAll, setConfirmResetAll] = useState(false)

  const [version, setVersion] = useState('')
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const dotInputRef = useRef<HTMLTextAreaElement>(null)
  const proxyRequestId = useRef(0)
  const dotRequestId = useRef(0)
  const cleaning = useRef(false)
  const checking = useRef(false)

  const allAccounts = useMemo(() => Object.values(accounts), [accounts])
  const botsByAccountId = useMemo(() => {
    const indexed = new Map<string, Bot[]>()
    for (const bot of bots) {
      for (const id of bot.accountIds) {
        const owners = indexed.get(id)
        if (owners) owners.push(bot)
        else indexed.set(id, [bot])
      }
    }
    return indexed
  }, [bots])
  const museBots = useMemo(() => bots.filter((b) => b.platformId === 'meta-muse'), [bots])
  const museAccounts = useMemo(() => allAccounts.filter((a) => a.platformId === 'meta-muse'), [allAccounts])
  const dotBots = useMemo(() => bots.filter((b) => b.platformId === 'dot'), [bots])
  const dotAccounts = useMemo(() => allAccounts.filter((a) => a.platformId === 'dot'), [allAccounts])
  const grokBots = useMemo(() => bots.filter((b) => b.platformId === 'grok'), [bots])
  const grokAccounts = useMemo(() => allAccounts.filter((a) => a.platformId === 'grok'), [allAccounts])
  const harkBots = useMemo(() => bots.filter((b) => b.platformId === 'hark'), [bots])
  const harkAccounts = useMemo(() => allAccounts.filter((a) => a.platformId === 'hark'), [allAccounts])
  const hermesBots = useMemo(() => bots.filter((b) => b.platformId === 'hermes'), [bots])
  const hermesAccounts = useMemo(() => allAccounts.filter((a) => a.platformId === 'hermes'), [allAccounts])
  const antigravityBots = useMemo(() => bots.filter((b) => b.platformId === 'antigravity'), [bots])
  const antigravityAccounts = useMemo(
    () => allAccounts.filter((a) => a.platformId === 'antigravity'),
    [allAccounts]
  )
  const cueBots = useMemo(() => bots.filter((b) => b.platformId === 'cue'), [bots])
  const cueAccounts = useMemo(() => allAccounts.filter((a) => a.platformId === 'cue'), [allAccounts])
  const openCueLogin = useBotStore((s) => s.openCueLogin)
  const importCueCredentials = useBotStore((s) => s.importCueCredentials)
  const syncCueAccountBots = useBotStore((s) => s.syncCueAccountBots)
  const [cueCredentialInput, setCueCredentialInput] = useState('')
  const [cueTargetAccountId, setCueTargetAccountId] = useState('__new__')

  const accountPlatformIds = useMemo(
    () => [...new Set(allAccounts.map((a) => a.platformId))] as PlatformId[],
    [allAccounts]
  )
  const accountLabel = (accId: string) =>
    bots.find((b) => b.accountIds.includes(accId))?.name || accounts[accId]?.displayName || accId

  const onlineAccountsCount = useMemo(
    () => allAccounts.filter((a) => a.status === 'online' || a.status === 'busy' || a.status === 'attention').length,
    [allAccounts]
  )

  const refreshProxiesAndPool = useCallback(async () => {
    const { settingsOpen, settingsTab, accounts } = useBotStore.getState()
    if (cleaning.current || !settingsOpen || !['overview', 'muse-accounts', 'proxy-pool'].includes(settingsTab)) return
    const muse = getBridge()?.muse
    if (!muse) return
    const request = ++proxyRequestId.current
    const isCurrent = () => {
      const state = useBotStore.getState()
      return state.settingsOpen && state.settingsTab === settingsTab && proxyRequestId.current === request
    }
    try {
      if (muse.listProxyPool) {
        const items = await muse.listProxyPool()
        if (!isCurrent()) return
        setPool(items)
      }
      if (settingsTab === 'muse-accounts' && muse.getProxy) {
        const ids = Object.values(accounts).filter((account) => account.platformId === 'meta-muse').map((account) => account.id)
        const results = await Promise.allSettled(ids.map(async (id) => [id, await muse.getProxy(id)] as const))
        if (!isCurrent()) return
        setAccountProxies(Object.fromEntries(
          results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
        ))
      }
    } catch (err) {
      if (isCurrent()) setError(errorMessage(err))
    }
  }, [])

  const refreshDotStoredMeta = useCallback(async () => {
    const { settingsOpen, settingsTab } = useBotStore.getState()
    if (cleaning.current || !settingsOpen || (settingsTab !== 'overview' && settingsTab !== 'dot-accounts')) return
    const dot = getBridge()?.dot
    if (!dot?.rpc) return
    const request = ++dotRequestId.current
    try {
      const res = await dot.rpc({ accountId: '_', op: 'listStoredAccounts' })
      const current = useBotStore.getState()
      if (!current.settingsOpen || current.settingsTab !== settingsTab || dotRequestId.current !== request) return
      if (res.ok && Array.isArray(res.data)) {
        const map: Record<string, DotStoredMeta> = {}
        for (const item of res.data as DotStoredMeta[]) {
          if (item && typeof item.accountId === 'string') {
            map[item.accountId] = item
          }
        }
        setDotMetaMap(map)
      }
    } catch {
      /* ignore */
    }
  }, [])

  useLayoutEffect(() => {
    return () => {
      proxyRequestId.current++
      dotRequestId.current++
    }
  }, [settingsTab])

  useEffect(() => {
    void refreshProxiesAndPool()
  }, [refreshProxiesAndPool, settingsTab, allAccounts.length])

  useEffect(() => {
    void refreshDotStoredMeta()
  }, [refreshDotStoredMeta, dotAccounts.length, settingsTab])

  useEffect(() => {
    const updates = getBridge()?.updates
    if (updates?.version) void updates.version().then(setVersion, () => {})
  }, [])

  const handleCheckForUpdates = async () => {
    if (checking.current) return
    const updates = getBridge()?.updates
    setHint(undefined)
    setError(undefined)
    if (!updates?.check) {
      setError(tr('Update checks require the desktop app'))
      return
    }
    checking.current = true
    setCheckingUpdate(true)
    try {
      if (!(await updates.check()).ok) throw new Error(tr('Something went wrong.'))
    } catch (err) {
      setError(tr('Could not check for updates: {reason}', { reason: errorMessage(err) }))
    } finally {
      checking.current = false
      setCheckingUpdate(false)
    }
  }

  const filteredBots = useMemo(() => {
    if (settingsTab !== 'overview') return []
    const q = searchQuery.trim().toLowerCase()
    return bots.filter((bot) => {
      if (platformFilter !== 'all' && bot.platformId !== platformFilter) return false
      const acc = accounts[bot.activeAccountId]
      const isOnline = acc?.status === 'online' || acc?.status === 'busy' || acc?.status === 'attention'
      if (statusFilter === 'online' && !isOnline) return false
      if (statusFilter === 'offline' && isOnline) return false
      if (!q) return true
      const hay = `${bot.name} ${acc?.displayName ?? ''} ${acc?.handle ?? ''} ${bot.activeAccountId}`.toLowerCase()
      return hay.includes(q)
    })
  }, [settingsTab, bots, accounts, searchQuery, platformFilter, statusFilter])

  const handleReconnectAll = async (onlyOffline = false) => {
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const targets = allAccounts.filter((a) => (onlyOffline ? a.status === 'offline' || a.status === 'error' : true))
      await Promise.all(targets.map((a) => connectAccount(a.id).catch(() => undefined)))
      await refreshDotStoredMeta()
      setHint(`已完成 ${targets.length} 个账号的连接巡检与会话同步`)
    } finally {
      setBusy(false)
    }
  }

  const handleImportPool = async () => {
    const muse = getBridge()?.muse
    if (!muse?.importProxyPool || !rawProxyText.trim()) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const res = await muse.importProxyPool(rawProxyText, defaultMode)
      setRawProxyText('')
      setPool(res.items)
      const assigned = await autoAssignProxyPool()
      if (assigned) setPool(assigned.items)
      setHint(
        `已导入 ${res.added} 个代理（池共 ${res.total} 个）` +
          (assigned ? `，已为勾选平台的 ${assigned.assignedCount} 个账号分配代理` : '；勾选平台的新账号会自动分配')
      )
      await refreshProxiesAndPool()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleAutoAssignAll = async () => {
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const res = await autoAssignProxyPool()
      if (res) setPool(res.items)
      setHint(`已为勾选平台的 ${res?.assignedCount ?? 0} 个账号分配代理`)
      await refreshProxiesAndPool()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleTestPool = async (ids: string[]) => {
    const muse = getBridge()?.muse
    if (!muse?.testProxy) return
    setTestingIds((prev) => new Set([...prev, ...ids]))
    await Promise.all(
      ids.map((poolId) =>
        muse
          .testProxy({ poolId })
          .catch(() => undefined)
          .finally(() => setTestingIds((prev) => new Set([...prev].filter((x) => x !== poolId))))
      )
    )
    setPool(await muse.listProxyPool())
  }

  const handleRemovePoolItem = async (id: string) => {
    const muse = getBridge()?.muse
    if (!muse?.removeProxyPoolItem) return
    const next = await muse.removeProxyPoolItem(id)
    setPool(next)
    await refreshProxiesAndPool()
  }

  const handleClearPool = async () => {
    const muse = getBridge()?.muse
    if (!muse?.clearProxyPool) return
    const next = await muse.clearProxyPool()
    setPool(next)
    setHint('已清空代理池，用过池中代理的账号已改回跟随系统')
    await refreshProxiesAndPool()
  }

  const quickAddProxyAccount = async (
    platformId: 'meta-muse' | 'hark' | 'cue',
    baseName: string,
    index: number
  ) => {
    if (busy) return
    setBusy(true)
    const accountId = createId(platformId === 'cue' ? 'acc_cue' : 'acc')
    const name = platformId === 'cue' && index === 1 ? baseName : `${baseName} ${index}`
    try {
      await autoAssignProxyPool([accountId], [{ id: accountId, platformId }]).catch(() => undefined)
      addBot({
        id: createId('bot'),
        platformId,
        name,
        accounts: [{ key: accountId, accountId, displayName: name, handle: '' }],
        background: true
      })
      return accountId
    } finally {
      setBusy(false)
    }
  }

  const handleQuickAddMuseAccount = async () => {
    const accountId = await quickAddProxyAccount('meta-muse', 'Muse', museBots.length + 1)
    if (!accountId) return
    void refreshProxiesAndPool()
    void openMuseLogin(accountId)
  }

  const handleQuickAddGrokAccount = (openInBrowser = false) => {
    const accountId = createId('acc')
    const botId = createId('bot')
    addBot({
      id: botId,
      platformId: 'grok',
      name: 'Grok Bot',
      accounts: [{ key: accountId, accountId, displayName: 'Grok Bot', handle: '' }],
      background: true
    })
    void openGrokLogin(accountId, openInBrowser)
  }

  const handleImportGrokToken = async () => {
    const token = grokTokenInput.trim()
    const rt = grokRefreshInput.trim() || undefined
    if (!token) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const isNew = grokTargetAccountId === '__new__' || !accounts[grokTargetAccountId]
      const accountId = isNew ? createId('acc') : grokTargetAccountId
      await setGrokAccessToken(accountId, token, undefined, undefined, rt)
      const latestAcc = useBotStore.getState().accounts[accountId]
      if (latestAcc?.status === 'error') {
        setError(latestAcc.statusDetail || '凭据无效或已过期，请检查后重试')
        return
      }
      const totalBots = await syncGrokAccountBots(accountId, {
        includeDismissed: true,
        selectFirst: isNew
      })
      setGrokTokenInput('')
      setGrokRefreshInput('')
      setGrokTargetAccountId('__new__')
      setHint(
        isNew
          ? `已接入 Grok 账号，自动同步 ${totalBots} 个 Bot 到左侧列表`
          : `已更新凭据并同步 ${totalBots} 个 Bot`
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleQuickAddHarkAccount = async () => {
    const accountId = await quickAddProxyAccount('hark', 'Hark', harkBots.length + 1)
    if (accountId) void openHarkLogin(accountId)
  }

  const handleImportHarkCredentials = async () => {
    const hark = getBridge()?.hark
    if (!hark?.importCredentials || !harkRawInput.trim()) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const isNew = harkTargetAccountId === '__new__' || !accounts[harkTargetAccountId]
      const targetId = isNew ? createId('acc_hark') : harkTargetAccountId
      const st = await importHarkCredentialsForAccount(hark, targetId, harkRawInput)
      const label = st.displayName || st.handle || `Hark ${harkBots.length + 1}`
      if (isNew) {
        addBot({
          id: `bot_${targetId}`,
          platformId: 'hark',
          name: `Hark · ${label}`,
          emoji: '✨',
          accounts: [{ key: targetId, accountId: targetId, displayName: label, handle: st.handle ?? '' }],
          background: true
        })
      } else {
        renameAccount(targetId, label)
        await connectAccount(targetId)
      }
      setHarkRawInput('')
      setHarkTargetAccountId('__new__')
      setHint(`已成功导入 Hark 账号：${label} (${st.handle || targetId}) 并同步对话历史`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleQuickAddDotAccount = () => {
    const accountId = createId('acc_dot')
    const botId = createId('bot')
    const index = dotBots.length + 1
    addBot({
      id: botId,
      platformId: 'dot',
      name: `Dot ${index}`,
      emoji: '🪐',
      accounts: [{ key: accountId, accountId, displayName: `Dot ${index}`, handle: '' }],
      background: true
    })
    void openDotLogin(accountId)
  }

  const handleQuickAddCueAccount = async (openInBrowser = false) => {
    const accountId = await quickAddProxyAccount('cue', 'Cue', cueBots.length + 1)
    if (accountId) void openCueLogin(accountId, openInBrowser)
  }

  const handleImportDotCredentials = async () => {
    const dot = getBridge()?.dot
    if (!dot?.importCredentials) return
    const raw = dotRawInput.trim()
    const rt = dotRefreshInput.trim()
    if (!raw && !rt) return
    setBusy(true)
    setError(undefined)
    setHint(undefined)
    try {
      const isNew = dotTargetAccountId === '__new__' || !accounts[dotTargetAccountId]

      // Support batch multi-line AT/RT or JSON array when creating new Dot Bots
      if (isNew && !rt) {
        let batchItems: string[] = []
        if (raw.startsWith('[')) {
          try {
            const arr = JSON.parse(raw) as unknown[]
            if (Array.isArray(arr) && arr.length > 1) {
              batchItems = arr.map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
            }
          } catch {
            /* single payload */
          }
        } else if (!raw.startsWith('{')) {
          const lines = raw
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith('#'))
          if (lines.length > 1) {
            batchItems = lines
          }
        }

        if (batchItems.length > 1) {
          let okCount = 0
          const importedNames: string[] = []
          for (const item of batchItems) {
            try {
              const accId = createId('acc_dot')
              const st = await dot.importCredentials({ accountId: accId, rawInput: item })
              const label = st.handle || st.displayName || accId
              addBot({
                id: `bot_${accId}`,
                platformId: 'dot',
                name: `Dot · ${label}`,
                emoji: '🪐',
                accounts: [{ key: accId, accountId: accId, displayName: label, handle: st.handle ?? label }],
                background: true
              })
              okCount++
              importedNames.push(label)
            } catch {
              /* continue remaining items */
            }
          }
          setDotRawInput('')
          await refreshDotStoredMeta()
          if (okCount === 0) {
            setError('批量导入未成功，请检查每行 AT / RT 或 JSON 格式是否正确')
          } else {
            setHint(`已批量导入 ${okCount} / ${batchItems.length} 个 Dot 账号：${importedNames.join('、')}`)
          }
          return
        }
      }

      const accountId = isNew ? createId('acc_dot') : dotTargetAccountId
      const st = await dot.importCredentials({
        accountId,
        rawInput: raw,
        refreshToken: rt || undefined,
        migrateDataFromAccountId: !isNew && dotMigrateMemory ? accountId : undefined
      })
      const label = st.handle || st.displayName || accountId
      if (isNew) {
        const botId = `bot_${accountId}`
        addBot({
          id: botId,
          platformId: 'dot',
          name: `Dot · ${label}`,
          emoji: '🪐',
          accounts: [
            {
              key: accountId,
              accountId,
              displayName: label,
              handle: st.handle ?? label
            }
          ],
          background: true
        })
      } else {
        renameAccount(accountId, label)
        const ownerBot = botsByAccountId.get(accountId)?.[0]
        if (ownerBot && ownerBot.name.startsWith('Dot')) {
          renameBot(ownerBot.id, `Dot · ${label}`)
        }
        await connectAccount(accountId)
      }
      setDotRawInput('')
      setDotRefreshInput('')
      setDotTargetAccountId('__new__')
      await refreshDotStoredMeta()
      const migratedMsg = st.migration
        ? `（已迁移目标 ${st.migration.goalCopied ? '✓' : '—'}、记忆 ${st.migration.memoriesCopied} 条）`
        : ''
      setHint(
        `已成功导入 Dot 账号：${label}${st.planType ? ` (${st.planType})` : ''} ${migratedMsg}`
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleExportSanitizedConfig = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      version: version || '0.2.8',
      sanitized: true,
      groups,
      bots: bots.map((b) => ({
        id: b.id,
        name: b.name,
        platformId: b.platformId,
        emoji: b.emoji,
        groupId: b.groupId,
        pinned: Boolean(b.pinned)
      })),
      accounts: allAccounts.map((a) => ({
        id: a.id,
        platformId: a.platformId,
        displayName: a.displayName,
        status: a.status
      }))
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `botark-workspace-sanitized-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    setHint('已导出不含任何 Token、Cookie 或密码的脱敏工作区结构文件')
  }

  const handleWipeAllCredentials = async () => {
    if (!confirmWipeCreds) {
      setConfirmWipeCreds(true)
      return
    }
    setConfirmWipeCreds(false)
    await handleCleanup(false)
  }

  const handleFactoryReset = async () => {
    if (!confirmResetAll) {
      setConfirmResetAll(true)
      return
    }
    setConfirmResetAll(false)
    await handleCleanup(true)
  }

  const handleCleanup = async (factoryReset: boolean) => {
    if (cleaning.current) return
    cleaning.current = true
    setBusy(true)
    setHint(undefined)
    setError(undefined)
    proxyRequestId.current++
    dotRequestId.current++
    try {
      await purgeCredentials()
      if (factoryReset) {
        const workspace = useBotStore.getState()
        await workspace.resetWorkspace()
        localStorage.removeItem('bothub-workspace-v1')
        if (localStorage.getItem('bothub-workspace-v1') !== null) {
          throw new Error(tr('Could not remove the saved workspace'))
        }
      }
      setPool([])
      setAccountProxies({})
      setDotMetaMap({})
      setGrokTokenInput('')
      setGrokRefreshInput('')
      setGrokTargetAccountId('__new__')
      setDotRawInput('')
      setDotRefreshInput('')
      setDotTargetAccountId('__new__')
      setHarkRawInput('')
      setHarkTargetAccountId('__new__')
      setCueCredentialInput('')
      setCueTargetAccountId('__new__')
      setRawProxyText('')
      setHint(factoryReset
        ? tr('Workspace, collaboration rooms, and saved credentials cleared')
        : tr('Saved account credentials, browser sessions, proxies, and collaboration rooms cleared'))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      cleaning.current = false
      void refreshProxiesAndPool()
      void refreshDotStoredMeta()
      setBusy(false)
    }
  }

  const NAV: Array<{ id: SettingsTab; label: string; icon: typeof Users; platformId?: PlatformId; count?: number }> = [
    { id: 'overview', label: tr('Overview'), icon: LayoutDashboard, count: bots.length },
    { id: 'muse-accounts', label: 'Meta Muse', icon: Users, platformId: 'meta-muse', count: museAccounts.length },
    { id: 'dot-accounts', label: 'ChatGPT Dot', icon: Users, platformId: 'dot', count: dotAccounts.length },
    { id: 'grok-accounts', label: 'Grok Bot', icon: Users, platformId: 'grok', count: grokAccounts.length },
    { id: 'hark-accounts', label: 'Hark', icon: Users, platformId: 'hark', count: harkAccounts.length },
    { id: 'hermes-accounts', label: 'Hermes', icon: Server, platformId: 'hermes', count: hermesAccounts.length },
    {
      id: 'antigravity-accounts',
      label: 'Antigravity',
      icon: Users,
      platformId: 'antigravity',
      count: antigravityAccounts.length
    },
    {
      id: 'cue-accounts',
      label: 'Cue (Manus)',
      icon: Sparkles,
      platformId: 'cue',
      count: cueAccounts.length
    },
    { id: 'mcp-hub', label: tr('MCP & Workspace'), icon: Server },
    { id: 'mobile-sync', label: tr('Mobile Sync'), icon: Smartphone },
    { id: 'proxy-pool', label: tr('Proxy pool'), icon: Server, count: pool.length },
    { id: 'general', label: tr('General & Security'), icon: Settings }
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-main">
      <PaneHeader className="justify-between px-4">
        <div className="flex items-center gap-2.5">
          <Button size="sm" variant="secondary" onClick={() => setSettingsOpen(false)}>
            <ArrowLeft aria-hidden />
            {tr('Back')}
          </Button>
          <h1 className="text-[15px] font-semibold tracking-tight text-ink">{tr('Settings & Accounts')}</h1>
        </div>
        <div className="flex items-center gap-2">
          {ACC_LIST_TABS.includes(settingsTab) && (
            <SegmentedControl<AccountLayout>
              size="sm"
              aria-label="账号布局"
              value={accLayout}
              onValueChange={setAccLayout}
              options={[
                { value: 'grid', label: '宫格' },
                { value: 'list', label: '列表' }
              ]}
            />
          )}
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || allAccounts.length === 0}
            onClick={() => void handleReconnectAll(false)}
          >
            <Activity className={cn('size-3.5', busy && 'animate-spin')} /> {tr('Check account connections')}
          </Button>
        </div>
      </PaneHeader>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left Settings Sub-navigation */}
        <aside className="flex w-[208px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line px-2.5 py-3">
          {NAV.map((item) => {
            const Icon = item.icon
            const pIcon = platformIcon(item.platformId)
            const active = settingsTab === item.id
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setSettingsOpen(true, item.id)
                  setHint(undefined)
                  setError(undefined)
                  setConfirmWipeCreds(false)
                  setConfirmResetAll(false)
                }}
                className={cn(
                  'press flex h-9 w-full items-center gap-2.5 rounded-xl px-3 text-left text-[13px] font-medium transition-colors',
                  active ? 'bg-active text-ink' : 'text-ink-secondary hover:bg-hover hover:text-ink'
                )}
              >
                {pIcon ? (
                  <img
                    src={pIcon}
                    alt=""
                    aria-hidden
                    draggable={false}
                    className="size-4 shrink-0 rounded-[4px] object-cover ring-1 ring-line"
                  />
                ) : item.id === 'mobile-sync' ? (
                  <ArkMobileLinkSvg className="size-4 shrink-0" />
                ) : (
                  <Icon className="size-4 shrink-0" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.count !== undefined && item.count > 0 && (
                  <span className="rounded-full bg-sunken px-1.5 py-0.2 text-[11px] text-ink-muted tabular-nums">
                    {item.count}
                  </span>
                )}
              </button>
            )
          })}
        </aside>

        {/* Right Content Area */}
        <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6" data-acc-layout={accLayout}>
          <div className={cn('mx-auto', accLayout === 'grid' && ACC_LIST_TABS.includes(settingsTab) ? 'max-w-none' : 'max-w-[820px]')}>
            {error && (
              <div role="alert" className="mb-4 whitespace-pre-line rounded-xl border border-status-error/25 bg-status-error/8 px-3.5 py-2.5 text-[13px] text-status-error">
                {error}
              </div>
            )}
            {hint && (
              <div className="mb-4 rounded-xl border border-accent-600/20 bg-accent-50 px-3.5 py-2.5 text-[13px] text-ink">
                {hint}
              </div>
            )}

            {settingsTab === 'overview' && (
              <div className="flex flex-col gap-4 animate-veil-in">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-[17px] font-semibold tracking-tight text-ink">{tr('Overview')}</h2>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy || allAccounts.length === 0}
                      onClick={() => void handleReconnectAll(true)}
                    >
                      <RefreshCw className="size-3.5" /> 重连离线
                    </Button>
                  </div>
                </div>

                {/* Clean Minimalist KPI Strip */}
                <div className="grid grid-cols-4 gap-3">
                  <div className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-hairline">
                    <p className="text-[11.5px] text-ink-muted">Bot 总数</p>
                    <p className="mt-1 text-[22px] font-semibold tabular-nums text-ink">{bots.length}</p>
                  </div>
                  <div className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-hairline">
                    <p className="text-[11.5px] text-ink-muted">在线账号</p>
                    <p className="mt-1 text-[22px] font-semibold tabular-nums text-status-online-ink">
                      {onlineAccountsCount} <span className="text-[13px] font-normal text-ink-muted">/ {allAccounts.length}</span>
                    </p>
                  </div>
                  <div className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-hairline">
                    <p className="text-[11.5px] text-ink-muted">{tr('Collaboration rooms')}</p>
                    <p className="mt-1 text-[22px] font-semibold tabular-nums text-ink">{roomCount}</p>
                  </div>
                  <div className="rounded-2xl border border-line bg-surface px-4 py-3 shadow-hairline">
                    <p className="text-[11.5px] text-ink-muted">加密代理池</p>
                    <p className="mt-1 text-[22px] font-semibold tabular-nums text-ink">{pool.length}</p>
                  </div>
                </div>

                {/* Platform Breakdown Cards */}
                <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-3">
                  {(
                    [
                      { id: 'meta-muse', tab: 'muse-accounts', name: 'Meta Muse', list: museAccounts, desc: 'Noise WSS' },
                      { id: 'dot', tab: 'dot-accounts', name: 'ChatGPT Dot', list: dotAccounts, desc: 'Calpico Room' },
                      { id: 'grok', tab: 'grok-accounts', name: 'Grok Bot', list: grokAccounts, desc: 'Sand PKCE' },
                      { id: 'hark', tab: 'hark-accounts', name: 'Hark Pro', list: harkAccounts, desc: '项目空间' },
                      { id: 'hermes', tab: 'hermes-accounts', name: 'Hermes', list: hermesAccounts, desc: '本地网关' },
                      {
                        id: 'antigravity',
                        tab: 'antigravity-accounts',
                        name: 'Antigravity',
                        list: antigravityAccounts,
                        desc: 'Google Cloud'
                      },
                      {
                        id: 'cue',
                        tab: 'cue-accounts',
                        name: 'Cue (Manus)',
                        list: cueAccounts,
                        desc: 'Manus API'
                      }
                    ] as const
                  ).map((p) => {
                    const onCount = p.list.filter(
                      (a) => a.status === 'online' || a.status === 'busy' || a.status === 'attention'
                    ).length
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setSettingsOpen(true, p.tab)}
                        className="press flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-3.5 py-3 text-left shadow-hairline transition-colors hover:border-line-strong hover:bg-hover/50"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          {platformIcon(p.id) && (
                            <img
                              src={platformIcon(p.id)}
                              alt=""
                              aria-hidden
                              draggable={false}
                              className="size-7 shrink-0 rounded-lg object-cover ring-1 ring-line"
                            />
                          )}
                          <div className="min-w-0">
                            <span className="block truncate text-[13.5px] font-semibold tracking-tight text-ink">
                              {p.name}
                            </span>
                            <span className="block truncate text-[11px] text-ink-muted">{p.desc}</span>
                          </div>
                        </div>
                        <span className="shrink-0 rounded-full bg-sunken px-2 py-0.5 font-mono text-[11px] font-medium text-ink-secondary tabular-nums">
                          {onCount}/{p.list.length}
                        </span>
                      </button>
                    )
                  })}
                </div>

                {/* Compact 1-Line Multi-Agent Collaboration Card */}
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-surface px-4 py-2.5 shadow-hairline">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-accent-50 text-accent-600">
                      <ArkRelayOrbSvg active className="size-4" />
                    </span>
                    <span className="truncate text-[13.5px] font-medium text-ink">
                      {tr('Multi-agent collaboration')}{roomCount > 0 ? ` · ${tr('{count} rooms', { count: roomCount })}` : ''}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setSettingsOpen(false)
                      selectBot(NEW_ROOM_ID)
                    }}
                  >
                    <Plus className="size-3.5" />
                    {tr('Create collaboration room')}
                  </Button>
                </div>

                {/* Unified Bot & Account Management Table */}
                <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-sunken/40 px-4 py-2.5">
                    <div className="relative min-w-[200px] flex-1">
                      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-muted" />
                      <input
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="搜索 Bot 名称、邮箱 Handle 或账号 ID…"
                        className="h-8 w-full rounded-xl border border-line bg-canvas pr-3 pl-8 text-[12px] text-ink outline-none placeholder:text-ink-muted focus:border-accent-600"
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Select
                        size="sm"
                        variant="pill"
                        value={platformFilter}
                        onValueChange={(next) => setPlatformFilter(next)}
                        className="min-w-36"
                        options={[
                          { value: 'all', label: `全部平台 (${bots.length})` },
                          { value: 'meta-muse', label: `Meta Muse (${museBots.length})` },
                          { value: 'dot', label: `ChatGPT Dot (${dotBots.length})` },
                          { value: 'grok', label: `Grok Bot (${grokBots.length})` },
                          { value: 'hark', label: `Hark Pro (${harkBots.length})` },
                          { value: 'hermes', label: `Hermes (${hermesBots.length})` },
                          { value: 'antigravity', label: `Antigravity (${antigravityBots.length})` }
                        ]}
                      />
                      <Select
                        size="sm"
                        variant="pill"
                        value={statusFilter}
                        onValueChange={(next) => setStatusFilter(next)}
                        className="min-w-28"
                        options={[
                          { value: 'all', label: '全部状态' },
                          { value: 'online', label: '仅在线' },
                          { value: 'offline', label: '仅离线 / 异常' }
                        ]}
                      />
                    </div>
                  </div>

                  {filteredBots.length === 0 ? (
                    <div className="py-12 text-center">
                      <p className="text-[13.5px] font-medium text-ink">
                        {bots.length === 0 ? '当前工作区暂无任何 Bot 账号' : '没有符合筛选条件的 Bot'}
                      </p>
                      <p className="mt-1 text-[12px] text-ink-muted">
                        {bots.length === 0
                          ? '可从左侧平台标签页添加或批量导入账号，所有凭据均使用系统安全存储加密。'
                          : '请尝试清空搜索词或切换平台筛选器。'}
                      </p>
                    </div>
                  ) : (
                    <ul className="goxf-acc-list divide-y divide-line">
                      {filteredBots.map((bot) => {
                        const acc = accounts[bot.activeAccountId]
                        const dotMeta = bot.platformId === 'dot' ? dotMetaMap[bot.activeAccountId] : undefined
                        const isEditing = editingBotId === bot.id
                        return (
                          <li
                            key={bot.id}
                            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-hover/30"
                          >
                            <div className="flex min-w-0 flex-1 items-center gap-3">
                              <BotAvatar
                                seed={bot.id}
                                avatar={bot.avatar}
                                avatarShape={bot.avatarShape}
                                avatarColor={bot.avatarColor}
                                emoji={bot.emoji}
                                platformId={bot.platformId}
                                status={acc?.status ?? 'offline'}
                                size="md"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  {isEditing ? (
                                    <form
                                      className="inline-flex items-center gap-1"
                                      onSubmit={(e) => {
                                        e.preventDefault()
                                        if (editingBotName.trim()) {
                                          renameBot(bot.id, editingBotName.trim())
                                          if (acc) renameAccount(acc.id, editingBotName.trim())
                                        }
                                        setEditingBotId(null)
                                      }}
                                    >
                                      <input
                                        autoFocus
                                        value={editingBotName}
                                        onChange={(e) => setEditingBotName(e.target.value)}
                                        onBlur={() => {
                                          if (editingBotName.trim()) {
                                            renameBot(bot.id, editingBotName.trim())
                                          }
                                          setEditingBotId(null)
                                        }}
                                        className="h-6 rounded border border-accent-600 bg-canvas px-2 text-[13px] font-medium text-ink outline-none"
                                      />
                                    </form>
                                  ) : (
                                    <span className="truncate text-[14px] font-medium text-ink">{bot.name}</span>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setEditingBotId(bot.id)
                                      setEditingBotName(bot.name)
                                    }}
                                    className="rounded p-0.5 text-ink-muted hover:bg-hover hover:text-ink"
                                    title="重命名 Bot"
                                  >
                                    <Pencil className="size-3" />
                                  </button>
                                  <span className="inline-flex items-center gap-1 rounded-md bg-sunken px-1.5 py-0.5 text-[11px] font-medium text-ink-secondary">
                                    {platformIcon(bot.platformId) && (
                                      <img
                                        src={platformIcon(bot.platformId)}
                                        alt=""
                                        aria-hidden
                                        draggable={false}
                                        className="size-3 shrink-0 rounded-[3px] object-cover"
                                      />
                                    )}
                                    {PLATFORM_LABELS[bot.platformId] ?? bot.platformId}
                                  </span>
                                  {acc && <StatusBadge status={acc.status} />}
                                  {dotMeta?.hasRefreshToken && (
                                    <span className="rounded-md bg-status-online/10 px-1.5 py-0.5 text-[10.5px] font-medium text-status-online-ink">
                                      RT 自动续期
                                    </span>
                                  )}
                                </div>
                                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11.5px] text-ink-muted">
                                  <span className="font-mono text-[11px]">
                                    {acc?.handle || dotMeta?.handle || PLATFORM_LABELS[bot.platformId]}
                                  </span>
                                  {dotMeta?.planType && (
                                    <>
                                      <span>·</span>
                                      <span className="uppercase">{dotMeta.planType}</span>
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>

                            <div className="flex shrink-0 items-center gap-1.5">
                              <Select
                                size="xs"
                                variant="pill"
                                value={bot.groupId}
                                onValueChange={(next) => moveBotToGroup(bot.id, next)}
                                title="调整所属分组"
                                className="max-w-32"
                                options={groups.map((g) => ({ value: g.id, label: g.name }))}
                              />
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => {
                                  setSettingsOpen(false)
                                  selectBot(bot.id)
                                }}
                              >
                                对话
                              </Button>
                              <Menu>
                                <MenuTrigger
                                  aria-label={`${bot.name} 更多操作`}
                                  className="press-icon grid size-7 place-items-center rounded-full text-ink-muted hover:bg-hover hover:text-ink"
                                >
                                  <MoreHorizontal className="size-4" />
                                </MenuTrigger>
                                <MenuContent align="end" side="bottom" className="min-w-40">
                                  <MenuItem onSelect={() => togglePinBot(bot.id)}>
                                    {bot.pinned ? <PinOff aria-hidden /> : <Pin aria-hidden />}
                                    {bot.pinned ? '取消置顶' : '置顶侧边栏'}
                                  </MenuItem>
                                  {acc && (
                                    <MenuItem
                                      disabled={acc.pending}
                                      onSelect={() => void connectAccount(acc.id)}
                                    >
                                      <RefreshCw aria-hidden /> 重新连接
                                    </MenuItem>
                                  )}
                                  {acc && (
                                    <MenuItem
                                      disabled={acc.pending}
                                      onSelect={() => void signOutAccount(acc.id)}
                                    >
                                      <LogOut aria-hidden /> 退出登录
                                    </MenuItem>
                                  )}
                                  <MenuSeparator />
                                  <MenuItem danger onSelect={() => void removeBot(bot.id)}>
                                    <Trash2 aria-hidden /> 删除 Bot
                                  </MenuItem>
                                </MenuContent>
                              </Menu>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </div>
              </div>
            )}

            {settingsTab === 'muse-accounts' && (
              <div className="flex flex-col gap-5 animate-veil-in">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-[17px] font-semibold tracking-tight text-ink">Muse 账号</h2>
                    <p className="mt-1 text-[13px] text-ink-secondary">
                      独立隔离多账号会话，支持批量导入与自动分配代理。
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => setBatchOpen(true)}>
                      批量导入账号 (邮箱 | 收件箱)
                    </Button>
                    <Button variant="primary" size="sm" disabled={busy} onClick={() => void handleQuickAddMuseAccount()}>
                      <Plus className="size-3.5" /> 新增 Muse 账号
                    </Button>
                  </div>
                </div>

                {/* Quick Summary Bar */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-2xl border border-line bg-surface p-3.5 shadow-soft">
                    <p className="text-[12px] text-ink-muted">Muse 账号总数</p>
                    <p className="mt-1 text-[22px] font-semibold tabular-nums text-ink">{museAccounts.length}</p>
                  </div>
                  <div className="rounded-2xl border border-line bg-surface p-3.5 shadow-soft">
                    <p className="text-[12px] text-ink-muted">在线就绪</p>
                    <p className="mt-1 text-[22px] font-semibold tabular-nums text-status-online-ink">
                      {museAccounts.filter((a) => a.status === 'online' || a.status === 'busy' || a.status === 'attention').length}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-line bg-surface p-3.5 shadow-soft">
                    <p className="text-[12px] text-ink-muted">已绑定独立代理</p>
                    <p className="mt-1 flex items-baseline justify-between">
                      <span className="text-[22px] font-semibold tabular-nums text-ink">
                        {Object.values(accountProxies).filter((p) => p?.host).length}
                      </span>
                      <button
                        type="button"
                        onClick={() => setSettingsOpen(true, 'proxy-pool')}
                        className="text-[12px] font-medium text-accent-600 hover:underline"
                      >
                        {tr('Configure proxy pool')} →
                      </button>
                    </p>
                  </div>
                </div>

                {/* Accounts List */}
                {museAccounts.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line py-12 text-center">
                    <p className="text-[14px] font-medium text-ink">暂无 Muse 账号</p>
                    <p className="max-w-md text-[12.5px] text-ink-muted">
                      你可以先在「代理池与自动分配」导入一批代理，然后点击「批量导入账号」或「新增 Muse 账号」，系统会自动实现一号一代理。
                    </p>
                    <div className="flex gap-2">
                      <Button variant="secondary" size="sm" onClick={() => setSettingsOpen(true, 'proxy-pool')}>
                        先导入代理池
                      </Button>
                      <Button variant="primary" size="sm" disabled={busy} onClick={() => setBatchOpen(true)}>
                        批量导入 Muse 账号
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
                    <div className="flex items-center justify-between border-b border-line bg-sunken/40 px-4 py-2.5 text-[12px] font-medium text-ink-secondary">
                      <span>账号与对应 Bot</span>
                      <div className="flex items-center gap-2">
                        {pool.length > 0 && (
                          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void handleAutoAssignAll()}>
                            <Shuffle className="size-3.5" /> 一键按代理池重新一对一匹配
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => void refreshProxiesAndPool()}>
                          <RefreshCw className="size-3.5" /> 刷新
                        </Button>
                      </div>
                    </div>
                    <ul className="goxf-acc-list divide-y divide-line">
                      {museAccounts.map((acc) => {
                        const ownerBot = botsByAccountId.get(acc.id)?.[0]
                        const px = accountProxies[acc.id]
                        const hasProxy = px?.host && px.port
                        return (
                          <li key={acc.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-hover/30">
                            <div className="flex min-w-0 items-center gap-3">
                              <BotAvatar
                                seed={ownerBot?.id ?? acc.id}
                                avatar={ownerBot?.avatar}
                                avatarShape={ownerBot?.avatarShape}
                                avatarColor={ownerBot?.avatarColor}
                                status={acc.status}
                                size="md"
                              />
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="truncate text-[14px] font-medium text-ink">
                                    {ownerBot?.name || acc.displayName}
                                  </span>
                                  <StatusBadge status={acc.status} />
                                </div>
                                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-ink-muted">
                                  <span className="font-mono text-[11px]">{acc.handle || acc.id}</span>
                                  <span>·</span>
                                  {hasProxy ? (
                                    <span className="inline-flex items-center gap-1 rounded-md bg-accent-50 px-1.5 py-0.5 font-mono text-[11px] font-medium text-accent-600">
                                      <Globe className="size-3" />
                                      {px.mode}://{px.username ? `${px.username}@` : ''}
                                      {px.host}:{px.port}
                                    </span>
                                  ) : (
                                    <span className="rounded-md bg-sunken px-1.5 py-0.5 text-[11px] text-ink-muted">
                                      {px?.mode === 'direct' ? '真直连' : '跟随系统'}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>

                            <div className="flex shrink-0 items-center gap-1.5">
                              {ownerBot && (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => selectBot(ownerBot.id)}
                                >
                                  进入对话
                                </Button>
                              )}
                              {acc.status === 'offline' ? (
                                <Button
                                  size="sm"
                                  variant="primary"
                                  disabled={acc.pending}
                                  onClick={() => void openMuseLogin(acc.id)}
                                >
                                  登录
                                </Button>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={acc.pending}
                                  onClick={() => void connectAccount(acc.id)}
                                >
                                  重连
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={acc.pending}
                                onClick={() => void signOutAccount(acc.id)}
                                title="退出登录"
                              >
                                <LogOut className="size-3.5" />
                              </Button>
                              {ownerBot && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => void removeBot(ownerBot.id)}
                                  title="删除该账号与 Bot"
                                >
                                  <Trash2 className="size-3.5 text-status-error" />
                                </Button>
                              )}
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {settingsTab === 'dot-accounts' && (
              <div className="flex flex-col gap-5 animate-veil-in">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-[17px] font-semibold tracking-tight text-ink">ChatGPT Dot 账号</h2>
                    <p className="mt-1 text-[13px] text-ink-secondary">
                      支持网页登录或导入凭据，自动加密保存与续期。
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="primary" size="sm" disabled={busy} onClick={handleQuickAddDotAccount}>
                      <Plus className="size-3.5" /> 网页登录新增 Dot 账号
                    </Button>
                  </div>
                </div>

                {/* Quick Summary Bar */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-2xl border border-line bg-surface p-3.5 shadow-soft">
                    <p className="text-[12px] text-ink-muted">Dot 账号总数</p>
                    <p className="mt-1 text-[22px] font-semibold tabular-nums text-ink">{dotAccounts.length}</p>
                  </div>
                  <div className="rounded-2xl border border-line bg-surface p-3.5 shadow-soft">
                    <p className="text-[12px] text-ink-muted">在线就绪</p>
                    <p className="mt-1 text-[22px] font-semibold tabular-nums text-status-online-ink">
                      {dotAccounts.filter((a) => a.status === 'online' || a.status === 'busy' || a.status === 'attention').length}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-line bg-surface p-3.5 shadow-soft">
                    <p className="text-[12px] text-ink-muted">RT 自动续期就绪</p>
                    <p className="mt-1 text-[22px] font-semibold tabular-nums text-ink">
                      {Object.values(dotMetaMap).filter((m) => m.hasRefreshToken).length}
                      <span className="text-[13px] font-normal text-ink-muted"> / {dotAccounts.length}</span>
                    </p>
                  </div>
                </div>

                {/* AT / RT / JSON Single & Batch Import Card */}
                <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
                  <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink">
                      <KeyRound className="size-3.5 text-accent-600" />
                      导入 ChatGPT AT / RT / JSON 凭据（支持多行批量导入）
                    </span>
                    <div className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
                      <span>导入目标：</span>
                      <Select
                        size="xs"
                        variant="pill"
                        value={dotTargetAccountId}
                        onValueChange={(next) => setDotTargetAccountId(next)}
                        className="max-w-64"
                        options={[
                          { value: '__new__', label: '+ 新建独立 Dot Bot（支持多行批量导入）' },
                          ...dotAccounts.map((acc) => {
                            const ownerBot = botsByAccountId.get(acc.id)?.[0]
                            return {
                              value: acc.id,
                              label: `替换凭据：${ownerBot?.name || acc.displayName} (${acc.handle || acc.id})`
                            }
                          })
                        ]}
                      />
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <textarea
                      ref={dotInputRef}
                      value={dotRawInput}
                      onChange={(e) => setDotRawInput(e.target.value)}
                      placeholder="粘贴单条或多行（每行一个）ChatGPT access_token (eyJ...)、refresh_token (rt_...) 或 JSON (auth.json / JSON 数组)…"
                      rows={3}
                      spellCheck={false}
                      className="block w-full resize-none rounded-xl border border-line bg-canvas p-2.5 font-mono text-[12px] leading-5 text-ink outline-none placeholder:text-ink-muted focus:border-accent-600"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        value={dotRefreshInput}
                        onChange={(e) => setDotRefreshInput(e.target.value)}
                        placeholder="可选：单账号导入时单独填写 refresh_token (rt_...) 用于自动续期"
                        className="h-8 min-w-0 flex-1 rounded-xl border border-line bg-canvas px-3 font-mono text-[12px] text-ink outline-none placeholder:text-ink-muted focus:border-accent-600"
                      />
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busy || (!dotRawInput.trim() && !dotRefreshInput.trim())}
                        onClick={() => void handleImportDotCredentials()}
                      >
                        {busy
                          ? '正在验证…'
                          : dotTargetAccountId === '__new__'
                            ? '导入并创建 Dot Bot'
                            : '更新该 Bot 凭据'}
                      </Button>
                    </div>
                    {dotTargetAccountId !== '__new__' && (
                      <div className="mt-0.5 flex items-center justify-between gap-3 rounded-xl bg-main px-3 py-2 ring-1 ring-line/50 text-[12px] text-ink-secondary">
                        <span>替换账号时自动迁移当前目标与记忆</span>
                        <SwitchPill checked={dotMigrateMemory} onCheckedChange={setDotMigrateMemory} />
                      </div>
                    )}
                  </div>
                </div>

                {/* Dot Accounts List */}
                {dotAccounts.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line py-10 text-center">
                    <p className="text-[14px] font-medium text-ink">暂无 Dot 账号</p>
                    <p className="max-w-md text-[12.5px] text-ink-muted">
                      点击上方「网页登录新增 Dot 账号」或在上方卡片中粘贴 ChatGPT AT / RT 凭据即可创建 Dot Bot。
                    </p>
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
                    <div className="flex items-center justify-between border-b border-line bg-sunken/40 px-4 py-2.5 text-[12px] font-medium text-ink-secondary">
                      <span>Dot 账号与对应 Bot ({dotAccounts.length})</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          for (const acc of dotAccounts) {
                            void connectAccount(acc.id)
                          }
                          void refreshDotStoredMeta()
                        }}
                      >
                        <RefreshCw className="size-3.5" /> 全部重连检验
                      </Button>
                    </div>
                    <ul className="goxf-acc-list divide-y divide-line">
                      {dotAccounts.map((acc) => {
                        const ownerBot = botsByAccountId.get(acc.id)?.[0]
                        const meta = dotMetaMap[acc.id]
                        return (
                          <li key={acc.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-hover/30">
                            <div className="flex min-w-0 items-center gap-3">
                              <BotAvatar
                                seed={ownerBot?.id ?? acc.id}
                                avatar={ownerBot?.avatar}
                                avatarShape={ownerBot?.avatarShape}
                                avatarColor={ownerBot?.avatarColor}
                                emoji={ownerBot?.emoji ?? '🪐'}
                                platformId="dot"
                                status={acc.status}
                                size="md"
                              />
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="truncate text-[14px] font-medium text-ink">
                                    {ownerBot?.name || acc.displayName}
                                  </span>
                                  <StatusBadge status={acc.status} />
                                  {meta?.planType && (
                                    <span className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[10.5px] uppercase text-ink-secondary">
                                      {meta.planType}
                                    </span>
                                  )}
                                  {meta?.hasRefreshToken ? (
                                    <span className="rounded bg-status-online/10 px-1.5 py-0.5 text-[10.5px] font-medium text-status-online-ink">
                                      RT 自动续期已开启
                                    </span>
                                  ) : (
                                    <span className="rounded bg-sunken px-1.5 py-0.5 text-[10.5px] text-ink-muted">
                                      仅 AT 会话
                                    </span>
                                  )}
                                </div>
                                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-ink-muted">
                                  <span className="font-mono text-[11px]">{acc.handle || meta?.handle || acc.id}</span>
                                  {meta?.mode && (
                                    <>
                                      <span>·</span>
                                      <span>{meta.mode === 'native' ? `Native (${meta.model || 'gpt-6-astra'})` : 'Calpico Room'}</span>
                                    </>
                                  )}
                                  {acc.statusDetail && (
                                    <>
                                      <span>·</span>
                                      <span className="rounded-md bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-ink-secondary">
                                        {acc.statusDetail}
                                      </span>
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                              {ownerBot && (
                                <Button size="sm" variant="secondary" onClick={() => selectBot(ownerBot.id)}>
                                  进入对话
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="primary"
                                disabled={acc.pending}
                                onClick={() => void openDotLogin(acc.id)}
                              >
                                网页登录
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                  setDotTargetAccountId(acc.id)
                                  dotInputRef.current?.focus()
                                }}
                              >
                                替换 AT/RT
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={acc.pending}
                                onClick={() => void connectAccount(acc.id)}
                              >
                                重连
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={acc.pending}
                                onClick={() => void signOutAccount(acc.id)}
                                title="退出登录"
                              >
                                <LogOut className="size-3.5" />
                              </Button>
                              {ownerBot && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => void removeBot(ownerBot.id)}
                                  title="删除该账号与 Bot"
                                >
                                  <Trash2 className="size-3.5 text-status-error" />
                                </Button>
                              )}
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {settingsTab === 'grok-accounts' && (
              <div className="flex flex-col gap-5 animate-veil-in">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-[17px] font-semibold tracking-tight text-ink">Grok Bot 账号管理</h2>
                    <p className="mt-1 text-[13px] text-ink-secondary">
                      一个 Grok 账号下可包含多个 Bot，登录后会自动按 Bot 展开在左侧对话列表中。
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="primary" size="sm" disabled={busy} onClick={() => handleQuickAddGrokAccount(false)}>
                      <Plus className="size-3.5" /> 登录窗口添加账号
                    </Button>
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => handleQuickAddGrokAccount(true)}>
                      <Globe className="size-3.5" /> 默认浏览器授权
                    </Button>
                  </div>
                </div>

                {/* Credential Import Card */}
                <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-ink">粘贴凭据导入（Token / Cookie / JSON / API Key）</span>
                    <Select
                      size="xs"
                      variant="pill"
                      value={grokTargetAccountId}
                      onValueChange={(next) => setGrokTargetAccountId(next)}
                      className="max-w-64"
                      options={[
                        { value: '__new__', label: '+ 接入新 Grok 账号（自动同步全部 Bot）' },
                        ...grokAccounts.map((acc) => ({
                          value: acc.id,
                          label: `更新凭据：${acc.handle || acc.displayName || acc.id}`
                        }))
                      ]}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <textarea
                      value={grokTokenInput}
                      onChange={(e) => setGrokTokenInput(e.target.value)}
                      placeholder="粘贴 Access Token (eyJ...)、Cookie (WorkosCursorSessionToken=...)、JSON 或 API Key…"
                      rows={2}
                      spellCheck={false}
                      className="block w-full resize-none rounded-xl border border-line bg-canvas p-2.5 font-mono text-[12px] leading-5 text-ink outline-none placeholder:text-ink-muted focus:border-accent-600"
                    />
                    <div className="flex gap-2">
                      <input
                        value={grokRefreshInput}
                        onChange={(e) => setGrokRefreshInput(e.target.value)}
                        placeholder="可选：填写 Refresh Token 用于自动续期"
                        className="h-8 min-w-0 flex-1 rounded-xl border border-line bg-canvas px-3 font-mono text-[12px] text-ink outline-none focus:border-accent-600"
                      />
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busy || !grokTokenInput.trim()}
                        onClick={() => void handleImportGrokToken()}
                      >
                        {busy ? '验证中…' : grokTargetAccountId === '__new__' ? '导入并同步 Bot' : '更新凭据'}
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Grok Accounts List */}
                {grokAccounts.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line py-10 text-center">
                    <p className="text-[14px] font-medium text-ink">暂无 Grok Bot 账号</p>
                    <p className="max-w-md text-[12.5px] text-ink-muted">
                      点击上方「登录窗口添加账号」或粘贴凭据，即可将账号下的全部 Bot 同步到左侧列表。
                    </p>
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
                    <ul className="goxf-acc-list divide-y divide-line">
                      {grokAccounts.map((acc) => {
                        const accountBots = (botsByAccountId.get(acc.id) ?? []).filter((b) => b.platformId === 'grok')
                        const ownerBot = accountBots[0]
                        return (
                          <li key={acc.id} className="flex flex-col gap-2.5 px-4 py-3.5 hover:bg-hover/30">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div className="flex min-w-0 items-center gap-3">
                                <BotAvatar
                                  seed={ownerBot?.id ?? acc.id}
                                  avatar={ownerBot?.avatar}
                                  avatarShape={ownerBot?.avatarShape}
                                  avatarColor={ownerBot?.avatarColor}
                                  platformId="grok"
                                  status={acc.status}
                                  size="md"
                                />
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="truncate text-[14px] font-medium text-ink">
                                      {acc.handle || acc.displayName || 'Grok Bot 账号'}
                                    </span>
                                    <StatusBadge status={acc.status} />
                                    <span className="rounded-md bg-sunken px-1.5 py-0.5 text-[11px] text-ink-secondary">
                                      {accountBots.length} 个 Bot
                                    </span>
                                  </div>
                                  {acc.statusDetail && (
                                    <p className="mt-0.5 truncate text-[11.5px] text-ink-muted">
                                      {acc.statusDetail}
                                    </p>
                                  )}
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-1.5">
                                <Button
                                  size="sm"
                                  variant="primary"
                                  disabled={acc.pending}
                                  onClick={() => void openGrokLogin(acc.id, false)}
                                >
                                  登录窗口
                                </Button>
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={acc.pending}
                                  onClick={() => void openGrokLogin(acc.id, true)}
                                >
                                  浏览器授权
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={acc.pending || busy}
                                  onClick={() => {
                                    void connectAccount(acc.id).then(() =>
                                      syncGrokAccountBots(acc.id, { includeDismissed: true })
                                    )
                                  }}
                                >
                                  同步全部 Bot
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={acc.pending}
                                  onClick={() => void signOutAccount(acc.id)}
                                  title="退出登录"
                                >
                                  <LogOut className="size-3.5" />
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={async () => {
                                    for (const b of accountBots) {
                                      await removeBot(b.id)
                                    }
                                  }}
                                  title="移除该账号及名下全部 Bot"
                                >
                                  <Trash2 className="size-3.5 text-status-error" />
                                </Button>
                              </div>
                            </div>

                            {accountBots.length > 0 && (
                              <div className="flex flex-wrap items-center gap-1.5 pl-12">
                                {accountBots.map((b) => (
                                  <button
                                    key={b.id}
                                    type="button"
                                    onClick={() => selectBot(b.id)}
                                    className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-canvas px-2.5 py-1 text-[12px] text-ink transition-colors hover:border-line-strong hover:bg-hover"
                                  >
                                    <BotAvatar
                                      seed={b.id}
                                      avatar={b.avatar}
                                      avatarShape={b.avatarShape}
                                      avatarColor={b.avatarColor}
                                      platformId="grok"
                                      size="xs"
                                    />
                                    <span className="max-w-[160px] truncate">{b.name}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {settingsTab === 'hark-accounts' && (
              <div className="flex flex-col gap-5 animate-veil-in">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-[17px] font-semibold tracking-tight text-ink">Hark 账号</h2>
                    <p className="mt-1 text-[13px] text-ink-secondary">
                      支持内置窗口登录或直接粘贴会话凭据接入。
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="primary" size="sm" disabled={busy} onClick={() => void handleQuickAddHarkAccount()}>
                      <Plus className="size-3.5" /> 网页登录新增 Hark 账号
                    </Button>
                  </div>
                </div>

                {/* Hark Cookie / Token Import Card */}
                <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-ink">导入 Hark Session Cookie / Token</span>
                    <Select
                      size="xs"
                      variant="pill"
                      value={harkTargetAccountId}
                      onValueChange={(next) => setHarkTargetAccountId(next)}
                      className="max-w-64"
                      options={[
                        { value: '__new__', label: '+ 新建独立 Hark Bot' },
                        ...harkAccounts.map((acc) => {
                          const ownerBot = botsByAccountId.get(acc.id)?.[0]
                          return {
                            value: acc.id,
                            label: `更新会话：${ownerBot?.name || acc.displayName} (${acc.handle || acc.id})`
                          }
                        })
                      ]}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <textarea
                      value={harkRawInput}
                      onChange={(e) => setHarkRawInput(e.target.value)}
                      placeholder="粘贴 Hark Cookie 字符串（如 __Secure-hark.session_token=...）、JSON Cookie 数组或原始 Session Token…"
                      rows={2}
                      spellCheck={false}
                      className="block w-full resize-none rounded-xl border border-line bg-canvas p-2.5 font-mono text-[12px] leading-5 text-ink outline-none placeholder:text-ink-muted focus:border-accent-600"
                    />
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busy || !harkRawInput.trim()}
                        onClick={() => void handleImportHarkCredentials()}
                      >
                        {busy
                          ? '正在验证会话…'
                          : harkTargetAccountId === '__new__'
                            ? '导入并新建 Hark Bot'
                            : '更新该账号会话'}
                      </Button>
                    </div>
                  </div>
                </div>

                {harkAccounts.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line py-10 text-center">
                    <p className="text-[14px] font-medium text-ink">暂无 Hark 账号</p>
                    <p className="max-w-md text-[12.5px] text-ink-muted">
                      点击上方「网页登录新增 Hark 账号」或在卡片中粘贴 Cookie / Session Token 即可接入。
                    </p>
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
                    <ul className="goxf-acc-list divide-y divide-line">
                      {harkAccounts.map((acc) => {
                        const ownerBot = botsByAccountId.get(acc.id)?.[0]
                        return (
                          <li key={acc.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-hover/30">
                            <div className="flex min-w-0 items-center gap-3">
                              <BotAvatar
                                seed={ownerBot?.id ?? acc.id}
                                avatar={ownerBot?.avatar}
                                avatarShape={ownerBot?.avatarShape}
                                avatarColor={ownerBot?.avatarColor}
                                status={acc.status}
                                size="md"
                              />
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="truncate text-[14px] font-medium text-ink">
                                    {ownerBot?.name || acc.displayName}
                                  </span>
                                  <StatusBadge status={acc.status} />
                                </div>
                                <p className="mt-0.5 truncate font-mono text-[11px] text-ink-muted">
                                  {acc.handle || acc.id}
                                </p>
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                              {ownerBot && (
                                <Button size="sm" variant="secondary" onClick={() => selectBot(ownerBot.id)}>
                                  进入对话
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="primary"
                                disabled={acc.pending}
                                onClick={() => void openHarkLogin(acc.id)}
                              >
                                登录窗口
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={acc.pending}
                                onClick={() => void connectAccount(acc.id)}
                              >
                                刷新会话
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={acc.pending}
                                onClick={() => void signOutAccount(acc.id)}
                                title="退出登录"
                              >
                                <LogOut className="size-3.5" />
                              </Button>
                              {ownerBot && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => void removeBot(ownerBot.id)}
                                  title="删除"
                                >
                                  <Trash2 className="size-3.5 text-status-error" />
                                </Button>
                              )}
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {settingsTab === 'hermes-accounts' && <HermesAccountsSettingsPanel />}

            {settingsTab === 'antigravity-accounts' && (
              <div className="flex flex-col gap-5 animate-veil-in">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-[17px] font-semibold tracking-tight text-ink">
                      Antigravity 账号
                    </h2>
                    <p className="mt-1 text-[13px] text-ink-secondary">
                      独立隔离登录 Google Antigravity，支持多账号、模型切换与流式对话。
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => useBotStore.getState().setAddBotOpen(true, 'antigravity')}
                  >
                    添加 Antigravity 账号
                  </Button>
                </div>

                {antigravityAccounts.length === 0 ? (
                  <div className="rounded-2xl border border-line bg-surface p-8 text-center">
                    <p className="text-[13.5px] font-medium text-ink">尚未添加 Google Antigravity 账号</p>
                    <p className="mt-1 text-[12px] text-ink-muted">
                      点击右上角「添加 Antigravity 账号」，在弹出的安全登录窗口完成 Google 登录即可。
                    </p>
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
                    <ul className="goxf-acc-list divide-y divide-line">
                      {antigravityAccounts.map((acc) => {
                        const bot = botsByAccountId.get(acc.id)?.find((b) => b.platformId === 'antigravity')
                        const online =
                          acc.status === 'online' || acc.status === 'busy' || acc.status === 'attention'
                        return (
                          <li
                            key={acc.id}
                            className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="truncate text-[13.5px] font-medium text-ink">
                                  {bot?.name || acc.displayName}
                                </span>
                                <span
                                  className={cn(
                                    'rounded-full px-2 py-0.5 text-[11px] font-medium',
                                    online
                                      ? 'bg-status-online/15 text-status-online-ink'
                                      : 'bg-sunken text-ink-muted'
                                  )}
                                >
                                  {online ? '在线' : '离线'}
                                </span>
                              </div>
                              <div className="mt-0.5 truncate font-mono text-[11.5px] text-ink-muted">
                                {acc.handle || acc.id}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => void useBotStore.getState().openAntigravityLogin(acc.id)}
                              >
                                {online ? '重新登录' : '登录'}
                              </Button>
                              {bot && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => {
                                    useBotStore.getState().selectBot(bot.id)
                                    setSettingsOpen(false)
                                  }}
                                >
                                  打开对话
                                </Button>
                              )}
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {settingsTab === 'mobile-sync' && <MobileSyncSettingsPanel />}

            {settingsTab === 'proxy-pool' && (
              <div className="flex flex-col gap-5 animate-veil-in">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-[17px] font-semibold tracking-tight text-ink">{tr('Proxy pool')}</h2>
                    <p className="mt-1 text-[13px] text-ink-secondary">
                      批量导入代理，按勾选的平台和每个代理的账号上限自动分配；密码用系统钥匙串加密。
                    </p>
                  </div>
                  {pool.length > 0 && (
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => void handleAutoAssignAll()}>
                      <Shuffle className="size-3.5" /> 按设置分配给现有账号
                    </Button>
                  )}
                </div>

                <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-[13px] font-medium text-ink">导入代理</span>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5 text-[12px] text-ink-secondary">
                        <span>无协议前缀时默认：</span>
                        <Select
                          size="xs"
                          variant="pill"
                          value={defaultMode}
                          onValueChange={(next) => setDefaultMode(next)}
                          className="w-40"
                          options={[
                            { value: 'socks5', label: 'SOCKS5' },
                            { value: 'socks5h', label: 'SOCKS5H (远程 DNS)' },
                            { value: 'http', label: 'HTTP' },
                            { value: 'https', label: 'HTTPS (TLS)' }
                          ]}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => fileRef.current?.click()}
                        className="inline-flex h-7 items-center gap-1 rounded-lg border border-line bg-canvas px-2.5 text-[12px] text-ink-secondary hover:bg-hover hover:text-ink"
                      >
                        <FileUp className="size-3.5" /> 从 .txt 导入
                      </button>
                      <input
                        ref={fileRef}
                        type="file"
                        accept=".txt,text/plain"
                        hidden
                        onChange={(ev) => {
                          const file = ev.target.files?.[0]
                          ev.target.value = ''
                          if (file) {
                            void file.text().then((txt) =>
                              setRawProxyText((prev) => (prev.trim() ? `${prev.trimEnd()}\n${txt}` : txt))
                            )
                          }
                        }}
                      />
                    </div>
                  </div>
                  <textarea
                    value={rawProxyText}
                    onChange={(e) => setRawProxyText(e.target.value)}
                    placeholder={PROXY_PLACEHOLDER}
                    rows={5}
                    spellCheck={false}
                    className="block w-full resize-none rounded-xl border border-line bg-canvas p-3 font-mono text-[12px] leading-5 text-ink outline-none placeholder:text-ink-muted focus:border-accent-600"
                  />

                  <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[12.5px]">
                    <span className="mr-1 text-ink-secondary">分配给</span>
                    {accountPlatformIds.length === 0 && <span className="text-ink-muted">还没有账号</span>}
                    {accountPlatformIds.map((pid) => {
                      const on = proxyAssignPlatforms.includes(pid)
                      return (
                        <button
                          key={pid}
                          type="button"
                          aria-pressed={on}
                          onClick={() =>
                            setProxyAssignPlatforms(
                              on ? proxyAssignPlatforms.filter((x) => x !== pid) : [...proxyAssignPlatforms, pid]
                            )
                          }
                          className={cn(
                            'press h-7 rounded-full border px-3 text-[12px] transition-colors',
                            on
                              ? 'border-accent-300 bg-accent-50 text-accent-600'
                              : 'border-line text-ink-secondary hover:bg-hover hover:text-ink'
                          )}
                        >
                          {getPlatform(pid).name}
                        </button>
                      )
                    })}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2 text-[12.5px] text-ink-secondary">
                      <span>每个代理最多</span>
                      <NumberStepper
                        value={proxyPerProxyLimit}
                        onChange={setProxyPerProxyLimit}
                        min={0}
                        max={99}
                        aria-label="每个代理最多账号数"
                      />
                      <span className="text-ink-muted">
                        {proxyPerProxyLimit === 0 ? '0 = 不限，平均分摊' : '个账号 · 1 就是一号一代理'}
                      </span>
                    </div>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy || !rawProxyText.trim()}
                      onClick={() => void handleImportPool()}
                    >
                      导入并分配
                    </Button>
                  </div>
                </div>

                <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
                  <div className="grid grid-cols-[minmax(0,1.3fr)_64px_minmax(0,2fr)_88px_72px] items-center gap-3 border-b border-line bg-sunken/40 px-4 py-2.5 text-[12px] font-medium text-ink-secondary">
                    <span>代理 ({pool.length})</span>
                    <span>协议</span>
                    <span>账号</span>
                    <span>连通</span>
                    <span />
                  </div>
                  {pool.length === 0 ? (
                    <p className="py-8 text-center text-[13px] text-ink-muted">代理池为空，请在上方粘贴导入代理</p>
                  ) : (
                    <ul className="divide-y divide-line">
                      {pool.map((item) => {
                        const test = item.lastTest
                        const n = item.assignedAccountIds.length
                        return (
                          <li
                            key={item.id}
                            className="group grid grid-cols-[minmax(0,1.3fr)_64px_minmax(0,2fr)_88px_72px] items-center gap-3 px-4 py-2.5 text-[13px]"
                          >
                            <span className="truncate font-mono text-[12.5px] text-ink" title={item.username ? `${item.username}@${item.host}:${item.port}` : undefined}>
                              {item.host}:{item.port}
                            </span>
                            <span className="text-[11.5px] uppercase text-ink-secondary">{item.mode}</span>
                            <span className="flex min-w-0 flex-wrap items-center gap-1">
                              {item.assignedAccountIds.map((accId) => (
                                <span key={accId} className="max-w-[120px] truncate rounded-full bg-hover px-2 py-0.5 text-[11.5px] text-ink-secondary">
                                  {accountLabel(accId)}
                                </span>
                              ))}
                              <span className="text-[11.5px] text-ink-muted tabular-nums">
                                {n === 0 ? '未分配 ' : ''}
                                {proxyPerProxyLimit > 0 ? `${n}/${proxyPerProxyLimit}` : n || ''}
                              </span>
                            </span>
                            <span className="flex items-center gap-1.5 text-[12px] text-ink-secondary tabular-nums">
                              {testingIds.has(item.id) ? (
                                <span className="text-ink-muted">测速中…</span>
                              ) : test ? (
                                <>
                                  <span className={cn('size-2 rounded-full', test.ok ? 'bg-status-online' : 'bg-status-error')} />
                                  {test.ok ? `${test.ms} ms` : test.error || '失败'}
                                </>
                              ) : (
                                <span className="text-ink-muted">—</span>
                              )}
                            </span>
                            <span className="flex items-center justify-end gap-1">
                              <Button size="sm" variant="ghost" disabled={testingIds.has(item.id)} onClick={() => void handleTestPool([item.id])}>
                                测速
                              </Button>
                              <button
                                type="button"
                                onClick={() => void handleRemovePoolItem(item.id)}
                                className="rounded p-1 text-ink-muted opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-status-error focus-visible:opacity-100"
                                title="移除代理（用它的账号改回跟随系统）"
                                aria-label="移除代理"
                              >
                                <Trash2 className="size-3.5" />
                              </button>
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                  {pool.length > 0 && (
                    <div className="flex items-center justify-between border-t border-line px-4 py-2.5">
                      <Button size="sm" variant="secondary" disabled={testingIds.size > 0} onClick={() => void handleTestPool(pool.map((p) => p.id))}>
                        全部测速
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void handleClearPool()}>
                        清空代理池
                      </Button>
                    </div>
                  )}
                </div>
                <p className="text-[12px] text-ink-muted">
                  超时的代理不参与自动分配；勾选的平台会记住，之后新加的账号自动分配。手动在账号侧栏「网络代理」里选的代理不受上限限制。
                </p>
              </div>
            )}

            {settingsTab === 'general' && (
              <div className="flex flex-col gap-5 animate-veil-in">
                <div>
                  <h2 className="text-[17px] font-semibold tracking-tight text-ink">{tr('General & Security')}</h2>
                  <p className="mt-1 text-[13px] text-ink-secondary">
                    {tr('Adjust the appearance, manage sidebar groups, and clear local credentials.')}
                  </p>
                </div>

                {/* Appearance & Version */}
                <div className="divide-y divide-line rounded-2xl border border-line bg-surface shadow-soft">
                  <div className="flex items-center justify-between px-4 py-3.5">
                    <div>
                      <p className="text-[14px] font-medium text-ink">{tr('Appearance')}</p>
                      <p className="text-[12px] text-ink-muted">{tr('Grok Bot Sand Light and Sand Dark themes')}</p>
                    </div>
                    <SegmentedControl<ThemePref>
                      size="sm"
                      value={theme}
                      onValueChange={(id) => setTheme(id)}
                      options={[
                        { value: 'system', label: tr('Match system') },
                        { value: 'light', label: tr('Light') },
                        { value: 'dark', label: tr('Dark') }
                      ]}
                    />
                  </div>

                  <div className="flex items-center justify-between px-4 py-3.5">
                    <div>
                      <p className="text-[14px] font-medium text-ink">{tr('Language')}</p>
                      <p className="text-[12px] text-ink-muted">{tr('Choose the display language')}</p>
                    </div>
                    <SegmentedControl<Locale>
                      size="sm"
                      value={locale}
                      onValueChange={(id) => {
                        if (id === locale) return
                        setLocale(id)
                        window.location.reload()
                      }}
                      options={[
                        { value: 'zh', label: '简体中文' },
                        { value: 'en', label: 'English' }
                      ]}
                    />
                  </div>

                  <div className="flex items-center justify-between px-4 py-3.5">
                    <div>
                      <p className="text-[14px] font-medium text-ink">启动时打开</p>
                      <p className="text-[12px] text-ink-muted">打开 BotArk 时先看哪一页</p>
                    </div>
                    <StartViewPicker />
                  </div>

                  <div className="flex items-center justify-between px-4 py-3.5">
                    <div>
                      <p className="text-[14px] font-medium text-ink">{tr('Current version')}</p>
                      <p className="font-mono text-[12px] text-ink-muted">BotArk {version || '0.11.1'}</p>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={checkingUpdate}
                      onClick={() => void handleCheckForUpdates()}
                    >
                      <RefreshCw className={cn('size-3.5', checkingUpdate && 'animate-spin')} />
                      {tr('Check for updates')}
                    </Button>
                  </div>
                  <GoxfChannelRow />

                  <div className="flex items-center justify-between px-4 py-3.5">
                    <div>
                      <p className="text-[14px] font-medium text-ink">{tr('BotArk guide')}</p>
                      <p className="text-[12px] text-ink-muted">
                        {tr('Learn how BotArk connects accounts, runs collaboration rooms, and uses MCP tools.')}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setOnboardingOpen(true)}
                    >
                      <Sparkles className="size-3.5 text-accent-600" />
                      {tr('Open the onboarding guide')}
                    </Button>
                  </div>
                </div>

                {/* Sidebar Section / Group Management */}
                <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
                  <div className="flex items-center justify-between border-b border-line bg-sunken/40 px-4 py-2.5">
                    <span className="text-[13px] font-medium text-ink">侧边栏分组管理 ({groups.length})</span>
                    <form
                      className="flex items-center gap-1.5"
                      onSubmit={(e) => {
                        e.preventDefault()
                        if (!newGroupName.trim()) return
                        addGroup(newGroupName.trim())
                        setNewGroupName('')
                      }}
                    >
                      <input
                        value={newGroupName}
                        onChange={(e) => setNewGroupName(e.target.value)}
                        placeholder="新建分组名称…"
                        className="h-7 rounded-lg border border-line bg-canvas px-2.5 text-[12px] text-ink outline-none focus:border-accent-600"
                      />
                      <Button size="sm" variant="secondary" type="submit" disabled={!newGroupName.trim()}>
                        <FolderPlus className="size-3.5" /> 新建分组
                      </Button>
                    </form>
                  </div>
                  <ul className="divide-y divide-line">
                    {groups.map((g) => {
                      const count = bots.filter((b) => b.groupId === g.id).length
                      const isEditing = editingGroupId === g.id
                      return (
                        <li key={g.id} className="flex items-center justify-between px-4 py-2.5 text-[13px]">
                          <div className="flex items-center gap-2">
                            {isEditing ? (
                              <input
                                autoFocus
                                value={editingGroupName}
                                onChange={(e) => setEditingGroupName(e.target.value)}
                                onBlur={() => {
                                  if (editingGroupName.trim()) renameGroup(g.id, editingGroupName.trim())
                                  setEditingGroupId(null)
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    if (editingGroupName.trim()) renameGroup(g.id, editingGroupName.trim())
                                    setEditingGroupId(null)
                                  }
                                }}
                                className="h-7 rounded border border-accent-600 bg-canvas px-2 text-[13px] text-ink outline-none"
                              />
                            ) : (
                              <span className="font-medium text-ink">{g.name}</span>
                            )}
                            <span className="rounded-full bg-sunken px-2 py-0.5 text-[11px] text-ink-muted">
                              {count} 个 Bot
                            </span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setEditingGroupId(g.id)
                                setEditingGroupName(g.name)
                              }}
                            >
                              重命名
                            </Button>
                            {groups.length > 1 && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => removeGroup(g.id)}
                                title="删除分组（组内 Bot 自动移至默认分组）"
                              >
                                <Trash2 className="size-3.5 text-status-error" />
                              </Button>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </div>

                {/* Live OS Keychain & Security Vault Audit */}
                <SecurityVaultCenter />

                {/* Security & Sanitization Center */}
                <div className="overflow-hidden rounded-2xl border border-status-error/25 bg-surface shadow-soft">
                  <div className="border-b border-line bg-status-error/5 px-4 py-3">
                    <div className="flex items-center gap-2">
                      <ShieldAlert className="size-4 text-status-error" />
                      <h3 className="text-[14px] font-semibold text-ink">{tr('Credential security')}</h3>
                    </div>
                    <p className="mt-1 text-[12px] text-ink-secondary">
                      {tr('BotArk encrypts OAuth tokens, refresh tokens, and proxy passwords using system secure storage.')}
                    </p>
                  </div>
                  <div className="divide-y divide-line">
                    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
                      <div>
                        <p className="text-[13.5px] font-medium text-ink">{tr('Export sanitized workspace metadata')}</p>
                        <p className="text-[12px] text-ink-muted">
                          {tr('The export contains group, bot, and account metadata.')}
                        </p>
                      </div>
                      <Button size="sm" variant="secondary" onClick={handleExportSanitizedConfig}>
                        <Download className="size-3.5" /> {tr('Export sanitized JSON')}
                      </Button>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
                      <div>
                        <p className="text-[13.5px] font-medium text-ink">{tr('Clear saved credentials')}</p>
                        <p className="text-[12px] text-ink-muted">
                          {tr('Sign out of all accounts and clear saved credentials, browser sessions, proxies, and collaboration rooms.')}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant={confirmWipeCreds ? 'primary' : 'secondary'}
                        disabled={busy}
                        onClick={() => void handleWipeAllCredentials()}
                        className={cn(confirmWipeCreds && 'bg-status-error text-white hover:bg-status-error/90')}
                      >
                        <Trash2 className="size-3.5" />
                        {tr(confirmWipeCreds ? 'Confirm credential cleanup' : 'Clear saved credentials')}
                      </Button>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
                      <div>
                        <p className="text-[13.5px] font-medium text-ink">{tr('Factory reset')}</p>
                        <p className="text-[12px] text-ink-muted">
                          {tr('Delete local bots, accounts, chat history, collaboration rooms, and saved credentials.')}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant={confirmResetAll ? 'primary' : 'secondary'}
                        disabled={busy}
                        onClick={() => void handleFactoryReset()}
                        className={cn(confirmResetAll && 'bg-status-error text-white hover:bg-status-error/90')}
                      >
                        <Trash2 className="size-3.5" />
                        {tr(confirmResetAll ? 'Confirm factory reset' : 'Factory reset')}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}
            {settingsTab === 'cue-accounts' && (
              <div className="flex flex-col gap-5 animate-veil-in">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-[17px] font-semibold tracking-tight text-ink">Cue 账号</h2>
                    <p className="mt-1 text-[13px] text-ink-secondary">
                      独立隔离登录 Cue（cue.im），通过 Cue 桌面端原生协议同步各 Agent 与历史消息并直连流式对话；亦可选填 Manus API Key（sk-...）。
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="primary" size="sm" disabled={busy} onClick={() => void handleQuickAddCueAccount(false)}>
                      <Plus className="size-3.5" /> 网页登录新增 Cue 账号
                    </Button>
                    <Button variant="secondary" size="sm" disabled={busy} onClick={() => void handleQuickAddCueAccount(true)}>
                      <Globe className="size-3.5" /> 系统浏览器登录
                    </Button>
                  </div>
                </div>

                <div className="rounded-2xl border border-line bg-surface p-4 shadow-soft">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-ink">导入 Cue 会话 Cookie / Token / 凭据（可选）</span>
                    <Select
                      size="xs"
                      variant="pill"
                      value={cueTargetAccountId}
                      onValueChange={(next) => setCueTargetAccountId(next)}
                      className="max-w-64"
                      options={[
                        { value: '__new__', label: '+ 新建独立 Cue 账号' },
                        ...cueAccounts.map((acc) => ({
                          value: acc.id,
                          label: `更新会话：${acc.handle || acc.displayName || acc.id}`
                        }))
                      ]}
                    />
                  </div>
                  <div className="flex flex-col gap-2">
                    <textarea
                      aria-label="Cue 会话凭据"
                      value={cueCredentialInput}
                      onChange={(e) => setCueCredentialInput(e.target.value)}
                      placeholder="粘贴 Manus API Key（sk-...）、Cue Cookie（cue_session_id=...）或 Bearer Token (eyJ...)…"
                      rows={2}
                      spellCheck={false}
                      className="block w-full resize-none rounded-xl border border-line bg-canvas p-2.5 font-mono text-[12px] leading-5 text-ink outline-none placeholder:text-ink-muted focus:border-accent-600"
                    />
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={busy || !cueCredentialInput.trim()}
                        onClick={async () => {
                          setBusy(true)
                          setError(undefined)
                          setHint(undefined)
                          try {
                            const isNew = cueTargetAccountId === '__new__' || !accounts[cueTargetAccountId]
                            const targetId = isNew ? createId('acc_cue') : cueTargetAccountId
                            await importCueCredentials(targetId, cueCredentialInput.trim())
                            setCueCredentialInput('')
                            setCueTargetAccountId('__new__')
                            setHint(isNew ? '已导入并新建 Cue 账号，可在侧栏进入会话' : '已更新 Cue 账号会话')
                          } catch (err) {
                            setError(err instanceof Error ? err.message : String(err))
                          } finally {
                            setBusy(false)
                          }
                        }}
                      >
                        {busy ? '正在验证会话…' : cueTargetAccountId === '__new__' ? '导入并新建 Cue Bot' : '更新该账号会话'}
                      </Button>
                    </div>
                  </div>
                </div>

                {cueAccounts.length === 0 ? (
                  <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-line py-10 text-center">
                    <p className="text-[14px] font-medium text-ink">暂无 Cue 账号</p>
                    <p className="max-w-md text-[12.5px] text-ink-muted">
                      点击上方「网页登录新增 Cue 账号」在内置隔离窗口登录，或在卡片中粘贴 Cookie / Token 即可接入。
                    </p>
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
                    <ul className="divide-y divide-line">
                      {cueAccounts.map((acc) => {
                        const accountBots = (botsByAccountId.get(acc.id) ?? []).filter((b) => b.platformId === 'cue')
                        const ownerBot = accountBots[0]
                        return (
                          <li key={acc.id} className="flex flex-col gap-2.5 px-4 py-3.5 hover:bg-hover/30">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                              <div className="flex min-w-0 items-center gap-3">
                                <BotAvatar
                                  seed={ownerBot?.id ?? acc.id}
                                  platformId="cue"
                                  status={acc.status}
                                  size="md"
                                />
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="truncate text-[14px] font-medium text-ink">
                                      {ownerBot?.name || acc.handle || acc.displayName || 'Cue 账号'}
                                    </span>
                                    <StatusBadge status={acc.status} />
                                    <span className="rounded-md bg-sunken px-1.5 py-0.5 text-[11px] text-ink-secondary">
                                      {accountBots.length} 个 Bot
                                    </span>
                                  </div>
                                  <p className="mt-0.5 truncate font-mono text-[11px] text-ink-muted">
                                    {acc.handle || acc.id}
                                  </p>
                                  {acc.statusDetail && (
                                    <p className="mt-0.5 truncate text-[11.5px] text-ink-muted">
                                      {acc.statusDetail}
                                    </p>
                                  )}
                                </div>
                              </div>
                              <div className="flex shrink-0 items-center gap-1.5">
                                {ownerBot && (
                                  <Button
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => {
                                      selectBot(ownerBot.id)
                                      setSettingsOpen(false)
                                    }}
                                  >
                                    进入对话
                                  </Button>
                                )}
                                <Button
                                  size="sm"
                                  variant="primary"
                                  disabled={acc.pending || busy}
                                  onClick={() => void openCueLogin(acc.id, false)}
                                >
                                  登录窗口
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={acc.pending || busy}
                                  onClick={() => void connectAccount(acc.id)}
                                >
                                  刷新会话
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={acc.pending || busy}
                                  onClick={() => void syncCueAccountBots(acc.id)}
                                >
                                  同步 Bot
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={acc.pending}
                                  onClick={() => void signOutAccount(acc.id)}
                                  title="退出登录"
                                >
                                  <LogOut className="size-3.5" />
                                </Button>
                                {ownerBot && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => void removeBot(ownerBot.id)}
                                    title="删除"
                                  >
                                    <Trash2 className="size-3.5 text-status-error" />
                                  </Button>
                                )}
                              </div>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {settingsTab === 'mcp-hub' && (
              <div className="flex flex-col gap-5 animate-veil-in">
                <McpSettingsSection />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Batch Import Dialog */}
      <Dialog
        open={batchOpen}
        onOpenChange={setBatchOpen}
        title={t('Batch import Muse accounts')}
      >
        <MuseBatchImport
          onDone={() => {
            setBatchOpen(false)
            void refreshProxiesAndPool()
          }}
        />
      </Dialog>
    </div>
  )
}

/** GOXF v12: which page BotArk opens on. */
function StartViewPicker() {
  const startView = usePanes((s) => s.startView)
  const setStartView = usePanes((s) => s.setStartView)
  return (
    <SegmentedControl<WorkspaceView | 'last'>
      size="sm"
      value={startView}
      onValueChange={setStartView}
      options={[
        { value: 'board', label: '任务' },
        { value: 'sessions', label: '会话' },
        { value: 'collab', label: '协作' },
        { value: 'last', label: '上次的页面' }
      ]}
    />
  )
}
