// Tells the page whether sign-in is set up, and how to reach Supabase. The anon key is
// meant to be public: what each person can read or change is enforced by the database
// (row level security, see supabase/schema.sql).
//
// Environment variables (Vercel, Settings, Environment Variables):
//   SUPABASE_URL, SUPABASE_ANON_KEY           (or the NEXT_PUBLIC_ names the Supabase integration adds)
//   PRI_AUTH_PROVIDERS                         which buttons to show, e.g. "google,facebook,apple,email"

export function authConfig(env = process.env) {
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '';
  const anonKey = env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  const allowed = ['google', 'facebook', 'apple', 'email'];
  const providers = String(env.PRI_AUTH_PROVIDERS || 'email')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => allowed.includes(p));
  if (!url || !anonKey) return { auth: false };
  return { auth: true, supabaseUrl: url.replace(/\/+$/, ''), supabaseAnonKey: anonKey, providers };
}

export default function handler(req, res) {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'public, max-age=60, s-maxage=300');
  res.end(JSON.stringify(authConfig()));
}
