'use client'

import { Plus, X } from 'lucide-react'

interface Props {
  headers: Record<string, string>
  onChange: (headers: Record<string, string>) => void
}

export function ExtraHeadersEditor({ headers, onChange }: Props) {
  const entries = Object.entries(headers)

  function updateKey(oldKey: string, newKey: string) {
    const updated: Record<string, string> = {}
    for (const [k, v] of Object.entries(headers)) {
      updated[k === oldKey ? newKey : k] = v
    }
    onChange(updated)
  }

  function updateValue(key: string, value: string) {
    onChange({ ...headers, [key]: value })
  }

  function removeEntry(key: string) {
    const updated = { ...headers }
    delete updated[key]
    onChange(updated)
  }

  function addEntry() {
    // find a unique key name
    let i = 1
    while (`X-Header-${i}` in headers) i++
    onChange({ ...headers, [`X-Header-${i}`]: '' })
  }

  return (
    <div className="space-y-2">
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-2">
          <input
            type="text"
            value={key}
            onChange={(e) => updateKey(key, e.target.value)}
            placeholder="Header name"
            className="w-40 flex-shrink-0 rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
          />
          <input
            type="text"
            value={value}
            onChange={(e) => updateValue(key, e.target.value)}
            placeholder="Value"
            className="min-w-0 flex-1 rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300"
          />
          <button
            type="button"
            onClick={() => removeEntry(key)}
            className="flex-shrink-0 rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addEntry}
        className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
      >
        <Plus className="h-3.5 w-3.5" />
        Add Header
      </button>
    </div>
  )
}
