import React from 'react'
import { type LucideIcon } from 'lucide-react'

interface InputProps extends React.ComponentProps<'input'> {
  label?: string
  error?: string
  icon?: LucideIcon
}

export default function Input({
  label,
  error,
  icon: Icon,
  className = '',
  ...props
}: InputProps) {
  return (
    <div className="w-full">
      {label && (
        <label className="mb-1 block text-sm font-medium text-[#1E293B]">
          {label}
        </label>
      )}
      <div className="relative">
        {Icon && (
          <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
            <Icon className="h-4 w-4 text-[#94A3B8]" />
          </div>
        )}
        <input
          className={`block w-full rounded-lg border text-sm text-[#1E293B] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#0EA5E9] focus:border-[#0EA5E9] disabled:opacity-50 disabled:cursor-not-allowed ${
            error
              ? 'border-[#EF4444] focus:ring-[#EF4444] focus:border-[#EF4444]'
              : 'border-[#E2E8F0]'
          } ${Icon ? 'pl-10' : 'px-3'} py-2 ${className}`}
          {...props}
        />
      </div>
      {error && (
        <p className="mt-1 text-sm text-[#EF4444]">{error}</p>
      )}
    </div>
  )
}
