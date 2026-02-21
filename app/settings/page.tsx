'use client'

import { SettingsPage } from '@/components/settings/SettingsPage'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { useEffect, useRef } from 'react'

type WindowWithSettingsDirty = Window & {
  __settingsHasUnsaved?: boolean
  __settingsHasUnsavedProfile?: boolean
}
const SETTINGS_PATH = '/settings'
const POP_SUPPRESS_MS = 500

export default function Settings() {
  const suppressPopUntilRef = useRef(0)
  const getLeavePrompt = () => {
    const win = window as WindowWithSettingsDirty
    if (win.__settingsHasUnsavedProfile) {
      return 'You have unsaved profile changes. Leave settings anyway?'
    }
    return 'You have unsaved settings changes. Leave settings anyway?'
  }

  useEffect(() => {
    const guardState = { __settingsGuard: true }
    const currentState = window.history.state as { __settingsGuard?: boolean } | null
    if (!currentState?.__settingsGuard) {
      window.history.pushState(guardState, '', window.location.href)
    }

    const suppressNextPop = () => {
      suppressPopUntilRef.current = Date.now() + POP_SUPPRESS_MS
    }

    const onPopState = () => {
      if (Date.now() < suppressPopUntilRef.current) {
        return
      }

      const onSettingsPath = window.location.pathname === SETTINGS_PATH

      const dirty = (window as WindowWithSettingsDirty).__settingsHasUnsaved
      if (!dirty) {
        // Back from guard -> settings base still leaves us on settings.
        // Advance one more step so a single click leaves settings.
        if (!onSettingsPath) return
        suppressNextPop()
        window.history.back()
        return
      }

      const ok = window.confirm(getLeavePrompt())
      if (ok) {
        // If we already popped away from settings (forward to another page),
        // accept the navigation as-is.
        if (!onSettingsPath) return
        // Back from guard -> settings base; one more step leaves settings.
        suppressNextPop()
        window.history.back()
        return
      }

      // popstate is not cancelable; restore settings when user cancels.
      if (!onSettingsPath) {
        suppressNextPop()
        window.history.back()
        return
      }

      // Stayed on settings base entry after a back press: re-arm the guard.
      window.history.pushState(guardState, '', window.location.href)
    }

    window.addEventListener('popstate', onPopState)
    return () => {
      window.removeEventListener('popstate', onPopState)
    }
  }, [])

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6 flex items-center gap-3">
          <Link
            href="/"
            onClick={(e) => {
              const dirty = (window as WindowWithSettingsDirty).__settingsHasUnsaved
              if (!dirty) return
              const ok = window.confirm(getLeavePrompt())
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
