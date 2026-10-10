# Pri

Find the official maximum retail price of a product in Mauritius and Rodrigues.

The prices come from the four public lists of the Price Fixing Unit
(Ministry of Commerce and Consumer Protection) at https://pfu.govmu.org:

| Key | List | Page |
| --- | --- | --- |
| `p` | Max retail prices | `/max-retail-prices-p` |
| `s` | Subsidised max retail prices | `/max-retail-prices-s` |
| `ph` | Max retail prices, pharmaceutical | `/max-retail-prices-pharmaceutical` |
| `phs` | Subsidised max retail prices, pharmaceutical | `/subsidised-mrp-pharmaceutical` |

This is an independent project by Aplica. It is not a government website.

## How it works

The site is static and builds in seconds. The data is pulled separately:

1. `api/pull` (a Vercel function, also runnable as `npm run pull`) reads the
   official lists for up to four minutes per run, picking up where the last run
   stopped, and keeps what it has in Vercel Blob storage (`scripts/lib/collector.mjs`).
   - The newest rows sit at the top of each list and are read first.
   - The full medicines list (about 57,000 batches, a minute per unfiltered page)
     is pulled through name searches, which answer in about a second, then
     completed once by a slow page-by-page read.
   - Each list gets a complete read-through every few days; rows missed by the
     official site's unstable paging are kept from earlier read-throughs, and rows
     that really left the list are dropped after two read-throughs.
2. `scripts/lib/outputs.mjs` turns those stores into the three files the page loads.
3. `api/data` serves them from Blob (`/data/*.json`); until the first pull, the
   copy built from `site/seed/` at deploy time is served instead.
4. `api/medicines` searches the official medicines list live for a name.

Triggers: Vercel Cron calls `/api/pull` once a day; any other scheduler can call it
too (rate-limited to once every 20 minutes unless it sends `CRON_SECRET`).

### Vercel setup

- Storage: create a Blob store and connect it to the project
  (`BLOB_READ_WRITE_TOKEN` is added automatically).
- Optional: `CRON_SECRET` environment variable, so scheduled calls skip the rate limit.

## Commands

```
npm test          # against a local stand-in for the official site
npm run pull      # pull for four minutes into data/store/ (PRI_MINUTES=60 for longer)
npm run build     # rebuild site/seed-data from site/seed
npm run dev       # preview on http://localhost:4173
```

Node 20 or later.
