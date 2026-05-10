import React from 'react'
import { type LucideIcon, TrendingUp, TrendingDown } from 'lucide-react'

interface StatCardProps extends React.ComponentProps<'div'> {
  icon: LucideIcon
  iconColor?: string
  title: string
  value: string | number
  trend?: {
    value: number
    label?: string
    positive?: boolean
  }
}

export default function StatCard({
  icon: Icon,
  iconColor = '#0EA5E9',
  title,
  value,
  trend,
  className = '',
  ...props
}: StatCardProps) {
  return (
    <div
      className={`rounded-xl bg-white p-5 shadow-sm border border-[#E2E8F0] ${className}`}
      {...props}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-sm font-medium text-[#94A3B8]">{title}</p>
          <p className="mt-1 text-2xl font-bold text-[#1E293B]">{value}</p>
          {trend && (
            <div className="mt-2 flex items-center gap-1 text-sm">
              {trend.positive ? (
                <>
                  <TrendingUp className="h-4 w-4 text-[#22C55E]" />
                  <span className="font-medium text-[#22C55E]">
                    +{trend.value}%
                  </span>
                </>
              ) : (
                <>
                  <TrendingDown className="h-4 w-4 text-[#EF4444]" />
                  <span className="font-medium text-[#EF4444]">
                    -{trend.value}%
                  </span>
                </>
              )}
              {trend.label && (
                <span className="text-[#94A3B8]">{trend.label}</span>
              )}
            </div>
          )}
        </div>
        <div
          className="flex h-10 w-10 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${iconColor}1A` }}
        >
          <Icon className="h-5 w-5" style={{ color: iconColor }} />
        </div>
      </div>
    </div>
  )
}
