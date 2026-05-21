# CPCQC Engagement Tracker — Frontend

Next.js 14 (App Router) + TypeScript + Tailwind CSS, designed against the CPCQC brand guidelines.

## Quick start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env.local
# Edit NEXT_PUBLIC_API_BASE if your backend isn't on localhost:3001

# 3. Run
npm run dev
```

The app runs on http://localhost:3000 and proxies `/api/*` calls to the backend (see `next.config.mjs`).

## What's in here (Phase 1)

- **Login** at `/login`
- **Hospital portal** at `/portal` — home, enrollment detail, aggregated task list
- **Manage Task modal** — type-aware forms for completing tasks

## Brand tokens

The CPCQC brand colors and fonts are wired into Tailwind via the `cpcqc-*` color names and the `font-sans` / `font-rounded` / `font-serif` / `font-script` font families. See `tailwind.config.ts` for the full palette.

Status colors used across the app:

- **`met`** — Dark Teal `#3D7F72`
- **`on_track`** — Bright Purple `#6B529B`
- **`at_risk`** — Dark Orange `#D87F03`
- **`not_met`** — Dark Pink `#C1534E`

## Notes

- Avenir Next Rounded Pro is a commercial font; we substitute Nunito (the rounded counterpart of Nunito Sans) which closely matches the visual character and is free via Google Fonts.
- Logo is a CSS recreation of the cpcqc wordmark; swap in the official SVG when available.
