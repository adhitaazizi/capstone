'use client'

import { useEffect, useState } from 'react'

import { createBrowserClient } from '@/lib/supabase/client'

export function useRealtime<T = any>(table: string, filter?: string) {
  const [data, setData] = useState<T[]>([])
  const [isConnected, setIsConnected] = useState(false)

  useEffect(() => {
    const supabase = createBrowserClient()
    const channel = supabase
      .channel(`${table}-changes`)
      .on('postgres_changes', { event: '*', schema: 'public', table, filter }, (payload) => {
        const record = (payload.new ?? payload.old) as T

        setData((current) => {
          // Find the primary key field dynamically (pass_id, id, session_id, etc.)
          const pkFields = ['pass_id', 'id', 'event_id', 'session_id']
          const pkField = pkFields.find((f) => (record as any)?.[f] !== undefined) ?? 'id'
          const recordKey = (record as any)[pkField]

          if (payload.eventType === 'INSERT') {
            const exists = current.some((item: any) => item[pkField] === recordKey)
            return exists ? current : [...current, record]
          }

          if (payload.eventType === 'UPDATE') {
            const exists = current.some((item: any) => item[pkField] === recordKey)
            if (exists) {
              return current.map((item: any) => (item[pkField] === recordKey ? record : item))
            }
            return [...current, record]
          }

          if (payload.eventType === 'DELETE') {
            return current.filter((item: any) => item[pkField] !== recordKey)
          }

          return current
        })
      })
      .subscribe((status) => {
        setIsConnected(status === 'SUBSCRIBED')
      })

    return () => {
      supabase.removeChannel(channel)
    }
  }, [table, filter])

  return { data, isConnected }
}
