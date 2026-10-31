import test from 'node:test';
import assert from 'node:assert/strict';
import { parseISODate, formatISODate, isDateAllowed } from '../lib/control-dates.ts';

test('date-only controls round-trip valid calendar dates without UTC conversions',()=>{
  for(const iso of ['2026-11-01','2024-02-29','0099-12-31','1900-01-01'])assert.equal(formatISODate(parseISODate(iso)),iso);
});

test('impossible or non-ISO source dates never roll over into an approved day',()=>{
  for(const value of ['2025-02-29','2026-04-31','2026-13-01','0000-01-01','01/11/2026','2026-1-1',''])assert.equal(parseISODate(value),undefined);
});

test('inclusive min/max restrictions reject dates outside the allowed calendar range',()=>{
  assert.equal(isDateAllowed('2026-11-01','2026-11-01','2026-11-30'),true);
  assert.equal(isDateAllowed('2026-11-30','2026-11-01','2026-11-30'),true);
  assert.equal(isDateAllowed('2026-10-31','2026-11-01','2026-11-30'),false);
  assert.equal(isDateAllowed('2026-12-01','2026-11-01','2026-11-30'),false);
});
