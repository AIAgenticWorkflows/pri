// Daily refresh. Vercel Cron calls this route once a day (see vercel.json); it asks
// Vercel to rebuild the site, and the build reads the official lists afresh from
// pfu.govmu.org (scripts/scrape.mjs). If the official site is down during a build,
// the build keeps the last lists that were read successfully.
//
// Needs two environment variables in the Vercel project:
//   DEPLOY_HOOK_URL  the project's deploy hook (Settings > Git > Deploy Hooks)
//   CRON_SECRET      any long random string; Vercel sends it with each cron call

export default async function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'unauthorised' }));
    return;
  }
  const hook = process.env.DEPLOY_HOOK_URL;
  if (!hook) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: 'DEPLOY_HOOK_URL is not set' }));
    return;
  }
  try {
    const r = await fetch(hook, { method: 'POST', signal: AbortSignal.timeout(15000) });
    res.statusCode = r.ok ? 200 : 502;
    res.end(JSON.stringify({ ok: r.ok, status: r.status, at: new Date().toISOString() }));
  } catch (err) {
    res.statusCode = 502;
    res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
  }
}
