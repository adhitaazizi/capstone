import { auth } from '@/lib/auth'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { headers } from 'next/headers'

const ROLE_ROUTES: Record<string, string[]> = {
  '/reports': ['supervisor', 'admin'],
  '/settings': ['admin'],
  '/monitoring': ['admin'],
}

export async function proxy(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() })

  if (!session) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  if ((session.user as any).is_active === false) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  const pathname = request.nextUrl.pathname

  const requiredRoles = Object.entries(ROLE_ROUTES).find(
    ([route]) => pathname === route || pathname.startsWith(`${route}/`)
  )?.[1]

  if (
    requiredRoles &&
    !requiredRoles.includes((session.user as any).role)
  ) {
    return NextResponse.redirect(new URL('/unauthorized', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!login|sign-up|forgot-password|api/auth|_next|favicon.ico).*)',
  ],
}
