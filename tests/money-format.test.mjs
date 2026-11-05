import test from 'node:test';
import assert from 'node:assert/strict';
import { money } from '../lib/types.ts';

test('money display preserves cents for the full supported financial range',()=>{
  assert.equal(money('999999999999999.99',2),'999,999,999,999,999.99');
  assert.equal(money('-999999999999999.99',2),'-999,999,999,999,999.99');
  assert.equal(money('1000000000000.01',2),'1,000,000,000,000.01');
});

test('money display rounds exact decimal strings once at the requested precision',()=>{
  assert.equal(money('1.005',2),'1.01');assert.equal(money('-1.005',2),'-1.01');
  assert.equal(money('999999999999999.995',2),'1,000,000,000,000,000.00');
  assert.equal(money('28.940',3),'28.940');assert.equal(money('0.50'), '1');
  assert.equal(money('',2),'0.00');assert.equal(money(1234.5,2),'1,234.50');
});
