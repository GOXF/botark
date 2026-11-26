import { FileText, Film, Loader2, Music, X } from 'lucide-react'
import { IconButton } from '@/components/ui/IconButton'
import { cn } from '@/lib/cn'
import { formatBytes } from '@/lib/format'
import { t } from '@/lib/i18n'
import type { DraftAttachment } from './attachmentDraft'

/** Pending attachments above a composer (one-to-one chat and collaboration rooms). */
export function AttachmentChips({ attachments, onRemove, onPreview }: {
  attachments: DraftAttachment[]
  onRemove: (id: string) => void
  onPreview: (image: { src: string; name: string }) => void
}) {
  if (attachments.length === 0) return null
  return (
    <ul className="flex flex-wrap gap-1.5 px-1 pt-0.5 pb-1.5" aria-label={t('Attachments')}>
      {attachments.map(({ file, status }) => {
        const image = file.mimeType.startsWith('image/')
        const isImg = image && status === 'ready'
        const isVideo = file.mimeType.startsWith('video/')
        const isAudio = file.mimeType.startsWith('audio/')
        const invalid = status !== 'ready' && status !== 'reading'
        const detail = {
          reading: t('Reading attachment…'),
          ready: formatBytes(file.size),
          'too-large': t('File exceeds {limit} MB', { limit: image ? 20 : 50 }),
          empty: t('Empty file'),
          'read-failed': t('Could not read file')
        }[status]
        return (
          <li
            key={file.id}
            className={cn(
              'flex animate-mark-pop items-center gap-2 rounded-xl border border-line/70 bg-hover/80 py-1 pr-1.5 pl-1.5 text-[12px]',
              invalid && 'border-status-error/40 bg-status-error/5'
            )}
          >
            {isImg ? (
              <button
                type="button"
                title={t('Click to preview')}
                onClick={() => onPreview({ src: `data:${file.mimeType};base64,${file.dataBase64}`, name: file.name })}
                className="shrink-0 cursor-zoom-in rounded-lg"
              >
                <img
                  src={`data:${file.mimeType};base64,${file.dataBase64}`}
                  alt={file.name}
                  className="size-8 rounded-lg object-cover ring-1 ring-line/60"
                />
              </button>
            ) : (
              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-surface text-accent-600">
                {status === 'reading' ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : isVideo ? (
                  <Film className="size-3.5" aria-hidden />
                ) : isAudio ? (
                  <Music className="size-3.5" aria-hidden />
                ) : (
                  <FileText className="size-3.5 text-ink-secondary" aria-hidden />
                )}
              </span>
            )}
            <div className="min-w-0">
              <span className="block max-w-40 truncate font-medium text-ink">{file.name}</span>
              <span
                className={cn('block text-[11px] tabular-nums', invalid ? 'text-status-error' : 'text-ink-muted')}
                aria-live="polite"
              >
                {detail}
              </span>
            </div>
            <IconButton
              size="sm"
              label={t('Remove {name}', { name: file.name })}
              onClick={() => onRemove(file.id)}
              className="size-5 text-ink-muted hover:bg-active [&_svg]:size-3"
            >
              <X />
            </IconButton>
          </li>
        )
      })}
    </ul>
  )
}
