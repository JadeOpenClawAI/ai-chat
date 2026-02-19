// ============================================================
// Message Input Component
// Textarea with file upload, drag & drop, and send controls
// ============================================================

'use client'

import {
  useRef,
  useCallback,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react'
import { useDropzone } from 'react-dropzone'
import type { FileAttachment } from '@/lib/types'
import { useFileUpload } from '@/hooks/useFileUpload'
import { AttachmentList } from './FilePreview'
import { Paperclip, Send, Square, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface MessageInputProps {
  value: string
  onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void
  onSend: () => void
  onStop?: () => void
  isLoading: boolean
  pendingAttachments: FileAttachment[]
  onAddAttachment: (file: FileAttachment) => void
  onRemoveAttachment: (id: string) => void
  disabled?: boolean
}

export function MessageInput({
  value,
  onChange,
  onSend,
  onStop,
  isLoading,
  pendingAttachments,
  onAddAttachment,
  onRemoveAttachment,
  disabled = false,
}: MessageInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { processFiles, isProcessing, error, acceptedTypes } = useFileUpload(
    onAddAttachment,
  )

  // Handle drag & drop
  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop: (accepted) => processFiles(accepted),
    accept: Object.fromEntries(
      acceptedTypes.split(',').map((t) => [t, []]),
    ),
    noClick: true,
    noKeyboard: true,
    maxSize: 10 * 1024 * 1024,
  })

  // Auto-resize textarea
  const handleChange = useCallback(
    (e: ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e)
      const target = e.target
      target.style.height = 'auto'
      target.style.height = `${Math.min(target.scrollHeight, 200)}px`
    },
    [onChange],
  )

  // Send on Enter (Shift+Enter for newline)
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey && !isLoading) {
        e.preventDefault()
        if (value.trim() || pendingAttachments.length > 0) {
          onSend()
          // Reset height after send
          if (textareaRef.current) {
            textareaRef.current.style.height = 'auto'
          }
        }
      }
    },
    [isLoading, onSend, value, pendingAttachments.length],
  )

  const canSend = (value.trim().length > 0 || pendingAttachments.length > 0) && !disabled

  return (
    <div
      {...getRootProps()}
      className={cn(
        'relative rounded-2xl border border-gray-200 bg-white shadow-sm transition-all dark:border-gray-700 dark:bg-gray-900',
        isDragActive && 'border-blue-400 ring-2 ring-blue-300 dark:border-blue-500',
        disabled && 'opacity-60',
      )}
    >
      {/* Drag overlay */}
      {isDragActive && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-blue-50/80 dark:bg-blue-950/80">
          <p className="text-sm font-medium text-blue-600 dark:text-blue-300">
            Drop files here...
          </p>
        </div>
      )}

      {/* Attachment previews */}
      {pendingAttachments.length > 0 && (
        <div className="border-b border-gray-100 px-3 pt-3 dark:border-gray-800">
          <AttachmentList
            attachments={pendingAttachments}
            onRemove={onRemoveAttachment}
            compact
          />
          <div className="h-2" />
        </div>
      )}

      {/* Textarea */}
      <div className="flex items-end gap-2 px-3 py-2">
        {/* File attach button */}
        <button
          type="button"
          onClick={open}
          disabled={disabled || isProcessing}
          className="flex-shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 disabled:opacity-40 dark:hover:bg-gray-800 dark:hover:text-gray-300"
          title="Attach file"
        >
          {isProcessing ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Paperclip className="h-5 w-5" />
          )}
        </button>

        <input {...getInputProps()} />

        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Message AI Chat... (Shift+Enter for new line)"
          disabled={disabled}
          rows={1}
          className={cn(
            'max-h-[200px] min-h-[36px] w-full resize-none bg-transparent text-sm text-gray-900 placeholder-gray-400 outline-none dark:text-gray-100 dark:placeholder-gray-500',
          )}
          style={{ height: 'auto' }}
        />

        {/* Send / Stop button */}
        {isLoading ? (
          <button
            type="button"
            onClick={onStop}
            className="flex-shrink-0 rounded-lg bg-gray-200 p-1.5 text-gray-600 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
            title="Stop generation"
          >
            <Square className="h-5 w-5" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              if (canSend) {
                onSend()
                if (textareaRef.current) {
                  textareaRef.current.style.height = 'auto'
                }
              }
            }}
            disabled={!canSend}
            className={cn(
              'flex-shrink-0 rounded-lg p-1.5 transition-colors',
              canSend
                ? 'bg-gray-900 text-white hover:bg-gray-700 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200'
                : 'bg-gray-100 text-gray-300 dark:bg-gray-800 dark:text-gray-600',
            )}
            title="Send message"
          >
            <Send className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* Error message */}
      {error && (
        <div className="border-t border-red-100 px-3 py-1.5 text-xs text-red-600 dark:border-red-900 dark:text-red-400">
          {error}
        </div>
      )}
    </div>
  )
}
