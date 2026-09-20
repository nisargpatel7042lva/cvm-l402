import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeCaveat, decodeServices, encodeCaveat, encodeServices, servicesSatisfier, timeoutSatisfier, verifyCaveats } from './caveat.js';

test('caveat encode/decode splits on first "=" only', () => {
  assert.equal(encodeCaveat({ condition: 'a', value: 'b=c' }), 'a=b=c');
  assert.deepEqual(decodeCaveat('a=b=c'), { condition: 'a', value: 'b=c' });
  assert.equal(decodeCaveat('no-equals'), undefined);
});

test('services encode/decode', () => {
  assert.equal(encodeServices([{ name: 'weather', tier: 0 }, { name: 'geo', tier: 2 }]), 'weather:0,geo:2');
  assert.deepEqual(decodeServices('weather:0,geo:2'), [{ name: 'weather', tier: 0 }, { name: 'geo', tier: 2 }]);
  assert.throws(() => decodeServices('nocolon'), /invalid service/);
});

test('services satisfier: target must be listed; successive lists must be subsets', () => {
  const s = servicesSatisfier('weather');
  assert.ok(s.satisfyFinal({ condition: 'services', value: 'weather:0,geo:0' }));
  assert.equal(s.satisfyFinal({ condition: 'services', value: 'geo:0' }), false);
  assert.ok(s.satisfyPrevious({ condition: 'services', value: 'weather:0,geo:0' }, { condition: 'services', value: 'weather:0' }));
  assert.equal(s.satisfyPrevious({ condition: 'services', value: 'weather:0' }, { condition: 'services', value: 'weather:0,geo:0' }), false);
});

test('timeout satisfier: now < valid_until; successive must not extend', () => {
  const s = timeoutSatisfier('weather', () => 1000);
  assert.equal(s.condition, 'weather_valid_until');
  assert.ok(s.satisfyFinal({ condition: s.condition, value: '1001' }));
  assert.equal(s.satisfyFinal({ condition: s.condition, value: '1000' }), false);
  assert.equal(s.satisfyFinal({ condition: s.condition, value: 'abc' }), false);
  assert.ok(s.satisfyPrevious({ condition: s.condition, value: '2000' }, { condition: s.condition, value: '1500' }));
  assert.equal(s.satisfyPrevious({ condition: s.condition, value: '1500' }, { condition: s.condition, value: '2000' }), false);
});

test('verifyCaveats: unknown conditions skipped, failures throw', () => {
  const sats = [servicesSatisfier('weather'), timeoutSatisfier('weather', () => 10)];
  assert.doesNotThrow(() => verifyCaveats([{ condition: 'services', value: 'weather:0' }, { condition: 'some_other_app', value: 'x' }], sats));
  assert.throws(() => verifyCaveats([{ condition: 'services', value: 'geo:0' }], sats), /not satisfied/);
  assert.throws(() => verifyCaveats([{ condition: 'weather_valid_until', value: '5' }], sats), /not satisfied/);
  assert.throws(
    () => verifyCaveats([{ condition: 'services', value: 'weather:0' }, { condition: 'services', value: 'weather:0,geo:0' }], sats),
    /not more restrictive/,
  );
});
