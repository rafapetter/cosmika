'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { buttonVariants } from '@cosmika/ui'
import { readSession } from '../lib/session-store'

export default function Home() {
  const t = useTranslations()
  const router = useRouter()
  const [decided, setDecided] = useState(false)

  // Authenticated visitors don't need the marketing landing — bounce to
  // the inbox. We can't read localStorage on the server, so we do this
  // client-side and render nothing until we've decided.
  useEffect(() => {
    if (readSession()) {
      router.replace('/inbox')
      return
    }
    setDecided(true)
  }, [router])

  if (!decided) return null

  return (
    <main className="container flex min-h-screen flex-col items-center justify-center gap-6 py-12">
      <h1 className="text-4xl font-bold tracking-tight">{t('brand.name')}</h1>
      <p className="text-muted-foreground text-center max-w-md">
        {t('brand.tagline')}
      </p>
      <div className="flex gap-3">
        <Link href="/sign-up" className={buttonVariants({ variant: 'default' })}>
          {t('auth.sign_up')}
        </Link>
        <Link href="/sign-in" className={buttonVariants({ variant: 'outline' })}>
          {t('auth.sign_in')}
        </Link>
      </div>
    </main>
  )
}
