import test from 'node:test';
import assert from 'node:assert/strict';
import { saveSchema } from '../lib/workspace-validation.ts';

test('workspace save revisions must remain exact after the next increment', () => {
  const data = { business: 'Revision QA', currency: 'PKR', openingCash: '0.00', companies: [], shipments: [], payments: [], imports: [], audit: [] };
  const save = revision => saveSchema.safeParse({ data, revision, action: 'Save' }).success;
  assert.equal(save(0), true);
  assert.equal(save(Number.MAX_SAFE_INTEGER - 1), true);
  for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, Infinity]) assert.equal(save(revision), false);
});
