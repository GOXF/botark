/**
 * GOXF fork only: keep each bot's unsent text and attachments while the
 * Composer is unmounted (switching bots or pages), until it is sent.
 */
import { createAttachmentDraft, type DraftAttachment } from './attachmentDraft'

export interface ComposerDraft {
  text: string
  entries: DraftAttachment[]
  attachments: ReturnType<typeof createAttachmentDraft>
  /** Points attachment updates at the mounted Composer; returns the unbind. */
  bind(listener: (entries: DraftAttachment[]) => void): () => void
}

const drafts = new Map<string, ComposerDraft>()

export function composerDraft(botId: string): ComposerDraft {
  let draft = drafts.get(botId)
  if (draft) return draft
  let listener: ((entries: DraftAttachment[]) => void) | null = null
  const d: ComposerDraft = {
    text: '',
    entries: [],
    // Reads that finish while the Composer is away still land in the cache.
    attachments: createAttachmentDraft((entries) => {
      d.entries = entries
      listener?.(entries)
    }),
    bind(next) {
      listener = next
      next(d.entries)
      return () => {
        if (listener === next) listener = null
      }
    }
  }
  draft = d
  drafts.set(botId, draft)
  return draft
}
