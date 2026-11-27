import { useState, type ReactNode } from 'react'
import { Activity, Download, FileUp, Loader2, RefreshCw, Trash2, Cpu } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { TextInput } from '@/components/ui/Field'
import { SwitchPill } from '@/components/ui/Controls'
import { SegmentedControl } from '@/components/ui/SegmentedControl'
import { Select } from '@/components/ui/Select'
import { cn } from '@/lib/cn'

/**
 * v20：代理池支持订阅（Mihomo 内核用户自己下载/导入，参考 cockpit-tools）。
 * 设置 → 代理池 页面：① 内核卡 ② 导入卡多一个「订阅」页 ③ 订阅来源 + 选节点 ④ 池列表里订阅节点和普通代理并排。
 */
const lat = (ms: number) =>
  ms < 300
    ? 'bg-status-online/10 text-status-online-ink'
    : ms < 800
      ? 'bg-status-attention/15 text-status-attention-ink'
      : 'bg-status-error/10 text-status-error-ink'

function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] font-medium', className)}>
      {children}
    </span>
  )
}
function Proto({ p }: { p: string }) {
  return <span className="rounded-md bg-sunken px-1.5 py-0.5 font-mono text-[11px] uppercase text-ink-secondary">{p}</span>
}
function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('rounded-2xl border border-line bg-surface p-4 shadow-soft', className)}>{children}</div>
}

function KernelCard({ installed }: { installed: boolean }) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-sunken text-ink-secondary">
            <Cpu className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-medium text-ink">Mihomo 内核</span>
              {installed ? (
                <Badge className="bg-status-online/10 text-status-online-ink">已安装 v1.19.31</Badge>
              ) : (
                <Badge className="bg-sunken text-ink-muted">未安装</Badge>
              )}
            </div>
            <p className="mt-1 text-[12px] text-ink-secondary">
              {installed
                ? '订阅节点由它在本机跑；只监听 127.0.0.1，带随机密码。'
                : '用订阅里的 SS / VMess / Trojan 等节点需要它。不内置，装在数据目录里，不改系统代理。'}
            </p>
            {!installed && (
              <p className="mt-1 font-mono text-[11px] text-ink-muted">mihomo-windows-amd64-v1.19.31.zip · 约 12 MB · 校验 SHA-256</p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {installed ? (
            <Button size="sm" variant="ghost">
              重新安装
            </Button>
          ) : (
            <>
              <Button size="sm" variant="secondary">
                <FileUp className="size-3.5" /> 本地导入
              </Button>
              <Button size="sm" variant="primary">
                <Download className="size-3.5" /> 下载并安装
              </Button>
            </>
          )}
        </div>
      </div>
      {!installed && (
        <p className="mt-3 text-[11px] text-ink-muted">下载走代理池（有可用代理时），否则走系统网络。下不动就去 GitHub 下官方压缩包，点「本地导入」。</p>
      )}
    </Card>
  )
}

function ImportCard() {
  const [tab, setTab] = useState('sub')
  const [auto, setAuto] = useState(false)
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <SegmentedControl
          size="sm"
          value={tab}
          onValueChange={setTab}
          options={[
            { value: 'list', label: '代理列表' },
            { value: 'sub', label: '订阅' }
          ]}
        />
        <span className="text-[12px] text-ink-muted">支持 Clash / Mihomo 订阅，也可粘贴 ss:// vmess:// trojan:// 节点</span>
      </div>
      <div className="flex items-center gap-2">
        <TextInput
          className="min-w-0 flex-1 font-mono"
          placeholder="粘贴订阅地址或节点链接"
          defaultValue="https://sub.example.com/api/v1/client/subscribe?token=••••••••"
        />
        <Button size="sm" variant="primary">
          导入订阅
        </Button>
      </div>
      <div className="mt-3 flex items-center gap-2 text-[12px] text-ink-secondary">
        <SwitchPill size="sm" checked={auto} onCheckedChange={setAuto} aria-label="自动刷新" />
        <span>每 6 小时自动刷新</span>
        <span className="text-ink-muted">· 刷新不会改动已分配给账号的节点</span>
      </div>
    </Card>
  )
}

const NODES: { name: string; p: string; ms?: number; state?: 'testing' | 'fail' }[] = [
  { name: '香港 01', p: 'vmess', ms: 86 },
  { name: '香港 02', p: 'vmess', ms: 112 },
  { name: '日本 东京 01', p: 'trojan', ms: 214 },
  { name: '新加坡 01', p: 'ss', ms: 498 },
  { name: '美国 洛杉矶 01', p: 'hysteria2', state: 'testing' },
  { name: '台湾 01', p: 'vless', state: 'fail' }
]

function SourceCard() {
  const [group, setGroup] = useState('auto')
  const [picked, setPicked] = useState<Set<string>>(new Set(['香港 01', '日本 东京 01']))
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-sunken/40 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-[12px]">
          <span className="font-medium text-ink">某某云</span>
          <span className="text-ink-muted">订阅 · 72 个节点 · 18 个分组 · 18:20 更新</span>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost">
            <RefreshCw className="size-3.5" /> 刷新
          </Button>
          <Button size="sm" variant="ghost">
            删除来源
          </Button>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 px-4 pt-3">
        <div className="flex items-center gap-2 text-[12px] text-ink-secondary">
          <span>分组</span>
          <Select
            size="xs"
            variant="pill"
            value={group}
            onValueChange={setGroup}
            className="w-44"
            options={[
              { value: 'auto', label: '♻️ 自动选择（url-test）' },
              { value: 'hk', label: '🇭🇰 香港节点' },
              { value: 'all', label: '全部节点' }
            ]}
          />
        </div>
        <Button size="sm" variant="secondary">
          <Activity className="size-3.5" /> 测这一组
        </Button>
      </div>
      <ul className="mt-2 divide-y divide-line">
        {NODES.map((n) => {
          const on = picked.has(n.name)
          return (
            <li key={n.name} className="flex items-center justify-between gap-3 px-4 py-2 text-[13px]">
              <div className="flex min-w-0 items-center gap-2.5">
                <SwitchPill
                  size="sm"
                  checked={on}
                  aria-label={`选择 ${n.name}`}
                  onCheckedChange={() => {
                    const next = new Set(picked)
                    if (on) next.delete(n.name)
                    else next.add(n.name)
                    setPicked(next)
                  }}
                />
                <Proto p={n.p} />
                <span className="truncate text-ink">{n.name}</span>
              </div>
              {n.state === 'testing' ? (
                <Badge className="bg-sunken text-ink-muted">
                  <Loader2 className="size-3 animate-spin" /> 检测中…
                </Badge>
              ) : n.state === 'fail' ? (
                <Badge className="bg-status-error/10 text-status-error-ink">超时</Badge>
              ) : (
                <Badge className={lat(n.ms!)}>{n.ms} ms</Badge>
              )}
            </li>
          )
        })}
      </ul>
      <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5">
        <span className="text-[12px] text-ink-muted">已选 {picked.size} 个节点 · 也可以把整组加进去（按组策略自动切换）</span>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="secondary">
            整组加入
          </Button>
          <Button size="sm" variant="primary">
            加入代理池
          </Button>
        </div>
      </div>
    </div>
  )
}

const POOL: { kind: 'plain' | 'sub'; p: string; label: string; sub?: string; ms: number; who: string[] }[] = [
  { kind: 'plain', p: 'socks5', label: 'hkd478e1:***@154.2.10.8:28443', ms: 310, who: ['客服'] },
  { kind: 'sub', p: 'vmess', label: '香港 01', sub: '某某云', ms: 86, who: ['评价', '品退'] },
  { kind: 'sub', p: 'group', label: '♻️ 自动选择', sub: '某某云 · 当前 香港 02', ms: 112, who: [] }
]

function PoolList() {
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-soft">
      <div className="border-b border-line bg-sunken/40 px-4 py-2.5 text-[12px] font-medium text-ink-secondary">代理池列表 (3)</div>
      <ul className="divide-y divide-line">
        {POOL.map((it, i) => (
          <li key={it.label} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="w-6 font-mono text-[11px] text-ink-muted">#{i + 1}</span>
              <Proto p={it.p} />
              <span className={cn('truncate text-ink', it.kind === 'plain' && 'font-mono')}>{it.label}</span>
              {it.sub && <span className="truncate text-[11px] text-ink-muted">{it.sub}</span>}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Badge className={lat(it.ms)}>{it.ms} ms</Badge>
              {it.who.length ? (
                it.who.map((w) => (
                  <span key={w} className="rounded-full bg-status-online/10 px-2 py-0.5 text-[11px] font-medium text-status-online-ink">
                    {w}
                  </span>
                ))
              ) : (
                <span className="rounded-full bg-sunken px-2.5 py-0.5 text-[11px] text-ink-muted">空闲待分配</span>
              )}
              <IconButton size="sm" label="测试延迟">
                <Activity className="size-3.5" />
              </IconButton>
              <IconButton size="sm" label="移除">
                <Trash2 className="size-3.5" />
              </IconButton>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function V20ProxySubMock() {
  return (
    <div className="flex gap-8">
      <div className="flex w-[720px] flex-col gap-4">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">代理池</h2>
          <p className="mt-1 text-[13px] text-ink-secondary">批量导入代理或订阅，按勾选的平台和每个代理的账号上限自动分配；密码用系统钥匙串加密。</p>
        </div>
        <KernelCard installed={false} />
        <ImportCard />
        <p className="text-[12px] text-ink-muted">↑ 内核没装时，「导入订阅」会先提示安装。下面是装好后的样子 ↓</p>
        <KernelCard installed />
        <SourceCard />
        <PoolList />
      </div>
    </div>
  )
}
