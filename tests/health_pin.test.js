/**
 * healthCheck reports the pin and the LIVE page address — exercised, not grepped.
 * The connection module is replaced by a fake, so no TradingView is needed.
 *
 * Run: node --test --experimental-test-module-mocks tests/health_pin.test.js
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

const fake = {
  pinned: 'qYwPLlLm',
  targetUrl: 'https://www.tradingview.com/chart/qYwPLlLm/',
  pageUrl: 'https://www.tradingview.com/chart/qYwPLlLm/?symbol=BATS%3ASPY',
};

mock.module('../src/connection.js', {
  namedExports: {
    getClient: async () => ({}),
    getTargetInfo: async () => ({ id: 'T1', url: fake.targetUrl, title: 'TradingView' }),
    evaluate: async () => ({ url: fake.pageUrl, symbol: 'BATS:SPY', resolution: '1D', chartType: 1, apiAvailable: true }),
    pinnedChartId: () => fake.pinned,
  },
});

const { healthCheck } = await import('../src/core/health.js');

describe('healthCheck', () => {
  it('echoes the pin this server runs under', async () => {
    const h = await healthCheck();
    assert.equal(h.pinned_chart_id, 'qYwPLlLm');
  });

  it('reports the live page address, not only the cached target entry', async () => {
    fake.pageUrl = 'https://www.tradingview.com/chart/C8wbh2oi/';
    const h = await healthCheck();
    assert.equal(h.page_url, 'https://www.tradingview.com/chart/C8wbh2oi/');
    assert.equal(h.target_url, 'https://www.tradingview.com/chart/qYwPLlLm/');
  });

  it('reports a null pin when unpinned', async () => {
    fake.pinned = null;
    const h = await healthCheck();
    assert.equal(h.pinned_chart_id, null);
  });
});
