'use client'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { authClient } from '@/lib/auth-client'
import {
  LayoutDashboard,
  Camera,
  FileText,
  HardDrive,
  Settings,
  Activity,
  LogOut,
  SprayCan,
  MoreVertical,
} from 'lucide-react'

interface UserInfo {
  name?: string | null
  email: string
  role: string
}

interface NavItem {
  href: string
  label: string
  icon: React.ElementType
  roles?: string[]
}

const navItems: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/cameras', label: 'Live Cameras', icon: Camera },
  { href: '/reports', label: 'Reports', icon: FileText, roles: ['supervisor', 'admin'] },
  { href: '/devices', label: 'Devices', icon: HardDrive },
  { href: '/settings', label: 'Settings', icon: Settings, roles: ['admin'] },
  { href: '/monitoring', label: 'Monitoring', icon: Activity, roles: ['admin'] },
]

export default function Sidebar({ user }: { user: UserInfo }) {
  const pathname = usePathname()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }
    if (menuOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [menuOpen])

  const handleSignOut = async () => {
    await authClient.signOut()
    window.location.href = '/login'
  }

  const visibleNavItems = navItems.filter((item) => {
    if (!item.roles) return true
    return item.roles.includes(user.role)
  })

  const userInitial = (
    user.name?.charAt(0) || user.email.charAt(0)
  ).toUpperCase()

  return (
    <aside className="fixed left-0 top-0 z-40 flex h-screen w-64 flex-col border-r border-[#E2E8F0] bg-[#F1F5F9]">
      <div className="flex items-center gap-3 border-b border-[#E2E8F0] px-6 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#0EA5E9]/10">
          <SprayCan className="h-5 w-5 text-[#0EA5E9]" />
        </div>
        <span className="text-lg font-semibold text-[#1E293B]">
          SprayCount
        </span>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-4 py-4">
        {visibleNavItems.map((item) => {
          const isActive =
            pathname === item.href || pathname.startsWith(item.href + '/')
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-[#E0F2FE] text-[#0EA5E9]'
                  : 'text-[#64748B] hover:bg-[#E2E8F0] hover:text-[#1E293B]'
              }`}
            >
              <item.icon className="h-5 w-5" />
              {item.label}
            </Link>
          )
        })}
      </nav>

      <div className="border-t border-[#E2E8F0] p-4">
        <div ref={menuRef} className="relative flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#0EA5E9]/10 text-sm font-medium text-[#0EA5E9]">
            {userInitial}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-[#1E293B]">
              {user.name || user.email}
            </p>
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                user.role === 'admin'
                  ? 'bg-purple-100 text-purple-700'
                  : user.role === 'supervisor'
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-gray-100 text-gray-700'
              }`}
            >
              {user.role}
            </span>
          </div>
          <button
            onClick={() => setMenuOpen((open) => !open)}
            className="rounded p-1 text-[#64748B] transition-colors hover:bg-[#E2E8F0] hover:text-[#1E293B]"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
          {menuOpen && (
            <div className="absolute bottom-full right-0 mb-2 w-32 rounded border border-[#E2E8F0] bg-white py-1 shadow-lg">
              <button
                onClick={handleSignOut}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-[#1E293B] transition-colors hover:bg-[#F1F5F9]"
              >
                <LogOut className="h-4 w-4" />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}
