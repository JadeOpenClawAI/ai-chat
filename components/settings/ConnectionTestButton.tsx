'use client'

import { useState } from 'react'
import { Loader2, CheckCircle2, XCircle } from 'lucide-react'

interface TestResult {
  ok: boolean
  error?: string
  tokens?: number
  response?: string
}

interface Props {
  provider: string
  model?: string
  onResult?: (result: TestResult) => void
}

export function ConnectionTestButton({ provider, model, onResult }: Props) {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)

  async function handleTest() {
    setLoading(true)
    setResult(null)
    try {
      const res = await fetch('/api/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, model }),
      })
      const data = (await res.json()) as TestResult
      setResult(data)
      onResult?.(data)
    } catch (err) {
      const r: TestResult = { ok: false, error: err instanceof Error ? err.message : 'Network error' }
      setResult(r)
      onResult?.(r)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={handleTest}
        disabled={loading}
        className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800"
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <span className="h-3.5 w-3.5 text-xs">⚡</span>
        )}
        Test Connection
      </button>
      {result && (
        <div
          className={`flex items-center gap-1.5 text-xs ${
            result.ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
          }`}
        >
          {result.ok ? (
            <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
          ) : (
            <XCircle className="h-3.5 w-3.5 flex-shrink-0" />
          )}
          <span>
            {result.ok
              ? `Connection OK — ${result.tokens ?? 0} tokens used`
              : result.error ?? 'Connection failed'}
          </span>
        </div>
      )}
    </div>
  )
}
