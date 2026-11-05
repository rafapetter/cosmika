'use client'

import { OnboardingFlow } from '../../components/onboarding-flow'

/**
 * Where signup lands. Deliberately outside the app shell: the flow is four
 * questions, and a sidebar full of screens nobody has set up yet is noise
 * around them.
 */
export default function WelcomePage() {
  return (
    <main className="flex min-h-screen w-full items-center justify-center bg-background p-4 sm:p-6">
      <OnboardingFlow />
    </main>
  )
}
