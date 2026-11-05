/**
 * Cosmika Tailwind preset — Linear/Vercel-clean design system.
 * All tokens are CSS variables defined in `src/styles.css`.
 */
/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ['class'],
  theme: {
    container: {
      center: true,
      padding: '1.5rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        'border-strong': 'hsl(var(--border-strong))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        surface: 'hsl(var(--surface))',
        subtle: 'hsl(var(--subtle))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
          subtle: 'hsl(var(--primary-subtle))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        success: {
          DEFAULT: 'hsl(var(--success))',
          foreground: 'hsl(var(--success-foreground))',
        },
        warning: {
          DEFAULT: 'hsl(var(--warning))',
          foreground: 'hsl(var(--warning-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        status: {
          open: 'hsl(var(--status-open))',
          pending: 'hsl(var(--status-pending))',
          resolved: 'hsl(var(--status-resolved))',
        },
        chat: {
          canvas: 'hsl(var(--chat-canvas))',
          inbound: 'hsl(var(--chat-inbound))',
          outbound: 'hsl(var(--chat-outbound))',
          'bubble-foreground': 'hsl(var(--chat-bubble-foreground))',
          meta: 'hsl(var(--chat-meta))',
          tick: 'hsl(var(--chat-tick))',
          private: 'hsl(var(--chat-private))',
          system: 'hsl(var(--chat-system))',
        },
      },
      borderRadius: {
        sm: 'var(--radius-sm)',
        md: 'var(--radius)',
        lg: 'var(--radius-lg)',
      },
      boxShadow: {
        xs: 'var(--shadow-xs)',
        sm: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'loading-bar': {
          '0%':   { transform: 'translateX(-100%) scaleX(0.4)' },
          '50%':  { transform: 'translateX(50%) scaleX(0.8)' },
          '100%': { transform: 'translateX(250%) scaleX(0.4)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 120ms ease-out',
        'slide-up': 'slide-up 160ms ease-out',
        'loading-bar': 'loading-bar 1.1s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
