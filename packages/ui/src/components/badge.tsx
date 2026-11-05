import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../lib/cn'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium leading-none',
  {
    variants: {
      variant: {
        default: 'bg-muted text-foreground',
        outline: 'border border-border text-foreground',
        primary: 'bg-primary-subtle text-primary',
        success: 'bg-success/10 text-success',
        warning: 'bg-warning/15 text-foreground',
        destructive: 'bg-destructive/10 text-destructive',
        open: 'bg-status-open/10 text-status-open',
        pending: 'bg-status-pending/15 text-status-pending',
        resolved: 'bg-status-resolved/10 text-status-resolved',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant, ...props }, ref) => (
    <span
      ref={ref}
      className={cn(badgeVariants({ variant, className }))}
      {...props}
    />
  ),
)
Badge.displayName = 'Badge'

export { badgeVariants }
