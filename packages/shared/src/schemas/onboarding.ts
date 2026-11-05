import { z } from 'zod'

// The "first steps" a brand-new account walks through before it is actually
// serving customers. Order matters: it is the order the checklist renders in.
export const OnboardingStepKey = z.enum([
  'channel',
  'firstMessage',
  'automation',
  'team',
  'availability',
])
export type OnboardingStepKey = z.infer<typeof OnboardingStepKey>

export type OnboardingStatusDTO = {
  steps: Record<OnboardingStepKey, boolean>
  completed: number
  total: number
}
