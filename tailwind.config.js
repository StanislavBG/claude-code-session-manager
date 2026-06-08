/** @type {import('tailwindcss').Config} */
// Almanac paper-warm palette. Token names match the dark-theme originals so
// the ~3,200 utility-class usages auto-reskin. Mapping (old → new):
//   bg       #0b0d10 → #f6efe1 (paper)
//   bg.elev  #12151a → #efe6d3 (panel)
//   bg.hi    #1a1f27 → #fbf6ec (card)
//   line     #242a33 → #e0d3b8 (edge)
//   fg       #e6e8ec → #2a221a (ink)
//   fg.dim   #8a93a0 → #5b4a36 (inkSoft)
//   fg.faint #545c68 → #8a7a60 (inkMute)
//   accent   #d97757 → #b85c34 (terracotta)
export default {
  content: ['./src/renderer/index.html', './src/renderer/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#f6efe1',
          elev: '#efe6d3',
          hi: '#fbf6ec',
        },
        line: '#e0d3b8',
        rule: '#d9c9a8',
        fg: {
          DEFAULT: '#2a221a',
          dim: '#5b4a36',
          faint: '#8a7a60',
        },
        accent: {
          DEFAULT: '#b85c34',
          muted: '#e8a988',
        },
        sage: '#6f7d52',
        butter: '#e4b85a',
        // Hive accent palette — three extra low-chroma tones to supplement
        // accent/sage/butter for the 6-slot hive card rotation.
        'hive-slate': '#5f6f86',
        'hive-plum': '#8a5a6e',
        'hive-teal': '#4f7d72',
      },
      fontFamily: {
        // Almanac trio: Geist for UI, Newsreader for editorial serif display
        // type, IBM Plex Mono for code/data. Loaded via Google Fonts in
        // index.html; CSP whitelisted in src/main/index.cjs.
        sans: ['Geist', 'system-ui', 'sans-serif'],
        serif: ['Newsreader', 'Georgia', 'serif'],
        mono: ['IBM Plex Mono', 'JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
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
