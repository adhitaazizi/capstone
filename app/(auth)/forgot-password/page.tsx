'use client'

import Link from 'next/link'
import { Info, ArrowLeft } from 'lucide-react'

export default function ForgotPasswordPage() {
  return (
    <div className="w-full rounded-xl bg-white p-8 shadow-sm border border-[#E2E8F0]">
      <div className="flex flex-col items-center mb-8">
        <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-[#0EA5E9]/10 mb-4">
          <Info className="h-6 w-6 text-[#0EA5E9]" />
        </div>
        <h2 className="text-2xl font-semibold text-[#1E293B]">Forgot password?</h2>
        <p className="mt-1 text-sm text-[#64748B]">Password reset assistance</p>
      </div>

      <div className="rounded-lg bg-[#F8FAFC] border border-[#E2E8F0] p-5 text-center">
        <p className="text-[#1E293B] font-medium">
          Password reset is managed by your system administrator
        </p>
        <p className="mt-2 text-sm text-[#64748B]">
          Please contact your administrator to reset your password or regain access to your account.
        </p>
      </div>

      <div className="mt-6 text-center">
        <Link
          href="/login"
          className="inline-flex items-center gap-1.5 text-sm text-[#0EA5E9] hover:text-[#0284C7] hover:underline"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to sign in
        </Link>
      </div>
    </div>
  )
}
