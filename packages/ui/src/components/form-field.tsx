'use client'

import * as React from 'react'

import { cn } from '../lib/cn'

import { Label } from './label'

// The one form-row layout for every system-of-record screen: label above,
// control, then hint or error. Pages compose it around any control (Input,
// Select, Textarea, Checkbox) instead of re-inventing spacing and error
// placement per page — that habit is how 113 hand-rolled control styles
// accumulated before this existed.
//
// Deliberately NOT bound to a form library: pages using plain useState and
// pages using react-hook-form both wrap their control in the same field.

type FormFieldProps = {
  label: React.ReactNode
  /** Reaches the control via htmlFor; pass the control the same id. */
  htmlFor?: string
  /** Shown under the control when there is no error. */
  hint?: React.ReactNode
  /** Overrides the hint and colours the row as invalid. */
  error?: React.ReactNode
  required?: boolean
  className?: string
  children: React.ReactNode
}

function FormField({
  label,
  htmlFor,
  hint,
  error,
  required,
  className,
  children,
}: FormFieldProps) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={htmlFor} className={cn(error && 'text-destructive')}>
        {label}
        {required ? <span className="ml-0.5 text-destructive">*</span> : null}
      </Label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}

/** Standard vertical rhythm for a stack of fields + actions. */
function FormSection({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('space-y-4', className)} {...props} />
}

export { FormField, FormSection }
