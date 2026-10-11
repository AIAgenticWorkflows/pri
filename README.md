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
  (`BLOB_READ_WRITE_TOKEN` is added to the project automatically).
- Optional: `CRON_SECRET` environment variable, so scheduled calls skip the rate limit.

### Sign-in and shopping lists (optional)

Sign-in uses Supabase (free plan is enough to start). Without it, the page works as
before and simply shows no sign-in button.

1. Create a project at supabase.com. In SQL Editor, run `supabase/schema.sql`.
2. Authentication, URL Configuration: set Site URL to `https://pri.aplica.biz` and add it to
   Redirect URLs (also `https://pri-ashy.vercel.app` and `http://localhost:4173` for testing).
3. Authentication, Providers: turn on the ones wanted. Google needs an OAuth client from
   Google Cloud Console; Facebook an app from developers.facebook.com; Apple an Apple
   Developer account. Email links work out of the box.
4. In Vercel, Settings, Environment Variables, add:
   - `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Supabase, Project Settings, API)
   - `SUPABASE_SERVICE_ROLE_KEY` (same page; lets people delete their account; never shown to the page)
   - `PRI_AUTH_PROVIDERS`, e.g. `google,facebook,apple,email`
5. Redeploy.

Only the email address (kept by Supabase Auth) and each person's lists are stored; each person
can read only their own rows (row level security), and can delete their account from the page.

### The first full copy

The daily four-minute runs would take weeks to walk the whole medicines list, so
the first copy is best made from any computer that can run Node for a few hours:

1. In Vercel open the project, then Storage, then the Blob store, then its
   ".env.local" tab, and press "Copy Snippet".
2. Paste the snippet into a file named `.env.local` in the project folder
   (it is ignored by git). It looks like `BLOB_READ_WRITE_TOKEN="vercel_blob_rw_..."`.
3. `npm install`, then `npm run check` (shows whether the storage answers and
   what is in it), then `PRI_MINUTES=720 npm run pull`
   (PowerShell: `$env:PRI_MINUTES="720"; npm run pull`).

The run can be stopped and restarted at any time; progress is saved every couple of
minutes, and the hosted site's daily run carries on from the same storage.

## Commands

```
npm test          # against a local stand-in for the official site
npm run check     # test the Blob token and show what is in storage
npm run pull      # pull for four minutes (PRI_MINUTES=720 for a long run);
                  # into Blob with BLOB_READ_WRITE_TOKEN, otherwise into data/store/
npm run build     # rebuild site/seed-data from site/seed
npm run dev       # preview on http://localhost:4173
```

Node 20 or later.
