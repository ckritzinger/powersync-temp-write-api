import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { applyPatch } from './prepare-backend.mjs';

test('configuration patch fails closed on missing or ambiguous upstream source', async () => {
  const patch = JSON.parse(await readFile(new URL('../backend/patches/verifier-supplements.json', import.meta.url)));
  assert.throws(() => applyPatch('changed upstream', patch), /exactly one/);
  assert.throws(() => applyPatch(patch.before + patch.before, patch), /exactly one/);
  const input = `prefix\n${patch.before}\nsuffix`;
  assert.equal(applyPatch(input, patch), `prefix\n${patch.after}\nsuffix`);
});
