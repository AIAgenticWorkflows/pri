// Shared knowledge about the Price Fixing Unit (PFU) website: which lists exist
// and how to read one page of results. No dependencies, so it runs anywhere.

export const BASE_URL = 'https://pfu.govmu.org';

// The four public lists. Each is a paged table, 100 rows per page.
export const LISTS = {
  p: { path: '/max-retail-prices-p', title: 'Max Retail Prices' },
  s: { path: '/max-retail-prices-s', title: 'Subsidised Max Retail Prices' },
  ph: { path: '/max-retail-prices-pharmaceutical', title: 'Max Retail Prices (Pharmaceutical)' },
  phs: { path: '/subsidised-mrp-pharmaceutical', title: 'Subsidised Max Retail Prices (Pharmaceutical)' },
};

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    const key = entity.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match;
  });
}

const cellText = (html) => decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * Read one page of a PFU list.
 * Returns the column headers, the rows (arrays of cell text, in column order),
 * the "Displaying X - Y of Z" figures and the highest page number in the pager.
 */
export function parsePage(html) {
  const out = { hasTable: false, headers: [], rows: [], from: null, to: null, total: null, lastPage: 0 };

  const displaying = html.match(/Displaying\s+(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/i);
  if (displaying) {
    out.from = Number(displaying[1]);
    out.to = Number(displaying[2]);
    out.total = Number(displaying[3]);
  }

  const pageNumbers = [...html.matchAll(/[?&;]page=(\d+)/g)].map((m) => Number(m[1]));
  if (pageNumbers.length) out.lastPage = Math.max(...pageNumbers);

  const table = html.match(/<table[^>]*class="[^"]*views-table[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
  if (!table) return out;
  out.hasTable = true;

  const thead = table[1].match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
  if (thead) out.headers = [...thead[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => cellText(m[1]));

  const tbody = table[1].match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  if (tbody) {
    for (const tr of tbody[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      out.rows.push([...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cellText(m[1])));
    }
  }
  return out;
}

/** "09/10/2026" -> "2026-10-09" (empty string when the cell is not a date). */
export function isoDate(ddmmyyyy) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(ddmmyyyy || '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}
