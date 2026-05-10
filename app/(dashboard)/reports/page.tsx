'use client'

import { useState, useEffect, useCallback } from 'react'
import { useSession } from '@/hooks/use-session'
import StatCard from '@/components/ui/stat-card'
import Button from '@/components/ui/button'
import {
  Table,
  TableHead,
  TableBody,
  TableRow,
  TableHeader,
  TableCell,
} from '@/components/ui/table'
import Badge from '@/components/ui/badge'
import {
  FileText,
  FileSpreadsheet,
  FileIcon,
  AlertCircle,
  Loader2,
  BarChart3,
  CheckCircle2,
  XCircle,
  Layers,
} from 'lucide-react'

interface SessionRow {
  session_id: string
  shift_label: string | null
  start_time: string
  end_time: string | null
  total_spindles: number
  total_matched: number
  total_mismatched: number
  operator_id: string | null
}

interface Summary {
  totalSessions: number
  totalSpindles: number
  totalMatched: number
  totalMismatched: number
}

export default function ReportsPage() {
  const { role, isLoading: sessionLoading } = useSession()
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [shiftLabel, setShiftLabel] = useState('all')
  const [shiftLabels, setShiftLabels] = useState<string[]>([])
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [summary, setSummary] = useState<Summary>({
    totalSessions: 0,
    totalSpindles: 0,
    totalMatched: 0,
    totalMismatched: 0,
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const today = new Date()
    const lastWeek = new Date(today)
    lastWeek.setDate(today.getDate() - 7)
    setFrom(lastWeek.toISOString().split('T')[0])
    setTo(today.toISOString().split('T')[0])
  }, [])

  const fetchReports = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams()
      if (from) params.set('from', from)
      if (to) params.set('to', to)
      if (shiftLabel && shiftLabel !== 'all')
        params.set('shift_label', shiftLabel)

      const res = await fetch(`/api/reports?${params.toString()}`)
      if (res.status === 403) {
        setError('You do not have permission to view reports.')
        setSessions([])
        return
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || 'Failed to fetch reports')
      }
      const data = await res.json()
      const fetchedSessions: SessionRow[] = data.sessions || []
      setSessions(fetchedSessions)
      setSummary(
        data.summary || {
          totalSessions: 0,
          totalSpindles: 0,
          totalMatched: 0,
          totalMismatched: 0,
        }
      )

      const unique = Array.from(
        new Set(
          fetchedSessions
            .map((s) => s.shift_label)
            .filter((l): l is string => Boolean(l))
        )
      )
      setShiftLabels((prev) => {
        const combined = Array.from(new Set([...prev, ...unique]))
        return combined.sort()
      })
    } catch (err: any) {
      setError(err.message || 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }, [from, to, shiftLabel])

  useEffect(() => {
    if (from && to) {
      fetchReports()
    }
  }, [from, to, fetchReports])

  const handleExport = async (format: 'csv' | 'pdf') => {
    const params = new URLSearchParams()
    params.set('format', format)
    if (from) params.set('from', from)
    if (to) params.set('to', to)
    if (shiftLabel && shiftLabel !== 'all')
      params.set('shift_label', shiftLabel)

    const res = await fetch(`/api/reports/export?${params.toString()}`)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      alert(data.error || 'Export failed')
      return
    }

    const blob = await res.blob()
    const url = window.URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const contentDisposition = res.headers.get('content-disposition')
    const filenameMatch = contentDisposition?.match(/filename="([^"]+)"/)
    a.download = filenameMatch?.[1] || `report.${format}`
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.URL.revokeObjectURL(url)
  }

  if (sessionLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-[#0EA5E9]" />
      </div>
    )
  }

  if (role === 'operator') {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8">
        <AlertCircle className="h-12 w-12 text-[#EF4444]" />
        <h1 className="mt-4 text-xl font-semibold text-[#1E293B]">
          Access Denied
        </h1>
        <p className="mt-2 text-[#64748B]">
          Operators do not have access to reports.
        </p>
      </div>
    )
  }

  const mismatchRate =
    summary.totalSpindles > 0
      ? ((summary.totalMismatched / summary.totalSpindles) * 100).toFixed(1)
      : '0.0'

  return (
    <div className="p-8">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#1E293B]">
            Reports & Analytics
          </h1>
          <p className="mt-1 text-[#64748B]">
            View and export production session data.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={() => handleExport('csv')}
            disabled={loading || sessions.length === 0}
          >
            <FileSpreadsheet className="mr-2 h-4 w-4" />
            Export CSV
          </Button>
          <Button
            variant="secondary"
            onClick={() => handleExport('pdf')}
            disabled={loading || sessions.length === 0}
          >
            <FileIcon className="mr-2 h-4 w-4" />
            Export PDF
          </Button>
        </div>
      </div>

      <div className="mb-6 rounded-xl border border-[#E2E8F0] bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-[200px] flex-1">
            <label className="mb-1 block text-sm font-medium text-[#1E293B]">
              From Date
            </label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="block w-full rounded-lg border border-[#E2E8F0] bg-white px-3 py-2 text-sm text-[#1E293B] focus:border-[#0EA5E9] focus:outline-none focus:ring-2 focus:ring-[#0EA5E9]/20"
            />
          </div>
          <div className="min-w-[200px] flex-1">
            <label className="mb-1 block text-sm font-medium text-[#1E293B]">
              To Date
            </label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="block w-full rounded-lg border border-[#E2E8F0] bg-white px-3 py-2 text-sm text-[#1E293B] focus:border-[#0EA5E9] focus:outline-none focus:ring-2 focus:ring-[#0EA5E9]/20"
            />
          </div>
          <div className="min-w-[200px] flex-1">
            <label className="mb-1 block text-sm font-medium text-[#1E293B]">
              Shift Label
            </label>
            <select
              value={shiftLabel}
              onChange={(e) => setShiftLabel(e.target.value)}
              className="block w-full rounded-lg border border-[#E2E8F0] bg-white px-3 py-2 text-sm text-[#1E293B] focus:border-[#0EA5E9] focus:outline-none focus:ring-2 focus:ring-[#0EA5E9]/20"
            >
              <option value="all">All Shifts</option>
              {shiftLabels.map((label) => (
                <option key={label} value={label}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <Button onClick={fetchReports} loading={loading}>
            <BarChart3 className="mr-2 h-4 w-4" />
            Generate Report
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-6 flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-600">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={FileText}
          iconColor="#0EA5E9"
          title="Total Sessions"
          value={summary.totalSessions}
        />
        <StatCard
          icon={Layers}
          iconColor="#6366F1"
          title="Total Spindles"
          value={summary.totalSpindles}
        />
        <StatCard
          icon={CheckCircle2}
          iconColor="#22C55E"
          title="Total Matched"
          value={summary.totalMatched}
        />
        <StatCard
          icon={XCircle}
          iconColor="#EF4444"
          title="Mismatch Rate"
          value={`${mismatchRate}%`}
          trend={{
            value: parseFloat(mismatchRate),
            label: 'of total spindles',
            positive: parseFloat(mismatchRate) < 5,
          }}
        />
      </div>

      <div className="rounded-xl border border-[#E2E8F0] bg-white p-5 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold text-[#1E293B]">
          Production Sessions
        </h2>
        {sessions.length === 0 && !loading ? (
          <p className="py-8 text-center text-[#94A3B8]">
            No sessions found for the selected filters.
          </p>
        ) : (
          <Table>
            <TableHead>
              <TableRow>
                <TableHeader>Session ID</TableHeader>
                <TableHeader>Shift</TableHeader>
                <TableHeader>Start Time</TableHeader>
                <TableHeader>End Time</TableHeader>
                <TableHeader>Spindles</TableHeader>
                <TableHeader>Matched</TableHeader>
                <TableHeader>Mismatched</TableHeader>
                <TableHeader>Status</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {sessions.map((session) => (
                <TableRow key={session.session_id}>
                  <TableCell className="font-mono text-xs">
                    {session.session_id.slice(0, 8)}...
                  </TableCell>
                  <TableCell>{session.shift_label || '-'}</TableCell>
                  <TableCell>
                    {new Date(session.start_time).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    {session.end_time
                      ? new Date(session.end_time).toLocaleString()
                      : '-'}
                  </TableCell>
                  <TableCell>{session.total_spindles}</TableCell>
                  <TableCell>{session.total_matched}</TableCell>
                  <TableCell>{session.total_mismatched}</TableCell>
                  <TableCell>
                    {session.end_time ? (
                      <Badge variant="success">Completed</Badge>
                    ) : (
                      <Badge variant="warning">In Progress</Badge>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}
