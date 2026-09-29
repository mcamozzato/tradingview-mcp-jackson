/**
 * Target selection — no TradingView connection needed.
 * Pins the rule that a TV_CHART_ID-pinned server attaches to its own tab or
 * refuses, and that the unpinned (legacy) rule is unchanged.
 *
 * Run: node --test tests/connection.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectChartTarget } from '../src/connection.js';

// CDP /json/list order: most recently ACTIVATED page first.
const TARGETS = [
  { type: 'iframe', id: 'f1', url: 'https://www.recaptcha.net/recaptcha/api2/anchor' },
  { type: 'page', id: 'golden', url: 'https://www.tradingview.com/chart/qYwPLlLm/' },
  { type: 'page', id: 'app', url: 'file:///Applications/TradingView.app/Contents/Resources/app.asar' },
  { type: 'page', id: 'extract', url: 'https://www.tradingview.com/chart/C8wbh2oi/?symbol=BATS%3ASPY' },
  { type: 'worker', id: 'w1', url: '' },
];

describe('selectChartTarget — pinned', () => {
  it('attaches to the pinned tab even when another tab is listed first', () => {
    assert.equal(selectChartTarget(TARGETS, 'C8wbh2oi').id, 'extract');
    assert.equal(selectChartTarget(TARGETS, 'qYwPLlLm').id, 'golden');
  });

  it('refuses when the pinned tab is not open — never falls back', () => {
    assert.throws(() => selectChartTarget(TARGETS, 'ZZZZ1234'), /found 0.*Refusing to fall back/);
  });

  it('refuses when two tabs show the same chart (ambiguous)', () => {
    const dup = [...TARGETS, { type: 'page', id: 'dup', url: 'https://www.tradingview.com/chart/C8wbh2oi/' }];
    assert.throws(() => selectChartTarget(dup, 'C8wbh2oi'), /found 2/);
  });

  it('does not match a chart id that merely starts with the pinned id', () => {
    const t = [{ type: 'page', id: 'x', url: 'https://www.tradingview.com/chart/C8wbh2oiXX/' }];
    assert.throws(() => selectChartTarget(t, 'C8wbh2oi'), /found 0/);
  });

  it('only pages count — an iframe or worker carrying the id is ignored', () => {
    const t = [{ type: 'iframe', id: 'i', url: 'https://www.tradingview.com/chart/C8wbh2oi/' }];
    assert.throws(() => selectChartTarget(t, 'C8wbh2oi'), /found 0/);
  });

  it('rejects a value that is not a chart id (no regex injection)', () => {
    assert.throws(() => selectChartTarget(TARGETS, '.*'), /is not a chart id/);
    assert.throws(() => selectChartTarget(TARGETS, 'https://www.tradingview.com/chart/C8wbh2oi/'), /is not a chart id/);
  });
});

describe('selectChartTarget — unpinned (legacy, unchanged)', () => {
  it('takes the first chart page in CDP order', () => {
    assert.equal(selectChartTarget(TARGETS).id, 'golden');
    assert.equal(selectChartTarget([TARGETS[3], TARGETS[1]]).id, 'extract');
  });

  it('falls back to any tradingview page, then null', () => {
    const t = [{ type: 'page', id: 'tv', url: 'https://www.tradingview.com/' }];
    assert.equal(selectChartTarget(t).id, 'tv');
    assert.equal(selectChartTarget([]), null);
  });
});
