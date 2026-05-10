import React from 'react'

interface TableProps extends React.ComponentProps<'table'> {
  children: React.ReactNode
}

export function Table({ children, className = '', ...props }: TableProps) {
  return (
    <div className="overflow-x-auto rounded-xl border border-[#E2E8F0]">
      <table
        className={`w-full text-left text-sm text-[#1E293B] ${className}`}
        {...props}
      >
        {children}
      </table>
    </div>
  )
}

interface TableHeadProps extends React.ComponentProps<'thead'> {
  children: React.ReactNode
}

export function TableHead({ children, className = '', ...props }: TableHeadProps) {
  return (
    <thead
      className={`bg-[#F8FAFC] text-xs font-semibold uppercase text-[#64748B] ${className}`}
      {...props}
    >
      {children}
    </thead>
  )
}

interface TableBodyProps extends React.ComponentProps<'tbody'> {
  children: React.ReactNode
}

export function TableBody({ children, className = '', ...props }: TableBodyProps) {
  return (
    <tbody className={`divide-y divide-[#E2E8F0] ${className}`} {...props}>
      {children}
    </tbody>
  )
}

interface TableRowProps extends React.ComponentProps<'tr'> {
  children: React.ReactNode
}

export function TableRow({ children, className = '', ...props }: TableRowProps) {
  return (
    <tr
      className={`transition-colors hover:bg-[#F8FAFC] ${className}`}
      {...props}
    >
      {children}
    </tr>
  )
}

interface TableHeaderProps extends React.ComponentProps<'th'> {
  children: React.ReactNode
}

export function TableHeader({ children, className = '', ...props }: TableHeaderProps) {
  return (
    <th
      className={`px-4 py-3 ${className}`}
      {...props}
    >
      {children}
    </th>
  )
}

interface TableCellProps extends React.ComponentProps<'td'> {
  children: React.ReactNode
}

export function TableCell({ children, className = '', ...props }: TableCellProps) {
  return (
    <td
      className={`px-4 py-3 ${className}`}
      {...props}
    >
      {children}
    </td>
  )
}
