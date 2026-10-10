import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanToken, parseEnv } from '../scripts/lib/env.mjs';

test('parseEnv reads the snippet Vercel gives, with Windows line endings and comments', () => {
  const text = '# Blob\r\nBLOB_READ_WRITE_TOKEN="vercel_blob_rw_abc_def"\r\nexport PLAIN=value # trailing\r\n\r\nSINGLE=\'x y\'\r\nbad line\r\n';
  assert.deepEqual(parseEnv(text), { BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_abc_def', PLAIN: 'value', SINGLE: 'x y' });
});

test('cleanToken drops quotes and spaces copied with the token', () => {
  assert.equal(cleanToken(' "vercel_blob_rw_abc_def" '), 'vercel_blob_rw_abc_def');
  assert.equal(cleanToken("'vercel_blob_rw_abc_def'"), 'vercel_blob_rw_abc_def');
  assert.equal(cleanToken(undefined), '');
});
