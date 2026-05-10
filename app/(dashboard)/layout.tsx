import { auth } from '@/lib/auth'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import Sidebar from '@/components/sidebar'

export default async function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const session = await auth.api.getSession({ headers: await headers() })

  if (!session) {
    redirect('/login')
  }

  const user = {
    name: session.user.name,
    email: session.user.email,
    role: (session.user as any).role as string,
  }

  return (
    <div className="flex min-h-screen">
      <Sidebar user={user} />
      <main className="ml-64 flex-1 bg-[#F8FAFC]">{children}</main>
    </div>
  )
}
