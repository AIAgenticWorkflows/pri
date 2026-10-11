// Tells the page whether sign-in is set up, and how to reach Supabase. The anon key is
// meant to be public: what each person can read or change is enforced by the database
// (row level security, see supabase/schema.sql).
//
// Environment variables (Vercel, Settings, Environment Variables):
//   SUPABASE_URL, SUPABASE_ANON_KEY           (or the NEXT_PUBLIC_ names the Supabase integration adds)
//   PRI_AUTH_PROVIDERS                         which buttons to show, e.g. "google,facebook,apple,email"

import { findEnv } from '../scripts/lib/env.mjs';

export { findEnv };

export function authConfig(env = process.env) {
  const url = findEnv(env, ['SUPABASE_URL']);
  const anonKey = findEnv(env, ['SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY']);
  const allowed = ['google', 'facebook', 'apple', 'email'];
  const providers = String(env.PRI_AUTH_PROVIDERS || 'email')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => allowed.includes(p));
  if (!url || !anonKey) {
    // Names only, never values: helps see what is missing.
    const seen = Object.keys(env).filter((k) => /SUPABASE/i.test(k)).sort();
    return { auth: false, missing: [!url && 'SUPABASE_URL', !anonKey && 'SUPABASE_ANON_KEY'].filter(Boolean), supabaseVariables: seen };
  }
  return { auth: true, supabaseUrl: url.value.replace(/\/+$/, ''), supabaseAnonKey: anonKey.value, providers };
}

export function serviceKey(env = process.env) {
  const hit = findEnv(env, ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY']);
  return hit ? hit.value : '';
}

export default function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=60, s-maxage=60');
  res.end(JSON.stringify(authConfig()));
}
