# AGENTS.md

## Cursor Cloud specific instructions

RecordShelf is a single, local-first React 19 + Vite 6 SPA (no backend server, no database, no Docker). All app code lives in `app/`; run every command from there. The update script already runs `npm install` in `app/` on startup.

Services and standard commands are defined in `app/package.json` scripts and the root `README.md`; prefer those over duplicating here. Key notes:

- Dev server: `cd app && npm run dev`. It binds to the fixed origin `http://127.0.0.1:4173` (`strictPort: true`, host `127.0.0.1`). This is the only authoritative browser origin for shared user data — do not use port `5173` (retired legacy origin).
- The Vite dev server also serves the read-only metadata/local-state APIs (`/api/local-state`, `/api/neodb/canonicalize`, `/api/metadata/*`) via middleware; there is no separate API process to start.
- Tests: `npm test` (Node test runner), and `npm run test:sites` which requires a prior `npm run build`. `npm run test:build-privacy` verifies the public build ships only synthetic demo data.
- There is no linter configured in this repo (no ESLint/Prettier scripts).
- No env vars or secrets are required for local dev; the app runs on bundled synthetic demo data and browser `localStorage`. The real private library (`app/.private/neodb-library.local.json`) is gitignored and absent in cloud, so `npm run dev` shows demo data.
- The Electron macOS desktop build (`npm run build:desktop`) is Apple Silicon-only and cannot run in the Linux cloud VM.
