import createNextIntlPlugin from 'next-intl/plugin'

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts')

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@cosmika/shared', '@cosmika/ui'],
  experimental: {
    typedRoutes: true,
  },
}

export default withNextIntl(nextConfig)
