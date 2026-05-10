import { Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'

const styles = StyleSheet.create({
  page: { padding: 30, fontSize: 10 },
  title: { fontSize: 18, marginBottom: 10, fontWeight: 'bold' },
  subtitle: { fontSize: 11, marginBottom: 4, color: '#64748B' },
  summaryBox: {
    marginTop: 10,
    marginBottom: 15,
    padding: 10,
    backgroundColor: '#F8FAFC',
    borderRadius: 4,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  summaryLabel: { fontSize: 10, color: '#64748B' },
  summaryValue: { fontSize: 10, fontWeight: 'bold', color: '#1E293B' },
  table: { marginTop: 10, width: '100%' },
  tableRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: '#E2E8F0',
    paddingVertical: 4,
  },
  tableHeader: {
    flexDirection: 'row',
    borderBottomWidth: 2,
    borderBottomColor: '#0EA5E9',
    paddingVertical: 5,
    backgroundColor: '#F8FAFC',
  },
  tableCell: { flex: 1.5, fontSize: 8, paddingHorizontal: 3 },
  tableCellNarrow: { flex: 1, fontSize: 8, paddingHorizontal: 3 },
  tableHeaderCell: {
    flex: 1.5,
    fontSize: 8,
    fontWeight: 'bold',
    paddingHorizontal: 3,
    color: '#0EA5E9',
  },
  tableHeaderCellNarrow: {
    flex: 1,
    fontSize: 8,
    fontWeight: 'bold',
    paddingHorizontal: 3,
    color: '#0EA5E9',
  },
})

interface Session {
  session_id: string
  shift_label: string | null
  start_time: string
  end_time: string | null
  total_spindles: number
  total_matched: number
  total_mismatched: number
  operator_id: string | null
}

interface ReportPDFProps {
  data: Session[]
  from: string | null
  to: string | null
  shiftLabel: string | null
}

export function ReportPDF({ data, from, to, shiftLabel }: ReportPDFProps) {
  const summary = {
    totalSessions: data.length,
    totalSpindles: data.reduce((sum, s) => sum + (s.total_spindles || 0), 0),
    totalMatched: data.reduce((sum, s) => sum + (s.total_matched || 0), 0),
    totalMismatched: data.reduce(
      (sum, s) => sum + (s.total_mismatched || 0),
      0
    ),
  }

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>Spray Count Report</Text>
        <Text style={styles.subtitle}>
          Period: {from || 'All'} to {to || 'All'}
        </Text>
        {shiftLabel && shiftLabel !== 'all' && (
          <Text style={styles.subtitle}>Shift: {shiftLabel}</Text>
        )}

        <View style={styles.summaryBox}>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Total Sessions</Text>
            <Text style={styles.summaryValue}>{summary.totalSessions}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Total Spindles</Text>
            <Text style={styles.summaryValue}>{summary.totalSpindles}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Total Matched</Text>
            <Text style={styles.summaryValue}>{summary.totalMatched}</Text>
          </View>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryLabel}>Total Mismatched</Text>
            <Text style={styles.summaryValue}>{summary.totalMismatched}</Text>
          </View>
        </View>

        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <Text style={styles.tableHeaderCell}>Session ID</Text>
            <Text style={styles.tableHeaderCell}>Shift</Text>
            <Text style={styles.tableHeaderCellNarrow}>Start</Text>
            <Text style={styles.tableHeaderCellNarrow}>End</Text>
            <Text style={styles.tableHeaderCellNarrow}>Spindles</Text>
            <Text style={styles.tableHeaderCellNarrow}>Matched</Text>
            <Text style={styles.tableHeaderCellNarrow}>Mismatched</Text>
          </View>
          {data.map((s) => (
            <View key={s.session_id} style={styles.tableRow}>
              <Text style={styles.tableCell}>{s.session_id.slice(0, 8)}</Text>
              <Text style={styles.tableCell}>{s.shift_label || '-'}</Text>
              <Text style={styles.tableCellNarrow}>
                {new Date(s.start_time).toLocaleDateString()}
              </Text>
              <Text style={styles.tableCellNarrow}>
                {s.end_time
                  ? new Date(s.end_time).toLocaleDateString()
                  : '-'}
              </Text>
              <Text style={styles.tableCellNarrow}>{s.total_spindles}</Text>
              <Text style={styles.tableCellNarrow}>{s.total_matched}</Text>
              <Text style={styles.tableCellNarrow}>
                {s.total_mismatched}
              </Text>
            </View>
          ))}
        </View>
      </Page>
    </Document>
  )
}
