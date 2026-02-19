// ============================================================
// File Preview Component
// Shows thumbnails/icons for attached files before sending
// ============================================================

'use client'

import type { FileAttachment } from '@/lib/types'
import { formatBytes } from '@/lib/utils'
import { X, FileText, Film, Image as ImageIcon } from 'lucide-react'

interface FilePreviewProps {
  attachment: FileAttachment
  onRemove?: () => void
  compact?: boolean
}

export function FilePreview({
  attachment,
  onRemove,
  compact = false,
}: FilePreviewProps) {
  const { name, type, size, dataUrl, thumbnailUrl } = attachment

  if (compact) {
    return (
      <div className="group relative flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-800">
        <FileTypeIcon type={type} className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="max-w-[120px] truncate text-gray-700 dark:text-gray-300">
          {name}
        </span>
        {onRemove && (
          <button
            onClick={onRemove}
            className="ml-1 rounded-full p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-600 dark:hover:bg-gray-700"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="group relative w-24 flex-shrink-0">
      {/* Preview area */}
      <div className="relative h-20 w-full overflow-hidden rounded-lg border border-gray-200 bg-gray-100 dark:border-gray-700 dark:bg-gray-800">
        {type === 'image' && dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={dataUrl}
            alt={name}
            className="h-full w-full object-cover"
          />
        ) : type === 'video' && thumbnailUrl ? (
          <div className="relative h-full w-full">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={thumbnailUrl}
              alt={name}
              className="h-full w-full object-cover"
            />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="rounded-full bg-black/50 p-1">
                <Film className="h-4 w-4 text-white" />
              </div>
            </div>
          </div>
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1">
            <FileTypeIcon type={type} className="h-8 w-8 text-gray-400" />
          </div>
        )}

        {/* Remove button */}
        {onRemove && (
          <button
            onClick={onRemove}
            className="absolute right-1 top-1 rounded-full bg-gray-900/70 p-0.5 text-white opacity-0 transition-opacity hover:bg-gray-900 group-hover:opacity-100"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Filename */}
      <p className="mt-1 truncate text-center text-xs text-gray-500 dark:text-gray-400">
        {name}
      </p>
      <p className="text-center text-xs text-gray-400">{formatBytes(size)}</p>
    </div>
  )
}

// ── File type icon helper ────────────────────────────────────

function FileTypeIcon({
  type,
  className,
}: {
  type: FileAttachment['type']
  className?: string
}) {
  switch (type) {
    case 'image':
      return <ImageIcon className={className} />
    case 'video':
      return <Film className={className} />
    default:
      return <FileText className={className} />
  }
}

// ── Attachment list ───────────────────────────────────────────

interface AttachmentListProps {
  attachments: FileAttachment[]
  onRemove?: (id: string) => void
  compact?: boolean
}

export function AttachmentList({
  attachments,
  onRemove,
  compact = false,
}: AttachmentListProps) {
  if (attachments.length === 0) return null

  if (compact) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {attachments.map((a) => (
          <FilePreview
            key={a.id}
            attachment={a}
            onRemove={onRemove ? () => onRemove(a.id) : undefined}
            compact
          />
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-3">
      {attachments.map((a) => (
        <FilePreview
          key={a.id}
          attachment={a}
          onRemove={onRemove ? () => onRemove(a.id) : undefined}
        />
      ))}
    </div>
  )
}
