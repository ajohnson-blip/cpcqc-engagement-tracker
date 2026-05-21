import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // CPCQC brand palette — see /Hospital Engagement Tracker Website/CPCQC - Brand Guidelines (1).pdf
        cpcqc: {
          // Primary
          purple: '#6B529B', // bright purple — primary
          'purple-dark': '#6A6587', // dark purple
          teal: '#6EB9A7', // teal

          // Secondary
          blue: '#5C6B8A',
          yellow: '#FFD629',
          pink: '#CE7672',
          orange: '#F9A027',

          // High-contrast substitutions (use for text or status pills)
          'teal-dark': '#3D7F72',
          'pink-dark': '#C1534E',
          'orange-dark': '#D87F03',

          // Surface tints (derived for backgrounds)
          cream: '#FAF6EE', // page background tint matching the screenshots
          'cream-dark': '#F1EAD9',
        },
      },
      fontFamily: {
        // Wired up in app/layout.tsx via next/font
        sans: ['var(--font-nunito-sans)', 'system-ui', 'sans-serif'],
        rounded: ['var(--font-nunito)', 'system-ui', 'sans-serif'], // web substitute for Avenir Next Rounded Pro
        serif: ['var(--font-halant)', 'Georgia', 'serif'],
        script: ['cursive'],
      },
      borderRadius: {
        xl: '1rem',
        '2xl': '1.25rem',
      },
      boxShadow: {
        card: '0 1px 2px rgba(60, 50, 90, 0.05), 0 4px 14px rgba(60, 50, 90, 0.06)',
      },
    },
  },
  plugins: [],
};

export default config;
