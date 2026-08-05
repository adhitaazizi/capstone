'use client'

import { useSession } from '@/hooks/use-session'
import {
  Settings,
  Users,
  Clock,
  SlidersHorizontal,
  AlertTriangle,
  ChevronRight,
} from 'lucide-react'
import Link from 'next/link'

export default function SettingsPage() {
  const { isAdmin, isLoading } = useSession()

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-[#E2E8F0] border-t-[#0EA5E9]" />
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8">
        <AlertTriangle className="h-12 w-12 text-[#EF4444]" />
        <h1 className="mt-4 text-xl font-semibold text-[#1E293B]">
          Access Denied
        </h1>
        <p className="mt-2 text-[#64748B]">
          Only administrators can access settings.
        </p>
      </div>
    )
  }

  const configItems = [
    {
      label: 'Session Duration',
      value: '8 hours',
      description: 'Maximum length of a production session before automatic timeout.',
    },
    {
      label: 'Mismatch Alert Threshold',
      value: '5%',
      description: 'Trigger an alert when mismatch rate exceeds this value.',
    }
  ]

  const settingsCards = [
    {
      title: 'Pipeline Settings',
      description:
        'Sampling window, confidence thresholds, and RF-DETR tunables',
      href: '/settings/pipeline',
      icon: SlidersHorizontal,
    },
    {
      title: 'User Management',
      description: 'Add, edit, and deactivate user accounts. Manage roles and permissions.',
      href: '/settings/users',
      icon: Users,
    },
  ]

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-[#1E293B]">System Settings</h1>
        <p className="mt-1 text-[#64748B]">
          Configure application parameters and manage system resources.
        </p>
      </div>

      <div className="mb-8 rounded-xl border border-[#E2E8F0] bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-2">
          <Settings className="h-5 w-5 text-[#0EA5E9]" />
          <h2 className="text-lg font-semibold text-[#1E293B]">
            Configuration
          </h2>
        </div>
        <div className="grid gap-4 grid-cols-2">
          {configItems.map((item) => (
            <div
              key={item.label}
              className="rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-4"
            >
              <p className="text-xs font-medium uppercase text-[#64748B]">
                {item.label}
              </p>
              <p className="mt-1 text-lg font-semibold text-[#1E293B]">
                {item.value}
              </p>
              <p className="mt-1 text-xs text-[#94A3B8]">{item.description}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        {settingsCards.map((card) => (
          <Link
            key={card.href}
            href={card.href}
            className="group flex items-start gap-4 rounded-xl border border-[#E2E8F0] bg-white p-6 shadow-sm transition-colors hover:border-[#0EA5E9]/30 hover:bg-[#F8FAFC]"
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#0EA5E9]/10">
              <card.icon className="h-5 w-5 text-[#0EA5E9]" />
            </div>
            <div className="flex-1">
              <h3 className="font-semibold text-[#1E293B]">{card.title}</h3>
              <p className="mt-1 text-sm text-[#64748B]">{card.description}</p>
            </div>
            <ChevronRight className="mt-1 h-5 w-5 text-[#94A3B8] transition-transform group-hover:translate-x-1" />
          </Link>
        ))}
      </div>
    </div>
  )
}
