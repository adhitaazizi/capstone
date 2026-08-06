'use client'

import { useEffect, useState } from 'react'
import { AlertTriangle, ArrowLeft, Loader2, Save } from 'lucide-react'
import Link from 'next/link'

import { useSession } from '@/hooks/use-session'
import { CAMERAS } from '@/lib/cameras'

interface SettingRow {
  key: string
  label: string
  description: string
  type: 'number' | 'string'
  appliesLive: boolean
  required: boolean
  isCameraId?: boolean
  min?: number
  max?: number
  step?: number
  value: string
  updatedAt: string | null
}

export default function PipelineSettingsPage() {
  const { isAdmin, isLoading: sessionLoading } = useSession()
  const [settings, setSettings] = useState<SettingRow[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!isAdmin) return
    fetch('/api/settings')
      .then((r) => r.json())
      .then((body) => {
        if (body.error) throw new Error(body.error)
        setSettings(body.settings)
        setDrafts(
          Object.fromEntries((body.settings as SettingRow[]).map((s) => [s.key, s.value]))
        )
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [isAdmin])

  function clientError(s: SettingRow): string | null {
    const draft = (drafts[s.key] ?? '').trim()
    if (draft === '') return s.required ? 'Required.' : null
    if (s.type === 'number') {
      const parsed = Number(draft)
      if (!Number.isFinite(parsed)) return 'Must be a number.'
      if (s.min !== undefined && parsed < s.min) return `Must be at least ${s.min}.`
      if (s.max !== undefined && parsed > s.max) return `Must be at most ${s.max}.`
    }
    return null
  }

  async function save(key: string) {
    setSavingKey(key)
    setError(null)
    setFieldErrors((prev) => ({ ...prev, [key]: '' }))
    try {
      const resp = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ updates: { [key]: drafts[key] } }),
      })
      const body = await resp.json()
      if (!resp.ok) {
        if (body.fieldErrors) {
          setFieldErrors((prev) => ({ ...prev, ...body.fieldErrors }))
        }
        throw new Error(body.error ?? 'Save failed')
      }
      setSettings((prev) =>
        prev.map((s) => (s.key === key ? { ...s, value: drafts[key] } : s))
      )
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSavingKey(null)
    }
  }

  if (sessionLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#E2E8F0] border-t-[#0EA5E9]" />
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8">
        <AlertTriangle className="h-12 w-12 text-[#EF4444]" />
        <h1 className="mt-4 text-xl font-semibold text-[#1E293B]">Access Denied</h1>
        <p className="mt-2 text-[#64748B]">Only administrators can access settings.</p>
      </div>
    )
  }

  const live = settings.filter((s) => s.appliesLive)
  const restartRequired = settings.filter((s) => !s.appliesLive)

  function group(title: string, rows: SettingRow[], note: string) {
    if (rows.length === 0) return null
    return (
      <div className="mb-8 rounded-xl border border-[#E2E8F0] bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-[#1E293B]">{title}</h2>
        <p className="mt-1 text-xs text-[#94A3B8]">{note}</p>
        <div className="mt-4 space-y-4">
          {rows.map((s) => {
            const err = fieldErrors[s.key] || clientError(s)
            const unchanged = drafts[s.key] === s.value
            return (
              <div
                key={s.key}
                className="flex flex-col gap-2 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-4 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="flex-1">
                  <p className="text-sm font-medium text-[#1E293B]">
                    {s.label}
                    {s.required && <span className="ml-1 text-[#EF4444]">*</span>}
                  </p>
                  <p className="mt-1 text-xs text-[#64748B]">{s.description}</p>
                  {err && <p className="mt-1 text-xs font-medium text-[#EF4444]">{err}</p>}
                </div>
                <div className="flex items-center gap-2">
                  {s.isCameraId ? (
                    <select
                      value={drafts[s.key] ?? ''}
                      onChange={(e) =>
                        setDrafts((prev) => ({ ...prev, [s.key]: e.target.value }))
                      }
                      className="w-48 rounded-md border border-[#E2E8F0] px-3 py-1.5 text-sm text-[#1E293B] focus:border-[#0EA5E9] focus:outline-none"
                    >
                      <option value="" disabled>
                        Select a camera…
                      </option>
                      {CAMERAS.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.id})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={s.type === 'number' ? 'number' : 'text'}
                      min={s.min}
                      max={s.max}
                      step={s.step ?? (s.type === 'number' ? 'any' : undefined)}
                      value={drafts[s.key] ?? ''}
                      onChange={(e) =>
                        setDrafts((prev) => ({ ...prev, [s.key]: e.target.value }))
                      }
                      className="w-40 rounded-md border border-[#E2E8F0] px-3 py-1.5 text-sm text-[#1E293B] focus:border-[#0EA5E9] focus:outline-none"
                    />
                  )}
                  <button
                    onClick={() => save(s.key)}
                    disabled={savingKey === s.key || unchanged || !!err}
                    className="flex items-center gap-1 rounded-md bg-[#0EA5E9] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
                  >
                    {savingKey === s.key ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Save className="h-3.5 w-3.5" />
                    )}
                    Save
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="p-8">
      <Link
        href="/settings"
        className="mb-4 inline-flex items-center gap-1 text-sm text-[#64748B] hover:text-[#1E293B]"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Settings
      </Link>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-[#1E293B]">Pipeline Settings</h1>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-[#FCA5A5] bg-[#FEF2F2] p-3 text-sm text-[#B91C1C]">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center p-12">
          <Loader2 className="h-6 w-6 animate-spin text-[#0EA5E9]" />
        </div>
      ) : (
        <>
          {group(
            'Applies immediately',
            live,
            'Read fresh on every request/frame — takes effect within a few seconds, no restart needed.'
          )}
          {group(
            'Requires a nextjs restart',
            restartRequired,
            'Snapshotted into the in-process FIFO pairing queue and interval aggregator at startup — changing these mid-run risks corrupting in-flight spindle passes, so they only take effect after `docker compose up -d --build nextjs` (or an equivalent restart).'
          )}
        </>
      )}
    </div>
  )
}
