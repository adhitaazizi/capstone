import React, { useState } from 'react'
import { Eye, EyeOff, type LucideIcon } from 'lucide-react'

interface InputProps extends React.ComponentProps<'input'> {
  label?: string
  error?: string
  icon?: LucideIcon
}

export default function Input({
  label,
  error,
  icon: Icon,
  type,
  className = '',
  ...props
}: InputProps) {
  const [showPassword, setShowPassword] = useState(false)
  const isPassword = type === 'password'
  const inputType = isPassword && showPassword ? 'text' : type

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
          type={inputType}
          className={`block w-full rounded-lg border text-sm text-[#1E293B] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#0EA5E9] focus:border-[#0EA5E9] disabled:opacity-50 disabled:cursor-not-allowed ${
            error
              ? 'border-[#EF4444] focus:ring-[#EF4444] focus:border-[#EF4444]'
              : 'border-[#E2E8F0]'
          } ${Icon ? 'pl-10' : 'px-3'} ${isPassword ? 'pr-10' : ''} py-2 ${className}`}
          {...props}
        />
        {isPassword && (
          <button
            type="button"
            className="absolute inset-y-0 right-0 flex items-center px-3 text-[#64748B] hover:text-[#1E293B]"
            onClick={() => setShowPassword((visible) => !visible)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
          >
            {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        )}
      </div>
      {error && (
        <p className="mt-1 text-sm text-[#EF4444]">{error}</p>
      )}
    </div>
  )
}
