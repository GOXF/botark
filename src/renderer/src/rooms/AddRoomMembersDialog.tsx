import { useState } from 'react'
import { Check } from 'lucide-react'
import { getPlatform } from '@adapters/platforms'
import { BotAvatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { cn } from '@/lib/cn'
import { useBotStore } from '@/store/botStore'
import { addMemberToRoom, useRooms } from './roomStore'

const MAX = 6
const ready = (status?: string) => status === 'online' || status === 'attention' || status === 'busy'

/** GOXF: add bots to a group that already exists (until now only drag-and-drop did). */
export function AddRoomMembersDialog({ roomId, open, onOpenChange }: { roomId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const room = useRooms((s) => s.rooms.find((r) => r.id === roomId))
  const bots = useBotStore((s) => s.bots)
  const accounts = useBotStore((s) => s.accounts)
  const connectAccount = useBotStore((s) => s.connectAccount)
  const [ids, setIds] = useState<string[]>([])
  const [error, setError] = useState<string>()
  if (!room) return null
  const inRoom = new Set(room.members.map((m) => m.botId))
  const candidates = bots.filter((b) => !inRoom.has(b.id))
  const left = MAX - room.members.length

  const close = (v: boolean) => {
    if (!v) { setIds([]); setError(undefined) }
    onOpenChange(v)
  }
  const add = () => {
    for (const id of ids) {
      const res = addMemberToRoom(roomId, id)
      if (!res.ok) { setError(res.error ?? '加入失败'); return }
    }
    close(false)
  }

  return (
    <Dialog open={open} onOpenChange={close} title={`添加成员到「${room.title}」`} className="max-w-[520px]"
      footer={<>
        <Button variant="secondary" onClick={() => close(false)}>取消</Button>
        <Button variant="primary" disabled={ids.length === 0} onClick={add}>{ids.length ? `加入 ${ids.length} 位` : '加入'}</Button>
      </>}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between px-0.5 text-[12px] text-ink-muted">
          <span>选择要加入的 Bot</span>
          <span className="tabular-nums">{room.members.length + ids.length} / {MAX}</span>
        </div>
        {error && <p role="alert" className="text-[12px] text-status-error">{error}</p>}
        {candidates.length === 0 ? <p className="py-6 text-center text-[12.5px] text-ink-muted">没有可加入的 Bot 了</p> : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {candidates.map((b) => {
              const acc = accounts[b.activeAccountId]
              const online = ready(acc?.status)
              const checked = ids.includes(b.id)
              const full = !checked && ids.length >= left
              const platform = getPlatform(b.platformId)
              const toggle = async () => {
                if (full) return
                if (!online) {
                  if (!b.activeAccountId || acc?.pending) return
                  await connectAccount(b.activeAccountId)
                  if (!ready(useBotStore.getState().accounts[b.activeAccountId]?.status)) return
                }
                setIds((p) => (p.includes(b.id) ? p.filter((x) => x !== b.id) : p.length >= left ? p : [...p, b.id]))
              }
              return (
                <button key={b.id} type="button" role="checkbox" aria-checked={checked} disabled={full} onClick={() => void toggle()}
                  className={cn('press flex items-center gap-2.5 rounded-2xl border px-3 py-2.5 text-left',
                    checked ? 'border-ink/25 bg-active/70' : online ? 'border-line bg-surface hover:bg-hover/45' : 'border-line/60 bg-sunken/35 opacity-75',
                    full && 'opacity-55')}>
                  <BotAvatar emoji={b.emoji} seed={b.id} avatar={b.avatar} avatarShape={b.avatarShape} avatarColor={b.avatarColor}
                    platformId={b.platformId} status={acc?.status ?? 'offline'} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium text-ink">{b.name}</span>
                    <span className="block truncate text-[11px] text-ink-muted">{online ? platform.name : acc?.pending ? '连接中…' : '未连接 · 点击连接'}</span>
                  </span>
                  <span className={cn('grid size-4.5 shrink-0 place-items-center rounded-full', checked ? 'bg-accent-600 text-white' : 'border border-line-strong')}>
                    {checked && <Check className="size-3" />}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </Dialog>
  )
}
