import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../lib/cn'

const progressVariants = cva('w-full overflow-hidden rounded-full bg-muted', {
  variants: {
    size: {
      sm: 'h-1',
      md: 'h-1.5',
      lg: 'h-2',
    },
  },
  defaultVariants: { size: 'md' },
})

export interface ProgressProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'>,
    VariantProps<typeof progressVariants> {
  /** Completed amount, in the same unit as `max`. Clamped to 0…max. */
  value: number
  /**
   * The total, in whatever the caller is actually counting — steps, not
   * percent. It is announced as-is, so a screen reader says "3 of 5" rather
   * than "60 percent", which is what someone walking a checklist needs.
   */
  max?: number
  /** Required: a bar with no name tells a screen reader nothing. */
  label: string
}

/**
 * A progress bar. Exists because two screens were about to hand-roll the same
 * `div role="progressbar"` with the same three aria attributes, which is how
 * control styles multiply.
 */
export const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, size, value, max = 100, label, ...props }, ref) => {
    // A caller that computes max from data can hand us 0 (nothing to do yet);
    // dividing by it would render NaN width and announce nothing sensible.
    const safeMax = max > 0 ? max : 1
    const safeValue = Math.min(Math.max(value, 0), safeMax)
    const pct = Math.round((safeValue / safeMax) * 100)
    return (
      <div
        ref={ref}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuenow={safeValue}
        aria-label={label}
        className={cn(progressVariants({ size, className }))}
        {...props}
      >
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${pct}%` }}
        />
      </div>
    )
  },
)
Progress.displayName = 'Progress'

export { progressVariants }
