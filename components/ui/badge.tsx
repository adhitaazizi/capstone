import React from 'react'

interface BadgeProps extends React.ComponentProps<'span'> {
  variant?: 'success' | 'danger' | 'warning' | 'default' | 'destructive' | 'outline'
}

export default function Badge({
  variant = 'default',
  children,
  className = '',
  ...props
}: BadgeProps) {
  const variants = {
    success: 'bg-[#22C55E]/10 text-[#22C55E]',
    danger: 'bg-[#EF4444]/10 text-[#EF4444]',
    warning: 'bg-[#F59E0B]/10 text-[#F59E0B]',
    default: 'bg-[#64748B]/10 text-[#64748B]',
    destructive: 'bg-red-500/10 text-red-500',
    outline: 'border border-slate-700 bg-transparent text-slate-300',
  }

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${variants[variant]} ${className}`}
      {...props}
    >
      {children}
    </span>
  )
}
