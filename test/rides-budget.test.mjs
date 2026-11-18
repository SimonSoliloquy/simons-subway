// Guards the rides Worker's shared allowance (see src/budget.js). Run: npm test (also before every build).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBudget } from '../src/budget.js';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const body = (name) => {
  const i = main.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `${name} not found`);
  let depth = 0, j = main.indexOf('{', i);
  for (let k = j; k < main.length; k++) {
    if (main[k] === '{') depth++;
    else if (main[k] === '}' && --depth === 0) return main.slice(j, k + 1);
  }
  throw new Error(`${name} has no end`);
};

test('a runaway loop of reads gets at most one read per 30 s and 40 per hour', () => {
  const check = createBudget({ readGapMs: 30_000, perHour: 40 });
  let sent = 0;
  // a tight loop: a read every 50 ms for two hours
  for (let t = 0; t < 2 * 3600_000; t += 50) if (!check(true, t)) sent++;
  assert.ok(sent <= 2 * 40, `sent ${sent} reads in two hours`);
  assert.ok(sent >= 2 * 40 - 1, 'normal polling still gets through');
});

test('writes are capped too', () => {
  const check = createBudget({ readGapMs: 30_000, perHour: 40 });
  let sent = 0;
  for (let t = 0; t < 3600_000; t += 10) if (!check(false, t)) sent++;
  assert.equal(sent, 40);
});

test('only ridesApi calls the Worker, and it asks the budget first', () => {
  assert.equal(main.split('fetch(RIDES_API').length - 1, 1, 'fetch(RIDES_API…) must appear exactly once');
  const api = body('ridesApi');
  assert.ok(api.includes('fetch(RIDES_API'), 'the one fetch must be inside ridesApi');
  assert.ok(api.indexOf('ridesBudget(') < api.indexOf('fetch(RIDES_API'), 'ridesApi must check the budget before fetching');
});

test('syncRide never calls itself (the 2026-11-15 bug)', () => {
  const sync = body('syncRide');
  assert.equal(sync.split('syncRide(').length - 1, 0, 'syncRide must not call syncRide');
});

test('no ride function calls the Worker from a timer or the frame loop', () => {
  for (const fn of ['animateRide', 'updateRide', 'renderRide', 'updateMini', 'frame', 'tick']) {
    const b = body(fn);
    assert.ok(!/ridesApi\(|syncRide\(/.test(b), `${fn} must not call the Worker`);
  }
});

test('ride tracking ships switched off', () => {
  assert.match(main, /const RIDES_ON = import\.meta\.env\.VITE_RIDES === 'on';/);
  for (const fn of ['loadRide', 'startRide', 'renderRide']) assert.ok(body(fn).includes('if (!RIDES_ON) return;'), `${fn} must check RIDES_ON`);
});

test('the × on your own live ride hides the card and never ends the ride', () => {
  const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const hide = src.indexOf("b.id === 'ride-close' && state.ride && !state.ride.shared && !state.ride.ended");
  const end = src.indexOf("if (b.id === 'ride-close' || b.id === 'ride-done') clearRide();");
  assert.ok(hide > 0 && end > hide, 'the hide case must come before clearRide');
  assert.match(src.slice(hide, end), /menuEl\.open = false;[^\n]*return;/);
});
