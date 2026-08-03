'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, CheckCircle, XCircle, Percent } from 'lucide-react'

import StatCard from '@/components/ui/stat-card'
import Button from '@/components/ui/button'
import Badge from '@/components/ui/badge'
import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeader,
  TableCell,
} from '@/components/ui/table'
import { useSession } from '@/hooks/use-session'
import { useRealtime } from '@/hooks/use-realtime'

interface ProductionSession {
  session_id: string
  shift_label: string | null
  shift_number: number | null
  start_time: string
  end_time: string | null
  total_spindles: number
  total_matched: number
  total_mismatched: number
  operator_id: string | null
}

interface SpindlePass {
  pass_id: string
  session_id: string
  toy_number: string
  entry_count: number
  exit_count: number | null
  entry_time: string
  exit_time: string | null
  status: 'in_progress' | 'matched' | 'mismatched'
  mismatch_delta: number | null
}

function msUntilNextShiftBoundary(): number {
  const now = new Date()
  const totalMs =
    ((now.getHours() * 60 + now.getMinutes()) * 60 + now.getSeconds()) * 1000 +
    now.getMilliseconds()
  const b1 = (8 * 60 + 40) * 60 * 1000  // 08:40
  const b2 = (15 * 60 + 45) * 60 * 1000 // 15:45
  const dayMs = 24 * 60 * 60 * 1000
  if (totalMs < b1) return b1 - totalMs
  if (totalMs < b2) return b2 - totalMs
  return dayMs - totalMs
}

export default function DashboardPage() {
  const { isLoading: authLoading } = useSession()
  const [session, setSession] = useState<ProductionSession | null>(null)
  const [spindles, setSpindles] = useState<SpindlePass[]>([])
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)

  const { data: realtimeSpindles } = useRealtime<SpindlePass>(
    'spindle_pass',
    session ? `session_id=eq.${session.session_id}` : undefined
  )

  const fetchActiveSession = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions?active=true')
      const json = await res.json()
      if (res.ok && json.data && json.data.length > 0) {
        setSession(json.data[0])
      } else {
        setSession(null)
      }
    } catch {
      setSession(null)
    }
  }, [])

  const fetchSpindles = useCallback(async (sessionId: string) => {
    try {
      const res = await fetch(`/api/spindles?session_id=${sessionId}`)
      const json = await res.json()
      if (res.ok && json.data) {
        setSpindles((current) => {
          const map = new Map(current.map((s) => [s.pass_id, s]))
          for (const item of json.data as SpindlePass[]) {
            map.set(item.pass_id, item)
          }
          return Array.from(map.values()).sort(
            (a, b) => new Date(b.entry_time).getTime() - new Date(a.entry_time).getTime()
          )
        })
      }
    } catch {}
  }, [])

  useEffect(() => {
    fetchActiveSession().finally(() => setLoading(false))
  }, [fetchActiveSession])

  useEffect(() => {
    if (!session?.session_id) {
      setSpindles([])
      return
    }
    fetchSpindles(session.session_id)
    const interval = setInterval(() => fetchSpindles(session.session_id), 5000)
    return () => clearInterval(interval)
  }, [session?.session_id, fetchSpindles])

  useEffect(() => {
    if (!session) return
    const ms = msUntilNextShiftBoundary()
    const timer = setTimeout(async () => {
      await fetch(`/api/sessions/${session.session_id}`, { method: 'PATCH' })
      const res = await fetch('/api/sessions', { method: 'POST' })
      const json = await res.json()
      if (res.ok) {
        setSession(json.data)
        setSpindles([])
      } else {
        setSession(null)
      }
    }, ms)
    return () => clearTimeout(timer)
  }, [session?.session_id])

  useEffect(() => {
    if (realtimeSpindles.length === 0) return
    setSpindles((current) => {
      const map = new Map(current.map((s) => [s.pass_id, s]))
      for (const item of realtimeSpindles) {
        map.set(item.pass_id, item)
      }
      return Array.from(map.values()).sort(
        (a, b) => new Date(b.entry_time).getTime() - new Date(a.entry_time).getTime()
      )
    })
  }, [realtimeSpindles])

  const stats = useMemo(() => {
    const total = spindles.length
    const matched = spindles.filter((s) => s.status === 'matched').length
    const mismatched = spindles.filter((s) => s.status === 'mismatched').length
    const completed = matched + mismatched
    const rate = completed > 0 ? Math.round((matched / completed) * 100) : 0
    return { total, matched, mismatched, rate }
  }, [spindles])

  const handleStartSession = async () => {
    setActionLoading(true)
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
      })
      const json = await res.json()
      if (res.ok) setSession(json.data)
    } finally {
      setActionLoading(false)
    }
  }

  const handleEndSession = async () => {
    if (!session) return
    setActionLoading(true)
    try {
      const res = await fetch(`/api/sessions/${session.session_id}`, {
        method: 'PATCH',
      })
      if (res.ok) {
        setSession(null)
        setSpindles([])
      }
    } finally {
      setActionLoading(false)
    }
  }

  if (loading || authLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#E2E8F0] border-t-[#0EA5E9]" />
      </div>
    )
  }

  return (
    <div className="p-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#1E293B]">Production Dashboard</h1>
          <p className="mt-1 text-sm text-[#64748B]">Line A — Spray Painting Station</p>
          {session && (
            <p className="mt-0.5 text-sm font-medium text-[#0EA5E9]">
              {session.shift_label ?? `Shift ${session.shift_number}`}
              {' • '}
              {new Date(session.start_time).toLocaleDateString('en-US', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {!session ? (
            <Button
              variant="success"
              size="md"
              loading={actionLoading}
              onClick={handleStartSession}
              className="h-10 rounded-md px-5"
            >
              START OPERATION
            </Button>
          ) : (
            <>
              <Button
                variant="outline-danger"
                size="md"
                loading={actionLoading}
                onClick={handleEndSession}
                className="h-10 rounded-md px-5"
              >
                STOP
              </Button>
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-[#22C55E]" />
                <span className="text-xs font-semibold text-[#22C55E]">LIVE</span>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="mb-8 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Activity}
          iconColor="#0EA5E9"
          title="Total Spindles"
          value={stats.total}
        />
        <StatCard
          icon={CheckCircle}
          iconColor="#22C55E"
          title="Matched"
          value={stats.matched}
        />
        <StatCard
          icon={XCircle}
          iconColor="#EF4444"
          title="Mismatched"
          value={stats.mismatched}
        />
        <StatCard
          icon={Percent}
          iconColor="#F59E0B"
          title="Match Rate"
          value={`${stats.rate}%`}
        />
      </div>

      <div>
        <h2 className="mb-4 text-lg font-semibold text-[#1E293B]">Spindle Passes</h2>
        <Table>
          <TableHead>
            <TableRow>
              <TableHeader>Toy Number</TableHeader>
              <TableHeader>Entry Count</TableHeader>
              <TableHeader>Exit Count</TableHeader>
              <TableHeader>Delta</TableHeader>
              <TableHeader>Entry Time</TableHeader>
              <TableHeader>Status</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {spindles.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-[#94A3B8]">
                  No spindle passes recorded yet
                </TableCell>
              </TableRow>
            ) : (
              spindles.map((s) => (
                <TableRow key={s.pass_id}>
                  <TableCell className="font-medium">{s.toy_number}</TableCell>
                  <TableCell>{s.entry_count}</TableCell>
                  <TableCell>{s.exit_count ?? '—'}</TableCell>
                  <TableCell>
                    {s.mismatch_delta != null
                      ? s.mismatch_delta === 0
                        ? '—'
                        : s.mismatch_delta > 0
                          ? `+${s.mismatch_delta}`
                          : `${s.mismatch_delta}`
                      : '—'}
                  </TableCell>
                  <TableCell>
                    {new Date(s.entry_time).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        s.status === 'matched'
                          ? 'success'
                          : s.status === 'mismatched'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {s.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
