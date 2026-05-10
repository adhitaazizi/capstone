'use client'

import { authClient } from '@/lib/auth-client'

export function useSession() {
  const { data: session, isPending, error } = authClient.useSession()

  return {
    user: session?.user ?? null,
    session: session?.session ?? null,
    isLoading: isPending,
    isAuthenticated: !!session?.user,
    role: (session?.user as any)?.role ?? null,
    isAdmin: (session?.user as any)?.role === 'admin',
    isSupervisor: ['supervisor', 'admin'].includes((session?.user as any)?.role ?? ''),
    error,
  }
}
