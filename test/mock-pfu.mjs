// A small stand-in for pfu.govmu.org, using the same markup as the real site,
// so the scraper can be tested without touching the government server.

import http from 'node:http';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#039;');

export const HEADERS = ['Effective Date', 'Brand Name', 'Commodity Name', 'Commodity Type', 'EAN Code', 'MRP (M)', 'MRP (R)'];
const CLASSES = ['php', 'field-brand-name-ap', 'field-commodity-name', 'field-commodity-type', 'field-ean-code-ap', 'field-mrp-m', 'field-mrp-r'];

export const PHARMA_HEADERS = ['Effective Date', 'Batch Number', 'Brand Name', 'Commodity Name', 'Commodity Type', 'EAN Code', 'MRP (M)', 'MRP (R)'];

export function renderPage(listPath, rows, page, perPage = 100, headers = HEADERS) {
  const total = rows.length;
  if (!total) return '<!DOCTYPE html><html><body><div class="view view-approved-prices"><div class="view-empty"></div></div></body></html>';
  const lastPage = Math.max(0, Math.ceil(total / perPage) - 1);
  const slice = rows.slice(page * perPage, page * perPage + perPage);
  const query = 'field_commodity_type_value=&amp;field_commodity_name_value=&amp;field_brand_name_ap_value=&amp;field_ean_code_ap_value=&amp;';
  const pager = Array.from({ length: lastPage + 1 }, (_, n) =>
    n === page
      ? `<li class="active"><span>${n + 1}</span></li>`
      : `<li><a title="Go to page ${n + 1}" href="${listPath}?${query}page=${n}">${n + 1}</a></li>`,
  ).join(' ');
  const body = slice
    .map(
      (row, i) =>
        `<tr role="row" class="${i % 2 ? 'even' : 'odd'}"> ${row.map((cell, c) => `<td class="views-field views-field-${CLASSES[c] || `col-${c}`}"> ${esc(cell)} </td>`).join(' ')} </tr>`,
    )
    .join('\n');
  return `<!DOCTYPE html><html><head><title>Max Retail Prices | Price Fixing Information Management System</title></head><body>
<div class="view view-approved-prices view-id-approved_prices view-display-id-page_2">
<div class="view-header"> M is for Mauritius and R is for RodriguesDisplaying ${page * perPage + 1} - ${page * perPage + slice.length} of ${total} </div>
<div class="view-content">
<table class="table table-bordered table-hover dataTable views-table cols-${headers.length} table table-hover table-striped">
<thead> <tr> ${headers.map((h, c) => `<th role="row" class="views-field views-field-${CLASSES[c] || `col-${c}`}"> ${h} </th>`).join(' ')} </tr> </thead>
<tbody>
${body}
</tbody></table></div>
<div class="text-center"><ul class="pagination">${pager}</ul></div>
</div></body></html>`;
}

/**
 * lists: { '/path': rows[] | 'error' }
 * onRequest(path, page, count) may change `lists` between requests (to imitate
 * rows being added while the scraper is running).
 */
export function startMock(lists, onRequest) {
  let count = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const page = Number(url.searchParams.get('page') || 0);
    count++;
    if (onRequest) onRequest(url.pathname, page, count);
    let rows = lists[url.pathname];
    let headers = HEADERS;
    if (rows && !Array.isArray(rows) && rows !== 'error') {
      headers = rows.headers;
      rows = rows.rows;
    }
    // The real site filters "Commodity Name" by "contains", ignoring case.
    const nameFilter = (url.searchParams.get('field_commodity_name_value') || '').toLowerCase();
    if (nameFilter && Array.isArray(rows)) {
      const col = headers.indexOf('Commodity Name');
      rows = rows.filter((row) => row[col].toLowerCase().includes(nameFilter));
    }
    if (rows === undefined) {
      res.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Page not found</h1>');
    } else if (rows === 'error') {
      res.writeHead(500, { 'content-type': 'text/html' }).end('<h1>Error</h1><p>The website encountered an unexpected error. Please try again later.</p>');
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(renderPage(url.pathname, rows, page, 100, headers));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, requests: () => count }));
  });
}
