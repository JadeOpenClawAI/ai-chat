// ============================================================
// useFileUpload — drag & drop, preview, and base64 conversion
// ============================================================

'use client'

import { useCallback, useState } from 'react'
import type { FileAttachment } from '@/lib/types'

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

const ACCEPTED_TYPES = {
  image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  document: [
    'text/plain',
    'text/markdown',
    'application/pdf',
    'application/json',
    'text/csv',
  ],
  video: ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime'],
}

const ALL_ACCEPTED = [
  ...ACCEPTED_TYPES.image,
  ...ACCEPTED_TYPES.document,
  ...ACCEPTED_TYPES.video,
]

function getFileType(mimeType: string): FileAttachment['type'] {
  if (ACCEPTED_TYPES.image.includes(mimeType)) return 'image'
  if (ACCEPTED_TYPES.video.includes(mimeType)) return 'video'
  return 'document'
}

/** Reads a file as a base64 data URL */
async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

/** Reads a text file as string */
async function fileToText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsText(file)
  })
}

/** Extracts first frame of video as an image data URL */
async function videoToThumbnail(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    const url = URL.createObjectURL(file)
    video.src = url
    video.muted = true
    video.currentTime = 1

    video.onloadeddata = () => {
      const canvas = document.createElement('canvas')
      canvas.width = video.videoWidth
      canvas.height = video.videoHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Canvas context unavailable'))
        return
      }
      ctx.drawImage(video, 0, 0)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/jpeg', 0.8))
    }
    video.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to load video'))
    }
  })
}

/** Processes a File into a FileAttachment */
async function processFile(file: File): Promise<FileAttachment> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const type = getFileType(file.type)

  const base: FileAttachment = {
    id,
    name: file.name,
    type,
    mimeType: file.type,
    size: file.size,
  }

  if (type === 'image') {
    base.dataUrl = await fileToDataUrl(file)
  } else if (type === 'video') {
    try {
      base.thumbnailUrl = await videoToThumbnail(file)
    } catch {
      // Thumbnail failed, that's ok
    }
  } else if (type === 'document') {
    // Try to read as text (works for txt, md, json, csv; not PDF)
    if (
      file.type !== 'application/pdf' &&
      (file.type.startsWith('text/') || file.type === 'application/json')
    ) {
      try {
        base.textContent = await fileToText(file)
      } catch {
        // Text read failed
      }
    } else if (file.type === 'application/pdf') {
      // PDF: In production, use a PDF parser like pdf-parse or pdf.js
      base.textContent = `[PDF file: ${file.name} — PDF text extraction requires server-side processing]`
    }
  }

  return base
}

// ── Hook ──────────────────────────────────────────────────────

interface UseFileUploadReturn {
  processFiles: (files: File[]) => Promise<FileAttachment[]>
  isProcessing: boolean
  error: string | null
  acceptedTypes: string
}

export function useFileUpload(
  onAttach: (file: FileAttachment) => void,
): UseFileUploadReturn {
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const processFiles = useCallback(
    async (files: File[]): Promise<FileAttachment[]> => {
      setError(null)
      setIsProcessing(true)
      const results: FileAttachment[] = []

      try {
        for (const file of files) {
          // Validate type
          if (!ALL_ACCEPTED.includes(file.type)) {
            setError(`Unsupported file type: ${file.type}`)
            continue
          }
          // Validate size
          if (file.size > MAX_FILE_SIZE) {
            setError(
              `File ${file.name} is too large (max ${MAX_FILE_SIZE / 1024 / 1024} MB)`,
            )
            continue
          }

          const attachment = await processFile(file)
          onAttach(attachment)
          results.push(attachment)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to process file')
      } finally {
        setIsProcessing(false)
      }

      return results
    },
    [onAttach],
  )

  return {
    processFiles,
    isProcessing,
    error,
    acceptedTypes: ALL_ACCEPTED.join(','),
  }
}
