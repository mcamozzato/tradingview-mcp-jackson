import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;
const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
const MAX_RETRIES = 5;
const BASE_DELAY = 500;

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  // Phase 1: Strategy data — model().dataSources() → find strategy → .performance().value(), .ordersData(), .reportData()
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  // Phase 2: Layouts — getSavedCharts(cb), loadChartFromServer(id)
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  // Phase 5: Symbol search — searchSymbols(query) returns Promise
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

export async function getClient() {
  if (client) {
    try {
      // Quick liveness check
      await client.Runtime.evaluate({ expression: '1', returnByValue: true });
      return client;
    } catch {
      client = null;
      targetInfo = null;
    }
  }
  return connect();
}

export async function connect() {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = await findChartTarget();
      if (!target) {
        throw new Error('No TradingView chart target found. Is TradingView open with a chart?');
      }
      targetInfo = target;
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });

      // Enable required domains
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();

      // A pinned server proves it landed on its tab before serving a single read.
      if (PINNED_CHART_ID) {
        const href = (await client.Runtime.evaluate({ expression: 'location.href', returnByValue: true }))
          ?.result?.value || '';
        try {
          selectChartTarget([{ type: 'page', url: href }], PINNED_CHART_ID);
        } catch {
          throw new Error(`pinned to ${PINNED_CHART_ID} but attached to ${href}`);
        }
      }

      return client;
    } catch (err) {
      lastError = err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

// TV_CHART_ID pins this server to ONE TradingView tab: the chart id in the tab's
// URL, e.g. "C8wbh2oi" for https://www.tradingview.com/chart/C8wbh2oi/.
//
// Why: CDP's /json/list puts the most recently ACTIVATED page first, and the
// unpinned rule takes the first chart page. So activating any other tab silently
// re-points every NEW connection: a job that meant "the golden layout" reads
// whatever tab someone last brought to the front. A pinned server attaches to its
// tab or refuses. It never falls back to another one.
const PINNED_CHART_ID = (process.env.TV_CHART_ID || '').trim() || null;

const CHART_ID_RE = /^[A-Za-z0-9]{4,16}$/;

export function selectChartTarget(targets, chartId = null) {
  const pages = (targets || []).filter(t => t && t.type === 'page' && typeof t.url === 'string');
  if (chartId) {
    if (!CHART_ID_RE.test(chartId)) {
      throw new Error(`TV_CHART_ID=${JSON.stringify(chartId)} is not a chart id (expected the `
        + 'alphanumeric id from a tradingview.com/chart/<id>/ URL).');
    }
    const re = new RegExp(`tradingview\\.com/chart/${chartId}(?:[/?#]|$)`);
    const hits = pages.filter(t => re.test(t.url));
    if (hits.length === 1) return hits[0];
    throw new Error(`TV_CHART_ID=${chartId}: expected exactly one open TradingView tab for this `
      + `chart, found ${hits.length}. Open that layout's tab in TradingView Desktop. `
      + 'Refusing to fall back to another tab.');
  }
  // Unpinned (legacy behaviour, unchanged): the first chart page in CDP's order.
  return pages.find(t => /tradingview\.com\/chart/i.test(t.url))
    || pages.find(t => /tradingview/i.test(t.url))
    || null;
}

export function pinnedChartId() {
  return PINNED_CHART_ID;
}

async function findChartTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  return selectChartTarget(targets, PINNED_CHART_ID);
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const result = await c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
    ...opts,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true });
}

export async function disconnect() {
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
  }
}

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar() {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars() {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
