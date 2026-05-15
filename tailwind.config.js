/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#0b0d10',
          elev: '#12151a',
          hi: '#1a1f27',
        },
        line: '#242a33',
        fg: {
          DEFAULT: '#e6e8ec',
          dim: '#8a93a0',
          faint: '#545c68',
        },
        accent: {
          DEFAULT: '#d97757',
          muted: '#8a4a33',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [
    // `compact:` variant — applies when <body> has `density-compact`.
    // Toggled via useDensity() in src/renderer/lib/useDensity.ts.
    function ({ addVariant }) {
      addVariant('compact', 'body.density-compact &')
    },
  ],
}
