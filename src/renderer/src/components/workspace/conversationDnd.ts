import type { DragEvent, MouseEvent } from 'react'
import { useConversationTitles } from '@/services/workspaceSync'
import { findLeaf, findTab, leaves } from '@/lib/paneTree'
import { usePanes } from '@/store/paneStore'

/**
 * GOXF Issue #7: open one conversation of a bot (Hark project, Muse/Hermes/
 * Antigravity session) in its own tab or pane. Session lists spread
 * `conversationRowProps` on a row: middle-click opens it as a new tab in the
 * focused pane, dragging it onto a pane's edge splits there.
 */
export const CONVERSATION_DRAG_MIME = 'application/x-botark-conversation'

export function readConversationDrag(data: string): { botId: string; conversationId: string; title: string } | null {
  const [botId, conversationId, title = ''] = data.split('\n')
  return botId && conversationId ? { botId, conversationId, title } : null
}

export function openConversationTab(botId: string, conversationId: string, title?: string): void {
  if (title) useConversationTitles.setState({ [conversationId]: title })
  const panes = usePanes.getState()
  if (panes.view !== 'sessions') panes.setView('sessions')
  panes.addTab(panes.focusedId, botId, conversationId)
}

/**
 * GOXF: a plain click on a conversation fills an empty split cell (the focused
 * one first) instead of replacing what the current pane shows. Also focuses a
 * pane that already shows it. Returns false when there is no such pane.
 */
export function openInEmptyPane(botId: string, conversationId: string, title?: string): boolean {
  const panes = usePanes.getState()
  if (panes.view !== 'sessions') return false
  const shown = findTab(panes.tree, botId, conversationId)
  if (shown) {
    if (shown.leaf.id !== panes.focusedId) panes.focus(shown.leaf.id)
    return false
  }
  const focused = findLeaf(panes.tree, panes.focusedId)
  const empty = focused && !focused.tabs.length ? focused : leaves(panes.tree).find((l) => !l.tabs.length)
  if (!empty) return false
  if (title) useConversationTitles.setState({ [conversationId]: title })
  panes.addTab(empty.id, botId, conversationId)
  return true
}

export function conversationRowProps(botId: string, conversationId: string, title?: string) {
  return {
    title: '中键：在新标签打开 · 拖到分屏格边缘：新开一格',
    draggable: true,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.effectAllowed = 'copy'
      e.dataTransfer.setData(CONVERSATION_DRAG_MIME, [botId, conversationId, (title ?? '').replace(/\n/g, ' ')].join('\n'))
    },
    onMouseDown: (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault() // no autoscroll
    },
    onAuxClick: (e: MouseEvent) => {
      if (e.button !== 1) return
      e.preventDefault()
      openConversationTab(botId, conversationId, title)
    }
  }
}
