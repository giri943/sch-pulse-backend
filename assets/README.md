# PDF assets

## `schbang-logo.png`

The Schbang logo embedded in the top-left of the generated **Server Maintenance
Report** PDF (see `src/controllers/ProjectSop.controller.ts` → `drawBrandHeader`).

- Save the corporate Schbang logo here as **`schbang-logo.png`** (this exact name).
- A square PNG works best (it's fit into a 38×38 pt box next to the "Schbang" wordmark).
  A transparent background looks cleanest on the white page.
- Override the location with the `PDF_LOGO_PATH` env var if you'd rather keep it elsewhere.

If the file is missing, the report falls back to a small drawn puzzle mark so it
still renders — but drop the real PNG here for client-facing decks.

> Resolved from the backend process working directory (`assets/schbang-logo.png`),
> so it works both in dev (`npm run dev`) and in production (`node dist/index.js`)
> as long as you run from the `backend/` folder.
