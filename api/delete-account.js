// Deletes the signed-in person's account and everything saved with it.
//   POST /api/delete-account   with "Authorization: Bearer <their access token>"
// Needs SUPABASE_SERVICE_ROLE_KEY (kept on the server only). Saved items go with the
// account (ON DELETE CASCADE in supabase/schema.sql).

import { authConfig } from './config.js';

export default async function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  const send = (status, body) => {
    res.statusCode = status;
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'POST') return send(405, { error: 'method' });
  const cfg = authConfig();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!cfg.auth || !serviceKey) return send(503, { error: 'not-configured' });
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!token) return send(401, { error: 'no-token' });
  try {
    // Who is asking: Supabase checks the token.
    const who = await fetch(`${cfg.supabaseUrl}/auth/v1/user`, {
      headers: { apikey: cfg.supabaseAnonKey, authorization: `Bearer ${token[1]}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!who.ok) return send(401, { error: 'bad-token' });
    const user = await who.json();
    if (!user || !user.id) return send(401, { error: 'bad-token' });
    const del = await fetch(`${cfg.supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(user.id)}`, {
      method: 'DELETE',
      headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!del.ok) return send(502, { error: 'delete-failed', status: del.status });
    return send(200, { deleted: true });
  } catch (err) {
    return send(502, { error: 'unavailable', message: String(err.message).slice(0, 120) });
  }
}
