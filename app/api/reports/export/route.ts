import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { createServerClient } from '@/lib/supabase/server'
import { renderToStream } from '@react-pdf/renderer'
import React from 'react'
import { ReportPDF } from '@/components/report-pdf'

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const role = (session.user as any).role
  if (!['supervisor', 'admin'].includes(role)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(request.url)
  const format = searchParams.get('format')
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  const shiftLabel = searchParams.get('shift_label')

  const supabase = createServerClient()
  let query = supabase
    .from('production_session')
    .select('*')
    .order('start_time', { ascending: false })

  if (from) {
    query = query.gte('start_time', `${from}T00:00:00Z`)
  }
  if (to) {
    query = query.lte('start_time', `${to}T23:59:59.999Z`)
  }
  if (shiftLabel && shiftLabel !== 'all') {
    query = query.eq('shift_label', shiftLabel)
  }

  const { data: sessions, error } = await query
  if (error) {
    return Response.json({ error: error.message }, { status: 500 })
  }

  const rows = sessions ?? []
  const safeFrom = from || 'all'
  const safeTo = to || 'all'

  if (format === 'csv') {
    const header = [
      'Session ID',
      'Shift Label',
      'Start Time',
      'End Time',
      'Total Spindles',
      'Total Matched',
      'Total Mismatched',
      'Operator ID',
    ]
    const lines = [header.join(',')]
    for (const s of rows) {
      lines.push(
        [
          s.session_id,
          `"${String(s.shift_label || '').replace(/"/g, '""')}"`,
          s.start_time,
          s.end_time || '',
          s.total_spindles,
          s.total_matched,
          s.total_mismatched,
          s.operator_id || '',
        ].join(',')
      )
    }
    const csv = lines.join('\n')
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="report_${safeFrom}_${safeTo}.csv"`,
      },
    })
  }

  if (format === 'pdf') {
    const pdfStream = await renderToStream(
      React.createElement(ReportPDF, {
        data: rows,
        from,
        to,
        shiftLabel,
      }) as any
    )
    const chunks: Buffer[] = []
    pdfStream.on('data', (chunk: Buffer) => chunks.push(chunk))
    await new Promise<void>((resolve, reject) => {
      pdfStream.on('end', () => resolve())
      pdfStream.on('error', reject)
    })
    const buffer = Buffer.concat(chunks)
    return new Response(buffer, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="report_${safeFrom}_${safeTo}.pdf"`,
      },
    })
  }

  return Response.json(
    { error: 'Invalid format. Use csv or pdf.' },
    { status: 400 }
  )
}
