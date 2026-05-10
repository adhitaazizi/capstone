import React from 'react'
import { Loader2 } from 'lucide-react'

interface ButtonProps extends React.ComponentProps<'button'> {
  variant?: 'primary' | 'secondary' | 'danger' | 'success' | 'outline-danger'
  size?: 'sm' | 'md' | 'lg'
  loading?: boolean
}

export default function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  children,
  disabled,
  className = '',
  ...props
}: ButtonProps) {
  const base =
    'inline-flex items-center justify-center rounded-lg font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed'

  const variants = {
    primary:
      'bg-[#0EA5E9] text-white hover:bg-[#0284C7] focus:ring-[#0EA5E9]',
    secondary:
      'bg-white text-[#1E293B] border border-[#E2E8F0] hover:bg-[#F8FAFC] focus:ring-[#E2E8F0]',
    danger:
      'bg-[#EF4444] text-white hover:bg-[#DC2626] focus:ring-[#EF4444]',
    success:
      'bg-[#22C55E] text-white hover:bg-[#16A34A] focus:ring-[#22C55E]',
    'outline-danger':
      'bg-white text-[#EF4444] border border-[#EF4444] hover:bg-[#EF4444]/5 focus:ring-[#EF4444]',
  }

  const sizes = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2 text-sm',
    lg: 'px-6 py-3 text-base',
  }

  return (
    <button
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
      {children}
    </button>
  )
}
