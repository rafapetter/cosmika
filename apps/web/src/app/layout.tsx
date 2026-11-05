import './globals.css'
import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import { NextIntlClientProvider } from 'next-intl'
import { ThemeProvider, TooltipProvider } from '@cosmika/ui'

import { ShellOrPublic } from '../components/shell-or-public'
import { MESSAGES } from '../i18n/config'
import { getLocale } from '../i18n/get-locale'

// Twenty's typeface. Self-hosted by next/font (no network call at runtime,
// no layout shift) and bound to the --font-sans token the design system reads.
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
})

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale()
  return {
    title: MESSAGES[locale].brand.name,
    description: MESSAGES[locale].brand.tagline,
  }
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const locale = await getLocale()
  return (
    <html lang={locale} className={inter.variable} suppressHydrationWarning>
      <body className="h-screen overflow-hidden bg-background font-sans antialiased">
        {/* Avoid the FOUC by setting the theme class before hydration. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try {
  var t = localStorage.getItem('cosmika.theme') || 'system';
  var d = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.add(d ? 'dark' : 'light');
  document.documentElement.style.colorScheme = d ? 'dark' : 'light';
} catch (e) {}`,
          }}
        />
        <ThemeProvider>
          <TooltipProvider delayDuration={200}>
            <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
              <ShellOrPublic>{children}</ShellOrPublic>
            </NextIntlClientProvider>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
