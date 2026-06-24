'use strict';

// ══════════════════════════════════════════════════════════════════════
// WINDOW MANAGEMENT (opens popup.html as a standalone window)
// ══════════════════════════════════════════════════════════════════════
var WINDOW_ID = null;

chrome.action.onClicked.addListener(function () {
  if (WINDOW_ID !== null) {
    chrome.windows.get(WINDOW_ID, function (win) {
      if (chrome.runtime.lastError || !win) {
        WINDOW_ID = null;
        openWindow();
      } else {
        chrome.windows.update(WINDOW_ID, { focused: true });
      }
    });
  } else {
    openWindow();
  }
});

function openWindow() {
  chrome.windows.create({
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    width: 960,
    height: 800,
    focused: true
  }, function (win) {
    WINDOW_ID = win.id;
  });
}

chrome.windows.onRemoved.addListener(function (windowId) {
  if (windowId === WINDOW_ID) WINDOW_ID = null;
});

// ══════════════════════════════════════════════════════════════════════
// TRADE DESK — TradingView scanner proxy
// ══════════════════════════════════════════════════════════════════════
const TV_SCAN_URL =
  'https://scanner.tradingview.com/america/scan?label-product=screener-stock';

// ══════════════════════════════════════════════════════════════════════
// TRADE DESK — Daily-bar history (Yahoo primary, Stooq fallback)
// ══════════════════════════════════════════════════════════════════════
function yahooSymbol(sym) {
  var s = String(sym || '').toUpperCase().replace(/^.*:/, '').trim();
  if (s === 'VIX' || s === '^VIX') return '%5EVIX';
  return encodeURIComponent(s);
}
function stooqSymbol(sym) {
  var s = String(sym || '').toUpperCase().replace(/^.*:/, '').trim();
  if (s === 'VIX' || s === '^VIX') return '%5Evix';
  return encodeURIComponent(s.toLowerCase()) + '.us';
}

function fetchYahoo(sym, range) {
  var hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  var path = '/v8/finance/chart/' + yahooSymbol(sym) +
    '?range=' + encodeURIComponent(range) + '&interval=1d&includePrePost=false';
  function tryHost(i) {
    if (i >= hosts.length) return Promise.reject(new Error('yahoo unreachable'));
    return fetch('https://' + hosts[i] + path, { method: 'GET' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        var res = j && j.chart && j.chart.result && j.chart.result[0];
        var ts = res && res.timestamp;
        var q = res && res.indicators && res.indicators.quote && res.indicators.quote[0];
        if (!ts || !q) throw new Error('empty');
        var bars = [];
        for (var k = 0; k < ts.length; k++) {
          var o = q.open[k], h = q.high[k], l = q.low[k], c = q.close[k];
          if (o == null || h == null || l == null || c == null) continue;
          var d = new Date(ts[k] * 1000);
          bars.push({ time: d.toISOString().slice(0, 10), open: +o, high: +h, low: +l, close: +c });
        }
        if (!bars.length) throw new Error('no bars');
        return { bars: bars, source: 'yahoo' };
      })
      .catch(function () { return tryHost(i + 1); });
  }
  return tryHost(0);
}

function fetchStooq(sym, range) {
  var url = 'https://stooq.com/q/d/l/?s=' + stooqSymbol(sym) + '&i=d';
  return fetch(url, { method: 'GET' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
    .then(function (txt) {
      var lines = String(txt || '').trim().split(/\r?\n/);
      if (lines.length < 2 || lines[0].indexOf('Date') === -1) throw new Error('stooq bad csv');
      var bars = [];
      for (var i = 1; i < lines.length; i++) {
        var p = lines[i].split(',');
        if (p.length < 5) continue;
        var o = parseFloat(p[1]), h = parseFloat(p[2]), l = parseFloat(p[3]), c = parseFloat(p[4]);
        if (!isFinite(o) || !isFinite(h) || !isFinite(l) || !isFinite(c)) continue;
        bars.push({ time: p[0], open: o, high: h, low: l, close: c });
      }
      if (!bars.length) throw new Error('stooq empty');
      var n = range === '3mo' ? 63 : 126;
      if (bars.length > n) bars = bars.slice(bars.length - n);
      return { bars: bars, source: 'stooq' };
    });
}

function fetchDeskHistory(sym, range) {
  return fetchYahoo(sym, range).catch(function () { return fetchStooq(sym, range); });
}

// ══════════════════════════════════════════════════════════════════════
// TRADE DESK — News proxy (Finnhub + TradingView)
// ══════════════════════════════════════════════════════════════════════
var NEWS_NOISE = ['motley fool', 'zacks', 'seeking alpha', 'investorplace', 'tipranks', 'simply wall'];
function isNoisySource(src) {
  var s = String(src || '').toLowerCase();
  return NEWS_NOISE.some(function (n) { return s.indexOf(n) !== -1; });
}
function ymd(d) { return d.toISOString().slice(0, 10); }

function fetchFinnhubNews(symbol, key) {
  if (!key || !symbol) return Promise.resolve([]);
  var to = new Date(), from = new Date(Date.now() - 2 * 864e5);
  var url = 'https://finnhub.io/api/v1/company-news?symbol=' + encodeURIComponent(symbol) +
    '&from=' + ymd(from) + '&to=' + ymd(to) + '&token=' + encodeURIComponent(key);
  return fetch(url)
    .then(function (r) { if (!r.ok) throw new Error('finnhub HTTP ' + r.status); return r.json(); })
    .then(function (arr) {
      if (!Array.isArray(arr)) return [];
      return arr
        .filter(function (n) { return n && n.headline && n.url && !isNoisySource(n.source); })
        .sort(function (a, b) { return (b.datetime || 0) - (a.datetime || 0); })
        .slice(0, 3)
        .map(function (n) {
          return {
            headline: String(n.headline), summary: String(n.summary || '').slice(0, 280),
            url: String(n.url), source: String(n.source || ''), ts: (n.datetime || 0) * 1000
          };
        });
    })
    .catch(function () { return []; });
}

var __tvClient = null;
function _tvFetchItems(sym, client) {
  var url = 'https://news-headlines.tradingview.com/v2/headlines?client=' +
    encodeURIComponent(client) + '&lang=en&symbol=' + encodeURIComponent(sym);
  return fetch(url)
    .then(function (r) { if (!r.ok) throw new Error('tv HTTP ' + r.status); return r.json(); })
    .then(function (j) {
      return Array.isArray(j) ? j
        : (j && Array.isArray(j.data)) ? j.data
          : (j && Array.isArray(j.items)) ? j.items : [];
    });
}
function _tvParse(items) {
  var cutoff = Math.floor(Date.now() / 1000) - 24 * 3600;
  return (items || []).map(function (n) {
    n = n || {};
    var title = String(n.title || n.headline || '').trim();
    if (!title) return null;
    var pub = (typeof n.published === 'number') ? n.published
      : (typeof n.published_at === 'number') ? n.published_at : 0;
    var sec = pub > 1e11 ? Math.floor(pub / 1000) : pub;
    if (sec && sec < cutoff) return null;
    var srcRaw = n.source || n.provider || '';
    var src = (srcRaw && typeof srcRaw === 'object') ? (srcRaw.name || srcRaw.id || 'TradingView') : String(srcRaw || 'TradingView');
    if (isNoisySource(src)) return null;
    var link = n.link || '';
    if (!link && n.storyPath) link = 'https://www.tradingview.com' + n.storyPath;
    if (!link) return null;
    return {
      title: title.slice(0, 200), url: link, source: src.slice(0, 40),
      summary: String(n.shortDescription || n.summary || '').slice(0, 280),
      ts: (sec || Math.floor(Date.now() / 1000)) * 1000
    };
  }).filter(Boolean);
}
function fetchTVNews(tvSymbol, bareTicker) {
  var syms = [];
  if (tvSymbol) syms.push(tvSymbol);
  if (bareTicker && bareTicker !== tvSymbol) syms.push(bareTicker);
  if (!syms.length) return Promise.resolve([]);
  var clients = __tvClient ? [__tvClient] : ['symbol', 'overview', 'landing_page', 'widget'];
  function tryCombo(ci, si) {
    if (ci >= clients.length) return Promise.resolve([]);
    if (si >= syms.length) return tryCombo(ci + 1, 0);
    return _tvFetchItems(syms[si], clients[ci])
      .then(function (items) {
        var parsed = _tvParse(items);
        if (parsed.length) { __tvClient = clients[ci]; return parsed.slice(0, 3); }
        return tryCombo(ci, si + 1);
      })
      .catch(function () { return tryCombo(ci, si + 1); });
  }
  return tryCombo(0, 0);
}

// ══════════════════════════════════════════════════════════════════════
// TRADE JOURNAL — Candle fetcher (Yahoo / Polygon / Finnhub)
// ══════════════════════════════════════════════════════════════════════
async function bg_fetchCandles(ticker, fromMs, toMs, resolution, polygonKey, finnhubKey, dailyRange) {
  if (resolution === 'daily') {
    var rangeStr = /^(1mo|3mo|6mo|1y|2y)$/.test(dailyRange || '') ? dailyRange : '1mo';
    var yhUrl = 'https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) +
      '?interval=1d&range=' + rangeStr + '&includePrePost=false';
    var yr = await fetch(yhUrl, { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
    if (!yr.ok) throw new Error('Yahoo daily HTTP ' + yr.status);
    var yd = await yr.json();
    var result = yd && yd.chart && yd.chart.result && yd.chart.result[0];
    if (!result || !result.timestamp || !result.timestamp.length) throw new Error('Yahoo: no daily data for ' + ticker);
    var q = result.indicators.quote[0];
    return result.timestamp.map(function (ts, i) {
      if (q.close[i] == null) return null;
      return { time: ts, open: q.open[i] || q.close[i], high: q.high[i] || q.close[i], low: q.low[i] || q.close[i], close: q.close[i], volume: q.volume[i] || 0 };
    }).filter(Boolean);
  }
  var yhError = null;
  try {
    var interval = resolution <= 1 ? '1m' : resolution <= 2 ? '2m' : resolution <= 5 ? '5m' : '15m';
    var range = (resolution || 1) <= 1 ? '5d' : '1mo';
    var yhUrl2 = 'https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) +
      '?interval=' + interval + '&range=' + range + '&includePrePost=true';
    var yr2 = await fetch(yhUrl2, { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
    if (yr2.ok) {
      var yd2 = await yr2.json();
      var result2 = yd2 && yd2.chart && yd2.chart.result && yd2.chart.result[0];
      if (result2 && result2.timestamp && result2.timestamp.length) {
        var allTs = result2.timestamp, q2 = result2.indicators.quote[0], candles = [];
        for (var i = 0; i < allTs.length; i++) {
          var tMs = allTs[i] * 1e3;
          if (tMs < fromMs || tMs > toMs) continue;
          if (q2.open[i] == null || q2.close[i] == null) continue;
          candles.push({ time: allTs[i], open: q2.open[i], high: q2.high[i], low: q2.low[i], close: q2.close[i], volume: q2.volume[i] || 0 });
        }
        if (candles.length) return candles;
        yhError = 'no data for ' + new Date(fromMs).toISOString().slice(0, 10);
      } else {
        var errCode = yd2 && yd2.chart && yd2.chart.error && yd2.chart.error.code;
        yhError = errCode ? 'Yahoo error: ' + errCode : 'empty result';
      }
    } else { yhError = 'HTTP ' + yr2.status; }
  } catch (e) { yhError = e.message; }
  if (polygonKey) {
    var fromDate = new Date(fromMs).toISOString().slice(0, 10);
    var toDate = new Date(toMs).toISOString().slice(0, 10);
    var url = 'https://api.polygon.io/v2/aggs/ticker/' + encodeURIComponent(ticker) +
      '/range/' + resolution + '/minute/' + fromDate + '/' + toDate +
      '?adjusted=false&sort=asc&limit=5000&apiKey=' + encodeURIComponent(polygonKey);
    var r = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error('Polygon HTTP ' + r.status + '. Yahoo also failed: ' + (yhError || 'no data'));
    var data = await r.json();
    if (!data.results || !data.results.length) throw new Error('Polygon: no data for ' + ticker);
    return data.results.map(function (b) { return { time: Math.floor(b.t / 1e3), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }; });
  }
  if (finnhubKey) {
    var url2 = 'https://finnhub.io/api/v1/stock/candle?symbol=' + encodeURIComponent(ticker) +
      '&resolution=' + (resolution === 1 ? '1' : resolution === 5 ? '5' : '1') +
      '&from=' + Math.floor(fromMs / 1e3) + '&to=' + Math.floor(toMs / 1e3) +
      '&token=' + encodeURIComponent(finnhubKey);
    var r2 = await fetch(url2, { method: 'GET', headers: { Accept: 'application/json' } });
    if (!r2.ok) throw new Error('Finnhub HTTP ' + r2.status);
    var data2 = await r2.json();
    if (data2.s !== 'ok' || !data2.t || !data2.t.length) throw new Error('Finnhub: no data for ' + ticker);
    return data2.t.map(function (ts, i) { return { time: ts, open: data2.o[i], high: data2.h[i], low: data2.l[i], close: data2.c[i], volume: data2.v[i] }; });
  }
  throw new Error('No chart data available. Yahoo only covers last 7 days. Add a Finnhub key under Chart data in the Journal tab for ~1 month of history.' + (yhError ? ' (' + yhError + ')' : ''));
}

// ══════════════════════════════════════════════════════════════════════
// MESSAGE ROUTER — handles all actions from popup.js
// ══════════════════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg) return;

  // Trade Desk: TradingView screener proxy
  if (msg.action === 'tvScan') {
    fetch(TV_SCAN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.body || {})
    })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (data) { sendResponse({ ok: true, data: data }); })
      .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
    return true;
  }

  // Trade Desk: daily OHLC history for market/sector charts
  if (msg.action === 'chartHistory') {
    var range = (msg.range === '3mo' || msg.range === '6mo') ? msg.range : '6mo';
    fetchDeskHistory(msg.symbol, range)
      .then(function (out) { sendResponse({ ok: true, bars: out.bars, source: out.source }); })
      .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
    return true;
  }

  // Trade Desk: news (Finnhub + TradingView)
  if (msg.action === 'news') {
    Promise.all([
      fetchFinnhubNews(msg.symbol, msg.finnhubKey),
      fetchTVNews(msg.tvSymbol, msg.symbol)
    ])
      .then(function (res) { sendResponse({ ok: true, finnhub: res[0], tradingview: res[1] }); })
      .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
    return true;
  }

  // Trade Journal: intraday / daily candles for per-trade charts
  if (msg.action === 'fetchCandles') {
    bg_fetchCandles(msg.ticker, msg.fromMs, msg.toMs, msg.resolution, msg.polygonKey, msg.finnhubKey, msg.range)
      .then(function (result) { sendResponse({ ok: true, candles: result }); })
      .catch(function (e) { sendResponse({ ok: false, error: e.message }); });
    return true;
  }
});
