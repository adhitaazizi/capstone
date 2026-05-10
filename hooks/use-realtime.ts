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
          if (payload.eventType === 'INSERT') {
            return [...current, record]
          }

          if (payload.eventType === 'UPDATE') {
            return current.map((item: any) => (item?.id === (record as any)?.id ? record : item))
          }

          if (payload.eventType === 'DELETE') {
            return current.filter((item: any) => item?.id !== (record as any)?.id)
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
