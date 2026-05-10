import Link from 'next/link'
import { ShieldAlert } from 'lucide-react'

export default function UnauthorizedPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#F8FAFC]">
      <div className="flex flex-col items-center text-center">
        <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
          <ShieldAlert className="h-8 w-8 text-red-600" />
        </div>
        <h1 className="mb-2 text-3xl font-bold text-[#1E293B]">
          Access Denied
        </h1>
        <p className="mb-8 max-w-md text-[#64748B]">
          You don&apos;t have permission to access this page. Contact your
          administrator if you believe this is an error.
        </p>
        <Link
          href="/"
          className="inline-flex items-center rounded-lg bg-[#0EA5E9] px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#0284C7]"
        >
          Go to Dashboard
        </Link>
      </div>
    </div>
  )
}
