/**
 * GOXF v13: Orca-style free split for the 会话 page.
 * A binary tree: every split holds two children side by side ('row') or
 * stacked ('col'); `ratio` is the first child's share. Leaves hold one bot.
 * Pure functions only, so the store and tests share them.
 */

export const PANE_MIN_W = 360
export const PANE_MIN_H = 240
export const PANE_GAP = 8

export type PaneLeaf = { type: 'leaf'; id: string; botId: string | null }
export type PaneSplit = { type: 'split'; id: string; dir: 'row' | 'col'; ratio: number; a: PaneNode; b: PaneNode }
export type PaneNode = PaneLeaf | PaneSplit
export type SplitSide = 'left' | 'right' | 'top' | 'bottom'

let seq = 0
export function paneId(prefix = 'p'): string {
  seq += 1
  return `${prefix}_${Date.now().toString(36)}_${seq}`
}

export function leaf(botId: string | null = null, id = paneId()): PaneLeaf {
  return { type: 'leaf', id, botId }
}

export function leaves(node: PaneNode): PaneLeaf[] {
  return node.type === 'leaf' ? [node] : [...leaves(node.a), ...leaves(node.b)]
}

export function findLeaf(node: PaneNode, id: string): PaneLeaf | undefined {
  return leaves(node).find((l) => l.id === id)
}

export function leafOfBot(node: PaneNode, botId: string): PaneLeaf | undefined {
  return leaves(node).find((l) => l.botId === botId)
}

function map(node: PaneNode, fn: (n: PaneNode) => PaneNode): PaneNode {
  const next = fn(node)
  if (next !== node || next.type === 'leaf') return next
  const a = map(next.a, fn)
  const b = map(next.b, fn)
  return a === next.a && b === next.b ? next : { ...next, a, b }
}

export function setLeafBot(node: PaneNode, id: string, botId: string | null): PaneNode {
  return map(node, (n) => (n.type === 'leaf' && n.id === id ? { ...n, botId } : n))
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

/** Split `leafId`; the new leaf (holding `botId`) goes on `side`. */
export function splitLeaf(node: PaneNode, leafId: string, side: SplitSide, botId: string | null, newId = paneId()): PaneNode {
  const fresh = leaf(botId, newId)
  return map(node, (n) => {
    if (n.type !== 'leaf' || n.id !== leafId) return n
    const dir = side === 'left' || side === 'right' ? 'row' : 'col'
    const first = side === 'left' || side === 'top'
    return { type: 'split', id: paneId('s'), dir, ratio: 0.5, a: first ? fresh : n, b: first ? n : fresh }
  })
}

/** Remove a leaf; its sibling takes the parent's place. The last leaf only empties. */
export function closeLeaf(node: PaneNode, leafId: string): PaneNode {
  if (node.type === 'leaf') return node.id === leafId ? { ...node, botId: null } : node
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

/** Drop bots that no longer exist (deleted in the sidebar). */
export function pruneBots(node: PaneNode, alive: (botId: string) => boolean): PaneNode {
  return map(node, (n) => (n.type === 'leaf' && n.botId && !alive(n.botId) ? { ...n, botId: null } : n))
}

export function isPaneNode(v: unknown): v is PaneNode {
  if (!v || typeof v !== 'object') return false
  const n = v as Record<string, unknown>
  if (n.type === 'leaf') return typeof n.id === 'string' && (n.botId === null || typeof n.botId === 'string')
  return (
    n.type === 'split' && typeof n.id === 'string' && (n.dir === 'row' || n.dir === 'col') &&
    typeof n.ratio === 'number' && isPaneNode(n.a) && isPaneNode(n.b)
  )
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
