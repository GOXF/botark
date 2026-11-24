/**
 * GOXF v13: Orca-style free split for the 会话 page.
 * A binary tree: every split holds two children side by side ('row') or
 * stacked ('col'); `ratio` is the first child's share. Leaves hold tabs
 * (Issue #2); a tab is a bot plus, where the platform has several, the
 * conversation shown (Issue #7), so two panes can show two conversations of
 * one bot.
 * Pure functions only, so the store and tests share them.
 */

export const PANE_MIN_W = 360
export const PANE_MIN_H = 240
export const PANE_GAP = 8

/** `conversationId` (Hark project, Muse/Hermes session…) unset = follows the bot's active conversation. */
export type PaneTab = { id: string; botId: string; conversationId?: string }
export type PaneLeaf = { type: 'leaf'; id: string; tabs: PaneTab[]; active: string | null }
export type PaneSplit = { type: 'split'; id: string; dir: 'row' | 'col'; ratio: number; a: PaneNode; b: PaneNode }
export type PaneNode = PaneLeaf | PaneSplit
export type SplitSide = 'left' | 'right' | 'top' | 'bottom'

let seq = 0
export function paneId(prefix = 'p'): string {
  seq += 1
  return `${prefix}_${Date.now().toString(36)}_${seq}`
}

export function tab(botId: string, conversationId?: string, id = paneId('t')): PaneTab {
  return conversationId ? { id, botId, conversationId } : { id, botId }
}

export function leaf(content: string | PaneTab | null = null, id = paneId()): PaneLeaf {
  const t = typeof content === 'string' ? tab(content) : content
  return { type: 'leaf', id, tabs: t ? [t] : [], active: t?.id ?? null }
}

export function activeTab(l: PaneLeaf): PaneTab | undefined {
  return l.tabs.find((t) => t.id === l.active)
}

/** The bot on screen in a pane (its active tab). */
export function leafBot(l: PaneLeaf): string | null {
  return activeTab(l)?.botId ?? null
}

export function leaves(node: PaneNode): PaneLeaf[] {
  return node.type === 'leaf' ? [node] : [...leaves(node.a), ...leaves(node.b)]
}

export function findLeaf(node: PaneNode, id: string): PaneLeaf | undefined {
  return leaves(node).find((l) => l.id === id)
}

export interface TabHit { leaf: PaneLeaf; tab: PaneTab }

/** Any tab of this bot, on-screen ones first. */
export function findBot(node: PaneNode, botId: string): TabHit | undefined {
  let hit: TabHit | undefined
  for (const l of leaves(node)) {
    for (const t of l.tabs) {
      if (t.botId !== botId) continue
      if (t.id === l.active) return { leaf: l, tab: t }
      hit ??= { leaf: l, tab: t }
    }
  }
  return hit
}

/** The tab showing exactly this bot + project (unset project matches only unset). */
export function findTab(node: PaneNode, botId: string, conversationId?: string): TabHit | undefined {
  for (const l of leaves(node)) {
    const t = l.tabs.find((x) => x.botId === botId && x.conversationId === conversationId)
    if (t) return { leaf: l, tab: t }
  }
  return undefined
}

function map(node: PaneNode, fn: (n: PaneNode) => PaneNode): PaneNode {
  const next = fn(node)
  if (next !== node || next.type === 'leaf') return next
  const a = map(next.a, fn)
  const b = map(next.b, fn)
  return a === next.a && b === next.b ? next : { ...next, a, b }
}

function mapLeaf(node: PaneNode, id: string, fn: (l: PaneLeaf) => PaneLeaf): PaneNode {
  return map(node, (n) => (n.type === 'leaf' && n.id === id ? fn(n) : n))
}

export function replaceLeaf(node: PaneNode, id: string, next: PaneLeaf): PaneNode {
  return mapLeaf(node, id, () => ({ ...next, id }))
}

/** Show a bot in a pane by swapping its active tab (sidebar click); an empty pane gets a tab. */
export function showInLeaf(node: PaneNode, id: string, botId: string, conversationId?: string): PaneNode {
  return mapLeaf(node, id, (l) => {
    const same = l.tabs.find((t) => t.botId === botId && (conversationId === undefined || t.conversationId === conversationId))
    if (same) return { ...l, active: same.id }
    const fresh = tab(botId, conversationId)
    const at = l.tabs.findIndex((t) => t.id === l.active)
    if (at < 0) return { ...l, tabs: [...l.tabs, fresh], active: fresh.id }
    return { ...l, tabs: l.tabs.map((t, i) => (i === at ? fresh : t)), active: fresh.id }
  })
}

/** Add a tab right after the active one and show it; an identical tab in the pane is just shown. */
export function openTab(node: PaneNode, id: string, t: PaneTab): PaneNode {
  return mapLeaf(node, id, (l) => {
    const same = l.tabs.find((x) => x.id === t.id || (x.botId === t.botId && x.conversationId === t.conversationId))
    if (same) return { ...l, active: same.id }
    const at = l.tabs.findIndex((x) => x.id === l.active)
    const tabs = [...l.tabs]
    tabs.splice(at < 0 ? tabs.length : at + 1, 0, t)
    return { ...l, tabs, active: t.id }
  })
}

export function selectTab(node: PaneNode, id: string, tabId: string): PaneNode {
  return mapLeaf(node, id, (l) => (l.active !== tabId && l.tabs.some((t) => t.id === tabId) ? { ...l, active: tabId } : l))
}

export function setTabConversation(node: PaneNode, id: string, tabId: string, conversationId: string | undefined): PaneNode {
  return mapLeaf(node, id, (l) => ({
    ...l,
    tabs: l.tabs.map((t) => (t.id === tabId && t.conversationId !== conversationId ? tab(t.botId, conversationId, t.id) : t))
  }))
}

function withoutTabs(l: PaneLeaf, drop: (t: PaneTab) => boolean): PaneLeaf {
  const tabs = l.tabs.filter((t) => !drop(t))
  if (tabs.length === l.tabs.length) return l
  if (tabs.some((t) => t.id === l.active)) return { ...l, tabs }
  // The active tab went: show its right neighbour, else the left one.
  const at = l.tabs.findIndex((t) => t.id === l.active)
  const next = l.tabs.slice(at + 1).find((t) => !drop(t)) ?? [...l.tabs.slice(0, Math.max(at, 0))].reverse().find((t) => !drop(t))
  return { ...l, tabs, active: next?.id ?? null }
}

/** Close a tab; a pane left with no tabs closes too, unless it is the last one. */
export function closeTab(node: PaneNode, id: string, tabId: string): PaneNode {
  const next = mapLeaf(node, id, (l) => withoutTabs(l, (t) => t.id === tabId))
  const l = findLeaf(next, id)
  return l && l.tabs.length === 0 && leaves(next).length > 1 ? closeLeaf(next, id) : next
}

/**
 * Drag a tab to another pane's middle (joins its tabs) or to an edge (splits
 * there). A pane emptied by the move closes. Returns the leaf now showing it.
 */
export function moveTab(
  node: PaneNode, fromId: string, tabId: string, toId: string, zone: SplitSide | 'center', newId = paneId()
): { tree: PaneNode; leafId: string } {
  const from = findLeaf(node, fromId)
  const moving = from?.tabs.find((t) => t.id === tabId)
  if (!from || !moving || !findLeaf(node, toId)) return { tree: node, leafId: fromId }
  if (fromId === toId && (zone === 'center' || from.tabs.length === 1)) return { tree: node, leafId: fromId }
  let tree = mapLeaf(node, fromId, (l) => withoutTabs(l, (t) => t.id === tabId))
  let leafId = toId
  if (zone === 'center') tree = openTab(tree, toId, moving)
  else {
    tree = splitLeaf(tree, toId, zone, moving, newId)
    leafId = newId
  }
  if (findLeaf(tree, fromId)?.tabs.length === 0) tree = closeLeaf(tree, fromId)
  return { tree, leafId }
}

/** Smallest box a subtree can be drawn in without a leaf going under the minimum. */
export function minSize(node: PaneNode): { w: number; h: number } {
  if (node.type === 'leaf') return { w: PANE_MIN_W, h: PANE_MIN_H }
  const a = minSize(node.a)
  const b = minSize(node.b)
  return node.dir === 'row'
    ? { w: a.w + b.w + PANE_GAP, h: Math.max(a.h, b.h) }
    : { w: Math.max(a.w, b.w), h: a.h + b.h + PANE_GAP }
}

export interface Rect { x: number; y: number; w: number; h: number }

/** Where every leaf lands inside `box`. */
export function layoutRects(node: PaneNode, box: Rect, out: Record<string, Rect> = {}): Record<string, Rect> {
  if (node.type === 'leaf') {
    out[node.id] = box
    return out
  }
  if (node.dir === 'row') {
    const aw = (box.w - PANE_GAP) * node.ratio
    layoutRects(node.a, { ...box, w: aw }, out)
    layoutRects(node.b, { ...box, x: box.x + aw + PANE_GAP, w: box.w - PANE_GAP - aw }, out)
  } else {
    const ah = (box.h - PANE_GAP) * node.ratio
    layoutRects(node.a, { ...box, h: ah }, out)
    layoutRects(node.b, { ...box, y: box.y + ah + PANE_GAP, h: box.h - PANE_GAP - ah }, out)
  }
  return out
}

/** Width (row) or height (col) each half gets if `leafId` is split now. */
export function splitResult(node: PaneNode, box: Rect, leafId: string, side: SplitSide): { ok: boolean; size: number; min: number } {
  const r = layoutRects(node, box)[leafId]
  if (!r) return { ok: false, size: 0, min: PANE_MIN_W }
  const horizontal = side === 'left' || side === 'right'
  const size = Math.floor(((horizontal ? r.w : r.h) - PANE_GAP) / 2)
  const min = horizontal ? PANE_MIN_W : PANE_MIN_H
  return { ok: size >= min, size, min }
}

/** Split `leafId`; the new leaf (holding `content`) goes on `side`. */
export function splitLeaf(node: PaneNode, leafId: string, side: SplitSide, content: string | PaneTab | null, newId = paneId()): PaneNode {
  const fresh = leaf(content, newId)
  return map(node, (n) => {
    if (n.type !== 'leaf' || n.id !== leafId) return n
    const dir = side === 'left' || side === 'right' ? 'row' : 'col'
    const first = side === 'left' || side === 'top'
    return { type: 'split', id: paneId('s'), dir, ratio: 0.5, a: first ? fresh : n, b: first ? n : fresh }
  })
}

/** Remove a leaf; its sibling takes the parent's place. The last leaf only empties. */
export function closeLeaf(node: PaneNode, leafId: string): PaneNode {
  if (node.type === 'leaf') return node.id === leafId ? { ...node, tabs: [], active: null } : node
  if (node.a.type === 'leaf' && node.a.id === leafId) return node.b
  if (node.b.type === 'leaf' && node.b.id === leafId) return node.a
  const a = closeLeaf(node.a, leafId)
  const b = closeLeaf(node.b, leafId)
  return a === node.a && b === node.b ? node : { ...node, a, b }
}

export function setRatio(node: PaneNode, splitId: string, ratio: number): PaneNode {
  return map(node, (n) => (n.type === 'split' && n.id === splitId ? { ...n, ratio } : n))
}

/** Ratio limits for a divider so neither side goes under its minimum. */
export function ratioBounds(split: PaneSplit, total: number): [number, number] {
  const usable = total - PANE_GAP
  if (usable <= 0) return [0.5, 0.5]
  const ma = minSize(split.a)
  const mb = minSize(split.b)
  const lo = (split.dir === 'row' ? ma.w : ma.h) / usable
  const hi = 1 - (split.dir === 'row' ? mb.w : mb.h) / usable
  return lo > hi ? [0.5, 0.5] : [lo, hi]
}

function count(node: PaneNode, dir: 'row' | 'col'): number {
  return node.type === 'split' && node.dir === dir ? count(node.a, dir) + count(node.b, dir) : 1
}

/** Every leaf in a run of same-direction splits gets the same share. */
export function equalize(node: PaneNode): PaneNode {
  if (node.type === 'leaf') return node
  const a = equalize(node.a)
  const b = equalize(node.b)
  const ca = count(a, node.dir)
  const cb = count(b, node.dir)
  return { ...node, a, b, ratio: ca / (ca + cb) }
}

/** Drop tabs of bots that no longer exist (deleted in the sidebar); panes stay. */
export function pruneBots(node: PaneNode, alive: (botId: string) => boolean): PaneNode {
  return map(node, (n) => (n.type === 'leaf' ? withoutTabs(n, (t) => !alive(t.botId)) : n))
}

function readTab(v: unknown): PaneTab | null {
  if (!v || typeof v !== 'object') return null
  const t = v as Record<string, unknown>
  if (typeof t.id !== 'string' || typeof t.botId !== 'string') return null
  return tab(t.botId, typeof t.conversationId === 'string' && t.conversationId ? t.conversationId : undefined, t.id)
}

/** Validate a saved layout; v13 leaves (`botId`, no tabs) become one-tab leaves. */
export function readPaneNode(v: unknown): PaneNode | null {
  if (!v || typeof v !== 'object') return null
  const n = v as Record<string, unknown>
  if (typeof n.id !== 'string') return null
  if (n.type === 'leaf') {
    if (!Array.isArray(n.tabs)) return n.botId === null || typeof n.botId === 'string' ? leaf(n.botId as string | null, n.id) : null
    const tabs = n.tabs.map(readTab)
    if (tabs.some((t) => !t)) return null
    const list = tabs as PaneTab[]
    const active = list.some((t) => t.id === n.active) ? (n.active as string) : (list[0]?.id ?? null)
    return { type: 'leaf', id: n.id, tabs: list, active }
  }
  if (n.type !== 'split' || (n.dir !== 'row' && n.dir !== 'col') || typeof n.ratio !== 'number') return null
  const a = readPaneNode(n.a)
  const b = readPaneNode(n.b)
  return a && b ? { type: 'split', id: n.id, dir: n.dir, ratio: n.ratio, a, b } : null
}

export interface PaneHandle { split: PaneSplit; box: Rect; gap: Rect }

/** The divider of every split: the gap between its children, plus the split's own box. */
export function paneHandles(node: PaneNode, box: Rect, out: PaneHandle[] = []): PaneHandle[] {
  if (node.type === 'leaf') return out
  if (node.dir === 'row') {
    const aw = (box.w - PANE_GAP) * node.ratio
    out.push({ split: node, box, gap: { x: box.x + aw, y: box.y, w: PANE_GAP, h: box.h } })
    paneHandles(node.a, { ...box, w: aw }, out)
    paneHandles(node.b, { ...box, x: box.x + aw + PANE_GAP, w: box.w - PANE_GAP - aw }, out)
  } else {
    const ah = (box.h - PANE_GAP) * node.ratio
    out.push({ split: node, box, gap: { x: box.x, y: box.y + ah, w: box.w, h: PANE_GAP } })
    paneHandles(node.a, { ...box, h: ah }, out)
    paneHandles(node.b, { ...box, y: box.y + ah + PANE_GAP, h: box.h - PANE_GAP - ah }, out)
  }
  return out
}

/** Which drop zone a point inside a pane falls in: an edge (outer 25 %) or the middle. */
export function dropZone(r: Rect, px: number, py: number): SplitSide | 'center' {
  const fx = (px - r.x) / r.w
  const fy = (py - r.y) / r.h
  const edge = 0.25
  const d = [
    ['left', fx], ['right', 1 - fx], ['top', fy], ['bottom', 1 - fy]
  ] as const
  const [side, dist] = d.reduce((m, c) => (c[1] < m[1] ? c : m))
  return dist < edge ? side : 'center'
}
