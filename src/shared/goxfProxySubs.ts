/** GOXF fork: proxy pool subscriptions served by a user-installed Mihomo kernel. */
export const GOXF_PROXYSUB_CHANNELS = {
  kernelStatus: 'goxf:proxysub:kernel-status',
  kernelDownload: 'goxf:proxysub:kernel-download',
  kernelImport: 'goxf:proxysub:kernel-import',
  kernelEvent: 'goxf:proxysub:kernel-event',
  list: 'goxf:proxysub:list',
  importSource: 'goxf:proxysub:import',
  refreshSource: 'goxf:proxysub:refresh',
  removeSource: 'goxf:proxysub:remove',
  setAutoRefresh: 'goxf:proxysub:auto-refresh',
  testDelays: 'goxf:proxysub:test-delays',
  addToPool: 'goxf:proxysub:add-to-pool',
  poolCurrent: 'goxf:proxysub:pool-current'
} as const

export interface MihomoKernelStatus {
  installed: boolean
  version?: string
  /** Pinned version this build downloads / accepts. */
  pinnedVersion: string
  /** Official asset for this OS/arch, null when Mihomo has no build for it. */
  asset: { file: string; size: number } | null
  releasesPage: string
  installing: boolean
}

export type MihomoKernelEvent =
  | { type: 'progress'; percent: number; totalMb?: number }
  | { type: 'done'; status: MihomoKernelStatus }
  | { type: 'error'; message: string }

export interface ProxySubNodeView {
  id: string
  name: string
  protocol: string
  /** Can be added to the pool. */
  usable: boolean
  insecure: boolean
  /** Short reason when not usable. */
  reason?: string
}

export interface ProxySubGroupView {
  id: string
  name: string
  kind: string
  /** Member node ids (nested groups expanded). */
  nodeIds: string[]
  usable: boolean
  insecure: boolean
  reason?: string
}

/** A subscription source; the URL / pasted links never leave main. */
export interface ProxySubSourceView {
  id: string
  name: string
  kind: 'url' | 'links'
  updatedAt: number
  nodes: ProxySubNodeView[]
  groups: ProxySubGroupView[]
  /** Node/group ids already in the pool. */
  inPool: string[]
  lastError?: string
}

export interface ProxySubListView {
  sources: ProxySubSourceView[]
  autoRefresh: boolean
}

export interface ProxySubDelay {
  ok: boolean
  ms?: number
  error?: string
}

export interface ProxySubAddRequest {
  sourceId: string
  nodeIds?: string[]
  groupId?: string
  /** The user confirmed nodes that skip certificate verification. */
  allowInsecure?: boolean
}

export interface GoxfProxySubsBridge {
  kernelStatus(): Promise<MihomoKernelStatus>
  /** Download the pinned official asset (proxy pool first, then system network) and install it. */
  kernelDownload(): Promise<MihomoKernelStatus>
  /** Pick an official .zip/.gz in a file dialog and install it. Null when cancelled. */
  kernelImport(): Promise<MihomoKernelStatus | null>
  onKernelEvent(listener: (event: MihomoKernelEvent) => void): () => void
  list(): Promise<ProxySubListView>
  /** URL (https) or pasted node links / subscription text. */
  importSource(input: string): Promise<ProxySubListView>
  refreshSource(id: string): Promise<ProxySubListView>
  removeSource(id: string): Promise<ProxySubListView>
  setAutoRefresh(on: boolean): Promise<ProxySubListView>
  /** Latency of nodes via Mihomo /proxies/<name>/delay (max 3 at a time). */
  testDelays(sourceId: string, nodeIds: string[]): Promise<Record<string, ProxySubDelay>>
  addToPool(req: ProxySubAddRequest): Promise<{ added: number; skipped: number }>
  /** Current node of running group entries (pool id → node name). */
  poolCurrent(): Promise<Record<string, string>>
}

/** Error text main throws when insecure nodes need the user's approval first. */
export const INSECURE_APPROVAL_NEEDED = '需要确认：所选节点跳过了证书校验'
