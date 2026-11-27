import { useEffect, useState } from 'react'
import type { MuseProxyPoolItemView } from '@shared/ipc'
import type { ProxySubListView } from '@shared/goxfProxySubs'
import { ProxyPoolSection } from '@/components/settings/ProxyPoolSection'
import { MihomoKernelCard } from '@/components/settings/GoxfProxySubs'

/** v20 final UI: the real ProxyPoolSection + Mihomo/subscription components on a fake bridge. */
const ID = (s: string) => s
const SOURCE: ProxySubListView = {
  autoRefresh: false,
  sources: [
    {
      id: 'sub1',
      name: '某某云',
      kind: 'url',
      updatedAt: new Date(2026, 10, 27, 18, 20).getTime(),
      inPool: ['n1'],
      nodes: [
        { id: 'n1', name: '香港 01', protocol: 'vmess', usable: true, insecure: false },
        { id: 'n2', name: '香港 02', protocol: 'vmess', usable: true, insecure: false },
        { id: 'n3', name: '日本 东京 01', protocol: 'trojan', usable: true, insecure: false },
        { id: 'n4', name: '新加坡 01', protocol: 'ss', usable: true, insecure: false },
        { id: 'n5', name: '美国 洛杉矶 01', protocol: 'hysteria2', usable: true, insecure: true },
        { id: 'n6', name: '台湾 01', protocol: 'vless', usable: true, insecure: false },
        { id: 'n7', name: '韩国 01', protocol: 'wireguard', usable: false, insecure: false, reason: '节点用了暂不支持的参数' }
      ],
      groups: [
        { id: 'g1', name: '♻️ 自动选择', kind: 'url-test', nodeIds: ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'], usable: true, insecure: true },
        { id: 'g2', name: '🇭🇰 香港节点', kind: 'select', nodeIds: ['n1', 'n2'], usable: true, insecure: false }
      ]
    }
  ]
}
const DELAYS: Record<string, { ok: boolean; ms?: number; error?: string } | null> = {
  n1: { ok: true, ms: 86 },
  n2: { ok: true, ms: 112 },
  n3: { ok: true, ms: 214 },
  n4: { ok: true, ms: 498 },
  n5: null,
  n6: { ok: false, error: '超时' }
}
const POOL: MuseProxyPoolItemView[] = [
  { id: 'p1', mode: 'socks5', host: '154.2.10.8', port: 28443, username: 'hkd478e1', hasPassword: true, assignedAccountIds: [ID('客服')], lastTest: { ok: true, ms: 310 } },
  { id: 'p2', mode: 'socks5h', host: '127.0.0.1', port: 24561, hasPassword: true, assignedAccountIds: [ID('评价'), ID('品退')], lastTest: { ok: true, ms: 86 }, sub: { name: '香港 01', protocol: 'vmess', source: '某某云', group: false } },
  { id: 'p3', mode: 'socks5h', host: '127.0.0.1', port: 27103, hasPassword: true, assignedAccountIds: [], lastTest: { ok: true, ms: 112 }, sub: { name: '♻️ 自动选择', protocol: 'group', source: '某某云', group: true } }
]
const KERNEL = { installed: true, version: '1.19.33', pinnedVersion: '1.19.33', latestVersion: '1.19.34', updateAvailable: true, asset: { file: 'mihomo-windows-amd64-v1-v1.19.33.zip', size: 22543530 }, releasesPage: '', installing: false }

;(window as unknown as { electron: unknown }).electron = {
  platform: 'win32',
  muse: {
    listProxyPool: async () => POOL,
    testProxyPool: async () => ({}),
    removeProxyPoolItem: async () => POOL
  },
  goxfProxySubs: {
    kernelStatus: async () => KERNEL,
    onKernelEvent: () => () => undefined,
    list: async () => SOURCE,
    poolCurrent: async () => ({ p3: '香港 02' }),
    testDelays: (_s: string, ids: string[]) =>
      DELAYS[ids[0]!] === null ? new Promise(() => undefined) : Promise.resolve({ [ids[0]!]: DELAYS[ids[0]!] })
  }
}

function Page() {
  const [pool, setPool] = useState(POOL)
  useEffect(() => {
    // Show latency badges: press 测这一组 once.
    const t = setTimeout(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('测这一组'))
      btn?.click()
    }, 300)
    return () => clearTimeout(t)
  }, [])
  return (
    <ProxyPoolSection
      active
      credentialRevision={0}
      museAccountCount={0}
      botsByAccountId={new Map()}
      defaultImportTab="sub"
      activity={{ busy: false, setBusy: () => undefined, setHint: () => undefined, setError: () => undefined }}
      proxyPool={{ pool, accountProxies: {}, setPool, refresh: async () => undefined, invalidate: () => undefined, clear: () => undefined, assignMuseProxies: async () => undefined }}
    />
  )
}

export function V20ProxySubRealMock() {
  return (
    <div className="flex w-[760px] flex-col gap-4">
      <MihomoKernelCard
        kernel={{ status: { ...KERNEL, installed: false, version: undefined }, progress: null, error: undefined, install: async () => false }}
      />
      <p className="text-[12px] text-ink-muted">↑ 未安装 · 下面是装好后的整页 ↓</p>
      <Page />
    </div>
  )
}
