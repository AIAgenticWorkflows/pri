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

1. `scripts/scrape.mjs` reads every page of each list and saves the rows,
   unmodified, in `data/raw/`.
2. `scripts/build-data.mjs` turns those rows into the compact files the page
   loads from `site/data/`.
3. `site/` is the website: one page, no build step.

The "Refresh prices" workflow (`.github/workflows/refresh.yml`) runs steps 1
and 2 on GitHub and commits what changed.

## Commands

```
npm test          # parser and scraper tests, against a local stand-in for the site
npm run scrape    # pull the lists (about 25 minutes; the site is slow)
npm run build     # rebuild site/data from data/raw
```

Node 20 or later. No dependencies.
