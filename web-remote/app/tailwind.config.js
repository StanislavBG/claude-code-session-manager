/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Almanac paper-warm palette (shared with the desktop app).
        paper: '#f6efe1',
        panel: '#efe6d3',
        card: '#fbf6ec',
        edge: '#e0d3b8',
        rule: '#d9c9a8',
        ink: '#2a221a',
        'ink-soft': '#5b4a36',
        'ink-mute': '#8a7a60',
        accent: '#b85c34',
        'accent-soft': '#e8a988',
        sage: '#6f7d52',
        butter: '#c79a3a',
        // Dark terminal scope — used only inside the session detail terminal.
        'term-bg': '#241d15',
        'term-soft': '#2c2419',
        'term-edge': '#3a3022',
        'term-text': '#e9ddc6',
        'term-dim': '#9a8b6f',
        'term-sage': '#a6b87a',
        'term-terra': '#e0a070',
        'term-butter': '#e4c46a',
        'term-blue': '#8fb0c4',
        // kept so any legacy reference still resolves during the reskin
        surface: '#efe6d3',
        bg: '#f6efe1',
      },
      fontFamily: {
        serif: ['Newsreader', 'Georgia', 'serif'],
        sans: ['"Geist Sans"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      minHeight: { touch: '44px' },
      minWidth: { touch: '44px' },
    },
  },
  plugins: [],
};
