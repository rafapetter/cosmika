# @cosmika/ui

shadcn-derived component library + Tailwind preset for Cosmika apps.

Design tokens in `src/styles.css` are placeholders. The real Cosmika brand
palette (logo, type, motion) is part of P0 web work and will replace them.

## Usage

```ts
// tailwind.config.ts in apps/web
import preset from '@cosmika/ui/tailwind-preset'
export default { presets: [preset], content: [...] }
```

```ts
// in app entry
import '@cosmika/ui/styles.css'
```
