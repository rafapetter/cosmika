'use client'

import { cn } from '@cosmika/ui'
import * as React from 'react'

/**
 * Standard scrolling page container that fits inside AppShell. Pages should
 * wrap their body in this to get consistent paddings + max-width.
 */
export function PageContainer({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className={cn('mx-auto w-full max-w-5xl p-8 space-y-6', className)}>
        {children}
      </div>
    </div>
  )
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: React.ReactNode
  subtitle?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <header className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? (
          <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  )
}
