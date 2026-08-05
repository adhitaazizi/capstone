import { auth } from '@/lib/auth'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { headers } from 'next/headers'

const ROLE_ROUTES: Record<string, string[]> = {
  '/reports': ['supervisor', 'admin'],
  '/settings': ['admin'],
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
  // api/inference/{detections,register,source} are machine-to-machine routes
  // called by Colab and the edge worker, which have no browser session — they
  // authenticate via the x-inference-key header inside the route handler
  // instead. Without this exemption every call gets redirected to /login
  // before the handler ever runs. api/inference/live is deliberately NOT
  // exempted: the dashboard calls it with a real session and it should stay
  // behind auth like any other page data route.
  matcher: [
    '/((?!login|api/auth|api/inference/detections|api/inference/register|api/inference/source|_next|favicon.ico).*)',
  ],
}
