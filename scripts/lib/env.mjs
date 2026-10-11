// Loads KEY=value lines from .env.local (and .env) in the project folder into
// process.env, so a token pasted once into a file is picked up by every run.
// Values in the file win over the terminal. Returns the names of the files read.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '').trim();
    out[m[1]] = value;
  }
  return out;
}

export function loadEnv(dir, files = ['.env.local', '.env']) {
  const loaded = [];
  for (const name of files) {
    const file = path.join(dir, name);
    if (!existsSync(file)) continue;
    const values = parseEnv(readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(values)) {
      // The file wins over a value left in the terminal or in Windows settings.
      if (value !== '') process.env[key] = value;
    }
    loaded.push(name);
  }
  return loaded;
}

// A token copied from a web page often arrives with quotes or spaces around it.
export function cleanToken(value) {
  return String(value || '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .trim();
}

// The Supabase integration names its variables in different ways (a prefix such as
// STORAGE_, NEXT_PUBLIC_, or the newer "publishable" and "secret" keys), so any variable
// whose name ends the right way is accepted.
export function findEnv(env, endings) {
  for (const ending of endings) {
    const exact = Object.keys(env).filter((k) => k === ending);
    const prefixed = Object.keys(env).filter((k) => k !== ending && k.endsWith(`_${ending}`)).sort();
    for (const k of [...exact, ...prefixed]) if (env[k]) return { name: k, value: cleanToken(env[k]) };
  }
  return null;
}
