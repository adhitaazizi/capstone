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
  start_time: string
  end_time: string | null
  total_spindles: number
  total_matched: number
  total_mismatched: number
  operator_id: string | null
}

interface SpindlePass {
  spindle_pass_id: string
  session_id: string
  entry_count: number
  exit_count: number | null
  entry_time: string
  exit_time: string | null
  status: 'in_progress' | 'matched' | 'mismatched'
  mismatch_delta: number | null
}

export default function DashboardPage() {
  const { user, isLoading: authLoading } = useSession()
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
        setSpindles(json.data)
      }
    } catch {
    }
  }, [])

  useEffect(() => {
    fetchActiveSession().finally(() => setLoading(false))
  }, [fetchActiveSession])

  useEffect(() => {
    if (session?.session_id) {
      fetchSpindles(session.session_id)
    } else {
      setSpindles([])
    }
  }, [session, fetchSpindles])

  useEffect(() => {
    if (realtimeSpindles.length > 0) {
      setSpindles((current) => {
        const map = new Map(current.map((s) => [s.spindle_pass_id, s]))
        for (const item of realtimeSpindles) {
          map.set(item.spindle_pass_id, item)
        }
        return Array.from(map.values()).sort(
          (a, b) =>
            new Date(b.entry_time).getTime() - new Date(a.entry_time).getTime()
        )
      })
    }
  }, [realtimeSpindles])

  const stats = useMemo(() => {
    const total = spindles.length
    const matched = spindles.filter((s) => s.status === 'matched').length
    const mismatched = spindles.filter((s) => s.status === 'mismatched').length
    const rate = total > 0 ? Math.round((matched / total) * 100) : 0
    return { total, matched, mismatched, rate }
  }, [spindles])

  const handleStartSession = async () => {
    setActionLoading(true)
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shift_label: 'Production Shift' }),
      })
      const json = await res.json()
      if (res.ok) {
        setSession(json.data)
      }
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
      const json = await res.json()
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
          <p className="mt-1 text-sm text-[#64748B]">
            Line A — Spray Painting Station
          </p>
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
        <h2 className="mb-4 text-lg font-semibold text-[#1E293B]">
          Spindle Passes
        </h2>
        <Table>
          <TableHead>
            <TableRow>
              <TableHeader>Pass ID</TableHeader>
              <TableHeader>Entry Count</TableHeader>
              <TableHeader>Exit Count</TableHeader>
              <TableHeader>Entry Time</TableHeader>
              <TableHeader>Status</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {spindles.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-[#94A3B8]">
                  No spindle passes recorded yet
                </TableCell>
              </TableRow>
            ) : (
              spindles.map((spindle) => (
                <TableRow key={spindle.spindle_pass_id}>
                  <TableCell className="font-medium">
                    {spindle.spindle_pass_id.slice(0, 8)}
                  </TableCell>
                  <TableCell>{spindle.entry_count}</TableCell>
                  <TableCell>{spindle.exit_count ?? '-'}</TableCell>
                  <TableCell>
                    {new Date(spindle.entry_time).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        spindle.status === 'matched'
                          ? 'success'
                          : spindle.status === 'mismatched'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {spindle.status}
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
