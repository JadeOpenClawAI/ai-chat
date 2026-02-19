'use client'

import { SettingsPage } from '@/components/settings/SettingsPage'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'

type WindowWithSettingsDirty = Window & { __settingsHasUnsaved?: boolean }

export default function Settings() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6 flex items-center gap-3">
          <Link
            href="/"
            onClick={(e) => {
              const dirty = (window as WindowWithSettingsDirty).__settingsHasUnsaved
              if (!dirty) return
              const ok = window.confirm('You have unsaved profile changes. Leave settings anyway?')
              if (!ok) e.preventDefault()
            }}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Chat
          </Link>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Settings
          </h1>
        </div>
        <SettingsPage />
      </div>
    </div>
  )
}
