'use strict';

/* ══════════════════════════════════════════════════════════════════════
   Trade Desk — clean rebuild (Market + Screener)
   Market regime dashboard + sector short-term bias + 3-screener scanner.
   Tap any index or sector for a daily candle chart (lightweight-charts).
   ══════════════════════════════════════════════════════════════════════ */

// ── tiny helpers ───────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function fmtVolShort(n) {
  if (n == null || !isFinite(n)) return '—';
  var a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
}
function fmtETTime(ms) {
  try {
    return new Date(ms).toLocaleTimeString('en-US',
      { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  } catch (_) { return ''; }
}
// Single backend round-trip (background POSTs to TradingView).
function tvScan(body) {
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage({ action: 'tvScan', body: body }, function (resp) {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp || !resp.ok) return reject(new Error(resp ? resp.error : 'no response'));
      resolve(resp.data);
    });
  });
}
// Map a TV row (item.d[]) to a named object given the column order.
function rowObj(item, cols) {
  var d = item.d || [], o = {};
  cols.forEach(function (c, i) { o[c] = d[i]; });
  return o;
}

// ── persistent settings + chrome.storage helpers ───────────────────────
var DEFAULT_SETTINGS = {
  hotImmediate: 80,     // sector score ≥ this → HOT immediately
  hotSustained: 65,     // score ≥ this → HOT only after holding hotSustainedDays sessions
  hotSustainedDays: 2,  // consecutive refresh sessions (distinct ET days) required to enter
  hotFloor: 40,         // once HOT, stays HOT while score ≥ this floor
  hotCoolDays: 2,       // drop HOT only after score is below the floor for MORE than this many sessions
  finnhubKey: '',
  finnhubNews: true     // include Finnhub news on cards (alongside TradingView); off = TradingView only
};
var settings = Object.assign({}, DEFAULT_SETTINGS);

function storageGet(keys) {
  return new Promise(function (resolve) {
    try {
      chrome.storage.local.get(keys, function (res) {
        resolve(chrome.runtime.lastError ? {} : (res || {}));
      });
    } catch (_) { resolve({}); }
  });
}
function storageSet(obj) {
  return new Promise(function (resolve) {
    try { chrome.storage.local.set(obj, function () { resolve(!chrome.runtime.lastError); }); }
    catch (_) { resolve(false); }
  });
}
function loadSettings() {
  return storageGet(['settings']).then(function (r) {
    settings = Object.assign({}, DEFAULT_SETTINGS, r.settings || {});
    return settings;
  });
}
function saveSettings() { return storageSet({ settings: settings }); }

// ET calendar date as YYYY-MM-DD (en-CA renders ISO-style); keys the hot history.
function etDateStr(ms) {
  try {
    return new Date(ms == null ? Date.now() : ms)
      .toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  } catch (_) { return new Date().toISOString().slice(0, 10); }
}

// Relative "x ago" for news timestamps (ms).
function fmtAgo(ts) {
  if (!ts) return '';
  var s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

// News round-trip (background fetches Finnhub + TradingView).
function fetchNews(symbol, tvSymbol) {
  var fhKey = settings.finnhubNews ? (settings.finnhubKey || '') : '';
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage(
      { action: 'news', symbol: symbol, tvSymbol: tvSymbol || '', finnhubKey: fhKey },
      function (resp) {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp || !resp.ok) return reject(new Error(resp ? resp.error : 'no response'));
        resolve(resp);
      });
  });
}

// ══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════════════

// Stock-type gate applied to every screener (common/preferred/DR/non-ETF fund; no pre-IPO).
var STOCK_FILTER2 = {
  operator: 'and',
  operands: [
    { operation: { operator: 'or', operands: [
      { operation: { operator: 'and', operands: [
        { expression: { left: 'type', operation: 'equal', right: 'stock' } },
        { expression: { left: 'typespecs', operation: 'has', right: ['common'] } } ] } },
      { operation: { operator: 'and', operands: [
        { expression: { left: 'type', operation: 'equal', right: 'stock' } },
        { expression: { left: 'typespecs', operation: 'has', right: ['preferred'] } } ] } },
      { operation: { operator: 'and', operands: [
        { expression: { left: 'type', operation: 'equal', right: 'dr' } } ] } },
      { operation: { operator: 'and', operands: [
        { expression: { left: 'type', operation: 'equal', right: 'fund' } },
        { expression: { left: 'typespecs', operation: 'has_none_of', right: ['etf', 'mutual', 'closedend'] } } ] } }
    ] } },
    { expression: { left: 'typespecs', operation: 'has_none_of', right: ['pre-ipo'] } }
  ]
};

// Column set requested for every screener (order = the response contract).
var TV_COLUMNS = [
  'ticker-view', 'open', 'close', 'change', 'relative_volume_10d_calc',
  'relative_volume_intraday|5', 'market_cap_basic', 'sector', 'industry',
  'change_from_open', 'VWAP',
  'High.1M', 'Low.1M', 'high', 'low', 'ATR',
  'short_percentage_of_float', 'float_shares_outstanding',
  'EMA9', 'EMA13', 'EMA20', 'EMA50', 'SMA5'
];

// The 3 screeners. Each runs its own filter set + sort against the scanner.
var SCREENERS = {
  trend: {
    name: '🍏 Trend + RVOL', short: 'Trend',
    filters: [
      { left: 'close', operation: 'egreater', right: 20 },
      { left: 'close', operation: 'egreater', right: 'SMA5' },
      { left: 'close', operation: 'egreater', right: 'VWAP' },
      { left: 'close|1W', operation: 'greater', right: 'VWAP|1W' },
      { left: 'close|1M', operation: 'greater', right: 'VWAP|1M' },
      { left: 'EMA50|1', operation: 'greater', right: 'EMA120|1' },
      { left: 'close|1', operation: 'egreater', right: 'EMA50|1' },
      { left: 'average_volume_90d_calc', operation: 'greater', right: 1000000 },
      { left: 'VWAP', operation: 'egreater', right: 'SMA75|5' },
      { left: 'relative_volume_intraday|5', operation: 'greater', right: 3 },
      { left: 'relative_volume_10d_calc', operation: 'greater', right: 1.5 },
      { left: 'close', operation: 'egreater', right: 1 }
    ],
    sort: { sortBy: 'change', sortOrder: 'desc' }
  },
  premarket: {
    name: '🔵 Pre-Market Volume', short: 'Pre-Mkt',
    filters: [
      { left: 'close', operation: 'egreater', right: 0.5 },
      { left: 'close', operation: 'egreater', right: 1 },
      { left: 'average_volume_10d_calc', operation: 'greater', right: 2000000 },
      { left: 'relative_volume_10d_calc', operation: 'greater', right: 3 },
      { left: 'premarket_volume', operation: 'greater', right: 1500000 }
    ],
    sort: { sortBy: 'premarket_volume', sortOrder: 'desc' }
  },
  bigmoves: {
    name: '❤️ Big Moves', short: 'Big Move',
    filters: [
      { left: 'relative_volume_10d_calc', operation: 'greater', right: 10 },
      { left: 'close', operation: 'egreater', right: 2 },
      { left: 'average_volume_10d_calc', operation: 'greater', right: 2000000 }
    ],
    sort: { sortBy: 'relative_volume_10d_calc', sortOrder: 'desc' }
  }
};

// Sector ETF map (15 broad sectors).
var SECTOR_ETF_MAP = {
  'Technology': 'AMEX:XLK', 'Finance': 'AMEX:XLF', 'Energy Minerals': 'AMEX:XLE',
  'Health Technology': 'AMEX:XLV', 'Producer Manufacturing': 'AMEX:XLI',
  'Communications': 'AMEX:XLC', 'Consumer Durables': 'AMEX:XLY',
  'Consumer Non-Durables': 'AMEX:XLP', 'Non-Energy Minerals': 'AMEX:XLB',
  'Finance/Real Estate': 'AMEX:XLRE', 'Utilities': 'AMEX:XLU',
  'Electronic Technology': 'AMEX:SMH', 'Health Services': 'AMEX:IBB',
  'Retail Trade': 'AMEX:XRT', 'Transportation': 'AMEX:XTN'
};
var SECTOR_ETF_REVERSE = {};
Object.keys(SECTOR_ETF_MAP).forEach(function (k) { SECTOR_ETF_REVERSE[SECTOR_ETF_MAP[k]] = k; });

// Granular sub-sector → broad key (trimmed but covers the common cases).
var SECTOR_FALLBACK_MAP = {
  'technology services': 'Technology', 'packaged software': 'Technology', 'software': 'Technology',
  'internet software/services': 'Technology', 'data processing services': 'Technology',
  'semiconductors': 'Electronic Technology', 'electronic components': 'Electronic Technology',
  'computer processing hardware': 'Electronic Technology', 'telecommunications equipment': 'Electronic Technology',
  'biotechnology': 'Health Technology', 'pharmaceuticals: major': 'Health Technology',
  'pharmaceuticals: other': 'Health Technology', 'medical specialties': 'Health Technology',
  'managed health care': 'Health Services', 'services to the health industry': 'Health Services',
  'major banks': 'Finance', 'regional banks': 'Finance', 'investment banks/brokers': 'Finance',
  'real estate investment trusts': 'Finance/Real Estate', 'oil & gas production': 'Energy Minerals',
  'integrated oil': 'Energy Minerals', 'oilfield services/equipment': 'Energy Minerals',
  'precious metals': 'Non-Energy Minerals', 'steel': 'Non-Energy Minerals', 'aluminum': 'Non-Energy Minerals',
  'aerospace & defense': 'Producer Manufacturing', 'industrial machinery': 'Producer Manufacturing',
  'motor vehicles': 'Consumer Durables', 'apparel/footwear': 'Consumer Non-Durables',
  'specialty stores': 'Retail Trade', 'internet retail': 'Retail Trade', 'discount stores': 'Retail Trade',
  'airlines': 'Transportation', 'trucking': 'Transportation', 'railroads': 'Transportation',
  'major telecommunications': 'Communications', 'electric utilities': 'Utilities',
  // ── TV top-level sectors that aren't ETF-bucket keys themselves ──
  // Without these, stocks in them resolve to nothing and the card shows a raw,
  // un-scored sector that can never reflect a hot bucket. Each is folded into
  // the closest scored proxy so the card and Market tab judge sectors the same
  // way. 'Miscellaneous' is left unmapped on purpose (no sensible ETF proxy).
  'commercial services': 'Producer Manufacturing',
  'consumer services': 'Consumer Durables',
  'distribution services': 'Producer Manufacturing',
  'industrial services': 'Producer Manufacturing',
  'process industries': 'Non-Energy Minerals'
};
function resolveBroadSector(stock) {
  if (!stock) return null;
  var sec = (stock.sector || '').toLowerCase().trim();
  var ind = (stock.industry || '').toLowerCase().trim();
  if (!sec && !ind) return null;
  if (sec) {
    var exact = Object.keys(SECTOR_ETF_MAP).find(function (k) { return k.toLowerCase() === sec; });
    if (exact) return exact;
  }
  if (sec && SECTOR_FALLBACK_MAP[sec]) return SECTOR_FALLBACK_MAP[sec];
  if (ind && SECTOR_FALLBACK_MAP[ind]) return SECTOR_FALLBACK_MAP[ind];
  // guarded substring: multi-word ETF keys only (never bare "Technology")
  var guard = Object.keys(SECTOR_ETF_MAP).filter(function (k) { return /[ /]/.test(k); });
  if (sec) { var g = guard.find(function (k) { return sec.indexOf(k.toLowerCase()) !== -1; }); if (g) return g; }
  if (ind) { var g2 = guard.find(function (k) { return ind.indexOf(k.toLowerCase()) !== -1; }); if (g2) return g2; }
  return null;
}

var MARKET_TICKERS = ['AMEX:SPY', 'NASDAQ:QQQ', 'AMEX:DIA', 'AMEX:IWM', 'TVC:VIX'];

// ══════════════════════════════════════════════════════════════════════
// THEME REGISTRY — ticker/industry → theme slug (powers the card's Themes line)
// ══════════════════════════════════════════════════════════════════════
var EE_THEMES = {
  AI_SOFTWARE: ['NVDA', 'AVGO', 'AMD', 'ARM', 'SMCI', 'PLTR', 'AI', 'BBAI', 'SOUN', 'AAPL', 'META', 'MSFT', 'GOOGL', 'AMZN', 'ORCL', 'NOW', 'CRM', 'ADBE', 'SNOW', 'MDB', 'DDOG', 'NET', 'CFLT', 'GTLB', 'S', 'PATH', 'DOCN', 'UPST', 'AFRM'],
  AI_POWER: ['CEG', 'VST', 'NRG', 'TLN', 'ETR', 'PCG', 'GEV', 'AES', 'DUK', 'SO', 'D', 'ED', 'EXC', 'XEL', 'AEP', 'WEC'],
  SEMIS_EQUIP: ['AMAT', 'LRCX', 'KLAC', 'ASML', 'TER', 'ENTG', 'ACLS', 'ONTO', 'CAMT', 'ICHR', 'COHU', 'KLIC', 'UCTT', 'NVMI'],
  SEMIS_FABS: ['TSM', 'INTC', 'GFS', 'UMC', 'STM', 'ON', 'MU', 'WDC', 'STX', 'MRVL', 'QCOM', 'TXN', 'MCHP', 'ADI', 'NXPI', 'SWKS', 'QRVO'],
  DATA_CENTER: ['EQIX', 'DLR', 'VRT', 'AAON', 'ETN', 'DELL', 'ANET', 'HPE', 'PSTG', 'NTAP', 'CIEN', 'LITE', 'COHR', 'APH', 'GLW'],
  QUANTUM: ['IONQ', 'RGTI', 'QBTS', 'QUBT', 'ARQQ', 'LAES', 'HON', 'IBM'],
  NUCLEAR: ['SMR', 'OKLO', 'LEU', 'UUUU', 'NNE', 'BWXT', 'CCJ', 'UEC', 'URG', 'DNN', 'ASPI', 'CVV', 'BW'],
  OIL_MAJORS: ['XOM', 'CVX', 'COP', 'EOG', 'OXY', 'PSX', 'MPC', 'VLO', 'MRO', 'HES', 'FANG', 'DVN', 'CTRA', 'APA', 'BP', 'SHEL'],
  NATGAS_EP: ['AR', 'RRC', 'EQT', 'CHK', 'SWN', 'CRK', 'MTDR', 'OVV', 'CIVI', 'PR'],
  OIL_SERVICES: ['SLB', 'HAL', 'BKR', 'WFRD', 'NOV', 'FTI', 'RIG', 'OII', 'NESR', 'HP', 'LBRT'],
  SOLAR: ['FSLR', 'ENPH', 'SEDG', 'RUN', 'NOVA', 'SHLS', 'ARRY', 'JKS', 'CSIQ', 'MAXN', 'SPWR'],
  OBESITY_GLP1: ['LLY', 'NVO', 'VKTX', 'ALT', 'TERN', 'ZEAL', 'SGMO', 'AMGN'],
  BIOTECH_ONC: ['MRNA', 'BNTX', 'RNA', 'CRSP', 'BEAM', 'NTLA', 'NKTR', 'RGNX', 'EDIT', 'BMRN', 'RARE', 'EXEL', 'IONS', 'SRPT'],
  BIOTECH_SMALL: ['SAVA', 'AXSM', 'CELG', 'PRTA', 'DNLI', 'KROS', 'DYN', 'INSM', 'NUVL', 'NVAX', 'OCUL', 'VERV', 'MDGL', 'MLTX', 'VRNA', 'LQDA', 'ARWR'],
  PHARMA_LARGE: ['JNJ', 'PFE', 'MRK', 'ABBV', 'BMY', 'GILD', 'REGN', 'VRTX', 'BIIB', 'ALNY'],
  MEDTECH: ['ISRG', 'MDT', 'BSX', 'SYK', 'EW', 'ABT', 'BDX', 'ZBH', 'BAX', 'HOLX', 'ALGN', 'TMO', 'DHR', 'ZTS', 'IDXX'],
  CYBERSECURITY: ['CRWD', 'PANW', 'ZS', 'FTNT', 'S', 'NET', 'OKTA', 'QLYS', 'RBRK', 'CYBR', 'TENB', 'VRNS', 'CHKP', 'OSPN', 'RPD'],
  FINTECH: ['PYPL', 'SQ', 'SOFI', 'HOOD', 'NU', 'MELI', 'TOST', 'LC', 'DAVE', 'OPFI', 'FOUR', 'PAGS', 'STNE', 'XYZ', 'GPN', 'FIS', 'FI'],
  BANKS_BIG: ['JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'BK', 'USB', 'TFC', 'PNC', 'COF', 'AXP'],
  BANKS_REGIONAL: ['RF', 'KEY', 'CMA', 'ZION', 'MTB', 'HBAN', 'CFG', 'FITB', 'TCBI', 'WAL', 'WTFC', 'SNV', 'CUBI', 'NYCB', 'OZK'],
  INSURANCE: ['BRK.B', 'UNH', 'ELV', 'CVS', 'CI', 'HUM', 'PGR', 'TRV', 'ALL', 'MET', 'PRU', 'AIG', 'CB', 'HIG', 'LNC'],
  CRYPTO_STK: ['COIN', 'MSTR', 'RIOT', 'MARA', 'CLSK', 'BITF', 'HUT', 'CIFR', 'CORZ', 'WULF', 'IREN', 'BTBT', 'BTDR', 'CAN', 'SMLR'],
  CHINA_ADR: ['BABA', 'PDD', 'JD', 'NIO', 'LI', 'XPEV', 'BIDU', 'TME', 'TCOM', 'YMM', 'FUTU', 'TIGR', 'BZ', 'KC', 'VIPS', 'IQ', 'BILI', 'YY', 'HTHT'],
  RARE_EARTH: ['MP', 'TMC', 'USAR', 'UAMY', 'LAC', 'IE'],
  LITHIUM: ['ALB', 'LAC', 'SQM', 'LTHM', 'SGML'],
  GOLD_SILVER: ['NEM', 'GOLD', 'AEM', 'FNV', 'WPM', 'PAAS', 'CDE', 'HL', 'EXK', 'AG', 'FSM', 'SILV', 'GATO'],
  STEEL_METALS: ['NUE', 'STLD', 'CLF', 'X', 'MT', 'RS', 'CMC', 'TMST'],
  SHIPPING: ['ZIM', 'STNG', 'FRO', 'EURN', 'INSW', 'DHT', 'TRMD', 'HAFN', 'NMM', 'MATX', 'KEX', 'GOGL', 'GSL'],
  DEFENSE: ['LMT', 'RTX', 'NOC', 'GD', 'LDOS', 'KTOS', 'AVAV', 'BA', 'GE', 'HEI', 'TDG', 'HII', 'LHX', 'TXT', 'SAIC'],
  SPACE: ['RKLB', 'ASTS', 'LUNR', 'SATS', 'IRDM', 'PL', 'RDW', 'SPIR', 'VSAT', 'MAXR'],
  DRONES_ROBOT: ['KTOS', 'ONDS', 'UMAC', 'UAVS', 'RCAT', 'AIRO', 'XPON', 'MVIS', 'SYM'],
  AIRLINES: ['UAL', 'DAL', 'AAL', 'LUV', 'JBLU', 'ALK', 'SAVE', 'HA', 'ALGT', 'SNCY', 'CPA', 'VLRS', 'CEA'],
  AUTO_EV: ['TSLA', 'RIVN', 'LCID', 'NIO', 'LI', 'XPEV', 'FFIE', 'GOEV'],
  AUTO_LEGACY: ['F', 'GM', 'TM', 'HMC', 'STLA'],
  CANNABIS: ['MSOS', 'TLRY', 'CGC', 'ACB', 'CRON', 'SNDL', 'OGI', 'HITI', 'VFF', 'GRWG', 'TCNNF', 'CURLF', 'GTBIF', 'CRLBF', 'VRNOF'],
  RETAIL_MEME: ['GME', 'AMC', 'KOSS', 'NAK', 'BBIG', 'MULN', 'GNS', 'SIRI'],
  RETAIL_DISC: ['COST', 'WMT', 'TGT', 'HD', 'LOW', 'BBY', 'ROST', 'TJX', 'DLTR', 'DG', 'FIVE', 'BURL', 'OLLI', 'ULTA'],
  RESTAURANTS: ['MCD', 'SBUX', 'CMG', 'YUM', 'DRI', 'TXRH', 'CAVA', 'WING', 'SHAK', 'DPZ', 'DASH', 'PZZA'],
  HOMEBUILDERS: ['DHI', 'LEN', 'NVR', 'PHM', 'TOL', 'KBH', 'MHO', 'TMHC', 'MTH', 'CCS', 'GRBK', 'LGIH'],
  CHEMICALS: ['LIN', 'APD', 'SHW', 'ECL', 'DD', 'DOW', 'PPG', 'LYB', 'FMC', 'CE', 'EMN', 'IFF', 'RPM', 'HUN']
};
var EE_TICKER_TO_THEMES = (function () {
  var m = {};
  Object.keys(EE_THEMES).forEach(function (t) {
    EE_THEMES[t].forEach(function (s) { (m[s] = m[s] || []).push(t); });
  });
  return m;
})();
// Industry substring → theme slug. First match wins. Catches tickers not in the roster.
var EE_INDUSTRY_TO_THEME = {
  'semiconductor equipment': 'SEMIS_EQUIP', 'semiconductors': 'SEMIS_FABS',
  'utilities—regulated electric': 'AI_POWER', 'utilities—independent power': 'AI_POWER',
  'utilities - regulated electric': 'AI_POWER', 'utilities - independent power': 'AI_POWER',
  'uranium': 'NUCLEAR', 'solar': 'SOLAR',
  'oil & gas integrated': 'OIL_MAJORS', 'oil & gas e&p': 'OIL_MAJORS', 'oil & gas midstream': 'OIL_MAJORS',
  'oil & gas refining': 'OIL_MAJORS', 'oil & gas equipment': 'OIL_SERVICES', 'oil & gas drilling': 'OIL_SERVICES',
  'biotechnology': 'BIOTECH_ONC', 'drug manufacturers—general': 'PHARMA_LARGE', 'drug manufacturers—specialty': 'PHARMA_LARGE',
  'drug manufacturers - general': 'PHARMA_LARGE', 'drug manufacturers - specialty': 'PHARMA_LARGE',
  'drug manufacturers—specialty & generic': 'PHARMA_LARGE', 'pharmaceuticals: major': 'PHARMA_LARGE', 'pharmaceuticals: generic': 'PHARMA_LARGE',
  'medical devices': 'MEDTECH', 'medical instruments': 'MEDTECH', 'diagnostics & research': 'MEDTECH', 'medical specialties': 'MEDTECH',
  'banks—diversified': 'BANKS_BIG', 'banks—regional': 'BANKS_REGIONAL', 'banks - diversified': 'BANKS_BIG', 'banks - regional': 'BANKS_REGIONAL',
  'major banks': 'BANKS_BIG', 'regional banks': 'BANKS_REGIONAL',
  'insurance—life': 'INSURANCE', 'insurance—property & casualty': 'INSURANCE', 'insurance—diversified': 'INSURANCE',
  'insurance—specialty': 'INSURANCE', 'insurance - life': 'INSURANCE', 'insurance - property': 'INSURANCE', 'insurance - diversified': 'INSURANCE',
  'credit services': 'FINTECH', 'gold': 'GOLD_SILVER', 'silver': 'GOLD_SILVER', 'steel': 'STEEL_METALS',
  'lithium': 'LITHIUM', 'rare earth': 'RARE_EARTH', 'other metals/minerals': 'RARE_EARTH', 'metal fabrication': 'STEEL_METALS',
  'specialty chemicals': 'CHEMICALS', 'chemicals': 'CHEMICALS',
  'aerospace & defense': 'DEFENSE', 'airlines': 'AIRLINES', 'air freight/couriers': 'AIRLINES',
  'marine shipping': 'SHIPPING', 'shipping & ports': 'SHIPPING', 'auto manufacturers': 'AUTO_LEGACY',
  'residential construction': 'HOMEBUILDERS', 'restaurants': 'RESTAURANTS', 'food: major diversified': 'RESTAURANTS',
  'discount stores': 'RETAIL_DISC', 'home improvement retail': 'RETAIL_DISC', 'apparel/footwear retail': 'RETAIL_DISC',
  'internet retail': 'RETAIL_DISC', 'specialty stores': 'RETAIL_DISC', 'food retail': 'RETAIL_DISC',
  'computer peripherals': 'DATA_CENTER', 'computer processing hardware': 'DATA_CENTER', 'computer communications': 'DATA_CENTER',
  'packaged software': 'AI_SOFTWARE', 'application software': 'AI_SOFTWARE', 'data processing services': 'AI_SOFTWARE', 'internet software/services': 'AI_SOFTWARE',
  'electronic equipment/instruments': 'SEMIS_EQUIP', 'electronic production equipment': 'SEMIS_EQUIP',
  'oilfield services/equipment': 'OIL_SERVICES', 'integrated oil': 'OIL_MAJORS',
  'biotechnology - other': 'BIOTECH_ONC', 'miscellaneous commercial services': 'FINTECH'
};
function classifyByIndustry(industry) {
  if (!industry) return null;
  var ind = String(industry).toLowerCase();
  for (var k in EE_INDUSTRY_TO_THEME) { if (ind.indexOf(k) !== -1) return EE_INDUSTRY_TO_THEME[k]; }
  return null;
}
// Themes for a stock: hardcoded roster first, then industry classification.
function themesForTicker(ticker, industry) {
  var t = String(ticker || '').toUpperCase();
  if (EE_TICKER_TO_THEMES[t]) return EE_TICKER_TO_THEMES[t];
  var byInd = classifyByIndustry(industry);
  return byInd ? [byInd] : [];
}

// ══════════════════════════════════════════════════════════════════════
// REGIME ENGINE
// ══════════════════════════════════════════════════════════════════════
var REGIME_MATRIX = {
  'BULLISH|UPTREND': 'STRONG_UP', 'BULLISH|PULLBACK': 'PULLBACK_BULL', 'BULLISH|REBOUND': 'UP',
  'BULLISH|SIDEWAYS': 'CHOP_BULL', 'BULLISH|DOWNTREND': 'CORRECTION',
  'RECOVERING|UPTREND': 'WEAK_UP', 'RECOVERING|PULLBACK': 'RECOVERY', 'RECOVERING|REBOUND': 'RECOVERY',
  'RECOVERING|SIDEWAYS': 'BASING', 'RECOVERING|DOWNTREND': 'DOWN',
  'WEAKENING|UPTREND': 'RECOVERY', 'WEAKENING|PULLBACK': 'TOPPING', 'WEAKENING|REBOUND': 'BEAR_RALLY',
  'WEAKENING|SIDEWAYS': 'CHOP_BEAR', 'WEAKENING|DOWNTREND': 'DOWN',
  'BEARISH|UPTREND': 'BEAR_RALLY', 'BEARISH|PULLBACK': 'DOWN', 'BEARISH|REBOUND': 'BEAR_RALLY',
  'BEARISH|SIDEWAYS': 'BASING', 'BEARISH|DOWNTREND': 'STRONG_DOWN'
};
var REGIME_CATALOG = {
  EXTENDED_UP: { label: 'Extended uptrend', icon: '🟢⚠️', color: '#fbbf24', bias: 'LONG' },
  STRONG_UP: { label: 'Strong uptrend', icon: '🟢🟢', color: '#4ade80', bias: 'LONG' },
  UP: { label: 'Uptrend (resuming)', icon: '🟢', color: '#4ade80', bias: 'LONG' },
  WEAK_UP: { label: 'Early uptrend (unconfirmed)', icon: '🟡↑', color: '#a3e635', bias: 'LONG' },
  PULLBACK_BULL: { label: 'Bull-market pullback', icon: '🟡⤵', color: '#fbbf24', bias: 'LONG' },
  RECOVERY: { label: 'Recovery attempt', icon: '🟡↗', color: '#fbbf24', bias: 'NEUTRAL' },
  BASING: { label: 'Basing / bottoming', icon: '⚪▁', color: '#94a3b8', bias: 'NEUTRAL' },
  CHOP_BULL: { label: 'Choppy range (above 200DMA)', icon: '⚪〰', color: '#94a3b8', bias: 'NEUTRAL' },
  CHOP_BEAR: { label: 'Choppy range (below 200DMA)', icon: '⚪〰', color: '#94a3b8', bias: 'NEUTRAL' },
  CORRECTION: { label: 'Correction (bull intact)', icon: '🟠⤵', color: '#fb923c', bias: 'NEUTRAL' },
  TOPPING: { label: 'Topping / breaking down', icon: '🟠▼', color: '#fb923c', bias: 'SHORT' },
  BEAR_RALLY: { label: 'Bear-market rally', icon: '🟠↗', color: '#fb923c', bias: 'NEUTRAL' },
  DOWN: { label: 'Downtrend', icon: '🔴', color: '#f87171', bias: 'SHORT' },
  STRONG_DOWN: { label: 'Strong downtrend', icon: '🔴🔴', color: '#ef4444', bias: 'SHORT' },
  CAPITULATION: { label: 'Capitulation / oversold', icon: '🔴⚠️', color: '#ef4444', bias: 'SHORT' },
  UNKNOWN: { label: 'Unknown', icon: '❔', color: '#64748b', bias: 'NEUTRAL' }
};
var REGIME_GUIDANCE = {
  STRONG_UP: { BULLISH: ['AGGRESSIVE_LONG', 'Long + mid confirmed and today agrees — trade longs aggressively, full size on A-setups.'], NEUTRAL: ['LONG', 'Trend intact, today undecided — longs at normal size, demand intraday confirmation.'], BEARISH: ['CAUTIOUS_LONG', 'Red day inside a strong uptrend — buy-the-dip only, reduced size, no chasing.'] },
  EXTENDED_UP: { BULLISH: ['CAUTIOUS_LONG', 'Uptrend but stretched (upper BB) — ride existing longs, take partials; fresh entries on pullbacks only.'], NEUTRAL: ['WAIT', 'Extended and stalling — no new entries; protect open profits with tighter stops.'], BEARISH: ['WAIT', 'Extension + red day — pullback likely; no new longs, tighten stops hard.'] },
  UP: { BULLISH: ['LONG', 'Trend resuming with confirmation — longs at normal size.'], NEUTRAL: ['CAUTIOUS_LONG', 'Rebound resuming but mixed — longs reduced size, quick to cut.'], BEARISH: ['WAIT', 'Rebound stalling today — wait for the trend to reassert.'] },
  WEAK_UP: { BULLISH: ['CAUTIOUS_LONG', 'Early uptrend, long-term unconfirmed — longs in leaders only, moderate size.'], NEUTRAL: ['WAIT', 'Early trend, no confirmation — watch leaders, keep powder dry.'], BEARISH: ['WAIT', 'Early trend being tested — stand aside until it proves itself.'] },
  PULLBACK_BULL: { BULLISH: ['CAUTIOUS_LONG', 'Bull pullback likely ending — reclaim/bounce entries, tight risk.'], NEUTRAL: ['WAIT', 'Pullback still working — let it finish, build the watchlist.'], BEARISH: ['WAIT', 'Pullback accelerating — don\'t catch the knife, wait for a green day.'] },
  RECOVERY: { BULLISH: ['CAUTIOUS_LONG', 'Recovery confirming — selective longs in the strongest names, moderate size.'], NEUTRAL: ['WAIT', 'Recovery unconfirmed — wait; failed recoveries are fast losers.'], BEARISH: ['FLAT', 'Recovery failing today — stand aside.'] },
  BASING: { BULLISH: ['CAUTIOUS_LONG', 'Base building with a green day — early breakout probes, small size.'], NEUTRAL: ['WAIT', 'Base building — range tactics small, or wait for the breakout.'], BEARISH: ['FLAT', 'Base under pressure — no positions until the range resolves.'] },
  CHOP_BULL: { BULLISH: ['CAUTIOUS_LONG', 'Chop with a bull backdrop — day trades only, smaller size, take profits fast.'], NEUTRAL: ['WAIT', 'Choppy — sit out or minimal size; chop eats swings.'], BEARISH: ['WAIT', 'Chop leaning red — no swings, protect capital.'] },
  CHOP_BEAR: { BULLISH: ['WAIT', 'Bounce inside chop under the 200DMA — scalps only.'], NEUTRAL: ['FLAT', 'Directionless under the 200DMA — highest-chop, lowest-edge. Stand aside.'], BEARISH: ['CAUTIOUS_SHORT', 'Chop resolving lower — small shorts on breakdowns only.'] },
  CORRECTION: { BULLISH: ['WAIT', 'Possible end of the correction — small probes until mid-term turns up.'], NEUTRAL: ['FLAT', 'Correction in progress — defensive, cash is a position.'], BEARISH: ['CAUTIOUS_SHORT', 'Correction active — shorts for experienced only (bull can snap back).'] },
  TOPPING: { BULLISH: ['WAIT', 'Bounce inside a topping structure — don\'t trust it, no new longs.'], NEUTRAL: ['CAUTIOUS_SHORT', 'Distribution forming — reduce exposure, prepare shorts.'], BEARISH: ['SHORT', 'Breakdown confirming — short setups, no longs.'] },
  BEAR_RALLY: { BULLISH: ['CAUTIOUS_LONG', 'Tradable bounce in a bear market — quick longs only, sell into strength, no swings.'], NEUTRAL: ['WAIT', 'Bear rally losing steam — take bounce profits, don\'t add.'], BEARISH: ['CAUTIOUS_SHORT', 'Rally failing — exit bounce longs, look for short re-entries.'] },
  DOWN: { BULLISH: ['WAIT', 'Bounce inside a downtrend — scalps only, small, sell fast.'], NEUTRAL: ['CAUTIOUS_SHORT', 'Downtrend intact — short bias; longs only as quick scalps.'], BEARISH: ['SHORT', 'Downtrend confirmed today — short bias, avoid longs.'] },
  STRONG_DOWN: { BULLISH: ['WAIT', 'Green day in a strong downtrend — bear-rally risk, no fresh positions for most.'], NEUTRAL: ['SHORT', 'Strong downtrend — risk-off, shorts/cash.'], BEARISH: ['AGGRESSIVE_SHORT', 'All levels agree down — shorts/cash only.'] },
  CAPITULATION: { BULLISH: ['WAIT', 'Oversold extreme bouncing — violent both ways, experienced scalps only.'], NEUTRAL: ['CAUTIOUS_SHORT', 'Capitulation zone — do NOT add shorts into the hole, snap-back risk extreme.'], BEARISH: ['CAUTIOUS_SHORT', 'Capitulation continuing — trail existing shorts, no fresh shorts here.'] },
  UNKNOWN: { BULLISH: ['WAIT', 'Market levels unknown — refresh Market Data.'], NEUTRAL: ['WAIT', 'Market levels unknown — refresh Market Data.'], BEARISH: ['WAIT', 'Market levels unknown — refresh Market Data.'] }
};
function regimeClassify(longTerm, stage, bb, shortBias) {
  var L = String(longTerm || '').toUpperCase(), S = String(stage || '').toUpperCase();
  var B = String(bb || '').toUpperCase(), SH = String(shortBias || '').toUpperCase();
  if (SH !== 'BULLISH' && SH !== 'BEARISH') SH = 'NEUTRAL';
  var slug = REGIME_MATRIX[L + '|' + S] || 'UNKNOWN';
  if (slug === 'STRONG_UP' && B === 'UPPER') slug = 'EXTENDED_UP';
  if (slug === 'STRONG_DOWN' && B === 'LOWER') slug = 'CAPITULATION';
  var cat = REGIME_CATALOG[slug] || REGIME_CATALOG.UNKNOWN;
  var g = (REGIME_GUIDANCE[slug] || REGIME_GUIDANCE.UNKNOWN)[SH];
  var known = 0;
  if (REGIME_MATRIX[L + '|' + S] !== undefined) known += 2; else if (L && L !== 'UNKNOWN') known++;
  if (B === 'UPPER' || B === 'MID' || B === 'LOWER') known++;
  var confidence = known >= 3 ? 'HIGH' : known === 2 ? 'MEDIUM' : 'LOW';
  if (slug === 'UNKNOWN') confidence = 'LOW';
  var aligned = (cat.bias === 'LONG' && SH === 'BULLISH') || (cat.bias === 'SHORT' && SH === 'BEARISH') ? true
    : (cat.bias === 'NEUTRAL' || SH === 'NEUTRAL') ? null : false;
  return { slug: slug, label: cat.label, icon: cat.icon, color: cat.color, bias: cat.bias,
    stance: g[0], guidance: g[1], confidence: confidence, aligned: aligned,
    inputs: { longTerm: L || 'UNKNOWN', stage: S || 'UNKNOWN', bb: B || 'UNKNOWN', shortBias: SH } };
}
function regimeStanceColor(s) {
  return ({ AGGRESSIVE_LONG: '#22c55e', LONG: '#4ade80', CAUTIOUS_LONG: '#a3e635', WAIT: '#fbbf24',
    FLAT: '#94a3b8', CAUTIOUS_SHORT: '#fb923c', SHORT: '#f87171', AGGRESSIVE_SHORT: '#ef4444' })[s] || '#94a3b8';
}
function regimePlaybook(rg) {
  if (!rg || rg.slug === 'UNKNOWN') return 'Refresh Market Data to read today\u2019s regime.';
  var turning = rg.confidence === 'LOW' || rg.stance === 'WAIT' || rg.stance === 'FLAT' || rg.aligned === false;
  if (turning) return '\u26a0 Market undecided / turning — scan, but wait for it to commit, then re-scan. Don\u2019t force a side.';
  if (rg.bias === 'LONG') return 'Look for LONGS — run scanners, prioritise the strongest regime-fit names.';
  if (rg.bias === 'SHORT') return 'Look for SHORTS — breakdowns / weak names that fit the regime.';
  return 'No directional edge — trade light or stand aside.';
}

// ══════════════════════════════════════════════════════════════════════
// MARKET-LEVEL COMPUTATIONS
// ══════════════════════════════════════════════════════════════════════
function computeMarketBias(ix) {
  var s = 0;
  function add(d, up, dn) { if (!d) return; if (d.change > up) s++; if (d.change < dn) s--; }
  add(ix.SPY, 0.3, -0.3); add(ix.QQQ, 0.3, -0.3); add(ix.IWM, 0.3, -0.3);
  if (ix.VIX) { if (ix.VIX.change > 3) s -= 2; else if (ix.VIX.change > 1) s--; else if (ix.VIX.change < -2) s++; }
  if (ix.SPY) { if (ix.SPY.weekChg > 1) s++; if (ix.SPY.weekChg < -1) s--; }
  if (ix.QQQ) { if (ix.QQQ.weekChg > 1) s++; if (ix.QQQ.weekChg < -1) s--; }
  return s >= 3 ? 'BULLISH' : s <= -3 ? 'BEARISH' : 'NEUTRAL';
}
function computeMarketStage(ix) {
  var src = ix.SPY, name = 'SPY';
  function ok(d) { return d && num(d.close) != null && num(d.sma5) != null && num(d.sma20) != null; }
  if (!ok(src)) { if (ok(ix.QQQ)) { src = ix.QQQ; name = 'QQQ'; } else return { stage: 'UNKNOWN', stageLabel: 'Indicators unavailable', bb: 'UNKNOWN', bbPct: null, signals: [], bull: 0, src: '' }; }
  var sig = [];
  function add(label, lhs, rhs, tf) {
    if (num(lhs) == null || num(rhs) == null) { sig.push({ label: label, state: 'unknown', tf: tf }); return; }
    sig.push({ label: label, state: lhs > rhs ? 'bull' : 'bear', tf: tf });
  }
  add('Close > 5DMA', src.close, src.sma5, 'D');
  add('Close > 20DMA', src.close, src.sma20, 'D');
  add('5DMA > 20DMA', src.sma5, src.sma20, 'D');
  add('20DMA > 50DMA', src.sma20, src.sma50, 'D');
  add('1H Close > 20MA', src.closeH, src.sma20H, 'H');
  add('1H 5MA > 20MA', src.sma5H, src.sma20H, 'H');
  var bull = sig.filter(function (x) { return x.state === 'bull'; }).length;
  var unk = sig.filter(function (x) { return x.state === 'unknown'; }).length;
  var ca5 = num(src.close) != null && num(src.sma5) != null ? src.close > src.sma5 : null;
  var s5a20 = num(src.sma5) != null && num(src.sma20) != null ? src.sma5 > src.sma20 : null;
  var stage, label;
  if (bull >= 5) { stage = 'UPTREND'; label = 'Uptrend — buyers in control'; }
  else if (bull === 4 && ca5 === true) { stage = 'UPTREND'; label = 'Uptrend — buyers in control'; }
  else if (bull >= 3 && bull <= 4 && ca5 === false && s5a20 === true) { stage = 'PULLBACK'; label = 'Pullback — uptrend correction'; }
  else if (bull >= 2 && bull <= 3 && ca5 === true && s5a20 === false) { stage = 'REBOUND'; label = 'Rebound — counter-rally in downtrend'; }
  else if (bull >= 2 && bull <= 3) { stage = 'SIDEWAYS'; label = 'Sideways — no clear edge'; }
  else { stage = 'DOWNTREND'; label = 'Downtrend — sellers in control'; }
  // BB position (daily, hourly fallback)
  var bb = 'UNKNOWN', bbPct = null;
  var up = src.bbUpper, lo = src.bbLower, cl = src.close;
  if (num(up) == null || num(lo) == null) { up = src.bbUpperH; lo = src.bbLowerH; cl = src.closeH; }
  if (num(up) != null && num(lo) != null && num(cl) != null && up > lo) {
    var p = (cl - lo) / (up - lo); p = Math.max(0, Math.min(1, p));
    bbPct = p; bb = p >= 0.75 ? 'UPPER' : p <= 0.25 ? 'LOWER' : 'MID';
  }
  return { stage: stage, stageLabel: label, bb: bb, bbPct: bbPct, signals: sig, bull: bull, unk: unk, src: name };
}
function computeLongTermBias(ix) {
  var src = ix.SPY, name = 'SPY';
  function ok(d) { return d && num(d.close) != null && num(d.sma200) != null && num(d.sma50) != null; }
  if (!ok(src)) { if (ok(ix.QQQ)) { src = ix.QQQ; name = 'QQQ'; } else return { bias: 'UNKNOWN', label: '200DMA unavailable', dist: null }; }
  var above = src.close > src.sma200, golden = src.sma50 > src.sma200;
  var dist = src.sma200 > 0 ? (src.close - src.sma200) / src.sma200 * 100 : null;
  var bias, label;
  if (above && golden) { bias = 'BULLISH'; label = 'Long-term uptrend (above 200DMA + golden cross)'; }
  else if (above && !golden) { bias = 'RECOVERING'; label = 'Recovering — above 200DMA but 50<200 (death cross)'; }
  else if (!above && golden) { bias = 'WEAKENING'; label = 'Weakening — below 200DMA but 50>200 (golden cross intact)'; }
  else { bias = 'BEARISH'; label = 'Long-term downtrend (below 200DMA + death cross)'; }
  return { bias: bias, label: label, dist: dist, src: name };
}
// ── Direction-aware SECTOR SHORT-TERM BIAS (single source of sector truth) ─
function clampN(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function sectorShortTermBias(name, etf, spy) {
  var e = etf[name];
  if (!e) return { dir: 'NEUTRAL', score: 0, dRS: 0, wRS: 0, parts: [] };
  var spyD = num(spy && spy.change) || 0, spyW = num(spy && spy.weekChg) || 0;
  var eD = num(e.change) || 0, eW = num(e.weekChg) || 0;
  var dRS = eD - spyD;   // day relative strength vs SPY (the divergence signal)
  var wRS = eW - spyW;   // week relative strength vs SPY
  var parts = [], s = 0, c;
  function push(label, val, detail) { parts.push({ label: label, val: Math.round(val * 10) / 10, detail: detail }); }
  c = clampN(eD / 1.5, -1, 1) * 18; s += c; push('Day move', c, (eD >= 0 ? '+' : '') + eD.toFixed(2) + '%');
  c = clampN(eW / 4, -1, 1) * 14; s += c; push('Week move', c, (eW >= 0 ? '+' : '') + eW.toFixed(2) + '%');
  c = clampN(dRS / 1.2, -1, 1) * 20; s += c; push('RS vs SPY (today)', c, (dRS >= 0 ? '+' : '') + dRS.toFixed(2) + '%');
  c = clampN(wRS / 3, -1, 1) * 16; s += c; push('RS vs SPY (week)', c, (wRS >= 0 ? '+' : '') + wRS.toFixed(2) + '%');
  if (num(e.close) != null && num(e.vwap) != null && e.vwap > 0) {
    c = e.close > e.vwap ? 10 : -10; s += c; push('VWAP position', c, e.close > e.vwap ? 'above VWAP' : 'below VWAP');
  }
  if (num(e.adx) != null && e.adx > 20) {
    c = (eD >= 0 ? 1 : -1) * Math.min((e.adx - 20) / 30, 1) * 12; s += c;
    push('Trend strength (ADX ' + Math.round(e.adx) + ')', c, eD >= 0 ? 'trending up' : 'trending down');
  }
  if (num(e.rvol) != null && e.rvol >= 1.2) {
    c = (eD >= 0 ? 1 : -1) * 10; s += c;
    push('Volume (RVOL ' + e.rvol.toFixed(1) + 'x)', c, eD >= 0 ? 'confirms up' : 'confirms down');
  }
  s = clampN(s, -100, 100);
  var dir = s >= 18 ? 'BULLISH' : s <= -18 ? 'BEARISH' : 'NEUTRAL';
  return { dir: dir, score: Math.round(s), dRS: Math.round(dRS * 100) / 100, wRS: Math.round(wRS * 100) / 100, parts: parts };
}
function computeSectorBiasScores(etf, spy) {
  var out = {};
  Object.keys(etf).forEach(function (k) { out[k] = sectorShortTermBias(k, etf, spy); });
  return out;
}

// ── HOT SECTOR state machine (enter → hold → cool off) ──────────────────
// Persisted per sector so 'hot' is sticky and doesn't flip day to day:
//   ENTER hot:  score ≥ immediate (instant), OR score ≥ sustained for N sessions.
//   STAY hot:   as long as score ≥ floor (even if it falls below 'sustained').
//   COOL off:   only after score stays below the floor for MORE than C sessions.
// A "session" = one distinct ET day on which you refresh. Same-day re-refreshes
// recompute today from the previous session's state, so they don't advance it.
// Stored shape: hotState[name] = { date, score, prev:{hot,susStreak,belowStreak}, cur:{…} }
function hotThresholds() {
  return {
    imm: settings.hotImmediate, sus: settings.hotSustained, susDays: settings.hotSustainedDays,
    floor: settings.hotFloor, cool: settings.hotCoolDays
  };
}
function advanceHot(prev, score, S) {
  var hot = !!prev.hot, sus = prev.susStreak || 0, below = prev.belowStreak || 0;
  if (hot) {
    if (score >= S.floor) { below = 0; }                       // holding above the floor
    else { below += 1; if (below > S.cool) { hot = false; below = 0; } } // cooled off
    if (!hot) sus = (score >= S.sus) ? 1 : 0;                  // re-seed entry streak
  } else {
    if (score >= S.imm) { hot = true; sus = 0; below = 0; }    // instant entry
    else if (score >= S.sus) { sus += 1; if (sus >= S.susDays) { hot = true; below = 0; } }
    else { sus = 0; }
  }
  return { hot: hot, susStreak: sus, belowStreak: below };
}
function hotRenderInfo(cur, score, S) {
  if (cur.hot) {
    if (score >= S.imm) return { hot: true, state: 'immediate', score: score };
    if (cur.belowStreak > 0) return { hot: true, state: 'cooling', belowStreak: cur.belowStreak, coolMax: S.cool, score: score };
    return { hot: true, state: 'holding', score: score };
  }
  if (score >= S.sus) return { hot: false, state: 'building', susStreak: cur.susStreak, susNeed: S.susDays, score: score };
  return { hot: false, state: 'cold', score: score };
}
function priorFor(rec, today) {
  if (!rec) return { hot: false, susStreak: 0, belowStreak: 0 };
  return rec.date === today ? rec.prev : rec.cur; // same-day overwrite vs new session
}
// Advance one session and persist. Returns render-ready info per sector.
function updateHotStates(scores) {
  return storageGet(['hotState']).then(function (r) {
    var store = r.hotState || {}, today = etDateStr(), S = hotThresholds(), out = {};
    Object.keys(scores).forEach(function (name) {
      var sc = scores[name].score, prev = priorFor(store[name], today);
      var cur = advanceHot(prev, sc, S);
      store[name] = { date: today, score: sc, prev: prev, cur: cur };
      out[name] = hotRenderInfo(cur, sc, S);
    });
    return storageSet({ hotState: store }).then(function () { return out; });
  });
}
// Re-apply (possibly changed) thresholds to TODAY's classification without
// advancing a new session. Can't rewrite history, but keeps today consistent.
function reclassifyHot() {
  return storageGet(['hotState']).then(function (r) {
    var store = r.hotState || {}, S = hotThresholds(), scores = marketCtx.sectorBiasScores || {}, out = {};
    Object.keys(scores).forEach(function (name) {
      var sc = scores[name].score, rec = store[name];
      var prev = rec ? rec.prev : { hot: false, susStreak: 0, belowStreak: 0 };
      var base = rec ? rec.score : sc;
      var cur = advanceHot(prev, base, S);
      if (rec) { rec.cur = cur; }
      out[name] = hotRenderInfo(cur, base, S);
    });
    return storageSet({ hotState: store }).then(function () { return out; });
  });
}

// ══════════════════════════════════════════════════════════════════════
// FETCH HELPERS
// ══════════════════════════════════════════════════════════════════════
function fetchMarketData() {
  var cols = ['close', 'change', 'Perf.W', 'VWAP', 'ADX',
    'SMA5', 'SMA20', 'SMA50', 'SMA200', 'BB.upper', 'BB.lower',
    'close|60', 'SMA5|60', 'SMA20|60', 'BB.upper|60', 'BB.lower|60'];
  return tvScan({ symbols: { tickers: MARKET_TICKERS }, columns: cols, options: { lang: 'en' } }).then(function (data) {
    var out = {};
    (data.data || []).forEach(function (item) {
      var r = rowObj(item, cols), short = String(item.s || '').replace(/^.*:/, '');
      out[short] = {
        change: num(r['change']), weekChg: num(r['Perf.W']),
        vwap: num(r['VWAP']), adx: num(r['ADX']), close: num(r['close']),
        sma5: num(r['SMA5']), sma20: num(r['SMA20']), sma50: num(r['SMA50']), sma200: num(r['SMA200']),
        bbUpper: num(r['BB.upper']), bbLower: num(r['BB.lower']),
        closeH: num(r['close|60']), sma5H: num(r['SMA5|60']), sma20H: num(r['SMA20|60']),
        bbUpperH: num(r['BB.upper|60']), bbLowerH: num(r['BB.lower|60'])
      };
    });
    return out;
  });
}
function fetchSectorETFs() {
  var cols = ['close', 'change', 'Perf.W', 'VWAP', 'ADX', 'relative_volume_intraday|5'];
  return tvScan({ symbols: { tickers: Object.values(SECTOR_ETF_MAP) }, columns: cols, options: { lang: 'en' } }).then(function (data) {
    var out = {};
    (data.data || []).forEach(function (item) {
      var sym = String(item.s || ''), r = rowObj(item, cols);
      var name = SECTOR_ETF_REVERSE[sym] || sym.replace(/^.*:/, '');
      out[name] = { etf: sym.replace(/^.*:/, ''), close: num(r['close']), change: num(r['change']),
        weekChg: num(r['Perf.W']), vwap: num(r['VWAP']),
        adx: num(r['ADX']), rvol: num(r['relative_volume_intraday|5']) };
    });
    return out;
  });
}
function fetchBreakoutStocks() {
  var cols = ['ticker-view'];
  var body = {
    columns: cols,
    filter: [
      { left: 'close', operation: 'egreater', right: 1 },
      { left: 'relative_volume_10d_calc', operation: 'greater', right: 2 },
      { left: 'Perf.W', operation: 'egreater', right: 2 }
    ],
    filter2: STOCK_FILTER2, ignore_unknown_fields: false, markets: ['america'],
    options: { lang: 'en' }, range: [0, 100], sort: { sortBy: 'Perf.W', sortOrder: 'desc' }, symbols: {}
  };
  return tvScan(body).then(function (data) {
    return (data.data || []).map(function (item) {
      var r = rowObj(item, cols), tv = r['ticker-view'], t = '';
      if (tv && typeof tv === 'object' && tv.symbol) t = tv.symbol; else if (typeof tv === 'string') t = tv; else t = String(item.s || '');
      t = t.replace(/^.*:/, '').trim();
      return { ticker: t };
    }).filter(function (s) { return s.ticker; });
  });
}

// ══════════════════════════════════════════════════════════════════════
// STATE
// ══════════════════════════════════════════════════════════════════════
var marketCtx = {
  indices: {}, sectorETFs: {}, sectorBiasScores: {}, hotStatus: {}, breakoutStocks: [],
  marketBias: 'NEUTRAL', marketStage: 'UNKNOWN', marketBB: 'UNKNOWN', stageData: null,
  marketLongTerm: 'UNKNOWN', ltData: null, lastRefresh: 0
};

// Last-rendered screener stocks, keyed by ticker — lets the shortlist star
// button look up the full row (tvSymbol, price, etc.) by ticker alone.
var scrIndex = {};
// Full shortlists store: { 'YYYY-MM-DD': { items:[…], exports:[…] } }. Loaded once,
// kept in sync on every mutation. shortlistTodaySet caches today's tickers so
// buildCard can render the correct star state synchronously.
var shortlists = {};
var shortlistTodaySet = {};

// ══════════════════════════════════════════════════════════════════════
// MARKET TAB RENDER
// ══════════════════════════════════════════════════════════════════════
function renderIdx() {
  var order = ['SPY', 'QQQ', 'DIA', 'IWM', 'VIX'];
  $('idxRow').innerHTML = order.map(function (n) {
    var d = marketCtx.indices[n];
    if (!d) return '<div class="idx-card" data-chart="' + n + '"><div class="idx-name">' + n + '</div><div class="idx-price">—</div></div>';
    var chgCls = n === 'VIX' ? (d.change > 0 ? 'neg' : 'pos') : (d.change >= 0 ? 'pos' : 'neg');
    var px = (n === 'VIX' ? '' : '$') + (d.close || 0).toFixed(2);
    return '<div class="idx-card" data-chart="' + n + '"><div class="idx-name">' + n + '</div>' +
      '<div class="idx-price">' + px + '</div>' +
      '<div class="idx-chg ' + chgCls + '">' + (d.change >= 0 ? '+' : '') + (d.change || 0).toFixed(2) + '%</div>' +
      '<div class="idx-sub">Week: ' + (d.weekChg >= 0 ? '+' : '') + (d.weekChg || 0).toFixed(1) + '%</div></div>';
  }).join('');
}

var _expanded = {};
function rowCls(state) {
  var s = String(state || '').toUpperCase();
  if (s === 'BULLISH' || s === 'UPTREND') return 'bull';
  if (s === 'BEARISH' || s === 'DOWNTREND') return 'bear';
  if (['PULLBACK', 'REBOUND', 'WEAKENING', 'RECOVERING'].indexOf(s) !== -1) return 'warn';
  return '';
}
function renderBiasPanel() {
  var host = $('biasPanel');
  var rg = regimeClassify(marketCtx.marketLongTerm, marketCtx.marketStage, marketCtx.marketBB, marketCtx.marketBias);
  var stCol = regimeStanceColor(rg.stance);
  var confirm = rg.aligned === true ? '<span class="pos">✓ short-term confirms</span>'
    : rg.aligned === false ? '<span class="neg">✗ short-term disagrees</span>'
      : '<span style="color:var(--muted)">○ short-term neutral — wait for confirmation</span>';
  var regimeHtml = '<div class="regime-box" style="border:1px solid ' + rg.color + '44;border-left:4px solid ' + rg.color + '">' +
    '<div class="regime-top"><span class="regime-name" style="color:' + rg.color + '">' + rg.icon + ' ' + esc(rg.label.toUpperCase()) + '</span>' +
    '<span class="regime-meta">regime · confidence ' + rg.confidence + '</span></div>' +
    '<div class="regime-stance" style="color:' + stCol + '">▶ ' + esc(rg.stance.replace(/_/g, ' ')) + ' — ' + esc(rg.guidance) + '</div>' +
    '<div class="regime-play">🎯 ' + esc(regimePlaybook(rg)) + '</div>' +
    '<div class="regime-inputs">Long ' + esc(rg.inputs.longTerm) + ' + Mid ' + esc(rg.inputs.stage) +
    (rg.inputs.bb !== 'UNKNOWN' ? ' + BB ' + esc(rg.inputs.bb) : '') + ' → ' + esc(rg.label) + ' · ' + confirm + '</div></div>';

  // SHORT
  var st = marketCtx.marketBias || 'NEUTRAL';
  var stIcon = st === 'BULLISH' ? '🟢 ▲' : st === 'BEARISH' ? '🔴 ▼' : '⚪ ➡';
  // MID
  var midData = marketCtx.stageData;
  var bbChip = (function () {
    var bb = marketCtx.marketBB, pct = midData && midData.bbPct != null ? midData.bbPct : null;
    var cls = bb === 'UPPER' ? 'bull' : bb === 'LOWER' ? 'bear' : 'neu';
    var txt = bb === 'UPPER' ? 'BB upper 25%' : bb === 'LOWER' ? 'BB lower 25%' : bb === 'MID' ? 'BB mid 50%' : 'BB —';
    if (pct != null) txt += ' (' + Math.round(pct * 100) + '%)';
    return '<span class="chip ' + cls + '">' + txt + '</span>';
  })();
  // LONG
  var lt = marketCtx.marketLongTerm, ltData = marketCtx.ltData;
  var ltChip = '';
  if (ltData && num(ltData.dist) != null) {
    var dp = ltData.dist;
    ltChip = '<span class="chip ' + (dp >= 0 ? 'bull' : 'bear') + '">' + (ltData.src || 'SPY') + ' ' + (dp >= 0 ? '+' : '') + dp.toFixed(2) + '% vs 200DMA</span>';
  }

  function sigDetail() {
    var sg = midData && midData.signals || [];
    if (!sg.length) return '<div class="sig-note">Refresh market data to compute signals.</div>';
    var h = '<div class="sig-note" style="margin-bottom:6px">Source ' + esc(midData.src || 'SPY') + ' · Bull ' + midData.bull + '/6' + (midData.unk ? ' · ' + midData.unk + ' unknown' : '') + '</div>';
    h += '<div class="sig-grid"><div class="sig-hdr"><span>Signal</span><span>State</span><span>TF</span></div>';
    sg.forEach(function (s) {
      var c = s.state === 'bull' ? 'sb' : s.state === 'bear' ? 'se' : 'sn';
      h += '<div class="sig-r ' + c + '"><span>' + esc(s.label) + '</span><span>' + s.state + '</span><span>' + s.tf + '</span></div>';
    });
    return h + '</div>';
  }

  function row(tier, label, val, cls, icon, chip, sub, body, key) {
    var ex = !!_expanded[key];
    return '<div class="bias-row ' + cls + '" data-key="' + key + '">' +
      '<div class="bias-head"><span class="bias-icon">' + icon + '</span>' +
      '<span class="bias-tier">' + label + '</span>' +
      '<span class="bias-val">' + esc(val) + '</span>' + (chip || '') +
      '<span class="bias-chev">' + (ex ? '▾' : '▸') + '</span></div>' +
      (sub ? '<div class="bias-sub">' + esc(sub) + '</div>' : '') +
      (ex && body ? '<div class="bias-body">' + body + '</div>' : '') + '</div>';
  }

  var refreshStr = marketCtx.lastRefresh ? 'Refreshed ' + fmtETTime(marketCtx.lastRefresh) + ' ET' : 'Not yet loaded';
  host.className = 'bias-panel';
  host.innerHTML = regimeHtml +
    row('short', 'SHORT-TERM (Today)', st, rowCls(st), stIcon, '', '', '', 'short') +
    row('mid', 'MID-TERM (Trend)', marketCtx.marketStage, rowCls(marketCtx.marketStage), (midData && midData.stage !== 'UNKNOWN' ? '📊' : '⚪'), bbChip, (midData && midData.stageLabel) || '', sigDetail(), 'mid') +
    row('long', 'LONG-TERM (200DMA)', lt, rowCls(lt), (lt !== 'UNKNOWN' ? '📈' : '⚪'), ltChip, (ltData && ltData.label) || '', (ltData ? '<div class="sig-note">' + esc(ltData.label) + '</div>' : ''), 'long') +
    '<div class="bias-foot">' + refreshStr + '</div>';

  Array.prototype.forEach.call(host.querySelectorAll('.bias-head'), function (h) {
    h.addEventListener('click', function () {
      var k = h.parentNode.getAttribute('data-key');
      _expanded[k] = !_expanded[k]; renderBiasPanel();
    });
  });
}
var _sbExpanded = {};
function renderSectorBias() {
  var el = $('sectorBias');
  if (!el) return;
  var scores = marketCtx.sectorBiasScores || {};
  var etf = marketCtx.sectorETFs || {};
  var hot = marketCtx.hotStatus || {};
  var names = Object.keys(scores);
  var breakout = (marketCtx.breakoutStocks || []).slice(0, 8).map(function (s) { return esc(s.ticker); }).join(', ');
  var breakoutLine = breakout ? '<div class="breakout-line">RVOL breakout names: ' + breakout + '</div>' : '';
  if (!names.length) { el.innerHTML = '<span class="cold-tag">Tap Refresh Market Data</span>'; return; }
  var bull = names.filter(function (n) { return scores[n].dir === 'BULLISH'; })
    .sort(function (a, b) { return scores[b].score - scores[a].score; });
  var bear = names.filter(function (n) { return scores[n].dir === 'BEARISH'; })
    .sort(function (a, b) { return scores[a].score - scores[b].score; });

  function hotBadge(n) {
    var h = hot[n];
    if (h && h.hot) {
      var why = h.state === 'cooling' ? 'cooling — below floor ' + settings.hotFloor + ' for ' + h.belowStreak + ' session(s)'
        : h.state === 'immediate' ? 'score ≥ ' + settings.hotImmediate
          : 'holding above floor ' + settings.hotFloor;
      var ic = h.state === 'cooling' ? '🔥🧊' : '🔥';
      return '<span class="hot-badge" title="' + esc(why) + '">' + ic + ' HOT</span>';
    }
    if (h && h.state === 'building')
      return '<span class="warm-badge" title="needs ' + h.susNeed + ' sessions ≥ ' + settings.hotSustained + '">🌤 ' + h.susStreak + '/' + h.susNeed + '</span>';
    return '';
  }
  function breakdown(n) {
    var sc = scores[n], h = hot[n] || {}, sym = (etf[n] && etf[n].etf) || '';
    var rows = (sc.parts || []).map(function (p) {
      var cls = p.val > 0 ? 'pos' : p.val < 0 ? 'neg' : '';
      return '<div class="sb-part"><span>' + esc(p.label) + '</span>' +
        '<span class="sub9">' + esc(p.detail || '') + '</span>' +
        '<span class="' + cls + '">' + (p.val >= 0 ? '+' : '') + p.val + '</span></div>';
    }).join('');
    var total = '<div class="sb-part sb-total"><span>Total score</span><span></span><span>' +
      (sc.score >= 0 ? '+' : '') + sc.score + '</span></div>';
    var hotExpl;
    if (h.state === 'immediate') hotExpl = '🔥 Score ' + sc.score + ' ≥ immediate threshold ' + settings.hotImmediate + ' → HOT now.';
    else if (h.state === 'holding') hotExpl = '🔥 HOT — holding at ' + sc.score + ', above the floor (' + settings.hotFloor + '). Stays HOT until it sits below ' + settings.hotFloor + ' for more than ' + settings.hotCoolDays + ' sessions.';
    else if (h.state === 'cooling') hotExpl = '🔥🧊 HOT but cooling — below the floor (' + settings.hotFloor + ') for ' + h.belowStreak + ' session(s). Drops if it stays below for more than ' + settings.hotCoolDays + ' (i.e. on session ' + (settings.hotCoolDays + 1) + ').';
    else if (h.state === 'building') hotExpl = '🌤 At ' + sc.score + ' (≥ ' + settings.hotSustained + ') for ' + h.susStreak + '/' + h.susNeed + ' sessions — one more holding session turns it HOT.';
    else hotExpl = 'Score ' + sc.score + ' is below the sustained threshold ' + settings.hotSustained + ' — not hot.';
    return '<div class="sb-body">' +
      '<div class="sb-parts">' + rows + total + '</div>' +
      '<div class="sb-hot">' + esc(hotExpl) + '</div>' +
      (sym ? '<button class="btn-mini" data-chart="' + esc(sym) + '">📈 Chart ' + esc(sym) + '</button>' : '') +
      '</div>';
  }
  function rowFor(n, cls) {
    var sc = scores[n], sym = (etf[n] && etf[n].etf) || '', ex = !!_sbExpanded[n];
    return '<div class="sb-row ' + cls + (hot[n] && hot[n].hot ? ' is-hot' : '') + '" data-sb="' + esc(n) + '">' +
      '<div class="sb-head"><span class="sb-name">' + esc(n) + (sym ? ' <span class="sub9">' + esc(sym) + '</span>' : '') + '</span>' +
      hotBadge(n) +
      '<span class="sb-score ' + cls + '">' + (sc.score > 0 ? '+' : '') + sc.score + '</span>' +
      '<span class="sb-rs sub9">RS ' + (sc.dRS >= 0 ? '+' : '') + sc.dRS + '%</span>' +
      '<span class="sb-chev">' + (ex ? '▾' : '▸') + '</span></div>' +
      (ex ? breakdown(n) : '') + '</div>';
  }
  var html = '';
  html += '<div class="bias-grp"><div class="bias-grp-hdr" style="color:var(--green-s)">▲ Leading — buyers in control (' + bull.length + ')</div>' +
    (bull.length ? bull.map(function (n) { return rowFor(n, 'bull'); }).join('') : '<span class="cold-tag">none</span>') + '</div>';
  html += '<div class="bias-grp"><div class="bias-grp-hdr" style="color:var(--red-s)">▼ Lagging — sellers in control (' + bear.length + ')</div>' +
    (bear.length ? bear.map(function (n) { return rowFor(n, 'bear'); }).join('') : '<span class="cold-tag">none</span>') + '</div>';
  el.innerHTML = html + breakoutLine;

  Array.prototype.forEach.call(el.querySelectorAll('.sb-head'), function (head) {
    head.addEventListener('click', function () {
      var n = head.parentNode.getAttribute('data-sb');
      _sbExpanded[n] = !_sbExpanded[n];
      renderSectorBias();
    });
  });
}
function renderHeatmap() {
  var el = $('heatGrid');
  var entries = Object.keys(marketCtx.sectorETFs).map(function (k) { return [k, marketCtx.sectorETFs[k]]; });
  if (!entries.length) { el.innerHTML = '<div class="empty">No sector data</div>'; return; }
  var scores = marketCtx.sectorBiasScores || {};
  entries.sort(function (a, b) {
    var sa = scores[a[0]] ? scores[a[0]].score : 0, sb = scores[b[0]] ? scores[b[0]].score : 0;
    return sb - sa;
  });
  el.innerHTML = entries.map(function (e) {
    var name = e[0], d = e[1];
    var sb = scores[name] || { dir: 'NEUTRAL', score: 0 };
    var cls = sb.dir === 'BULLISH' ? 'up' : sb.dir === 'BEARISH' ? 'dn' : '';
    var biasCls = sb.dir === 'BULLISH' ? 'pos' : sb.dir === 'BEARISH' ? 'neg' : '';
    var isHot = marketCtx.hotStatus[name] && marketCtx.hotStatus[name].hot;
    return '<div class="heat-cell ' + cls + (isHot ? ' is-hot' : '') + '" data-chart="' + esc(d.etf) + '">' +
      (isHot ? '<div class="heat-hot" title="Hot sector">🔥</div>' : '') +
      '<div class="heat-name">' + esc(name) + '</div>' +
      '<div class="heat-etf">' + esc(d.etf) + '</div>' +
      '<div class="heat-d ' + (d.change >= 0 ? 'pos' : 'neg') + '">' + (d.change >= 0 ? '+' : '') + (d.change || 0).toFixed(2) + '%</div>' +
      '<div class="heat-w">W: ' + (d.weekChg >= 0 ? '+' : '') + (d.weekChg || 0).toFixed(1) + '%</div>' +
      '<div class="heat-bias ' + biasCls + '">' + esc(sb.dir) + ' ' + (sb.score > 0 ? '+' : '') + sb.score +
        (d.adx ? ' · ADX ' + Math.round(d.adx) : '') + '</div>' +
      '</div>';
  }).join('');
}
function renderMarket() { renderIdx(); renderBiasPanel(); renderSectorBias(); renderHeatmap(); }

// ── orchestration ──────────────────────────────────────────────────────
async function refreshMarket() {
  $('mktRefresh').disabled = true;
  $('mktStatus').textContent = 'Loading market data…';
  try {
    var [etf, ix, hot] = await Promise.all([
      fetchSectorETFs().catch(function () { return {}; }),
      fetchMarketData().catch(function () { return {}; }),
      fetchBreakoutStocks().catch(function () { return []; })
    ]);
    marketCtx.indices = ix; marketCtx.sectorETFs = etf; marketCtx.breakoutStocks = hot;
    marketCtx.marketBias = computeMarketBias(ix);
    marketCtx.sectorBiasScores = computeSectorBiasScores(etf, ix.SPY);
    marketCtx.hotStatus = await updateHotStates(marketCtx.sectorBiasScores).catch(function () { return {}; });
    var sd = computeMarketStage(ix); marketCtx.marketStage = sd.stage; marketCtx.marketBB = sd.bb; marketCtx.stageData = sd;
    var lt = computeLongTermBias(ix); marketCtx.marketLongTerm = lt.bias; marketCtx.ltData = lt;
    marketCtx.lastRefresh = Date.now();
    renderMarket();
    $('mktStatus').textContent = '';
  } catch (e) {
    $('mktStatus').textContent = 'Error: ' + e.message;
  }
  $('mktRefresh').disabled = false;
}

// ══════════════════════════════════════════════════════════════════════
// SCREENER TAB
// ══════════════════════════════════════════════════════════════════════
// Map one TradingView scanner row (item.d[] in TV_COLUMNS order) to the rich
// stock object the cards + registry consume. Shared by the filter-based
// screeners and the symbol-based refresh of earlier candidates.
function mapTvRowToStock(item, screenerKey) {
  var r = rowObj(item, TV_COLUMNS);
  var tv = r['ticker-view'], t = '';
  if (tv && typeof tv === 'object' && tv.symbol) t = tv.symbol; else if (typeof tv === 'string') t = tv; else t = String(item.s || '');
  t = t.replace(/^.*:/, '').trim();
  var close = num(r['close']), change = num(r['change']);
  var cfo = num(r['change_from_open']);
  return {
    ticker: t, screenerKey: screenerKey || null, tvSymbol: String(item.s || ''),
    price: close, open: num(r['open']), change: change,
    prevClose: (close != null && change != null && (1 + change / 100) !== 0) ? close / (1 + change / 100) : null,
    gapPct: (change != null && cfo != null) ? (change - cfo) : null,
    vwap: num(r['VWAP']),
    ema9: num(r['EMA9']), ema13: num(r['EMA13']), ema20: num(r['EMA20']), ema50: num(r['EMA50']),
    sma5: num(r['SMA5']),
    monthHigh: num(r['High.1M']), monthLow: num(r['Low.1M']),
    dayHigh: num(r['high']), dayLow: num(r['low']), atr: num(r['ATR']),
    mcap: num(r['market_cap_basic']),
    floatShares: num(r['float_shares_outstanding']),
    shortFloat: num(r['short_percentage_of_float']),
    rvol: num(r['relative_volume_intraday|5']) || num(r['relative_volume_10d_calc']),
    sector: r['sector'] || '', industry: r['industry'] || ''
  };
}

function runScreener(key) {
  var cfg = SCREENERS[key];
  var body = {
    columns: TV_COLUMNS, filter: cfg.filters, filter2: STOCK_FILTER2,
    ignore_unknown_fields: false, markets: ['america'], options: { lang: 'en' },
    range: [0, 50], sort: cfg.sort, symbols: {}
  };
  return tvScan(body).then(function (data) {
    return (data.data || []).map(function (item) { return mapTvRowToStock(item, key); })
      .filter(function (s) { return s.ticker; });
  });
}

// Fetch current quote data for an explicit list of TradingView symbols
// ("EXCHANGE:TICKER"), bypassing the screener filters. Used to refresh
// candidates that appeared earlier today but aren't in the latest live scan.
function fetchBySymbols(tvSymbols) {
  tvSymbols = (tvSymbols || []).filter(Boolean);
  if (!tvSymbols.length) return Promise.resolve([]);
  var body = { symbols: { tickers: tvSymbols }, columns: TV_COLUMNS, options: { lang: 'en' } };
  return tvScan(body).then(function (data) {
    return (data.data || []).map(function (item) { return mapTvRowToStock(item, null); })
      .filter(function (s) { return s.ticker; });
  });
}

// ── per-card news (lazy-loaded to respect Finnhub's 60/min free limit) ──
function renderNewsItems(resp) {
  var fh = (resp && resp.finnhub) || [], tv = (resp && resp.tradingview) || [];
  if (!fh.length && !tv.length) {
    var hint = (settings.finnhubNews && !settings.finnhubKey) ? ' <span class="sub9">(add a Finnhub key in ⚙ Settings for summaries)</span>' : '';
    return '<span class="sub9">No recent news found.' + hint + '</span>';
  }
  var html = '';
  fh.slice(0, 2).forEach(function (n) {
    html += '<div class="news-item">' +
      '<a href="' + esc(n.url) + '" target="_blank" rel="noopener noreferrer" class="news-title">' + esc(n.headline) + '</a>' +
      '<div class="news-meta sub9">' + esc(n.source || 'Finnhub') + (n.ts ? ' · ' + esc(fmtAgo(n.ts)) : '') + '</div>' +
      (n.summary ? '<div class="news-sum">' + esc(n.summary) + '</div>' : '') +
      '</div>';
  });
  tv.slice(0, 2).forEach(function (n) {
    html += '<div class="news-item">' +
      '<a href="' + esc(n.url) + '" target="_blank" rel="noopener noreferrer" class="news-title">' + esc(n.title) + '</a>' +
      '<div class="news-meta sub9">TradingView' + (n.source ? ' · ' + esc(n.source) : '') + (n.ts ? ' · ' + esc(fmtAgo(n.ts)) : '') + '</div>' +
      (n.summary ? '<div class="news-sum">' + esc(n.summary) + '</div>' : '') +
      '</div>';
  });
  return html;
}
function loadCardNews(ticker, tvSymbol, hostId) {
  var host = document.getElementById(hostId);
  if (!host) return;
  host.innerHTML = '<span class="sub9">Loading news…</span>';
  fetchNews(ticker, tvSymbol)
    .then(function (resp) {
      // News goes into the registry first, then the card renders from it.
      var id = regId(ticker, etDateStr()), row = registry[id];
      var news = { finnhub: resp.finnhub || [], tradingview: resp.tradingview || [], fetchedAt: Date.now() };
      if (row) { row.news = news; saveRegistry(); }
      host.innerHTML = newsHostInner(ticker, tvSymbol, hostId, news);
    })
    .catch(function (e) { host.innerHTML = '<span class="sub9">News unavailable: ' + esc(e.message) + '</span>'; });
}

// Inner markup for a card's news host — either the stored (registry) news with
// a refresh control, or the initial "load" button. Shared by buildCard and
// loadCardNews so a freshly-fetched card matches a re-rendered one.
function newsHostInner(ticker, tvSymbol, newsId, news) {
  var btn = function (label) {
    return '<button class="btn-mini" data-news="' + esc(ticker) + '" data-tvsym="' + esc(tvSymbol || '') +
      '" data-newsid="' + esc(newsId) + '">' + label + '</button>';
  };
  if (news) {
    return renderNewsItems(news) +
      '<div class="sub9" style="margin-top:4px">Fetched ' + esc(fmtETTime(news.fetchedAt)) + ' ET · ' + btn('↻ refresh') + '</div>';
  }
  return btn('📰 Load recent news');
}

// Snapshot the Market-tab-derived context for a stock at scan time, so the
// card reads themes / sector bias / hot status / market bias from the registry
// row instead of recomputing against the live marketCtx every render.
function computeCardContext(s) {
  var themes = themesForTicker(s.ticker, s.industry);
  var broadResolved = resolveBroadSector(s);
  var sbScore = broadResolved && marketCtx.sectorBiasScores[broadResolved];
  var hotInfo = broadResolved && marketCtx.hotStatus && marketCtx.hotStatus[broadResolved];
  return {
    themes: themes,
    broadResolved: broadResolved || null,
    broad: broadResolved || s.sector || '',
    secBias: (sbScore && sbScore.dir) || 'NEUTRAL',
    secScore: sbScore ? sbScore.score : null,
    secHot: !!(hotInfo && hotInfo.hot),
    marketBias: marketCtx.marketBias || 'NEUTRAL'
  };
}

function buildCard(row) {
  var s = row.stock, matchedKeys = row.screenerKeys;
  var ctx = row.context || computeCardContext(s);
  scrIndex[s.ticker] = s;
  var L = [];
  // Price · Open · Prev close
  var p = [];
  if (s.price != null) p.push('<b>Price:</b> $' + s.price.toFixed(2));
  if (s.open != null) p.push('<b>Open:</b> $' + s.open.toFixed(2));
  if (s.prevClose != null) p.push('<b>Prev close:</b> $' + s.prevClose.toFixed(2));
  if (p.length) L.push('<div class="line">' + p.join(' &nbsp;·&nbsp; ') + '</div>');
  // VWAP
  if (s.vwap != null && s.vwap > 0) {
    var v = '<b>VWAP:</b> $' + s.vwap.toFixed(2);
    if (s.price != null) v += s.price > s.vwap ? ' <span class="pos">▲ above</span>' : s.price < s.vwap ? ' <span class="neg">▼ below</span>' : '';
    L.push('<div class="line">' + v + '</div>');
  }
  // Daily EMAs
  if (s.ema9 != null && s.ema13 != null && s.ema20 != null && s.ema50 != null) {
    var stack, above50 = s.price != null && s.price > s.ema50;
    if (s.ema9 > s.ema13 && s.ema13 > s.ema20 && s.ema20 > s.ema50) stack = '<span class="pos">9&gt;13&gt;20&gt;50 (full bull stack)</span>';
    else if (s.ema9 < s.ema13 && s.ema13 < s.ema20 && s.ema20 < s.ema50) stack = '<span class="neg">9&lt;13&lt;20&lt;50 (full bear stack)</span>';
    else if (s.ema9 > s.ema13 && s.ema13 > s.ema20) stack = '<span class="pos">9&gt;13&gt;20</span> <span class="sub9">(above 50: ' + (above50 ? 'yes' : 'no') + ')</span>';
    else if (s.ema9 < s.ema13 && s.ema13 < s.ema20) stack = '<span class="neg">9&lt;13&lt;20</span> <span class="sub9">(above 50: ' + (above50 ? 'yes' : 'no') + ')</span>';
    else stack = '<span class="sub9">mixed / consolidating</span>';
    var prices = '<span class="sub9">9: $' + s.ema9.toFixed(2) + ' · 13: $' + s.ema13.toFixed(2) + ' · 20: $' + s.ema20.toFixed(2) + ' · 50: $' + s.ema50.toFixed(2) + '</span>';
    L.push('<div class="line"><b>Daily EMAs:</b> ' + stack + '<br>' + prices + '</div>');
  }
  // 5-day MA
  if (s.sma5 != null && s.sma5 > 0 && s.price != null) {
    var side = s.price > s.sma5 ? ' <span class="pos">▲ price above</span>' : ' <span class="neg">▼ price below</span>';
    var pct5 = Math.abs(s.price - s.sma5) / s.sma5 * 100;
    var dist = '';
    if (s.atr != null && s.atr > 0 && !(s.atr > s.price * 1.5)) {
      dist = ' <span class="sub9">(' + (Math.abs(s.price - s.sma5) / s.atr).toFixed(1) + ' ATR · ' + pct5.toFixed(1) + '% away)</span>';
    } else dist = ' <span class="sub9">(' + pct5.toFixed(1) + '% away)</span>';
    L.push('<div class="line"><b>5-day MA:</b> $' + s.sma5.toFixed(2) + side + dist + '</div>');
  }
  // 1-month range
  if (s.monthHigh != null || s.monthLow != null) {
    var m = '<b>1-month range:</b>';
    if (s.monthHigh != null) {
      m += ' H $' + s.monthHigh.toFixed(2);
      if (s.price != null) { var fh = (s.price - s.monthHigh) / s.monthHigh * 100; m += ' <span class="sub9" style="color:' + (fh >= -5 ? 'var(--amber)' : 'var(--muted2)') + '">(' + (fh >= 0 ? '+' : '') + fh.toFixed(1) + '% from H)</span>'; }
    }
    if (s.monthLow != null && s.monthLow > 0) {
      m += ' / L $' + s.monthLow.toFixed(2);
      if (s.price != null) { var fl = (s.price - s.monthLow) / s.monthLow * 100; m += ' <span class="sub9" style="color:' + (fl <= 10 ? 'var(--green-s)' : 'var(--muted2)') + '">(+' + fl.toFixed(1) + '% from L)</span>'; }
    }
    L.push('<div class="line">' + m + '</div>');
  }
  // Gap
  if (s.gapPct != null) {
    var gc = s.gapPct >= 0 ? 'pos' : 'neg', gd = s.gapPct >= 0 ? '▲ gap up' : '▼ gap down';
    L.push('<div class="line"><b>Gap:</b> <span class="' + gc + '">' + (s.gapPct >= 0 ? '+' : '') + s.gapPct.toFixed(1) + '% ' + gd + '</span></div>');
  }
  // Market cap
  if (s.mcap != null && s.mcap > 0) {
    var tier = s.mcap >= 1e10 ? 'large' : s.mcap >= 2e9 ? 'mid' : s.mcap >= 3e8 ? 'small' : 'micro';
    L.push('<div class="line"><b>Market cap:</b> $' + fmtVolShort(s.mcap) + ' <span class="sub9">(' + tier + ' cap)</span></div>');
  }
  // Float
  if (s.floatShares != null && s.floatShares > 0) {
    var ft = s.floatShares < 1e7 ? ' <span class="sub9" style="color:var(--amber)">⚠ low float</span>' : s.floatShares < 5e7 ? ' <span class="sub9" style="color:var(--amber2)">small float</span>' : '';
    L.push('<div class="line"><b>Float:</b> ' + fmtVolShort(s.floatShares) + ' sh' + ft + '</div>');
  }
  // Short float
  if (s.shortFloat != null) {
    var sc = s.shortFloat >= 20 ? 'var(--amber)' : s.shortFloat >= 10 ? 'var(--amber2)' : 'var(--txt2)';
    var sn = s.shortFloat >= 20 ? ' <span class="sub9" style="color:var(--amber)">⚠ high — squeeze risk</span>' : '';
    L.push('<div class="line"><b>Short float:</b> <span style="color:' + sc + '">' + s.shortFloat.toFixed(1) + '%</span>' + sn + '</div>');
  }
  // RVOL
  if (s.rvol != null && s.rvol > 0) {
    var rc = s.rvol >= 3 ? 'pos' : s.rvol >= 1.5 ? '' : 'neg';
    L.push('<div class="line"><b>RVOL:</b> <span class="' + rc + '">' + s.rvol.toFixed(1) + 'x</span></div>');
  }
  // Move (× ATR)
  if (s.dayHigh != null && s.dayLow != null && s.atr != null && s.atr > 0) {
    if (s.price != null && s.atr > s.price * 1.5) {
      L.push('<div class="line"><b>Move:</b> <span class="sub9">— (ATR-14 unreliable)</span></div>');
    } else {
      var ranges = [s.dayHigh - s.dayLow];
      if (s.prevClose != null) { ranges.push(Math.abs(s.dayHigh - s.prevClose)); ranges.push(Math.abs(s.dayLow - s.prevClose)); }
      var mv = Math.max.apply(null, ranges) / s.atr;
      if (isFinite(mv)) {
        var mc = mv >= 3 ? 'neg' : mv >= 1 ? 'pos' : '';
        var mn = mv >= 3 ? ' (overextended)' : mv >= 1 ? ' (above avg day)' : mv < 0.5 ? ' (quiet)' : '';
        L.push('<div class="line"><b>Move:</b> <span class="' + mc + '">' + mv.toFixed(2) + '× ATR</span><span class="sub9">' + mn + '</span></div>');
      }
    }
  }

  var badges = (matchedKeys || [s.screenerKey]).map(function (k) { return '<span class="scr-badge">' + esc(SCREENERS[k].short) + '</span>'; }).join('');
  var chgCls = s.change >= 0 ? 'pos' : 'neg';

  // ── THEMES, SECTOR & MARKET — connects this card to the Market tab ──
  function biasSpan(b) {
    var cls = b === 'BULLISH' ? 'pos' : b === 'BEARISH' ? 'neg' : '';
    return '<span class="' + cls + '"' + (cls ? '' : ' style="color:var(--muted)"') + '>' + esc(b || 'NEUTRAL') + '</span>';
  }
  // All values below are read from the registry snapshot (row.context), not
  // recomputed from the live marketCtx — the card is purely a view of the row.
  var themes = ctx.themes || [];
  var themePills = themes.length
    ? themes.slice(0, 4).map(function (t) {
        return '<span class="theme-pill">· ' + esc(t) + '</span>';
      }).join(' ')
    : '<span style="color:var(--muted2)">—</span>';
  // A resolved bucket gets a bias/hot read; an unmapped raw sector (e.g.
  // "Miscellaneous") is shown but labelled as having no ETF proxy.
  var broad = ctx.broad, broadResolved = ctx.broadResolved;
  var secBias = ctx.secBias || 'NEUTRAL';
  var secScoreStr = ctx.secScore != null ? (ctx.secScore >= 0 ? '+' + ctx.secScore : '' + ctx.secScore) : '';
  var secHot = '';
  if (ctx.secHot) {
    secHot = ' <span class="pos" style="font-size:10px">🔥 hot' + (secScoreStr ? ' ' + secScoreStr : '') + '</span>';
  } else if (secBias === 'BULLISH') {
    secHot = ' <span class="pos" style="font-size:10px">▲ leading' + (secScoreStr ? ' ' + secScoreStr : '') + '</span>';
  } else if (secBias === 'BEARISH') {
    secHot = ' <span class="neg" style="font-size:10px">▼ lagging' + (secScoreStr ? ' ' + secScoreStr : '') + '</span>';
  }
  var sectorLine = !broad
    ? '<span style="color:var(--muted2)">—</span>'
    : broadResolved
      ? esc(broad) + ' — ' + biasSpan(secBias) + secHot
      : esc(broad) + ' <span class="sub9">(no ETF proxy — not scored)</span>';
  var ctxHtml = '<div class="ctx-block">' +
    '<div class="ctx-hdr">🌊 THEMES, SECTOR &amp; MARKET</div>' +
    '<div class="line"><b>Themes:</b> ' + themePills + '</div>' +
    '<div class="line"><b>Sector:</b> ' + sectorLine + '</div>' +
    '<div class="line"><b>Market:</b> ' + biasSpan(ctx.marketBias) + '</div>' +
    '</div>';

  var newsId = 'news-' + String(s.ticker).replace(/[^A-Za-z0-9]/g, '');
  var newsBlock = '<div class="ctx-block">' +
    '<div class="ctx-hdr">📰 NEWS</div>' +
    '<div id="' + newsId + '" class="news-host">' +
      newsHostInner(s.ticker, s.tvSymbol, newsId, row.news) +
    '</div></div>';

  var inList = shortlistHas(s.ticker);
  var starBtn = '<button class="sl-star' + (inList ? ' on' : '') + '" data-sl-add="' + esc(s.ticker) + '">' +
    (inList ? '★ In list' : '☆ Shortlist') + '</button>';

  // Registry status line — whether the stock is live in the latest scan or was
  // surfaced earlier today and has since been refreshed.
  var regStatus = '';
  if (row.lastUpdated) {
    regStatus = row.liveNow
      ? '<div style="font-size:10px;font-weight:600;color:#4ade80;margin:0 0 4px">● Live now · updated ' + esc(fmtETTime(row.lastUpdated)) + ' ET</div>'
      : '<div style="font-size:10px;font-weight:600;color:#fbbf24;margin:0 0 4px">○ Seen earlier today · refreshed ' + esc(fmtETTime(row.lastUpdated)) + ' ET</div>';
  }

  return '<div class="scr-card">' +
    '<div class="scr-hdr"><span class="scr-ticker tap" data-chart="' + esc(s.ticker) + '">' + esc(s.ticker) + '</span>' +
    (s.change != null ? '<span class="scr-chg ' + chgCls + '">' + (s.change >= 0 ? '+' : '') + s.change.toFixed(2) + '%</span>' : '') +
    '<span class="scr-badges">' + badges + '</span>' + starBtn +
    (s.sector ? '<span class="scr-sector">' + esc(s.sector) + (s.industry ? ' · ' + esc(s.industry) : '') + '</span>' : '') +
    '</div>' +
    regStatus +
    ctxHtml +
    '<div class="tech-hdr">📈 TECHNICALS</div>' +
    (L.length ? L.join('') : '<div class="empty">— no technical data —</div>') +
    newsBlock +
    '</div>';
}

// ══════════════════════════════════════════════════════════════════════
// CANDIDATE REGISTRY — durable record of every stock a scan surfaces.
// Cards are ALWAYS built from this registry (never directly from a live
// scan) so candidates that appeared earlier in the day aren't lost when a
// later scan no longer returns them. Unique id = TICKER|YYYY-MM-DD (ET):
// the same ticker on a different day is a distinct record.
//
//   row = {
//     id, ticker, date, tvSymbol,
//     firstSeen, lastUpdated, liveNow,   // liveNow = matched the latest full scan
//     screenerKeys: [..],                // screeners it has matched today (union)
//     stock:   { ...full mapped quote... },   // technicals the card/table consume
//     context: { themes, broad, broadResolved, secBias, secScore, secHot,
//                marketBias },                 // Market-tab snapshot, frozen at scan time
//     news:    { finnhub:[], tradingview:[], fetchedAt } | null  // fetched on demand
//   }
// Cards are a pure view of the row — buildCard reads stock/context/news only,
// never the live marketCtx — so a record stays consistent with the scan that
// produced it.
// ══════════════════════════════════════════════════════════════════════
var registry = {};   // id -> row

function loadRegistry() {
  return storageGet(['registry']).then(function (r) { registry = r.registry || {}; return registry; });
}
function saveRegistry() { return storageSet({ registry: registry }); }
function regId(ticker, date) { return ticker + '|' + date; }
function regTodayRows() {
  var today = etDateStr();
  return Object.keys(registry).map(function (k) { return registry[k]; })
    .filter(function (row) { return row.date === today; });
}

// Add/update today's rows for the stocks that are live in this scan.
// keysByTicker: { TICKER -> [screenerKeys matched this scan] }.
function registryUpsertLive(stocks, keysByTicker) {
  var today = etDateStr(), now = Date.now();
  stocks.forEach(function (s) {
    var id = regId(s.ticker, today);
    var keys = keysByTicker[s.ticker] || (s.screenerKey ? [s.screenerKey] : []);
    var ctx = computeCardContext(s);        // snapshot themes/sector/market now
    var row = registry[id];
    if (row) {                              // seen earlier today → update in place
      row.stock = s;
      row.context = ctx;
      row.tvSymbol = s.tvSymbol || row.tvSymbol;
      row.lastUpdated = now;
      row.liveNow = true;
      keys.forEach(function (k) { if (row.screenerKeys.indexOf(k) === -1) row.screenerKeys.push(k); });
    } else {                                // brand-new candidate for today → new row
      registry[id] = {
        id: id, ticker: s.ticker, date: today, tvSymbol: s.tvSymbol || '',
        firstSeen: now, lastUpdated: now, liveNow: true,
        screenerKeys: keys.slice(), stock: s, context: ctx, news: null
      };
    }
  });
}

// Refresh today's rows that did NOT appear in the latest full scan (live
// earlier, not live now) with fresh quote data, and mark them not-live.
// Their screener context is preserved — that's why they're candidates.
function registryRefreshStale(liveTickerSet) {
  var stale = regTodayRows().filter(function (row) { return !liveTickerSet[row.ticker]; });
  if (!stale.length) return Promise.resolve(0);
  var syms = stale.map(function (row) { return row.tvSymbol || (row.stock && row.stock.tvSymbol) || row.ticker; });
  var now = Date.now();
  return fetchBySymbols(syms).then(function (fresh) {
    var byTicker = {};
    fresh.forEach(function (s) { byTicker[s.ticker] = s; });
    var refreshed = 0;
    stale.forEach(function (row) {
      var s = byTicker[row.ticker];
      if (s) {
        s.screenerKey = row.stock ? row.stock.screenerKey : null; // keep why-it's-a-candidate
        row.stock = s;
        row.tvSymbol = s.tvSymbol || row.tvSymbol;
        row.lastUpdated = now;
        refreshed++;
      }
      // re-snapshot the context too (sector bias / market can shift intraday)
      if (row.stock) row.context = computeCardContext(row.stock);
      row.liveNow = false;
    });
    return refreshed;
  }).catch(function () {
    stale.forEach(function (row) {            // honest UI even if the refresh fetch fails
      if (row.stock) row.context = computeCardContext(row.stock);
      row.liveNow = false;
    });
    return 0;
  });
}

// Render the Screener result cards from today's registry rows (the only path
// that fills #scrResults). Live candidates first, then by screeners matched,
// then RVOL, then most-recently updated.
function renderScreenerFromRegistry() {
  var rows = regTodayRows();
  rows.sort(function (a, b) {
    if (a.liveNow !== b.liveNow) return a.liveNow ? -1 : 1;
    if (b.screenerKeys.length !== a.screenerKeys.length) return b.screenerKeys.length - a.screenerKeys.length;
    var ra = (a.stock && a.stock.rvol) || 0, rb = (b.stock && b.stock.rvol) || 0;
    if (rb !== ra) return rb - ra;
    return (b.lastUpdated || 0) - (a.lastUpdated || 0);
  });
  var host = $('scrResults');
  if (!rows.length) { host.innerHTML = '<div class="empty">No candidates yet today. Run a scan above.</div>'; return 0; }
  host.innerHTML = rows.map(function (row) { return buildCard(row); }).join('');
  return rows.length;
}

async function runAllScreeners() {
  var scrBtns = $('scrButtons').querySelectorAll('[data-scr]');
  $('scrRunAll').disabled = true;
  Array.prototype.forEach.call(scrBtns, function (b) { b.disabled = true; });
  $('scrStatus').textContent = 'Running 3 screeners…';
  try {
    if (!marketCtx.lastRefresh) await refreshMarket();
    var keys = ['trend', 'premarket', 'bigmoves'];
    var lists = await Promise.all(keys.map(function (k) { return runScreener(k).catch(function () { return []; }); }));
    // merge by ticker, collect matched screeners
    var byTicker = {};
    keys.forEach(function (k, i) {
      lists[i].forEach(function (s) {
        if (!byTicker[s.ticker]) byTicker[s.ticker] = { stock: s, keys: [] };
        if (byTicker[s.ticker].keys.indexOf(k) === -1) byTicker[s.ticker].keys.push(k);
      });
    });
    var liveStocks = [], keysByTicker = {}, liveSet = {};
    Object.keys(byTicker).forEach(function (t) {
      liveStocks.push(byTicker[t].stock); keysByTicker[t] = byTicker[t].keys; liveSet[t] = true;
    });
    // registry-first: record live now → refresh earlier-today candidates → render from registry
    registryUpsertLive(liveStocks, keysByTicker);
    var refreshed = await registryRefreshStale(liveSet);
    await saveRegistry();
    var shown = renderScreenerFromRegistry();
    renderRegistryTable();
    $('scrStatus').textContent = shown + ' candidate' + (shown === 1 ? '' : 's') + ' today · ' +
      liveStocks.length + ' live now' + (refreshed ? ' · ' + refreshed + ' earlier refreshed' : '');
  } catch (e) {
    $('scrStatus').textContent = 'Error: ' + e.message;
  }
  $('scrRunAll').disabled = false;
  Array.prototype.forEach.call(scrBtns, function (b) { b.disabled = false; });
}

async function runSingle(key) {
  var scrBtns = $('scrButtons').querySelectorAll('[data-scr]');
  $('scrRunAll').disabled = true;
  Array.prototype.forEach.call(scrBtns, function (b) { b.disabled = true; });
  $('scrStatus').textContent = 'Running ' + SCREENERS[key].name + '…';
  try {
    if (!marketCtx.lastRefresh) await refreshMarket();
    var list = await runScreener(key);
    // A single screener is a partial scan: add/update what it found (and mark
    // those live) but don't reconcile or refresh the other screeners' rows.
    var keysByTicker = {};
    list.forEach(function (s) { keysByTicker[s.ticker] = [key]; });
    registryUpsertLive(list, keysByTicker);
    await saveRegistry();
    var shown = renderScreenerFromRegistry();
    renderRegistryTable();
    $('scrStatus').textContent = list.length + ' live from ' + SCREENERS[key].name +
      ' · ' + shown + ' candidate' + (shown === 1 ? '' : 's') + ' today';
  } catch (e) { $('scrStatus').textContent = 'Error: ' + e.message; }
  $('scrRunAll').disabled = false;
  Array.prototype.forEach.call(scrBtns, function (b) { b.disabled = false; });
}

// ── REGISTRY TAB: table view + CSV export ───────────────────────────────
function regFix(v, d) { return (v == null || !isFinite(v)) ? '' : Number(v).toFixed(d == null ? 2 : d); }
var REG_COLUMNS = [
  { label: 'Date', get: function (r) { return r.date; } },
  { label: 'Ticker', get: function (r) { return r.ticker; } },
  { label: 'Status', get: function (r) { return r.liveNow ? 'live' : 'earlier'; } },
  { label: 'First seen', get: function (r) { return fmtETTime(r.firstSeen); } },
  { label: 'Updated', get: function (r) { return fmtETTime(r.lastUpdated); } },
  { label: 'Screeners', get: function (r) { return (r.screenerKeys || []).map(function (k) { return SCREENERS[k] ? SCREENERS[k].short : k; }).join(' / '); } },
  { label: 'Price', get: function (r) { return regFix(r.stock.price); } },
  { label: 'Open', get: function (r) { return regFix(r.stock.open); } },
  { label: 'Prev close', get: function (r) { return regFix(r.stock.prevClose); } },
  { label: 'Change %', get: function (r) { return regFix(r.stock.change); } },
  { label: 'Gap %', get: function (r) { return regFix(r.stock.gapPct); } },
  { label: 'VWAP', get: function (r) { return regFix(r.stock.vwap); } },
  { label: 'RVOL', get: function (r) { return regFix(r.stock.rvol); } },
  { label: 'ATR', get: function (r) { return regFix(r.stock.atr); } },
  { label: 'Day H', get: function (r) { return regFix(r.stock.dayHigh); } },
  { label: 'Day L', get: function (r) { return regFix(r.stock.dayLow); } },
  { label: '1M H', get: function (r) { return regFix(r.stock.monthHigh); } },
  { label: '1M L', get: function (r) { return regFix(r.stock.monthLow); } },
  { label: 'Mkt cap', get: function (r) { return regFix(r.stock.mcap, 0); } },
  { label: 'Float', get: function (r) { return regFix(r.stock.floatShares, 0); } },
  { label: 'Short %', get: function (r) { return regFix(r.stock.shortFloat); } },
  { label: 'EMA9', get: function (r) { return regFix(r.stock.ema9); } },
  { label: 'EMA13', get: function (r) { return regFix(r.stock.ema13); } },
  { label: 'EMA20', get: function (r) { return regFix(r.stock.ema20); } },
  { label: 'EMA50', get: function (r) { return regFix(r.stock.ema50); } },
  { label: 'SMA5', get: function (r) { return regFix(r.stock.sma5); } },
  { label: 'Sector', get: function (r) { return r.stock.sector || ''; } },
  { label: 'Industry', get: function (r) { return r.stock.industry || ''; } },
  { label: 'Themes', get: function (r) { return ((r.context && r.context.themes) || []).join(' '); } },
  { label: 'Sec bias', get: function (r) { return (r.context && r.context.secBias) || ''; } },
  { label: 'Sec score', get: function (r) { return r.context && r.context.secScore != null ? r.context.secScore : ''; } },
  { label: 'Hot sector', get: function (r) { return r.context && r.context.secHot ? 'hot' : ''; } },
  { label: 'Mkt bias', get: function (r) { return (r.context && r.context.marketBias) || ''; } },
  { label: 'News', get: function (r) {
      if (!r.news) return '';
      var n = (r.news.finnhub || []).length + (r.news.tradingview || []).length;
      return n + ' items @ ' + fmtETTime(r.news.fetchedAt) + ' ET';
  } }
];
function regSortForTable(a, b) {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;          // newest day first
  if (a.liveNow !== b.liveNow) return a.liveNow ? -1 : 1;          // live before earlier
  return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
}
function setRegStatus(msg) {
  var el = $('regStatus'); if (!el) return;
  el.textContent = msg || '';
  if (msg) setTimeout(function () { if (el.textContent === msg) el.textContent = ''; }, 4000);
}
function renderRegistryTable() {
  var host = $('regTableWrap'); if (!host) return;
  var all = Object.keys(registry).map(function (k) { return registry[k]; });
  var today = etDateStr();
  var todayCount = all.filter(function (r) { return r.date === today; }).length;
  var liveCount = all.filter(function (r) { return r.date === today && r.liveNow; }).length;
  var sum = $('regSummary');
  if (sum) sum.textContent = all.length + ' record' + (all.length === 1 ? '' : 's') + ' · ' + todayCount + ' today · ' + liveCount + ' live now';
  if (!all.length) { host.innerHTML = '<div class="empty">No records yet. Run a scan from the 🔎 Screener tab.</div>'; return; }
  all.sort(regSortForTable);
  var head = '<tr>' + REG_COLUMNS.map(function (c) { return '<th>' + esc(c.label) + '</th>'; }).join('') + '</tr>';
  var body = all.map(function (row) {
    var cls = row.date !== today ? 'reg-old' : row.liveNow ? 'reg-live' : 'reg-today';
    return '<tr class="' + cls + '">' + REG_COLUMNS.map(function (c) {
      return '<td>' + esc(c.get(row)) + '</td>';
    }).join('') + '</tr>';
  }).join('');
  host.innerHTML = '<table class="reg-table"><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
}
function csvCell(v) {
  var s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function exportRegistryCsv() {
  var all = Object.keys(registry).map(function (k) { return registry[k]; });
  if (!all.length) { setRegStatus('Registry is empty — nothing to export.'); return; }
  all.sort(regSortForTable);
  var lines = [REG_COLUMNS.map(function (c) { return csvCell(c.label); }).join(',')];
  all.forEach(function (row) {
    lines.push(REG_COLUMNS.map(function (c) { return csvCell(c.get(row)); }).join(','));
  });
  var csv = lines.join('\r\n');
  var fname = 'candidate-registry-' + etDateStr() + '.csv';
  var ok = false;
  try {
    var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = fname; document.body.appendChild(a); a.click();
    setTimeout(function () { try { document.body.removeChild(a); } catch (_) {} URL.revokeObjectURL(url); }, 1000);
    ok = true;
  } catch (_) { ok = downloadText(fname, csv); }
  setRegStatus(ok ? ('Exported ' + all.length + ' record' + (all.length === 1 ? '' : 's') + ' → ' + fname) : 'Export failed.');
}
function initRegistry() {
  var ex = $('regExport'); if (ex) ex.addEventListener('click', exportRegistryCsv);
  var rf = $('regRefresh'); if (rf) rf.addEventListener('click', renderRegistryTable);
  var cl = $('regClear');
  if (cl) cl.addEventListener('click', function () {
    if (!window.confirm('Clear the entire candidate registry? This removes every saved record for all days.')) return;
    registry = {};
    saveRegistry().then(function () {
      renderRegistryTable();
      renderScreenerFromRegistry();
      setRegStatus('Registry cleared.');
    });
  });
}

// ══════════════════════════════════════════════════════════════════════
// SHORTLIST TAB — per-day saved picks, exportable to a TradingView watchlist
// Adds come from the Screener cards (☆ Shortlist). Lists are keyed by ET day,
// so when the date rolls over a fresh empty list starts and past days persist.
// Each export (clipboard or .txt) is logged under its day with the exact time.
// ══════════════════════════════════════════════════════════════════════
var _slExpanded = {}; // date → bool (default: today open, past days collapsed)

function todayKey() { return etDateStr(); }
function loadShortlists() {
  return storageGet(['shortlists']).then(function (r) {
    shortlists = r.shortlists || {};
    refreshShortlistCache();
    return shortlists;
  });
}
function saveShortlists() { return storageSet({ shortlists: shortlists }); }
function refreshShortlistCache() {
  shortlistTodaySet = {};
  var day = shortlists[todayKey()];
  if (day && day.items) day.items.forEach(function (it) { shortlistTodaySet[it.ticker] = true; });
}
function shortlistHas(ticker) { return !!shortlistTodaySet[ticker]; }
function toggleShortlist(ticker) {
  var key = todayKey(), day = shortlists[key];
  if (!day) { day = { items: [], exports: [] }; shortlists[key] = day; }
  var idx = day.items.findIndex(function (it) { return it.ticker === ticker; });
  if (idx >= 0) {
    day.items.splice(idx, 1);
  } else {
    var s = scrIndex[ticker] || {};
    day.items.push({
      ticker: ticker, tvSymbol: s.tvSymbol || '', price: s.price != null ? s.price : null,
      change: s.change != null ? s.change : null, sector: s.sector || '', addedAt: Date.now()
    });
  }
  refreshShortlistCache();
  return saveShortlists();
}

// DD/Mon/YYYY from a YYYY-MM-DD key.
function fmtDayLabel(key) {
  var p = String(key || '').split('-');
  if (p.length !== 3) return key;
  var mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][parseInt(p[1], 10) - 1] || p[1];
  return p[2] + '/' + mon + '/' + p[0];
}

// Clipboard with a textarea + execCommand fallback (Kiwi/Android friendly).
function copyText(text) {
  return new Promise(function (resolve) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { resolve(true); }, function () { resolve(fallbackCopy(text)); });
    } else { resolve(fallbackCopy(text)); }
  });
}
function fallbackCopy(text) {
  try {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    var ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) { return false; }
}
function downloadText(filename, text) {
  try {
    var blob = new Blob([text], { type: 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(function () { try { document.body.removeChild(a); } catch (_) {} URL.revokeObjectURL(url); }, 1000);
    return true;
  } catch (_) { return false; }
}

function setShortlistStatus(msg) {
  var el = $('slStatus'); if (!el) return;
  el.textContent = msg || '';
  if (msg) setTimeout(function () { if (el.textContent === msg) el.textContent = ''; }, 4000);
}

// Build the comma-joined TradingView import string for one day.
function dayExportSymbols(day) {
  return (day.items || []).map(function (it) { return it.tvSymbol || it.ticker; });
}
function exportDay(dateKey, mode) {
  var day = shortlists[dateKey];
  if (!day || !day.items.length) { setShortlistStatus('Nothing to export for ' + fmtDayLabel(dateKey) + '.'); return; }
  var syms = dayExportSymbols(day), text = syms.join(',');
  if (!day.exports) day.exports = [];
  if (mode === 'file') {
    var fname = 'shortlist-' + dateKey + '.txt';
    var ok = downloadText(fname, text);
    day.exports.push({ at: Date.now(), count: syms.length, mode: 'file' });
    saveShortlists().then(function () {
      renderShortlist();
      setShortlistStatus(ok ? ('Saved ' + fname + ' (' + syms.length + ' symbols).') : 'Download failed — use copy instead.');
    });
  } else {
    copyText(text).then(function (ok) {
      day.exports.push({ at: Date.now(), count: syms.length, mode: 'clipboard' });
      saveShortlists().then(function () {
        renderShortlist();
        setShortlistStatus(ok ? ('Copied ' + syms.length + ' symbols — paste into TradingView › Watchlist › Import.') : 'Copy blocked — long-press the list to copy manually.');
      });
    });
  }
}

function renderShortlist() {
  var host = $('slList'); if (!host) return;
  var today = todayKey();
  var keys = Object.keys(shortlists);
  if (keys.indexOf(today) === -1) keys.push(today);   // always surface today, even if empty
  keys.sort(function (a, b) { return a < b ? 1 : a > b ? -1 : 0; }); // newest day first

  host.innerHTML = keys.map(function (key) {
    var day = shortlists[key] || { items: [], exports: [] };
    var isToday = key === today;
    var open = _slExpanded.hasOwnProperty(key) ? _slExpanded[key] : isToday;
    var count = (day.items || []).length;

    var itemsHtml = count ? day.items.slice().sort(function (a, b) { return (b.addedAt || 0) - (a.addedAt || 0); })
      .map(function (it) {
        var chg = it.change != null
          ? '<span class="sl-chg ' + (it.change >= 0 ? 'pos' : 'neg') + '">' + (it.change >= 0 ? '+' : '') + it.change.toFixed(2) + '%</span>'
          : '';
        var meta = '<span class="sl-meta">' + (it.tvSymbol ? esc(it.tvSymbol) : esc(it.ticker)) + (it.sector ? ' · ' + esc(it.sector) : '') + '</span>';
        return '<div class="sl-item">' +
          '<span class="sl-tkr" data-chart="' + esc(it.ticker) + '">' + esc(it.ticker) + '</span>' +
          chg + meta +
          '<button class="sl-del" data-sl-del="' + esc(it.ticker) + '" data-sl-date="' + esc(key) + '">✕ remove</button>' +
          '</div>';
      }).join('')
      : '<div class="sl-empty">No stocks yet. Add from the 🔎 Screener tab.</div>';

    var actions = count
      ? '<div class="sl-actions">' +
        '<button class="btn-mini" data-sl-export="' + esc(key) + '" data-sl-mode="clipboard">📋 Export → copy symbols</button>' +
        '<button class="btn-mini" data-sl-export="' + esc(key) + '" data-sl-mode="file">⬇ Save .txt</button>' +
        '</div>'
      : '';

    var exportsHtml = (day.exports && day.exports.length)
      ? '<div class="sl-exports"><b>Export history:</b>' +
        day.exports.slice().sort(function (a, b) { return (b.at || 0) - (a.at || 0); }).map(function (e) {
          return '<span class="x">✓ ' + esc(fmtETTime(e.at)) + ' ET · ' + e.count + ' symbols · ' + (e.mode === 'file' ? 'saved .txt' : 'copied') + '</span>';
        }).join('') + '</div>'
      : '';

    return '<div class="sl-day' + (isToday ? ' today' : '') + '" data-sl-day="' + esc(key) + '">' +
      '<div class="sl-head"><span class="sl-date">' + esc(fmtDayLabel(key)) + '</span>' +
      (isToday ? '<span class="sl-today-badge">TODAY</span>' : '') +
      '<span class="sl-count">' + count + ' stock' + (count === 1 ? '' : 's') + '</span>' +
      '<span class="sl-chev">' + (open ? '▾' : '▸') + '</span></div>' +
      (open ? '<div class="sl-body">' + itemsHtml + actions + exportsHtml + '</div>' : '') +
      '</div>';
  }).join('');
}

// One delegated listener for the whole shortlist pane (survives re-renders).
function initShortlist() {
  $('slList').addEventListener('click', function (ev) {
    var t = ev.target;
    // remove
    var del = t.closest && t.closest('[data-sl-del]');
    if (del) {
      var dk = del.getAttribute('data-sl-date'), tk = del.getAttribute('data-sl-del');
      var day = shortlists[dk];
      if (day && day.items) {
        var i = day.items.findIndex(function (it) { return it.ticker === tk; });
        if (i >= 0) day.items.splice(i, 1);
        refreshShortlistCache();
        saveShortlists().then(function () { renderShortlist(); });
      }
      return;
    }
    // export
    var ex = t.closest && t.closest('[data-sl-export]');
    if (ex) { exportDay(ex.getAttribute('data-sl-export'), ex.getAttribute('data-sl-mode')); return; }
    // collapse toggle (ignore taps on the ticker, which charts instead)
    var head = t.closest && t.closest('.sl-head');
    if (head) {
      var key = head.parentNode.getAttribute('data-sl-day');
      var cur = _slExpanded.hasOwnProperty(key) ? _slExpanded[key] : (key === todayKey());
      _slExpanded[key] = !cur;
      renderShortlist();
    }
  });
}

// Delegated handler for the ☆/★ star buttons on screener cards.
function initShortlistStars() {
  document.body.addEventListener('click', function (ev) {
    var btn = ev.target.closest && ev.target.closest('[data-sl-add]');
    if (!btn) return;
    var ticker = btn.getAttribute('data-sl-add');
    toggleShortlist(ticker).then(function () {
      var on = shortlistHas(ticker);
      btn.classList.toggle('on', on);
      btn.innerHTML = on ? '★ In list' : '☆ Shortlist';
      renderShortlist();
    });
  });
}


// Rendering: TradingView lightweight-charts (bundled locally).
// Data: daily OHLC via background.js (Yahoo primary, Stooq fallback).
// ══════════════════════════════════════════════════════════════════════
var chartState = { symbol: null, label: null, range: '6mo', chart: null, series: null, ro: null, reqId: 0 };

function fetchChartHistory(symbol, range) {
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage({ action: 'chartHistory', symbol: symbol, range: range }, function (resp) {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp || !resp.ok) return reject(new Error(resp ? resp.error : 'no response'));
      resolve(resp);
    });
  });
}

function destroyChart() {
  if (chartState.ro) { try { chartState.ro.disconnect(); } catch (_) {} chartState.ro = null; }
  if (chartState.chart) { try { chartState.chart.remove(); } catch (_) {} }
  chartState.chart = null; chartState.series = null;
}

function buildChartInstance() {
  var host = $('chartHost');
  if (!host || typeof LightweightCharts === 'undefined') return null;
  var w = host.clientWidth || 720, h = host.clientHeight || 360;
  var chart = LightweightCharts.createChart(host, {
    width: w, height: h,
    layout: { background: { color: 'transparent' }, textColor: '#cbd5e1', fontSize: 11 },
    grid: { vertLines: { color: 'rgba(148,163,184,0.07)' }, horzLines: { color: 'rgba(148,163,184,0.07)' } },
    rightPriceScale: { borderColor: '#1e293b' },
    timeScale: { borderColor: '#1e293b', timeVisible: false, secondsVisible: false },
    crosshair: { mode: 1 },
    handleScale: true, handleScroll: true
  });
  var series = chart.addCandlestickSeries({
    upColor: '#22c55e', downColor: '#ef4444',
    borderUpColor: '#22c55e', borderDownColor: '#ef4444',
    wickUpColor: '#4ade80', wickDownColor: '#f87171',
    priceLineVisible: true, lastValueVisible: true
  });
  chartState.chart = chart; chartState.series = series;
  if (typeof ResizeObserver !== 'undefined') {
    chartState.ro = new ResizeObserver(function () {
      if (chartState.chart && host.clientWidth) chartState.chart.applyOptions({ width: host.clientWidth });
    });
    chartState.ro.observe(host);
  }
  return series;
}

function setChartNote(txt) {
  var n = $('chartNote');
  if (!n) return;
  if (txt) { n.textContent = txt; n.style.display = 'flex'; }
  else n.style.display = 'none';
}

function loadChart(range) {
  chartState.range = range;
  $('chartRange3M').classList.toggle('on', range === '3mo');
  $('chartRange6M').classList.toggle('on', range === '6mo');
  if (typeof LightweightCharts === 'undefined') { setChartNote('Chart library not loaded.'); return; }
  var myReq = ++chartState.reqId;
  setChartNote('Loading…');
  $('chartSub').textContent = '';
  fetchChartHistory(chartState.symbol, range).then(function (resp) {
    if (myReq !== chartState.reqId) return; // a newer request superseded this one
    var bars = (resp.bars || []).slice().sort(function (a, b) { return a.time < b.time ? -1 : a.time > b.time ? 1 : 0; });
    bars = bars.filter(function (b, i) { return i === 0 || b.time !== bars[i - 1].time; }); // strictly increasing time
    if (!bars.length) { setChartNote('No data for ' + esc(chartState.symbol) + '.'); return; }
    if (!chartState.series) { if (!buildChartInstance()) { setChartNote('Chart unavailable.'); return; } }
    chartState.series.setData(bars);
    chartState.chart.timeScale().fitContent();
    setChartNote('');
    var first = bars[0], last = bars[bars.length - 1];
    var pct = first.open ? (last.close - first.open) / first.open * 100 : null;
    var lbl = range === '3mo' ? '3M' : '6M';
    var pctStr = pct == null ? '' : ' · ' + (pct >= 0 ? '+' : '') + pct.toFixed(1) + '% over period';
    var src = resp.source ? ' · ' + resp.source : '';
    $('chartSub').textContent = bars.length + ' daily bars · ' + lbl + pctStr + src;
  }).catch(function (e) {
    if (myReq !== chartState.reqId) return;
    setChartNote('Couldn\u2019t load chart: ' + e.message);
  });
}

function openChart(symbol, label) {
  chartState.symbol = symbol; chartState.label = label || symbol;
  $('chartTitle').textContent = '📈 ' + chartState.label + ' — daily';
  destroyChart();
  $('chartOverlay').classList.add('open');
  // The chart instance is built inside loadChart() after the fetch resolves,
  // by which point the overlay is painted and chartHost has a real width.
  loadChart(chartState.range || '6mo');
}

function closeChart() {
  chartState.reqId++; // invalidate any in-flight load
  $('chartOverlay').classList.remove('open');
  destroyChart();
}

function initChart() {
  // Open on tap of anything carrying data-chart (index cards, heat cells, bias tags).
  document.body.addEventListener('click', function (ev) {
    var t = ev.target;
    while (t && t !== document.body && !(t.getAttribute && t.getAttribute('data-chart'))) t = t.parentNode;
    if (!t || t === document.body) return;
    var sym = t.getAttribute('data-chart');
    if (sym) { ev.preventDefault(); openChart(sym, sym); }
  });
  $('chartClose').addEventListener('click', closeChart);
  $('chartOverlay').addEventListener('click', function (ev) { if (ev.target === $('chartOverlay')) closeChart(); });
  $('chartRange3M').addEventListener('click', function () { loadChart('3mo'); });
  $('chartRange6M').addEventListener('click', function () { loadChart('6mo'); });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && $('chartOverlay').classList.contains('open')) closeChart();
  });
}


// ══════════════════════════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════════════════════════
function initScreenerButtons() {
  $('scrButtons').innerHTML = Object.keys(SCREENERS).map(function (k) {
    return '<button class="btn btn-ghost" data-scr="' + k + '" style="flex:1">' + esc(SCREENERS[k].name) + '</button>';
  }).join('');
  Array.prototype.forEach.call($('scrButtons').querySelectorAll('[data-scr]'), function (b) {
    b.addEventListener('click', function () { runSingle(b.getAttribute('data-scr')); });
  });
}
function initTabs() {
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
      document.querySelectorAll('.pane').forEach(function (x) { x.classList.remove('active'); });
      t.classList.add('active');
      var pane = t.getAttribute('data-pane');
      $(pane).classList.add('active');
      if (pane === 'pane-registry') renderRegistryTable(); // always show the latest records
    });
  });
}

// Delegated handler for the per-card "Load news" buttons (cards are re-rendered).
function initNews() {
  document.body.addEventListener('click', function (ev) {
    var t = ev.target;
    while (t && t !== document.body && !(t.getAttribute && t.getAttribute('data-news'))) t = t.parentNode;
    if (!t || t === document.body) return;
    loadCardNews(t.getAttribute('data-news'), t.getAttribute('data-tvsym'), t.getAttribute('data-newsid'));
  });
}

function clampInt(v, lo, hi, dflt) {
  var n = parseInt(v, 10);
  if (!isFinite(n)) n = dflt;
  return Math.max(lo, Math.min(hi, n));
}
function fillSettingsForm() {
  $('setHotImm').value = settings.hotImmediate;
  $('setHotSus').value = settings.hotSustained;
  $('setHotDays').value = settings.hotSustainedDays;
  $('setHotFloor').value = settings.hotFloor;
  $('setHotCool').value = settings.hotCoolDays;
  $('setFinnhub').value = settings.finnhubKey || '';
  $('setFinnhubNews').checked = settings.finnhubNews !== false;
}
function setSettingsStatus(msg) {
  $('setStatus').textContent = msg;
  if (msg) setTimeout(function () { $('setStatus').textContent = ''; }, 2200);
}
function recomputeHotFromStore() {
  if (!marketCtx.lastRefresh) return Promise.resolve();
  return reclassifyHot().then(function (out) {
    marketCtx.hotStatus = out;
    renderSectorBias(); renderHeatmap();
  });
}
function initSettings() {
  fillSettingsForm();
  $('setSave').addEventListener('click', function () {
    settings.hotImmediate = clampInt($('setHotImm').value, 0, 100, DEFAULT_SETTINGS.hotImmediate);
    settings.hotSustained = clampInt($('setHotSus').value, 0, 100, DEFAULT_SETTINGS.hotSustained);
    settings.hotSustainedDays = clampInt($('setHotDays').value, 1, 14, DEFAULT_SETTINGS.hotSustainedDays);
    settings.hotFloor = clampInt($('setHotFloor').value, 0, 100, DEFAULT_SETTINGS.hotFloor);
    settings.hotCoolDays = clampInt($('setHotCool').value, 1, 14, DEFAULT_SETTINGS.hotCoolDays);
    settings.finnhubKey = ($('setFinnhub').value || '').trim();
    settings.finnhubNews = !!$('setFinnhubNews').checked;
    // keep thresholds ordered: floor ≤ sustained ≤ immediate
    if (settings.hotSustained > settings.hotImmediate) settings.hotSustained = settings.hotImmediate;
    if (settings.hotFloor > settings.hotSustained) settings.hotFloor = settings.hotSustained;
    fillSettingsForm();
    saveSettings().then(function () { setSettingsStatus('Saved ✓'); return recomputeHotFromStore(); });
  });
  $('setReset').addEventListener('click', function () {
    settings = Object.assign({}, DEFAULT_SETTINGS, { finnhubKey: settings.finnhubKey, finnhubNews: settings.finnhubNews });
    fillSettingsForm();
    saveSettings().then(function () { setSettingsStatus('Thresholds reset to defaults ✓'); return recomputeHotFromStore(); });
  });
  $('setClearHist').addEventListener('click', function () {
    storageSet({ hotState: {}, sectorHistory: {} }).then(function () {
      setSettingsStatus('Hot-sector history cleared ✓');
      if (marketCtx.lastRefresh) {
        return updateHotStates(marketCtx.sectorBiasScores).then(function (out) {
          marketCtx.hotStatus = out; renderSectorBias(); renderHeatmap();
        });
      }
      marketCtx.hotStatus = {};
    });
  });
}

document.addEventListener('DOMContentLoaded', function () {
  initTabs();
  initScreenerButtons();
  initChart();
  initNews();
  initShortlist();
  initShortlistStars();
  initRegistry();
  $('mktRefresh').addEventListener('click', refreshMarket);
  $('scrRunAll').addEventListener('click', runAllScreeners);
  // load settings first (thresholds + key), then auto-load market
  loadSettings().then(function () {
    initSettings();
    refreshMarket();
  });
  // restore the registry + shortlists, then paint today's candidate cards
  // (after shortlists so the ☆/★ state is correct) and the registry table.
  Promise.all([loadRegistry(), loadShortlists()]).then(function () {
    renderShortlist();
    renderScreenerFromRegistry();
    renderRegistryTable();
  });
});

/* ══════════════════════════════════════════════════════════════════════
   TRADE JOURNAL — merged from ext2/popup.js
   All functions prefixed jnl_ to avoid namespace conflicts with ext1.
   ══════════════════════════════════════════════════════════════════════ */

var ET_TZ = "America/New_York";

function htmlEscape(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function fmtETIsoDate(ts) {
  var parts = new Date(ts).toLocaleDateString("en-US", {
    timeZone: ET_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  var m = parts.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? m[3] + "-" + m[1] + "-" + m[2] : parts;
}

var __jnlTrades = [];

function jnl_save(trades) {
  __jnlTrades = trades;
  try {
    chrome.storage.local.set({
      smb_journal: JSON.stringify(trades)
    });
  } catch (_) {}
}

function jnl_load(cb) {
  try {
    chrome.storage.local.get([ "smb_journal" ], function(d) {
      try {
        __jnlTrades = d.smb_journal ? JSON.parse(d.smb_journal) : [];
      } catch (_) {
        __jnlTrades = [];
      }
      cb(__jnlTrades);
    });
  } catch (_) {
    cb([]);
  }
}

function jnl_parseCsvLine(line, delim) {
  var result = [];
  var cur = "";
  var inQ = false;
  var d = delim || ",";
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (ch === '"') {
      inQ = !inQ;
    } else if (ch === d && !inQ) {
      result.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur.trim());
  return result;
}

function jnl_detectFormat(headers) {
  var h = headers.map(function(x) {
    return x.toLowerCase().replace(/[^a-z]/g, "");
  });
  if (h.indexOf("datetime") !== -1 && h.indexOf("orderid") !== -1 && h.indexOf("event") !== -1) return "ttporders";
  if (h.indexOf("symbol") !== -1 && h.indexOf("side") !== -1 && h.indexOf("qty") !== -1) return "tv";
  if (h.indexOf("action") !== -1 && h.indexOf("shares") !== -1) return "ttp";
  if (h.length === 2 && h.indexOf("time") !== -1 && h.indexOf("text") !== -1) return "tvjournal";
  return null;
}

function jnl_etOffsetMs(dateStr) {
  var s = String(dateStr || "").slice(0, 10);
  try {
    var d = new Date(s + "T12:00:00Z");
    if (isNaN(d.getTime())) throw 0;
    var parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour12: false,
      hour: "2-digit"
    }).formatToParts(d);
    var hh = 0;
    parts.forEach(function(p) {
      if (p.type === "hour") hh = parseInt(p.value, 10);
    });
    if (hh === 24) hh = 0;
    var offH = 12 - hh;
    if (offH < 0) offH += 24;
    return offH * 36e5;
  } catch (_) {
    var month = parseInt(s.slice(5, 7), 10);
    return month >= 3 && month <= 11 ? 4 * 36e5 : 5 * 36e5;
  }
}

function jnl_parseDateTime(dateStr, timeStr) {
  var combined = timeStr ? dateStr.trim() + " " + timeStr.trim() : dateStr.trim();
  var m = combined.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    var utcMs = new Date(m[1] + "-" + m[2] + "-" + m[3] + "T" + m[4] + ":" + m[5] + ":" + (m[6] || "00") + "Z").getTime();
    return utcMs + jnl_etOffsetMs(m[1] + "-" + m[2] + "-" + m[3]);
  }
  m = combined.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    var mm = m[1].padStart(2, "0"), dd = m[2].padStart(2, "0"), yr = m[3];
    var utcMs = new Date(yr + "-" + mm + "-" + dd + "T" + m[4] + ":" + m[5] + ":" + (m[6] || "00") + "Z").getTime();
    return utcMs + jnl_etOffsetMs(yr + "-" + mm + "-" + dd);
  }
  return null;
}

function jnl_parseTv(lines, headers) {
  var hIdx = {};
  headers.forEach(function(h, i) {
    hIdx[h.toLowerCase()] = i;
  });
  var fills = [];
  for (var i = 1; i < lines.length; i++) {
    var cols = jnl_parseCsvLine(lines[i]);
    if (cols.length < 4) continue;
    var dateStr = cols[hIdx["date"]] || "";
    var ticker = (cols[hIdx["symbol"]] || "").toUpperCase().trim();
    var side = (cols[hIdx["side"]] || "").trim().toLowerCase();
    var qty = parseFloat(cols[hIdx["qty"]]) || 0;
    var price = parseFloat(cols[hIdx["price"]]) || 0;
    var comm = parseFloat(cols[hIdx["commission"]]) || 0;
    if (!ticker || !dateStr || !qty || !price) continue;
    var ts = jnl_parseDateTime(dateStr, "");
    if (!ts) continue;
    fills.push({
      ticker: ticker,
      ts: ts,
      side: side,
      shares: qty,
      price: price,
      commission: comm
    });
  }
  return fills;
}

function jnl_parseTtp(lines, headers) {
  var hIdx = {};
  headers.forEach(function(h, i) {
    hIdx[h.toLowerCase().replace(/[^a-z]/g, "")] = i;
  });
  var colDate = hIdx["date"];
  var colTime = hIdx["time"];
  var colSym = hIdx["symbol"] !== undefined ? hIdx["symbol"] : hIdx["sym"];
  var colAction = hIdx["action"];
  var colSide = hIdx["side"];
  var colShares = hIdx["shares"];
  var colPrice = hIdx["price"];
  var colComm = hIdx["commission"];
  var fills = [];
  for (var i = 1; i < lines.length; i++) {
    var cols = jnl_parseCsvLine(lines[i]);
    if (cols.length < 5) continue;
    var dateStr = colDate !== undefined ? cols[colDate] : "";
    var timeStr = colTime !== undefined ? cols[colTime] : "";
    var ticker = colSym !== undefined ? (cols[colSym] || "").toUpperCase().trim() : "";
    var action = colAction !== undefined ? (cols[colAction] || "").toLowerCase() : "";
    var sideRaw = colSide !== undefined ? (cols[colSide] || "").toLowerCase() : "";
    var shares = parseFloat(colShares !== undefined ? cols[colShares] : 0) || 0;
    var price = parseFloat(colPrice !== undefined ? cols[colPrice] : 0) || 0;
    var comm = parseFloat(colComm !== undefined ? cols[colComm] : 0) || 0;
    if (!ticker || !dateStr || !shares || !price) continue;
    var ts = jnl_parseDateTime(dateStr, timeStr);
    if (!ts) continue;
    var side = action === "open" || action === "entry" ? sideRaw === "short" ? "sell_short" : "buy" : sideRaw === "short" ? "buy_cover" : "sell";
    fills.push({
      ticker: ticker,
      ts: ts,
      side: side,
      shares: shares,
      price: price,
      commission: comm
    });
  }
  return fills;
}

function jnl_parseTtpOrders(lines, headers, delim) {
  var hIdx = {};
  headers.forEach(function(h, i) {
    hIdx[h.toLowerCase().replace(/[^a-z]/g, "")] = i;
  });
  var cDt = hIdx["datetime"], cSym = hIdx["symbol"], cSide = hIdx["side"], cType = hIdx["type"];
  var cPrice = hIdx["price"], cStop = hIdx["stopprice"], cQty = hIdx["quantity"], cEvent = hIdx["event"];
  var cAcct = hIdx["account"];
  function num(s) {
    var v = parseFloat(String(s == null ? "" : s).replace(/,/g, ""));
    return isNaN(v) ? 0 : v;
  }
  var dayFirst = true;
  for (var i = 1; i < lines.length; i++) {
    var m0 = lines[i].match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m0) continue;
    if (parseInt(m0[1], 10) > 12) {
      dayFirst = true;
      break;
    }
    if (parseInt(m0[2], 10) > 12) {
      dayFirst = false;
      break;
    }
  }
  function parseDt(s) {
    var m = (s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
    if (!m) return null;
    var dd = dayFirst ? m[1] : m[2], mm = dayFirst ? m[2] : m[1];
    var h = parseInt(m[4], 10);
    var ap = (m[7] || "").toUpperCase();
    if (ap === "PM" && h < 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    var iso = m[3] + "-" + mm.padStart(2, "0") + "-" + dd.padStart(2, "0");
    var utcMs = new Date(iso + "T" + String(h).padStart(2, "0") + ":" + m[5] + ":" + (m[6] || "00") + "Z").getTime();
    return utcMs + jnl_etOffsetMs(iso);
  }
  var raw = [];
  for (var r = 1; r < lines.length; r++) {
    var cols = jnl_parseCsvLine(lines[r], delim);
    if (cols.length < 10) continue;
    if ((cols[cEvent] || "").trim().toLowerCase() !== "filled") continue;
    var ticker = (cols[cSym] || "").toUpperCase().trim();
    var sideRaw = (cols[cSide] || "").trim().toLowerCase();
    var shares = num(cols[cQty]);
    var price = num(cols[cPrice]) || num(cols[cStop]);
    var ts = parseDt(cols[cDt]);
    if (!ticker || !shares || !price || !ts || sideRaw !== "buy" && sideRaw !== "sell") continue;
    var acct = cAcct !== undefined ? (cols[cAcct] || "").trim() : "";
    raw.push({
      ticker: ticker,
      ts: ts,
      sideRaw: sideRaw,
      shares: shares,
      price: price,
      account: acct || null
    });
  }
  raw.sort(function(a, b) {
    return a.ts - b.ts;
  });
  var net = {};
  return raw.map(function(f) {
    var n = net[f.ticker] || 0;
    var side = f.sideRaw === "buy" ? n < 0 ? "buy_cover" : "buy" : n > 0 ? "sell" : "sell_short";
    net[f.ticker] = n + (f.sideRaw === "buy" ? f.shares : -f.shares);
    return {
      ticker: f.ticker,
      ts: f.ts,
      side: side,
      shares: f.shares,
      price: f.price,
      commission: 0,
      account: f.account
    };
  });
}

function jnl_parseTvJournal(lines) {
  var execs = [], calls = [], modConfirms = [], modPosEvents = [], posDirs = [];
  var activatedIds = {}, manualIds = {};
  function tick(s) {
    return s.replace(/^.*:/, "").toUpperCase();
  }
  function localTs(str) {
    var m = (str || "").match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
    return m ? new Date(m[1] + "-" + m[2] + "-" + m[3] + "T" + m[4] + ":" + m[5] + ":" + (m[6] || "00")).getTime() : null;
  }
  for (var i = 1; i < lines.length; i++) {
    var cols = jnl_parseCsvLine(lines[i]);
    if (cols.length < 2) continue;
    var ts = localTs(cols[0]);
    if (!ts) continue;
    var text = cols.slice(1).join(",");
    var m = text.match(/Order\s+(\d+)\s+for symbol\s+(\S+)\s+has been executed at price\s+([\d.]+)\s+for\s+([\d.]+)\s+units/i);
    if (m) {
      execs.push({
        ts: ts,
        seq: lines.length - i,
        orderId: m[1],
        ticker: tick(m[2]),
        price: parseFloat(m[3]),
        units: parseFloat(m[4])
      });
      continue;
    }
    m = text.match(/Call to place market order to (buy|sell)\s+([\d.]+)\s+units of symbol\s+(\S+)/i);
    if (m) {
      calls.push({
        ts: ts,
        side: m[1].toLowerCase(),
        units: parseFloat(m[2]),
        ticker: tick(m[3]),
        used: false
      });
      continue;
    }
    m = text.match(/Order\s+(\d+)\s+activated at price/i);
    if (m) {
      activatedIds[m[1]] = true;
      continue;
    }
    m = text.match(/Modified order\s+(\d+)\s+for symbol/i);
    if (m) {
      manualIds[m[1]] = true;
      continue;
    }
    m = text.match(/Order\s+(\d+)\s+modification confirmed/i);
    if (m) {
      modConfirms.push({
        ts: ts,
        id: m[1]
      });
      continue;
    }
    m = text.match(/Modify position for symbol\s+(\S+)\s+with SL\s+([\d.]+)\s+and TP\s+([\d.]+)/i);
    if (m) {
      modPosEvents.push(ts);
      posDirs.push({
        ts: ts,
        ticker: tick(m[1]),
        dir: parseFloat(m[2]) > parseFloat(m[3]) ? "short" : "long"
      });
    }
  }
  var bracketIds = Object.assign({}, activatedIds);
  modConfirms.forEach(function(mc) {
    if (manualIds[mc.id]) return;
    for (var p = 0; p < modPosEvents.length; p++) {
      if (Math.abs(modPosEvents[p] - mc.ts) <= 2e3) {
        bracketIds[mc.id] = true;
        return;
      }
    }
  });
  posDirs.sort(function(a, b) {
    return a.ts - b.ts;
  });
  execs.sort(function(a, b) {
    return a.ts - b.ts || a.seq - b.seq;
  });
  var netPos = {};
  var fills = [];
  execs.forEach(function(ex) {
    var side = null;
    for (var c = 0; c < calls.length; c++) {
      var cl = calls[c];
      if (!cl.used && cl.ticker === ex.ticker && cl.units === ex.units && Math.abs(cl.ts - ex.ts) <= 5e3) {
        side = cl.side;
        cl.used = true;
        break;
      }
    }
    var net = netPos[ex.ticker] || 0;
    if (!side && !bracketIds[ex.orderId]) {
      var after = null;
      for (var p2 = 0; p2 < posDirs.length; p2++) {
        if (posDirs[p2].ticker === ex.ticker && posDirs[p2].ts >= ex.ts) {
          after = posDirs[p2].dir;
          break;
        }
      }
      if (after) {
        var sellMatches = net - ex.units < 0 === (after === "short");
        var buyMatches = net + ex.units < 0 === (after === "short");
        if (sellMatches !== buyMatches) side = sellMatches ? "sell" : "buy";
      }
    }
    if (!side) side = net > 0 ? "sell" : net < 0 ? "buy" : null;
    if (!side) return;
    netPos[ex.ticker] = net + (side === "buy" ? ex.units : -ex.units);
    var fillSide = side === "buy" ? net < 0 ? "buy_cover" : "buy" : net > 0 ? "sell" : "sell_short";
    fills.push({
      ticker: ex.ticker,
      ts: ex.ts,
      side: fillSide,
      shares: ex.units,
      price: ex.price,
      commission: 0
    });
  });
  return fills;
}

function jnl_parseCSV(raw) {
  raw = String(raw == null ? "" : raw).replace(/^﻿/, "");
  var lines = raw.split(/\r?\n/).filter(function(l) {
    return l.trim().length > 0;
  });
  if (lines.length < 2) return {
    error: "CSV has fewer than 2 lines",
    fills: []
  };
  var delim = lines[0].split(";").length > lines[0].split(",").length ? ";" : ",";
  var headers = jnl_parseCsvLine(lines[0], delim);
  var fmt = jnl_detectFormat(headers);
  if (!fmt) return {
    error: "Could not detect format. Expected TradingView trade log, TradingView journal, or Trade the Pool CSV.",
    fills: []
  };
  var fills = fmt === "tv" ? jnl_parseTv(lines, headers) : fmt === "tvjournal" ? jnl_parseTvJournal(lines) : fmt === "ttporders" ? jnl_parseTtpOrders(lines, headers, delim) : jnl_parseTtp(lines, headers);
  return {
    format: fmt,
    fills: fills,
    error: fills.length === 0 ? "No valid fills found" : null
  };
}

var JNL_FUTURES_MULT = {
  MNQ: 2,
  NQ: 20,
  MES: 5,
  ES: 50,
  MYM: .5,
  YM: 5,
  M2K: 5,
  RTY: 50,
  MGC: 10,
  GC: 100,
  MCL: 100,
  CL: 1e3
};

function jnl_futuresMultiplier(ticker) {
  var m = (ticker || "").match(/^([A-Z0-9]+?)\d*!$/);
  return m && JNL_FUTURES_MULT[m[1]] || 1;
}

function jnl_yahooSymbol(ticker) {
  var m = (ticker || "").match(/^([A-Z0-9]+?)\d*!$/);
  return m ? m[1] + "=F" : ticker;
}

function jnl_normAccount(s) {
  if (s == null) return null;
  var t = String(s).replace(/\s+/g, " ").trim().toUpperCase();
  return t || null;
}

function jnl_matchFills(fills, meta) {
  meta = meta || {};
  var groups = {};
  fills.forEach(function(f) {
    var off = jnl_etOffsetMs(new Date(f.ts).toISOString().slice(0, 10));
    var d = new Date(f.ts - off);
    var key = f.ticker + "|" + d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
    if (!groups[key]) groups[key] = {
      ticker: f.ticker,
      date: key.split("|")[1],
      fills: []
    };
    groups[key].fills.push(f);
  });
  var trades = [];
  var orphanExits = [];
  Object.values(groups).forEach(function(g) {
    g.fills.sort(function(a, b) {
      return a.ts - b.ts;
    });
    var side = "long";
    var firstSide = g.fills[0].side;
    if (firstSide === "sell_short" || firstSide === "short") side = "short";
    var entryFills = g.fills.filter(function(f) {
      return side === "long" ? f.side === "buy" || f.side === "long" || f.side === "buy_long" : f.side === "sell_short" || f.side === "short" || f.side === "sell short";
    });
    var exitFills = g.fills.filter(function(f) {
      return side === "long" ? f.side === "sell" || f.side === "sell_long" : f.side === "buy_cover" || f.side === "buy" || f.side === "cover";
    });
    if (!entryFills.length) {
      orphanExits.push({
        ticker: g.ticker,
        date: g.date,
        fills: exitFills.length || g.fills.length
      });
      return;
    }
    var entryShares = entryFills.reduce(function(s, f) {
      return s + f.shares;
    }, 0);
    var entryValue = entryFills.reduce(function(s, f) {
      return s + f.shares * f.price;
    }, 0);
    var entryPrice = entryShares > 0 ? entryValue / entryShares : 0;
    var entryTs = entryFills[0].ts;
    var entryComm = entryFills.reduce(function(s, f) {
      return s + f.commission;
    }, 0);
    var exitShares = exitFills.reduce(function(s, f) {
      return s + f.shares;
    }, 0);
    var exitValue = exitFills.reduce(function(s, f) {
      return s + f.shares * f.price;
    }, 0);
    var exitPrice = exitShares > 0 ? exitValue / exitShares : 0;
    var exitTs = exitFills.length ? exitFills[exitFills.length - 1].ts : null;
    var exitComm = exitFills.reduce(function(s, f) {
      return s + f.commission;
    }, 0);
    var closedShares = Math.min(entryShares, exitShares);
    var ptValue = jnl_futuresMultiplier(g.ticker);
    var grossPnl = exitTs ? (side === "long" ? (exitPrice - entryPrice) * closedShares : (entryPrice - exitPrice) * closedShares) * ptValue : null;
    var totalComm = entryComm + exitComm;
    var netPnl = grossPnl !== null ? grossPnl - totalComm : null;
    var pctMove = entryPrice > 0 && exitTs ? (exitPrice - entryPrice) / entryPrice * 100 * (side === "short" ? -1 : 1) : null;
    var durationMs = exitTs ? exitTs - entryTs : null;
    var fillAcct = null;
    for (var fa = 0; fa < g.fills.length && !fillAcct; fa++) {
      if (g.fills[fa].account) fillAcct = g.fills[fa].account;
    }
    trades.push({
      id: g.ticker + "|" + g.date + "|" + entryTs,
      ticker: g.ticker,
      date: g.date,
      side: side,
      account: jnl_normAccount(fillAcct || meta.accountLabel),
      source: meta.source || null,
      entryTs: entryTs,
      exitTs: exitTs,
      entryPrice: entryPrice,
      exitPrice: exitTs ? exitPrice : null,
      shares: entryShares,
      closedShares: closedShares,
      grossPnl: grossPnl,
      netPnl: netPnl,
      pctMove: pctMove,
      totalComm: totalComm,
      csvComm: totalComm,
      durationMs: durationMs,
      entryFills: entryFills,
      exitFills: exitFills,
      open: !exitTs || exitShares < entryShares * .995
    });
  });
  trades.sort(function(a, b) {
    return b.entryTs - a.entryTs;
  });
  trades.orphanExits = orphanExits;
  return trades;
}

var __jnlFeeProfiles = {};

function jnl_loadFeeProfiles(cb) {
  chrome.storage.local.get([ "smb_jnl_fee_profiles" ], function(d) {
    try {
      __jnlFeeProfiles = d.smb_jnl_fee_profiles ? JSON.parse(d.smb_jnl_fee_profiles) : {};
    } catch (_) {
      __jnlFeeProfiles = {};
    }
    if (cb) cb();
  });
}

function jnl_saveFeeProfiles() {
  try {
    chrome.storage.local.set({
      smb_jnl_fee_profiles: JSON.stringify(__jnlFeeProfiles)
    });
  } catch (_) {}
}

function jnl_feeProfileFor(account) {
  if (account && __jnlFeeProfiles[account]) return __jnlFeeProfiles[account];
  return __jnlFeeProfiles["*"] || null;
}

function jnl_computeFees(trade, profile) {
  if (!profile || !Array.isArray(profile.rules) || !profile.rules.length) return {
    total: 0,
    parts: []
  };
  var pt = jnl_futuresMultiplier(trade.ticker);
  var parts = [];
  function clamp(v, rule) {
    if (rule.minPerOrder != null && v < rule.minPerOrder) v = rule.minPerOrder;
    if (rule.maxPerOrder != null && rule.maxPerOrder > 0 && v > rule.maxPerOrder) v = rule.maxPerOrder;
    return v;
  }
  profile.rules.forEach(function(rule) {
    var rate = Number(rule.rate);
    if (!isFinite(rate) || rate === 0) return;
    var sides = [];
    if (rule.side !== "exit") sides.push(trade.entryFills || []);
    if (rule.side !== "entry") sides.push(trade.exitFills || []);
    var amt = 0;
    if (rule.basis === "trade") {
      if (rule.side === "both") amt = rate; else sides.forEach(function(fl) {
        if (fl.length) amt += rate;
      });
    } else {
      sides.forEach(function(fl) {
        fl.forEach(function(f) {
          if (rule.basis === "share") amt += clamp(rate * (f.shares || 0), rule); else if (rule.basis === "order") amt += rate; else if (rule.basis === "pct") amt += clamp(rate / 100 * (f.price || 0) * (f.shares || 0) * pt, rule);
        });
      });
    }
    if (amt > 0) {
      var lbl = {
        share: "$" + rate + "/sh",
        order: "$" + rate + "/order",
        trade: "$" + rate + "/trade",
        pct: rate + "% notional"
      }[rule.basis] || rule.basis;
      if (rule.side !== "both") lbl += " (" + rule.side + ")";
      parts.push({
        label: lbl,
        amount: Math.round(amt * 100) / 100
      });
    }
  });
  var total = parts.reduce(function(s, p) {
    return s + p.amount;
  }, 0);
  return {
    total: Math.round(total * 100) / 100,
    parts: parts
  };
}

function jnl_applyFeeProfile(trade) {
  if (trade.csvComm == null) trade.csvComm = trade.totalComm || 0;
  var profile = jnl_feeProfileFor(trade.account);
  var hasFills = (trade.entryFills || []).length || (trade.exitFills || []).length;
  if (!hasFills) profile = null;
  if (!profile || !Array.isArray(profile.rules) || !profile.rules.length) {
    trade.totalComm = trade.csvComm;
    trade.commSource = "csv";
  } else {
    var fees = jnl_computeFees(trade, profile).total;
    if (profile.mode === "add") {
      trade.totalComm = Math.round((trade.csvComm + fees) * 100) / 100;
      trade.commSource = "csv+profile";
    } else {
      trade.totalComm = fees;
      trade.commSource = "profile";
    }
  }
  trade.netPnl = !trade.open && trade.grossPnl != null ? trade.grossPnl - trade.totalComm : trade.open ? null : trade.netPnl;
  return trade;
}

function jnl_recalcAllFees() {
  var matched = 0;
  (__jnlTrades || []).forEach(function(t) {
    jnl_applyFeeProfile(t);
    if (t.commSource && t.commSource !== "csv") matched++;
  });
  jnl_save(__jnlTrades);
  return {
    total: (__jnlTrades || []).length,
    matched: matched
  };
}

function jnl_feeEditorRules() {
  var out = [];
  document.querySelectorAll(".jnl-fee-rule").forEach(function(row) {
    var g = function(cls) {
      return row.querySelector("." + cls);
    };
    var basis = g("jnl-fee-basis") ? g("jnl-fee-basis").value : "share";
    var rate = parseFloat(g("jnl-fee-rate") ? g("jnl-fee-rate").value : "");
    var side = g("jnl-fee-side") ? g("jnl-fee-side").value : "both";
    var min = parseFloat(g("jnl-fee-min") ? g("jnl-fee-min").value : "");
    var max = parseFloat(g("jnl-fee-max") ? g("jnl-fee-max").value : "");
    if (!isFinite(rate) || rate <= 0) return;
    out.push({
      basis: basis,
      rate: rate,
      side: side,
      minPerOrder: isFinite(min) && min > 0 ? min : null,
      maxPerOrder: isFinite(max) && max > 0 ? max : null
    });
  });
  return out;
}

function jnl_feeRenderRules(rules) {
  var box = document.getElementById("jnl-fee-rules");
  if (!box) return;
  var selStyle = "background:#0f172a;border:1px solid #334155;border-radius:4px;color:#e2e8f0;font-size:11px;padding:4px 6px";
  var numStyle = selStyle + ";width:64px";
  function opt(v, label, cur) {
    return '<option value="' + v + '"' + (v === cur ? " selected" : "") + ">" + label + "</option>";
  }
  box.innerHTML = (rules || []).map(function(r, i) {
    return '<div class="jnl-fee-rule" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:4px">' + '<select class="jnl-fee-basis" style="' + selStyle + '">' + opt("share", "$ / share", r.basis) + opt("order", "$ / order", r.basis) + opt("trade", "$ / position", r.basis) + opt("pct", "% of value", r.basis) + "</select>" + '<input class="jnl-fee-rate" type="number" step="0.0001" min="0" placeholder="rate" value="' + (r.rate != null ? r.rate : "") + '" style="' + numStyle + '">' + '<select class="jnl-fee-side" style="' + selStyle + '">' + opt("both", "both sides", r.side) + opt("entry", "entry only", r.side) + opt("exit", "exit only", r.side) + "</select>" + '<input class="jnl-fee-min" type="number" step="0.01" min="0" placeholder="min/ord" title="Minimum per order (optional)" value="' + (r.minPerOrder != null ? r.minPerOrder : "") + '" style="' + numStyle + '">' + '<input class="jnl-fee-max" type="number" step="0.01" min="0" placeholder="max/ord" title="Maximum per order (optional)" value="' + (r.maxPerOrder != null ? r.maxPerOrder : "") + '" style="' + numStyle + '">' + '<button class="jnl-fee-del" data-idx="' + i + '" title="Remove rule" style="background:#1e1e2e;color:#64748b;border:1px solid #334155;border-radius:4px;font-size:11px;padding:4px 8px;cursor:pointer">✕</button>' + "</div>";
  }).join("") || '<div style="font-size:11px;color:#475569;padding:4px 0">No rules — this account uses CSV commissions as-is.</div>';
  box.querySelectorAll(".jnl-fee-del").forEach(function(b) {
    b.addEventListener("click", function() {
      var cur = jnl_feeEditorRules();
      cur.splice(parseInt(b.getAttribute("data-idx"), 10), 1);
      jnl_feeRenderRules(cur);
    });
  });
}

function jnl_feeLoadIntoEditor(account) {
  var p = __jnlFeeProfiles[account] || null;
  var modeEl = document.getElementById("jnl-fee-mode");
  if (modeEl) modeEl.value = p && p.mode || "replace";
  jnl_feeRenderRules(p ? p.rules : []);
}

function jnl_feePopulateAccounts() {
  var sel = document.getElementById("jnl-fee-account");
  if (!sel) return;
  var cur = sel.value || "*";
  var names = {};
  (__jnlTrades || []).forEach(function(t) {
    if (t.account) names[t.account] = true;
  });
  Object.keys(__jnlFeeProfiles || {}).forEach(function(k) {
    if (k !== "*") names[k] = true;
  });
  sel.innerHTML = '<option value="*">* All accounts (default)</option>' + Object.keys(names).sort().map(function(a) {
    return '<option value="' + htmlEscape(a) + '">' + htmlEscape(a) + (__jnlFeeProfiles[a] ? " ✓" : "") + "</option>";
  }).join("");
  sel.value = names[cur] || cur === "*" ? cur : "*";
}

function jnl_feeInitUI() {
  var sel = document.getElementById("jnl-fee-account");
  var addBtn = document.getElementById("jnl-fee-add-rule");
  var saveBtn = document.getElementById("jnl-fee-save");
  var recalcBtn = document.getElementById("jnl-fee-recalc");
  var msg = document.getElementById("jnl-fee-msg");
  function say(t, ok) {
    if (msg) {
      msg.textContent = t;
      msg.style.color = ok ? "#22c55e" : "#f59e0b";
    }
  }
  jnl_feePopulateAccounts();
  jnl_feeLoadIntoEditor(sel ? sel.value : "*");
  if (sel) sel.addEventListener("change", function() {
    jnl_feeLoadIntoEditor(sel.value);
  });
  if (addBtn) addBtn.addEventListener("click", function() {
    var cur = jnl_feeEditorRules();
    cur.push({
      basis: "share",
      rate: "",
      side: "both",
      minPerOrder: null,
      maxPerOrder: null
    });
    jnl_feeRenderRules(cur);
  });
  if (saveBtn) saveBtn.addEventListener("click", function() {
    var account = sel ? sel.value : "*";
    var rules = jnl_feeEditorRules();
    var modeEl = document.getElementById("jnl-fee-mode");
    if (rules.length) {
      __jnlFeeProfiles[account] = {
        mode: modeEl && modeEl.value || "replace",
        rules: rules
      };
      say("✓ Profile saved for " + (account === "*" ? "all accounts" : account) + " (" + rules.length + " rule" + (rules.length !== 1 ? "s" : "") + "). Hit ♻ Recalculate to apply to existing trades.", true);
    } else {
      delete __jnlFeeProfiles[account];
      say("Profile removed for " + (account === "*" ? "all accounts" : account) + " — CSV commissions will be used.", true);
    }
    jnl_saveFeeProfiles();
    jnl_feePopulateAccounts();
  });
  if (recalcBtn) recalcBtn.addEventListener("click", function() {
    var r = jnl_recalcAllFees();
    say("♻ Recalculated " + r.total + " trade" + (r.total !== 1 ? "s" : "") + " · " + r.matched + " matched a fee profile.", true);
    try {
      jnl_renderList();
    } catch (_) {}
    try {
      jnl_renderStatsBar(jnl_scopedTrades());
    } catch (_) {}
  });
}

function jnl_fmt$(v) {
  if (v === null || v === undefined) return "—";
  var abs = Math.abs(v);
  var s = abs >= 1e3 ? abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }) : abs.toFixed(2);
  return (v < 0 ? "-$" : "$") + s;
}

function jnl_fmtPct(v) {
  if (v === null || v === undefined) return "—";
  return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
}

function jnl_fmtDur(ms) {
  if (!ms) return "—";
  var s = Math.floor(ms / 1e3);
  var m = Math.floor(s / 60);
  s %= 60;
  var h = Math.floor(m / 60);
  m %= 60;
  if (h) return h + "h " + m + "m";
  if (m) return m + "m " + s + "s";
  return s + "s";
}

function jnl_fmtTime(ts) {
  if (!ts) return "—";
  var d = new Date(ts);
  return d.getUTCHours().toString().padStart(2, "0") + ":" + d.getUTCMinutes().toString().padStart(2, "0");
}

function jnl_computeChecklist(snap, trade) {
  if (!snap) return {
    items: [],
    pass: 0,
    total: 0
  };
  var isLong = trade.side === "long";
  var items = [], pass = 0, total = 0;
  function push(o) {
    if (o.scored !== false && o.good !== null && o.good !== undefined) {
      total++;
      if (o.good) pass++;
    }
    items.push({
      key: o.key,
      section: o.section,
      label: o.label,
      nlabel: o.nlabel || o.label,
      good: o.good === undefined ? null : o.good,
      val: o.val != null ? o.val : null,
      valStr: o.valStr != null ? o.valStr : o.val != null && !isNaN(o.val) ? "$" + o.val.toFixed(2) : null,
      pct: o.pct != null && !isNaN(o.pct) ? o.pct : null,
      isSlope: !!o.isSlope,
      extra: o.extra || null,
      scored: o.scored !== false
    });
  }
  function aboveGood(pct) {
    if (pct == null || isNaN(pct)) return null;
    return Math.abs(pct) <= .05 ? true : pct > 0 === isLong;
  }
  function slopeGood(s) {
    if (!s || !s.s5 || Math.abs(s.s5.signal) < .005) return null;
    return s.s5.signal > 0 === isLong;
  }
  function slopeDir(s) {
    if (!s || !s.s5) return "—";
    return s.s5.signal > .005 ? "↗ up" : s.s5.signal < -.005 ? "↘ down" : "→ flat";
  }
  var ab = isLong ? "Above" : "Below";
  var sl = isLong ? "up" : "down";
  function level(key, section, name, val, pct, nname) {
    if (val == null) return;
    push({
      key: key,
      section: section,
      label: ab + " " + name,
      nlabel: (nname || name) + " aligned",
      good: aboveGood(pct),
      val: val,
      pct: pct
    });
  }
  function slopeItem(key, section, name, s) {
    push({
      key: key,
      section: section,
      label: name + " sloping " + sl,
      nlabel: name + " slope aligned",
      good: slopeGood(s),
      valStr: slopeDir(s),
      isSlope: true
    });
  }
  var S1 = "Moving Averages";
  level("ma5d", S1, "5d MA", snap.sma5dVal, snap.priceRel5dMa);
  level("sma9", S1, "SMA 9", snap.sma9Val, snap.priceRelSma9);
  level("sma13", S1, "SMA 13", snap.sma13Val, snap.priceRelSma13);
  level("sma20", S1, "SMA 20", snap.sma20Val, snap.priceRelSma20);
  level("ema20", S1, "EMA 20", snap.ema20Val, snap.priceRelEma20);
  slopeItem("ema20_slope", S1, "EMA 20", snap.slopeEma20);
  level("ema13", S1, "EMA 13", snap.ema13Val, snap.priceRelEma13);
  slopeItem("ema13_slope", S1, "EMA 13", snap.slopeEma13);
  level("ema9", S1, "EMA 9", snap.ema9Val, snap.priceRelEma9);
  slopeItem("ema9_slope", S1, "EMA 9", snap.slopeEma9);
  if (snap.ema13AboveEma20 != null) push({
    key: "ema_stack_1320",
    section: S1,
    label: "EMA 13 " + (isLong ? "above" : "below") + " EMA 20",
    nlabel: "EMA 13/20 stacked",
    good: snap.ema13AboveEma20 === isLong
  });
  if (snap.ema9AboveEma13 != null) push({
    key: "ema_stack_913",
    section: S1,
    label: "EMA 9 " + (isLong ? "above" : "below") + " EMA 13",
    nlabel: "EMA 9/13 stacked",
    good: snap.ema9AboveEma13 === isLong
  });
  var S2 = "VWAPs";
  level("vwap", S2, "Session VWAP", snap.vwapVal, snap.priceRelVwap);
  slopeItem("vwap_slope", S2, "Session VWAP", snap.slopeVwap);
  if (snap.twoDVwapVal != null) {
    level("vwap2d", S2, "2-Day VWAP", snap.twoDVwapVal, snap.priceRelTwoDVwap);
    slopeItem("vwap2d_slope", S2, "2-Day VWAP", snap.slopeTwoDVwap);
  }
  level("vwapW", S2, "Weekly VWAP", snap.wVwapVal, snap.priceRelWVwap);
  slopeItem("vwapW_slope", S2, "Weekly VWAP", snap.slopeWVwap);
  level("vwapM", S2, "Monthly VWAP", snap.mVwapVal, snap.priceRelMVwap);
  var S3 = "Anchored VWAPs";
  level("vwapHH", S3, "HH AVWAP", snap.vwapHHVal, snap.priceRelVwapHH);
  level("vwapLL", S3, "LL AVWAP", snap.vwapLLVal, snap.priceRelVwapLL);
  level("weekHH", S3, "Week HH VWAP", snap.weekHHVal, snap.priceRelWeekHH);
  level("weekLL", S3, "Week LL VWAP", snap.weekLLVal, snap.priceRelWeekLL);
  level("gapVwap", S3, "Gap VWAP", snap.gapVwapVal, snap.priceRelGapVwap);
  level("lhLL", S3, "Last-hr LL VWAP", snap.lhLLVal, snap.priceRelLhLL);
  level("lhHH", S3, "Last-hr HH VWAP", snap.lhHHVal, snap.priceRelLhHH);
  var S4 = "VWAP Clusters";
  if (snap.clusterAVal != null) push({
    key: "clusterA",
    section: S4,
    label: ab + " Cluster A",
    nlabel: "Cluster A aligned",
    good: aboveGood(snap.priceRelClusterA),
    val: snap.clusterAVal,
    pct: snap.priceRelClusterA,
    extra: snap.clusterANames ? "[" + snap.clusterANames + "]" : null
  });
  if (snap.clusterBVal != null) push({
    key: "clusterB",
    section: S4,
    label: ab + " Cluster B",
    nlabel: "Cluster B aligned",
    good: aboveGood(snap.priceRelClusterB),
    val: snap.clusterBVal,
    pct: snap.priceRelClusterB,
    extra: snap.clusterBNames ? "[" + snap.clusterBNames + "]" : null
  });
  var S5 = "Bollinger Bands (20,2)";
  if (snap.bbPositionPct != null) {
    var bbGood = isLong ? snap.bbPositionPct >= 70 : snap.bbPositionPct <= 30;
    var bbPosLabel = snap.bbPositionPct < 0 ? "below lower band" : snap.bbPositionPct > 100 ? "above upper band" : snap.bbPositionPct.toFixed(0) + "% of band";
    push({
      key: "bb_zone",
      section: S5,
      label: isLong ? "BB upper zone (≥70%)" : "BB lower zone (≤30%)",
      nlabel: "BB zone aligned",
      good: bbGood,
      valStr: bbPosLabel,
      extra: "Upper " + (snap.bbUpperVal != null ? "$" + snap.bbUpperVal.toFixed(2) : "—") + " · Lower " + (snap.bbLowerVal != null ? "$" + snap.bbLowerVal.toFixed(2) : "—") + " · Width " + (snap.bbBandwidthPct != null ? snap.bbBandwidthPct.toFixed(1) + "%" : "—") + " " + slopeDir(snap.slopeBbWidth)
    });
  }
  var S6 = "VWAP σ Band & Session";
  if (snap.snapshotVersion >= 2) {
    var bandVal = isLong ? snap.vwapSigmaUpVal : snap.vwapSigmaDnVal;
    var bandPct = isLong ? snap.priceRelSigmaUp : snap.priceRelSigmaDn;
    if (bandVal != null) push({
      key: "sigma_band",
      section: S6,
      label: isLong ? "Above VWAP +0.8σ band" : "Below VWAP −0.8σ band",
      nlabel: "VWAP σ band aligned",
      good: snap.bzVwapBandOK,
      val: bandVal,
      pct: bandPct,
      extra: "σ " + (snap.vwapStdevVal != null ? "$" + snap.vwapStdevVal.toFixed(3) : "—")
    });
    push({
      key: "bz_zone",
      section: S6,
      label: "Bodies out of " + (isLong ? "red (lower)" : "green (upper)") + " BB zone",
      nlabel: "BB opposing zone clear",
      good: snap.bzZoneOK
    });
    push({
      key: "session_window",
      section: S6,
      label: "Inside 9:30–13:00 ET window",
      nlabel: "Inside session window",
      good: snap.bzSessionOK
    });
    if (isLong && snap.l3SlopeScore != null) push({
      key: "l3_slope",
      section: S6,
      label: "VWAP slope score ≥ 2",
      nlabel: "VWAP slope score ≥ 2",
      good: snap.l3SlopeScore >= 2,
      valStr: String(snap.l3SlopeScore)
    });
    if (isLong) push({
      key: "l3_bias",
      section: S6,
      label: "L3 long bias (all 3 VWAPs + BB EMA)",
      nlabel: "L3 bias aligned",
      good: snap.l3Bias
    });
    if (snap.atr14Val != null) push({
      key: "atr14",
      section: S6,
      label: "ATR(14)",
      nlabel: "ATR(14)",
      good: null,
      scored: false,
      valStr: "$" + snap.atr14Val.toFixed(3)
    });
  }
  var S7 = "Key Levels";
  if (snap.pmHighVal) push({
    key: "pmHigh",
    section: S7,
    label: isLong ? "Above PM High (breakout)" : "Below PM High (resistance)",
    nlabel: "PM High aligned",
    good: aboveGood(snap.priceRelPmHigh),
    val: snap.pmHighVal,
    pct: snap.priceRelPmHigh
  });
  if (snap.pmLowVal) push({
    key: "pmLow",
    section: S7,
    label: isLong ? "Above PM Low (support)" : "Below PM Low (breakdown)",
    nlabel: "PM Low aligned",
    good: aboveGood(snap.priceRelPmLow),
    val: snap.pmLowVal,
    pct: snap.priceRelPmLow
  });
  if (snap.ahHighVal) push({
    key: "ahHigh",
    section: S7,
    label: isLong ? "Above AH High (breakout)" : "Below AH High (resistance)",
    nlabel: "AH High aligned",
    good: aboveGood(snap.priceRelAhHigh),
    val: snap.ahHighVal,
    pct: snap.priceRelAhHigh
  });
  if (snap.ahLowVal) push({
    key: "ahLow",
    section: S7,
    label: isLong ? "Above AH Low (support)" : "Below AH Low (breakdown)",
    nlabel: "AH Low aligned",
    good: aboveGood(snap.priceRelAhLow),
    val: snap.ahLowVal,
    pct: snap.priceRelAhLow
  });
  var S8 = "Volume & Context";
  if (snap.volumeRelSessionAvg != null) {
    var volGood = snap.volumeRelSessionAvg >= 1.2 ? true : snap.volumeRelSessionAvg <= .8 ? false : null;
    push({
      key: "vol_avg",
      section: S8,
      label: "Volume vs session avg",
      nlabel: "Volume vs session avg",
      good: volGood,
      valStr: snap.volumeRelSessionAvg.toFixed(1) + "×"
    });
  }
  if (snap.volumeRelPriorBar != null) push({
    key: "vol_prior",
    section: S8,
    label: "Volume vs prior bar",
    nlabel: "Volume vs prior bar",
    good: null,
    scored: false,
    valStr: snap.volumeRelPriorBar.toFixed(1) + "×"
  });
  if (snap.candlePattern && snap.candlePattern !== "other") {
    var goodPatterns = [ "hammer", "inverted_hammer", "engulfing", "doji", "momentum" ];
    push({
      key: "pattern",
      section: S8,
      label: "Candle pattern: " + snap.candlePattern,
      nlabel: "Reversal candle pattern",
      good: goodPatterns.indexOf(snap.candlePattern) >= 0,
      valStr: snap.candlePattern
    });
  }
  push({
    key: "slope_align",
    section: S8,
    label: "Slope alignment",
    nlabel: "Slope alignment",
    good: null,
    scored: false,
    valStr: (snap.slopeAlignment || 0) + "/4"
  });
  var S9 = "Setup Engines";
  var vb = snap.vwapBounce;
  if (vb && vb.checked) push({
    key: "eng_vwap_bounce",
    section: S9,
    label: "VWAP bounce confirmed (engine)",
    nlabel: "VWAP bounce confirmed",
    good: !!(vb.hard || vb.engineSignal),
    scored: false,
    valStr: vb.hard ? vb.level || "" : vb.nearZone ? "zone touch" : "—",
    extra: vb.hard ? "core " + vb.coreScore + " · extra " + vb.extraScore + (vb.engineSignal ? " · STRICT SIGNAL" : "") : null
  });
  var mt = snap.maTouch;
  if (mt && mt.checked) push({
    key: "eng_ma_touch",
    section: S9,
    label: "MA-touch bounce confirmed (engine)",
    nlabel: "MA-touch bounce confirmed",
    good: !!(mt.hard || mt.engineSignal),
    scored: false,
    valStr: mt.hard ? mt.ma || "" : mt.nearMa ? "straddle only" : "—",
    extra: mt.hard ? "zone " + (mt.zoneOK ? "✓" : "✗") + " · band " + (mt.vwapBandOK ? "✓" : "✗") + " · session " + (mt.inSession ? "✓" : "✗") + (mt.engineSignal ? " · FULL SIGNAL" : "") : null
  });
  if (isLong && snap.l3PullbackLong != null) push({
    key: "eng_l3",
    section: S9,
    label: "L3 healthy pullback (engine)",
    nlabel: "L3 healthy pullback",
    good: !!snap.l3PullbackLong,
    scored: false
  });
  return {
    items: items,
    pass: pass,
    total: total
  };
}

function jnl_renderSnapshotCard(trade) {
  var snap = trade.snapshot;
  var cl;
  if (snap) {
    cl = jnl_computeChecklist(snap, trade);
    trade.checklistRecord = cl.items;
    trade._mut = Date.now();
  } else if (trade.checklistRecord && trade.checklistRecord.length) {
    var rp = 0, rt = 0;
    trade.checklistRecord.forEach(function(it) {
      if (it.scored !== false && it.good !== null && it.good !== undefined) {
        rt++;
        if (it.good) rp++;
      }
    });
    cl = {
      items: trade.checklistRecord,
      pass: rp,
      total: rt
    };
  } else {
    return "";
  }
  trade.checklistPass = cl.pass;
  trade.checklistTotal = cl.total;
  var isLong = trade.side === "long";
  function fmtPct(v) {
    if (v == null || isNaN(v)) return "";
    return (v > 0 ? "+" : "") + v.toFixed(2) + "%";
  }
  function mark(good) {
    if (good === null || good === undefined) return '<span style="color:#334155;font-size:12px;line-height:1">·</span>';
    return good ? '<span style="color:#22c55e;font-weight:700;font-size:13px;line-height:1">✓</span>' : '<span style="color:#ef4444;font-weight:700;font-size:13px;line-height:1">✗</span>';
  }
  function sec(title) {
    return '<div style="color:#475569;font-size:9px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:8px 0 3px;margin-top:2px">' + title + "</div>";
  }
  function row(it) {
    var indent = it.isSlope ? "padding:3px 0 3px 22px;" : "padding:4px 0;";
    var lblColor = it.isSlope ? "#475569" : "#94a3b8";
    var lblSize = it.isSlope ? "10px" : "11px";
    var valStr = it.valStr ? '<span style="color:#e2e8f0;font-size:11px">' + it.valStr + "</span>" : "";
    var pctStr = it.pct != null ? '<span style="color:#475569;font-size:10px;margin-left:4px">' + fmtPct(it.pct) + "</span>" : "";
    var h = '<div style="display:flex;align-items:center;' + indent + 'border-bottom:1px solid #0f172a;gap:6px">' + '<span style="width:16px;flex-shrink:0;text-align:center">' + mark(it.good) + "</span>" + '<span style="flex:1;color:' + lblColor + ";font-size:" + lblSize + '">' + it.label + (it.isSlope ? "?" : "") + "</span>" + '<span style="flex-shrink:0">' + valStr + pctStr + "</span>" + "</div>";
    if (it.extra) {
      h += '<div style="padding:2px 0 3px 22px;font-size:10px;color:#334155;border-bottom:1px solid #0f172a">' + it.extra + "</div>";
    }
    return h;
  }
  var outcome = trade.netPnl != null ? trade.netPnl > 0 ? "✅ WIN" : trade.netPnl < 0 ? "❌ LOSS" : "⬜ B/E" : "";
  var sideLabel = isLong ? "Long" : "Short";
  var sessLine = snap ? (snap.sessionPeriod || "") + (snap.minutesFromOpen != null ? " · " + Math.round(snap.minutesFromOpen) + "m from open" : "") : "regenerated from saved record";
  var body = "";
  var lastSection = null;
  cl.items.forEach(function(it) {
    if (it.section !== lastSection) {
      body += sec(it.section);
      lastSection = it.section;
    }
    body += row(it);
  });
  return '<div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:10px 12px;margin-top:8px">' + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">' + '<span style="color:#64748b;font-size:10px;font-weight:600">📋 ENTRY CHECKLIST · ' + sideLabel.toUpperCase() + "</span>" + '<span style="font-size:12px;font-weight:700">' + outcome + "</span>" + "</div>" + '<div style="color:#334155;font-size:9px;margin-bottom:6px">' + sessLine + "</div>" + body + '<div style="margin-top:8px;display:flex;align-items:center;justify-content:space-between">' + '<span style="font-size:10px;color:#475569">Score</span>' + '<span style="font-size:13px;font-weight:700;color:' + (cl.total > 0 && cl.pass / cl.total >= .6 ? "#22c55e" : cl.total > 0 && cl.pass / cl.total >= .35 ? "#f59e0b" : "#ef4444") + '">' + cl.pass + " / " + cl.total + "</span>" + "</div>" + "</div>";
}

var __jnlWinWeights = null;

function jnl_computeWinWeights() {
  try {
    var closed = (__jnlTrades || []).filter(function(t) {
      return !t.open && t.netPnl !== null;
    });
    __jnlWinWeights = {
      long: jnl_recordCorrRows(closed.filter(function(t) {
        return t.side === "long";
      })),
      short: jnl_recordCorrRows(closed.filter(function(t) {
        return t.side === "short";
      }))
    };
  } catch (_) {
    __jnlWinWeights = null;
  }
  return __jnlWinWeights;
}

function jnl_renderWinSignalCard(trade) {
  var rec = trade.checklistRecord && trade.checklistRecord.length ? trade.checklistRecord : trade.snapshot ? jnl_computeChecklist(trade.snapshot, trade).items : null;
  if (!rec) return "";
  if (!__jnlWinWeights) jnl_computeWinWeights();
  var weights = __jnlWinWeights && __jnlWinWeights[trade.side] || [];
  if (!weights.length) return "";
  var sig = jnl_winSignal(rec, weights, {});
  if (!sig.posAvail && !sig.redFlags.length) return "";
  var col = {
    GO: "#22c55e",
    CAUTION: "#fbbf24",
    AVOID: "#ef4444",
    WAIT: "#64748b"
  }[sig.signal];
  var bg = {
    GO: "#0a2e1a",
    CAUTION: "#2e2410",
    AVOID: "#2e0f0f",
    WAIT: "#0f172a"
  }[sig.signal];
  var h = '<div class="jnl-snap-card" style="margin-top:8px;border:1px solid ' + col + "66;background:" + bg + '">';
  h += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">' + '<span style="font-size:13px;font-weight:800;color:' + col + '">🎯 ' + sig.signal + "</span>" + '<span style="font-size:10px;color:#94a3b8">' + sig.confirms.length + "/" + sig.minConfirm + " top win-checkpoints confirmed" + (sig.redFlags.length ? ' · <b style="color:#ef4444">' + sig.redFlags.length + " red flag" + (sig.redFlags.length > 1 ? "s" : "") + "</b>" : "") + " · net weight " + (sig.net >= 0 ? "+" : "") + sig.net + "</span></div>";
  function row(x, icon, c) {
    return '<div style="font-size:10px;color:' + c + '">' + icon + " " + htmlEscape(x.label) + ' <span style="color:#64748b">(' + (x.edge > 0 ? "+" : "") + x.edge + "pp · n=" + x.n + ")</span></div>";
  }
  sig.confirms.slice(0, 6).forEach(function(x) {
    h += row(x, "✓", "#86efac");
  });
  sig.redFlags.forEach(function(x) {
    h += row(x, "⚠", "#fca5a5");
  });
  if (sig.missed.length) h += '<div style="font-size:9px;color:#475569;margin-top:3px">Missing: ' + sig.missed.slice(0, 4).map(function(x) {
    return htmlEscape(x.label) + " (+" + x.edge + ")";
  }).join(", ") + "</div>";
  h += '<div style="font-size:9px;color:#475569;margin-top:3px">Weighted by your own ' + (trade.side === "long" ? "long" : "short") + "-trade history. GO = ≥" + sig.minConfirm + " confirms · no red flags · positive net.</div></div>";
  return h;
}

function jnl_renderCard(trade) {
  var isWin = trade.netPnl !== null && trade.netPnl > 0;
  var isLoss = trade.netPnl !== null && trade.netPnl < 0;
  var pnlColor = isWin ? "#22c55e" : isLoss ? "#ef4444" : "#94a3b8";
  var sideColor = trade.side === "long" ? "#22c55e" : "#f97316";
  var sideLabel = trade.side === "long" ? "▲ Long" : "▼ Short";
  var setupChip = trade.snapshot || trade.setup ? jnl_renderSetupChip(trade) : "";
  var gradeChip = jnl_renderTradeGrade(jnl_gradeTrade(trade, __jnlCorrelations));
  var qualityBar = trade.entryQuality !== null && trade.entryQuality !== undefined ? '<div style="margin-top:6px;font-size:10px;color:#475569">Entry quality: ' + jnl_renderEntryQualityBar(trade.entryQuality) + "</div>" : "";
  return '<div class="jnl-card" data-trade-id="' + trade.id + '" style="background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:12px 14px;margin-bottom:8px">' + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:4px">' + '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' + '<span style="font-size:16px;font-weight:700;color:#e2e8f0">' + trade.ticker + "</span>" + '<span style="font-size:11px;font-weight:600;color:' + sideColor + ";background:" + sideColor + '1a;padding:2px 7px;border-radius:4px">' + sideLabel + "</span>" + (trade.open ? '<span style="font-size:10px;color:#f59e0b;background:#f59e0b1a;padding:2px 6px;border-radius:4px">OPEN</span>' : "") + setupChip + gradeChip + (trade.account ? '<span style="font-size:9px;color:#93c5fd;background:#1e3a5f55;border:1px solid #1e40af66;padding:1px 6px;border-radius:3px">' + trade.account + "</span>" : "") + (trade.source ? '<span style="font-size:9px;color:#64748b;background:#1e293b;border:1px solid #334155;padding:1px 6px;border-radius:3px">' + trade.source + "</span>" : "") + "</div>" + '<div style="display:flex;align-items:center;gap:8px">' + '<span style="font-size:13px;font-weight:700;color:' + pnlColor + '">' + jnl_fmt$(trade.netPnl) + "</span>" + '<span style="font-size:11px;color:' + pnlColor + '">' + jnl_fmtPct(trade.pctMove) + "</span>" + '<button class="jnl-chart-btn btn" data-trade-id="' + trade.id + '" style="font-size:11px;padding:3px 9px;background:#1e3a5f;color:#93c5fd;border:1px solid #1e40af">📈 Chart</button>' + '<button class="jnl-del-btn" data-trade-id="' + trade.id + '" title="Delete this trade" style="font-size:11px;padding:3px 7px;background:#1e293b;color:#64748b;border:1px solid #334155;border-radius:6px;cursor:pointer">🗑</button>' + "</div>" + "</div>" + '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px 10px;font-size:11px">' + jnl_stat("Date", trade.date) + jnl_stat("Entry", trade.entryPrice ? "$" + trade.entryPrice.toFixed(2) : "—") + jnl_stat("Exit", trade.exitPrice ? "$" + trade.exitPrice.toFixed(2) : "—") + jnl_stat("Shares", trade.shares ? trade.shares.toLocaleString() : "—") + jnl_stat("In", jnl_fmtTime(trade.entryTs)) + jnl_stat("Out", jnl_fmtTime(trade.exitTs)) + jnl_stat("Duration", jnl_fmtDur(trade.durationMs)) + jnl_stat("Gross", jnl_fmt$(trade.grossPnl)) + jnl_stat("Comm" + (trade.commSource && trade.commSource !== "csv" ? " ·profile" : ""), trade.totalComm ? "-$" + trade.totalComm.toFixed(2) : "—") + jnl_stat("Net P&L", trade.netPnl !== null ? jnl_fmt$(trade.netPnl) : "—", pnlColor) + "</div>" + qualityBar + jnl_renderWinSignalCard(trade) + jnl_renderSnapshotCard(trade) + '<div id="jnl-exit-row-' + trade.id + '">' + (trade.exitAnalysis ? jnl_renderExitRow(trade.exitAnalysis, trade) : "") + "</div>" + (trade.checklistRecord && trade.checklistRecord.length ? '<button class="jnl-record-btn btn" data-trade-id="' + trade.id + '" style="margin-top:8px;font-size:10px;padding:3px 9px;background:#1e293b;color:#94a3b8;border:1px solid #334155">📋 Trade Record</button>' + '<div id="jnl-record-' + trade.id + '" style="display:none">' + jnl_renderTradeRecord(trade) + "</div>" : "") + "</div>";
}

function jnl_renderTradeRecord(trade) {
  var rec = trade.checklistRecord || [];
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  }
  function dRow(label, value) {
    return '<tr><td class="jnl-rec-lbl">' + esc(label) + '</td><td class="jnl-rec-val">' + esc(value != null && value !== "" ? value : "—") + "</td></tr>";
  }
  var ex = trade.exitAnalysis;
  var detail = '<div class="jnl-rec-sec">1 · TRADE DETAILS</div>' + '<div class="jnl-rec-wrap"><table class="jnl-rec-table">' + dRow("Ticker", trade.ticker) + dRow("Date", trade.date) + dRow("Side", trade.side) + dRow("Shares", trade.shares) + dRow("Entry price", trade.entryPrice != null ? "$" + trade.entryPrice.toFixed(2) : null) + dRow("Entry time", jnl_fmtTime(trade.entryTs)) + dRow("Exit price", trade.exitPrice != null ? "$" + trade.exitPrice.toFixed(2) : null) + dRow("Exit time", trade.exitTs ? jnl_fmtTime(trade.exitTs) : null) + dRow("Duration", jnl_fmtDur(trade.durationMs)) + dRow("Gross P&L", jnl_fmt$(trade.grossPnl)) + dRow("Commission", trade.totalComm != null ? "-$" + trade.totalComm.toFixed(2) : null) + dRow("Net P&L", jnl_fmt$(trade.netPnl)) + dRow("% move", jnl_fmtPct(trade.pctMove)) + dRow("Setup", JNL_SETUP_LABELS[jnl_setupLabel(trade)] || jnl_setupLabel(trade)) + dRow("Account", trade.account) + dRow("Source", trade.source) + dRow("Session", trade.snapshot ? trade.snapshot.sessionPeriod : null) + dRow("Market regime", trade.marketBias) + "</table></div>";
  var checks = '<div class="jnl-rec-sec">2 · CHECKPOINT RECORD</div>' + '<div class="jnl-rec-wrap"><table class="jnl-rec-table">' + "<tr><th>Checkpoint</th><th>Value</th><th>%</th><th>Aligned</th></tr>" + rec.map(function(it) {
    var alignTxt = it.good === true ? '<span style="color:#22c55e;font-weight:700">✓ yes</span>' : it.good === false ? '<span style="color:#ef4444;font-weight:700">✗ no</span>' : '<span style="color:#475569">·</span>';
    return '<tr><td class="jnl-rec-lbl">' + esc(it.label) + (it.extra ? '<div style="color:#334155;font-size:9px">' + esc(it.extra) + "</div>" : "") + "</td>" + '<td class="jnl-rec-val">' + esc(it.valStr || "—") + "</td>" + '<td class="jnl-rec-val">' + (it.pct != null ? (it.pct > 0 ? "+" : "") + it.pct.toFixed(2) + "%" : "—") + "</td>" + "<td>" + alignTxt + "</td></tr>";
  }).join("") + "</table></div>";
  var outcome = '<div class="jnl-rec-sec">3 · OUTCOME</div>' + '<div class="jnl-rec-wrap"><table class="jnl-rec-table">' + dRow("Result", trade.netPnl != null ? trade.netPnl > 0 ? "WIN" : trade.netPnl < 0 ? "LOSS" : "B/E" : null) + (ex ? dRow("MAE", ex.maePct != null ? ex.maePct.toFixed(2) + "%" : null) + dRow("MFE", ex.mfePct != null ? ex.mfePct.toFixed(2) + "%" : null) + dRow("R multiple", ex.rMultiple != null ? ex.rMultiple + "R" : null) + dRow("Capture", ex.capturePct != null ? ex.capturePct + "%" : null) + dRow("Exit verdict", JNL_VERDICT_LABELS[ex.verdict] || ex.verdict) : dRow("Exit analysis", "not computed yet")) + "</table></div>";
  return '<div style="background:#0b1220;border:1px solid #1e293b;border-radius:8px;padding:8px 10px;margin-top:6px">' + detail + checks + outcome + "</div>";
}

function jnl_exportRecordsCSV() {
  var trades = __jnlTrades || [];
  if (!trades.length) return;
  trades.forEach(function(t) {
    if ((!t.checklistRecord || !t.checklistRecord.length) && t.snapshot) {
      t.checklistRecord = jnl_computeChecklist(t.snapshot, t).items;
      t._mut = Date.now();
    }
  });
  var keys = [], seen = {};
  trades.forEach(function(t) {
    (t.checklistRecord || []).forEach(function(it) {
      if (!seen[it.key]) {
        seen[it.key] = true;
        keys.push(it.key);
      }
    });
  });
  var magByTrade = jnl_classifyMagnitude(trades, jnl_magnitudeSettings()).byId;
  var head = [ "ticker", "date", "side", "account", "source", "shares", "entry_price", "entry_time", "exit_price", "exit_time", "duration_min", "gross_pnl", "commission", "net_pnl", "pct_move", "magnitude", "setup", "session", "market_regime", "result", "mae_pct", "mfe_pct", "r_multiple", "capture_pct", "exit_verdict", "checklist_pass", "checklist_total" ];
  keys.forEach(function(k) {
    head.push(k + "_value", k + "_pct", k + "_aligned");
  });
  function csvCell(v) {
    if (v == null || v === "") return "";
    var s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  var lines = [ head.map(csvCell).join(",") ];
  trades.forEach(function(t) {
    var ex = t.exitAnalysis || {};
    var byKey = {};
    (t.checklistRecord || []).forEach(function(it) {
      byKey[it.key] = it;
    });
    var row = [ t.ticker, t.date, t.side, t.account || "", t.source || "", t.shares, t.entryPrice != null ? t.entryPrice : "", t.entryTs ? jnl_fmtTime(t.entryTs) : "", t.exitPrice != null ? t.exitPrice : "", t.exitTs ? jnl_fmtTime(t.exitTs) : "", t.durationMs != null ? Math.round(t.durationMs / 6e4) : "", t.grossPnl != null ? t.grossPnl : "", t.totalComm != null ? t.totalComm : "", t.netPnl != null ? t.netPnl : "", t.pctMove != null ? t.pctMove : "", magByTrade[t.id] || "", jnl_setupLabel(t), t.snapshot ? t.snapshot.sessionPeriod || "" : "", t.marketBias || "", t.netPnl != null ? t.netPnl > 0 ? "win" : t.netPnl < 0 ? "loss" : "be" : "", ex.maePct != null ? ex.maePct : "", ex.mfePct != null ? ex.mfePct : "", ex.rMultiple != null ? ex.rMultiple : "", ex.capturePct != null ? ex.capturePct : "", ex.verdict || "", t.checklistPass != null ? t.checklistPass : "", t.checklistTotal != null ? t.checklistTotal : "" ];
    keys.forEach(function(k) {
      var it = byKey[k];
      row.push(it ? it.valStr || "" : "", it && it.pct != null ? it.pct.toFixed(3) : "", it ? it.good === true ? "yes" : it.good === false ? "no" : "" : "");
    });
    lines.push(row.map(csvCell).join(","));
  });
  var blob = new Blob([ lines.join("\n") ], {
    type: "text/csv"
  });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = "trade_records_" + fmtETIsoDate(Date.now()) + ".csv";
  document.body.appendChild(a);
  a.click();
  setTimeout(function() {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 500);
  jnl_save(trades);
}

function jnl_stat(label, value, color) {
  return '<div style="color:#475569">' + label + ': <span style="color:' + (color || "#94a3b8") + ';font-weight:600">' + value + "</span></div>";
}

function jnl_renderStatsBar(trades) {
  var closed = trades.filter(function(t) {
    return !t.open && t.netPnl !== null;
  });
  var wins = closed.filter(function(t) {
    return t.netPnl > 0;
  });
  var totalPnl = closed.reduce(function(s, t) {
    return s + t.netPnl;
  }, 0);
  var winRate = closed.length ? (wins.length / closed.length * 100).toFixed(0) : "—";
  var bar = document.getElementById("jnl-stats-bar");
  if (!bar) return;
  bar.style.display = "flex";
  var acctEl = document.getElementById("jnl-filter-account");
  var srcEl = document.getElementById("jnl-filter-source");
  var scopeBits = [];
  if (acctEl && acctEl.value) scopeBits.push(acctEl.value);
  if (srcEl && srcEl.value) scopeBits.push(srcEl.value);
  var scopeHtml = scopeBits.length ? '<span style="color:#93c5fd;font-weight:600">Scope: ' + scopeBits.join(" · ") + "</span>" : "";
  bar.innerHTML = scopeHtml + '<span><b style="color:#e2e8f0">' + trades.length + "</b> trades</span>" + '<span><b style="color:#e2e8f0">' + closed.length + "</b> closed</span>" + '<span>Win rate: <b style="color:' + (parseFloat(winRate) >= 50 ? "#22c55e" : "#ef4444") + '">' + winRate + "%</b></span>" + '<span>Net P&L: <b style="color:' + (totalPnl >= 0 ? "#22c55e" : "#ef4444") + '">' + jnl_fmt$(totalPnl) + "</b></span>";
}

function jnl_applyFilter(trades) {
  var tickerEl = document.getElementById("jnl-filter-ticker");
  var sideEl = document.getElementById("jnl-filter-side");
  var sortEl = document.getElementById("jnl-sort");
  var tickerF = tickerEl ? tickerEl.value.trim().toUpperCase() : "";
  var sideF = sideEl ? sideEl.value : "";
  var sortV = sortEl ? sortEl.value : "date-desc";
  var out = trades.filter(function(t) {
    if (tickerF && t.ticker.indexOf(tickerF) === -1) return false;
    if (sideF && t.side !== sideF) return false;
    return true;
  });
  out.sort(function(a, b) {
    if (sortV === "date-asc") return a.entryTs - b.entryTs;
    if (sortV === "pnl-desc") return (b.netPnl || 0) - (a.netPnl || 0);
    if (sortV === "pnl-asc") return (a.netPnl || 0) - (b.netPnl || 0);
    return b.entryTs - a.entryTs;
  });
  return out;
}

function jnl_scopedTrades() {
  var acctEl = document.getElementById("jnl-filter-account");
  var srcEl = document.getElementById("jnl-filter-source");
  var acct = acctEl ? acctEl.value : "";
  var srcv = srcEl ? srcEl.value : "";
  return (__jnlTrades || []).filter(function(t) {
    if (acct && (jnl_normAccount(t.account) || "(untagged)") !== acct) return false;
    if (srcv && (t.source || "(unknown)") !== srcv) return false;
    return true;
  });
}

function jnl_populateScopeFilters() {
  function fill(id, allLabel, valueOf) {
    var el = document.getElementById(id);
    if (!el) return;
    var prev = el.value;
    var vals = {};
    (__jnlTrades || []).forEach(function(t) {
      vals[valueOf(t)] = true;
    });
    var keys = Object.keys(vals).sort();
    el.innerHTML = '<option value="">' + allLabel + "</option>" + keys.map(function(k) {
      return '<option value="' + k.replace(/"/g, "&quot;") + '">' + k + "</option>";
    }).join("");
    if (prev && keys.indexOf(prev) !== -1) el.value = prev;
  }
  fill("jnl-filter-account", "All accounts", function(t) {
    return jnl_normAccount(t.account) || "(untagged)";
  });
  fill("jnl-filter-source", "All sources", function(t) {
    return t.source || "(unknown)";
  });
}

function jnl_renderList() {
  var container = document.getElementById("jnl-cards-container");
  if (!container) return;
  jnl_populateScopeFilters();
  jnl_computeWinWeights();
  var scoped = jnl_scopedTrades();
  var trades = jnl_applyFilter(scoped);
  var fr = document.getElementById("jnl-filter-row");
  if (!trades.length) {
    container.innerHTML = __jnlTrades.length ? '<div style="color:#475569;font-size:12px;padding:12px 0;text-align:center">No trades match the current filters.</div>' : '<div style="color:#475569;font-size:12px;padding:12px 0;text-align:center">No trades yet — paste a CSV export above and click Import.</div>';
    if (fr) fr.style.display = __jnlTrades.length ? "flex" : "none";
    jnl_renderStatsBar(scoped);
    jnl_renderAccountStats(scoped);
    jnl_renderSetupStatsSection(scoped);
    jnl_renderMagnitudeSection(scoped);
    jnl_renderCorrelationSection(__jnlTrades.length ? jnl_computeCorrelations(scoped) : null);
    jnl_renderOverviewDash(scoped);
    jnl_renderCalendarTab(scoped);
    jnl_renderTimeTab(scoped);
    jnl_renderRiskTab(scoped);
    jnl_renderStatsCatalog(scoped);
    jnl_dashApplyVisibility();
    return;
  }
  if (fr) fr.style.display = "flex";
  __jnlCorrelations = jnl_computeCorrelations(scoped);
  var view = "byday";
  try {
    view = localStorage.getItem("jnl_trades_view") || "byday";
  } catch (_) {}
  var viewBar = '<div style="display:flex;gap:4px;margin-bottom:8px">' + '<button class="jnl-corr-tab-btn jnl-trades-view' + (view === "byday" ? " active" : "") + '" data-view="byday">By day</button>' + '<button class="jnl-corr-tab-btn jnl-trades-view' + (view === "flat" ? " active" : "") + '" data-view="flat">Flat</button></div>';
  var cardsHtml;
  if (view === "byday") {
    var dayOrder = [], dayMap = {};
    trades.forEach(function(t) {
      if (!dayMap[t.date]) {
        dayMap[t.date] = [];
        dayOrder.push(t.date);
      }
      dayMap[t.date].push(t);
    });
    cardsHtml = dayOrder.map(function(d) {
      return jnl_renderDayHeader(d, dayMap[d]) + dayMap[d].map(jnl_renderCard).join("");
    }).join("");
  } else {
    cardsHtml = trades.map(jnl_renderCard).join("");
  }
  container.innerHTML = viewBar + cardsHtml;
  jnl_wireCardButtons();
  jnl_renderStatsBar(scoped);
  jnl_renderAccountStats(scoped);
  jnl_renderSetupStatsSection(scoped);
  jnl_renderMagnitudeSection(scoped);
  jnl_renderCorrelationSection(__jnlCorrelations);
  jnl_renderOverviewDash(scoped);
  jnl_renderCalendarTab(scoped);
  jnl_renderTimeTab(scoped);
  jnl_renderRiskTab(scoped);
  jnl_renderStatsCatalog(scoped);
  jnl_dashApplyVisibility();
}

function jnl_wireCardButtons() {
  document.querySelectorAll(".jnl-chart-btn").forEach(function(btn) {
    btn.addEventListener("click", function() {
      var id = btn.getAttribute("data-trade-id");
      var trade = __jnlTrades.find(function(t) {
        return t.id === id;
      });
      if (trade) jnl_openChart(trade);
    });
  });
  document.querySelectorAll(".jnl-setup-chip").forEach(function(chip) {
    chip.addEventListener("click", function() {
      var id = chip.getAttribute("data-trade-id");
      var trade = __jnlTrades.find(function(t) {
        return t.id === id;
      });
      if (!trade) return;
      var opts = [ "vwap_bounce", "ma_bounce", "catch_low_high", "unknown" ];
      var labels = opts.map(function(k) {
        return JNL_SETUP_LABELS[k] || k;
      });
      var current = jnl_setupLabel(trade);
      var chosen = prompt("Set setup for " + trade.ticker + ":\n" + opts.map(function(k, i) {
        return i + 1 + ". " + labels[i] + (k === current ? " ✓" : "");
      }).join("\n") + "\nEnter 1–" + opts.length + " (blank to clear override):");
      if (chosen === null) return;
      var idx = parseInt(chosen) - 1;
      if (chosen.trim() === "") {
        trade.setupOverride = null;
      } else if (idx >= 0 && idx < opts.length) {
        trade.setupOverride = opts[idx];
      } else {
        return;
      }
      trade._mut = Date.now();
      jnl_save(__jnlTrades);
      var cardEl = document.querySelector('.jnl-card[data-trade-id="' + id + '"]');
      if (cardEl) {
        cardEl.outerHTML = jnl_renderCard(trade);
        jnl_wireCardButtons();
      }
    });
  });
  document.querySelectorAll(".jnl-record-btn").forEach(function(btn) {
    btn.addEventListener("click", function() {
      var el = document.getElementById("jnl-record-" + btn.getAttribute("data-trade-id"));
      if (el) el.style.display = el.style.display === "none" ? "block" : "none";
    });
  });
}

var __jnlChart = null;

var __jnlVolChart = null;

var __jnlCurrentTrade = null;

var __jnlCurrentRes = 1;

var __jnlChecklistRes = 5;

var JNL_SNAP_VER = 3;

function jnl_openChart(trade) {
  __jnlCurrentTrade = trade;
  __jnlCurrentRes = __jnlChecklistRes;
  var modal = document.getElementById("jnl-chart-modal");
  if (!modal) return;
  modal.style.display = "flex";
  var title = document.getElementById("jnl-chart-title");
  if (title) title.textContent = trade.ticker + " · " + trade.date + " · " + (trade.side === "long" ? "▲ Long" : "▼ Short");
  jnl_setActiveResBtn(__jnlCurrentRes);
  jnl_setActiveChkTfBtn(__jnlChecklistRes);
  jnl_loadAndRenderChart(trade, __jnlCurrentRes);
}

function jnl_setActiveChkTfBtn(res) {
  document.querySelectorAll(".jnl-chktf-btn").forEach(function(b) {
    var active = parseInt(b.getAttribute("data-chktf")) === res;
    b.style.background = active ? "#3b2f1e" : "#1e1e2e";
    b.style.color = active ? "#fbbf24" : "#64748b";
    b.style.border = active ? "1px solid #b45309" : "1px solid #334155";
  });
}

function jnl_closeChart() {
  var modal = document.getElementById("jnl-chart-modal");
  if (modal) modal.style.display = "none";
  if (__jnlChart) {
    try {
      __jnlChart.remove();
    } catch (_) {}
    __jnlChart = null;
  }
  if (__jnlVolChart) {
    try {
      __jnlVolChart.remove();
    } catch (_) {}
    __jnlVolChart = null;
  }
}

function jnl_setActiveResBtn(res) {
  document.querySelectorAll(".jnl-res-btn").forEach(function(b) {
    var active = parseInt(b.getAttribute("data-res")) === res;
    b.style.background = active ? "#1e3a5f" : "#1e1e2e";
    b.style.color = active ? "#93c5fd" : "#64748b";
    b.style.border = active ? "1px solid #1e40af" : "1px solid #334155";
  });
}

function jnl_setChartStatus(msg, isErr) {
  var el = document.getElementById("jnl-chart-status");
  if (el) {
    el.textContent = msg;
    el.style.color = isErr ? "#ef4444" : "#64748b";
  }
}

async function jnl_loadAndRenderChart(trade, resolution) {
  jnl_setChartStatus("Loading candles…");
  if (__jnlChart) {
    try {
      __jnlChart.remove();
    } catch (_) {}
    __jnlChart = null;
  }
  if (__jnlVolChart) {
    try {
      __jnlVolChart.remove();
    } catch (_) {}
    __jnlVolChart = null;
  }
  var tradeDateStr = trade.date;
  var etOff = jnl_etOffsetMs(tradeDateStr);
  var dayStartUtc = new Date(tradeDateStr + "T00:00:00Z").getTime();
  var fromDayMs = dayStartUtc + 4 * 36e5 + etOff;
  var toMs = dayStartUtc + 20.5 * 36e5 + etOff;
  var mondayStr = jnl_getMonday(tradeDateStr);
  var mondayEtOff = jnl_etOffsetMs(mondayStr);
  var fromWeekMs = new Date(mondayStr + "T00:00:00Z").getTime() + 4 * 36e5 + mondayEtOff;
  var weekAgeMs = Date.now() - fromWeekMs;
  var fromMs = weekAgeMs <= 10 * 864e5 ? fromWeekMs : fromDayMs;
  var polygonKey = "", finnhubKey = "";
  try {
    var el = document.getElementById("jnl-polygon-key");
    if (el) polygonKey = el.value.trim();
    var fn = document.getElementById("jnl-finnhub-key");
    if (fn) finnhubKey = fn.value.trim();
  } catch (_) {}
  if (!polygonKey && !finnhubKey) {
    chrome.storage.local.get([ "smb_jnl_polygon_key", "smb_jnl_finnhub_key" ], function(d) {
      jnl_doFetchAndRender(trade, resolution, fromMs, fromDayMs, toMs, d.smb_jnl_polygon_key || "", d.smb_jnl_finnhub_key || "");
    });
    return;
  }
  jnl_doFetchAndRender(trade, resolution, fromMs, fromDayMs, toMs, polygonKey, finnhubKey);
}

function jnl_computeMarketBiasAtDate(spyCandles, tradeDateStr) {
  if (!spyCandles || spyCandles.length < 20) return "UNKNOWN";
  var cutoff = new Date(tradeDateStr + "T23:59:59Z").getTime() / 1e3;
  var dc = spyCandles.filter(function(c) {
    return c.time <= cutoff && c.close > 0;
  });
  if (dc.length < 20) return "UNKNOWN";
  function sma(n) {
    if (dc.length < n) return null;
    var s = 0;
    for (var i = dc.length - n; i < dc.length; i++) s += dc[i].close;
    return s / n;
  }
  var close = dc[dc.length - 1].close, s5 = sma(5), s20 = sma(20), s50 = sma(50);
  if (!s5 || !s20) return "UNKNOWN";
  if (close > s5 && s5 > s20 && (s50 == null || s20 > s50)) return "BULLISH";
  if (close < s5 && s5 < s20 && (s50 == null || s20 < s50)) return "BEARISH";
  return "NEUTRAL";
}

function jnl_doFetchAndRender(trade, resolution, fromMs, fromDayMs, toMs, polygonKey, finnhubKey) {
  var weekCandles = null, dailyCandles = null, spyCandles = null, oneMinCandles = null, pending = 4, errMsg = null;
  function maybeRender() {
    if (--pending > 0) return;
    if (errMsg) {
      jnl_setChartStatus("Error: " + errMsg, true);
      return;
    }
    var dayCandles = weekCandles.filter(function(c) {
      return c.time * 1e3 >= fromDayMs && c.time * 1e3 <= toMs;
    });
    if (!dayCandles.length) dayCandles = weekCandles;
    var etOffH = jnl_etOffsetMs(trade.date) / 36e5;
    var snapStale = !trade.snapshot || (trade.snapshot.snapRes || 1) !== __jnlChecklistRes || (trade.snapshot.snapVer || 0) < JNL_SNAP_VER;
    if (snapStale && resolution === __jnlChecklistRes) {
      var snap = jnl_calcEntrySnapshot(trade, weekCandles, dayCandles, dailyCandles, etOffH, resolution, oneMinCandles);
      if (snap) {
        snap.snapRes = __jnlChecklistRes;
        snap.snapVer = JNL_SNAP_VER;
        trade.snapshot = snap;
        trade._mut = Date.now();
        var rec = jnl_computeChecklist(snap, trade);
        trade.checklistRecord = rec.items;
        trade.checklistPass = rec.pass;
        trade.checklistTotal = rec.total;
        var assignment = jnl_assignSetup(snap, trade);
        trade.setup = assignment.setup;
        trade.setupScores = assignment.scores;
        var quality = jnl_entryQualityScore(snap, assignment.topScore, trade);
        trade.entryQuality = quality;
        jnl_save(__jnlTrades);
        var cardEl = document.querySelector('.jnl-card[data-trade-id="' + trade.id + '"]');
        if (cardEl) cardEl.outerHTML = jnl_renderCard(trade);
        jnl_wireCardButtons();
      }
    }
    var dailyAtr = jnl_calcDailyAtr(dailyCandles, 14, trade.date);
    var exitStats = jnl_calcExitStats(trade, dayCandles, dailyAtr);
    if (exitStats) exitStats.exitSignals = jnl_detectExitSignals(trade, dayCandles, weekCandles, dailyAtr);
    if (exitStats) {
      trade.exitAnalysis = exitStats;
      trade._mut = Date.now();
      jnl_save(__jnlTrades);
      var exitRowEl = document.getElementById("jnl-exit-row-" + trade.id);
      if (exitRowEl) exitRowEl.innerHTML = jnl_renderExitRow(exitStats, trade);
    }
    var sma5d = null;
    if (oneMinCandles && oneMinCandles.length) {
      var ma5Status = jnl_vcbMa5Day(oneMinCandles, weekCandles, resolution);
      for (var mi = ma5Status.length - 1; mi >= 0; mi--) {
        if (ma5Status[mi] != null) {
          sma5d = ma5Status[mi];
          break;
        }
      }
    }
    if (sma5d == null) sma5d = jnl_calcDailySma5(dailyCandles, trade.date);
    jnl_setChartStatus(weekCandles.length + " candles · " + resolution + "m" + (sma5d ? " | 5d MA: $" + sma5d.toFixed(2) : ""));
    jnl_renderChart(trade, weekCandles, dayCandles, dailyCandles, resolution, oneMinCandles);
    var bias = jnl_computeMarketBiasAtDate(spyCandles, trade.date);
    if (bias !== "UNKNOWN" || !trade.marketBias) {
      trade.marketBias = bias;
      jnl_save(__jnlTrades);
    }
  }
  chrome.runtime.sendMessage({
    action: "fetchCandles",
    ticker: jnl_yahooSymbol(trade.ticker),
    fromMs: fromMs,
    toMs: toMs,
    resolution: resolution,
    polygonKey: polygonKey,
    finnhubKey: finnhubKey
  }, function(resp) {
    if (!chrome.runtime.lastError && resp && resp.ok && resp.candles && resp.candles.length) {
      weekCandles = resp.candles;
    } else {
      errMsg = resp && resp.error ? resp.error : chrome.runtime.lastError ? chrome.runtime.lastError.message : "no data";
    }
    maybeRender();
  });
  chrome.runtime.sendMessage({
    action: "fetchCandles",
    ticker: jnl_yahooSymbol(trade.ticker),
    fromMs: 0,
    toMs: Date.now(),
    resolution: "daily",
    polygonKey: "",
    finnhubKey: ""
  }, function(resp) {
    if (!chrome.runtime.lastError && resp && resp.ok && resp.candles) dailyCandles = resp.candles;
    maybeRender();
  });
  chrome.runtime.sendMessage({
    action: "fetchCandles",
    ticker: jnl_yahooSymbol(trade.ticker),
    fromMs: toMs - 7 * 864e5,
    toMs: toMs,
    resolution: 1,
    polygonKey: polygonKey,
    finnhubKey: finnhubKey
  }, function(resp) {
    if (!chrome.runtime.lastError && resp && resp.ok && resp.candles && resp.candles.length) oneMinCandles = resp.candles;
    maybeRender();
  });
  chrome.runtime.sendMessage({
    action: "fetchCandles",
    ticker: "SPY",
    fromMs: 0,
    toMs: Date.now(),
    resolution: "daily",
    polygonKey: "",
    finnhubKey: ""
  }, function(resp) {
    if (!chrome.runtime.lastError && resp && resp.ok && resp.candles) spyCandles = resp.candles;
    maybeRender();
  });
}

function jnl_calcEma(closes, period) {
  if (closes.length < period) return closes.map(function() {
    return null;
  });
  var k = 2 / (period + 1);
  var result = new Array(period - 1).fill(null);
  var sum = 0;
  for (var i = 0; i < period; i++) sum += closes[i];
  var ema = sum / period;
  result.push(ema);
  for (var i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function jnl_calcSma(values, period) {
  var result = [], sum = 0;
  for (var i = 0; i < values.length; i++) {
    sum += values[i] || 0;
    if (i >= period) sum -= values[i - period] || 0;
    result.push(i >= period - 1 ? sum / period : null);
  }
  return result;
}

function jnl_calc5dMaSeries(allCandles, resolution) {
  var barsPerDay = Math.round(390 / (resolution || 1));
  var period = 5 * barsPerDay;
  var closes = allCandles.map(function(c) {
    return c.close || 0;
  });
  for (var i = 1; i < closes.length; i++) {
    if (!closes[i]) closes[i] = closes[i - 1];
  }
  var sma = jnl_calcSma(closes, period);
  return allCandles.map(function(c, i) {
    return sma[i] != null ? {
      time: c.time,
      value: sma[i]
    } : null;
  }).filter(Boolean);
}

function jnl_calcVwap(candles, etOffH) {
  etOffH = etOffH || 4;
  var result = [];
  var cumTP = 0, cumVol = 0;
  var lastDayKey = null;
  candles.forEach(function(c) {
    var d = new Date(c.time * 1e3);
    var utcFrac = d.getUTCHours() + d.getUTCMinutes() / 60;
    var etH = utcFrac - etOffH;
    var isRegular = etH >= 9.5 && etH < 16;
    if (isRegular) {
      var dayKey = d.getUTCFullYear() + "|" + d.getUTCMonth() + "|" + d.getUTCDate();
      if (dayKey !== lastDayKey) {
        cumTP = 0;
        cumVol = 0;
        lastDayKey = dayKey;
      }
      var tp = (c.high + c.low + c.close) / 3;
      cumTP += tp * c.volume;
      cumVol += c.volume;
      result.push(cumVol > 0 ? cumTP / cumVol : null);
    } else {
      result.push(null);
    }
  });
  return result;
}

function jnl_calcBB(closes, period, mult) {
  period = period || 20;
  mult = mult || 2;
  var upper = [], lower = [];
  for (var i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      upper.push(null);
      lower.push(null);
      continue;
    }
    var slice = closes.slice(i - period + 1, i + 1);
    var mean = slice.reduce(function(s, v) {
      return s + v;
    }, 0) / period;
    var variance = slice.reduce(function(s, v) {
      return s + (v - mean) * (v - mean);
    }, 0) / period;
    var sd = Math.sqrt(variance);
    upper.push(mean + mult * sd);
    lower.push(mean - mult * sd);
  }
  return {
    upper: upper,
    lower: lower
  };
}

function jnl_pmHiLo(candles, etOffH) {
  etOffH = etOffH || 4;
  var high = null, low = null;
  candles.forEach(function(c) {
    var d = new Date(c.time * 1e3);
    var etH = d.getUTCHours() + d.getUTCMinutes() / 60 - etOffH;
    if (etH >= 4 && etH < 9.5) {
      if (high === null || c.high > high) high = c.high;
      if (low === null || c.low < low) low = c.low;
    }
  });
  return {
    high: high,
    low: low
  };
}

function jnl_ahHiLo(candles, etOffH) {
  etOffH = etOffH || 4;
  var high = null, low = null;
  candles.forEach(function(c) {
    var d = new Date(c.time * 1e3);
    var etH = d.getUTCHours() + d.getUTCMinutes() / 60 - etOffH;
    if (etH >= 16) {
      if (high === null || c.high > high) high = c.high;
      if (low === null || c.low < low) low = c.low;
    }
  });
  return {
    high: high,
    low: low
  };
}

function jnl_getMonday(tradeDateStr) {
  var d = new Date(tradeDateStr + "T12:00:00Z");
  var dow = d.getUTCDay();
  var daysToMon = dow === 0 ? -6 : 1 - dow;
  return new Date(d.getTime() + daysToMon * 864e5).toISOString().slice(0, 10);
}

function jnl_calcWeekVwap(candles, tradeDateStr) {
  var etOffH = jnl_etOffsetMs(tradeDateStr) / 36e5;
  var mondayStr = jnl_getMonday(tradeDateStr);
  var weekStartMs = new Date(mondayStr + "T00:00:00Z").getTime() + (9.5 + etOffH) * 36e5;
  var result = [];
  var cumTP = 0, cumVol = 0, started = false;
  candles.forEach(function(c) {
    var d = new Date(c.time * 1e3);
    var etH = d.getUTCHours() + d.getUTCMinutes() / 60 - etOffH;
    var isRegular = etH >= 9.5 && etH < 16;
    if (!started && c.time * 1e3 >= weekStartMs && isRegular) started = true;
    if (started && isRegular) {
      var tp = (c.high + c.low + c.close) / 3;
      cumTP += tp * c.volume;
      cumVol += c.volume;
      result.push(cumVol > 0 ? cumTP / cumVol : null);
    } else {
      result.push(null);
    }
  });
  return result;
}

function jnl_calc2dVwap(candles, tradeDateStr) {
  var etOffH = jnl_etOffsetMs(tradeDateStr) / 36e5;
  var prevDayStart = null;
  for (var i = 0; i < candles.length; i++) {
    var d = new Date(candles[i].time * 1e3);
    var etH = d.getUTCHours() + d.getUTCMinutes() / 60 - etOffH;
    if (etH >= 9.5 && etH < 16) {
      var candleDateStr = new Date(candles[i].time * 1e3 - etOffH * 36e5).toISOString().slice(0, 10);
      if (candleDateStr < tradeDateStr) {
        prevDayStart = candles[i].time;
        break;
      }
    }
  }
  if (prevDayStart === null) return candles.map(function() {
    return null;
  });
  var result = [];
  var cumTP = 0, cumVol = 0, started = false;
  candles.forEach(function(c) {
    var d = new Date(c.time * 1e3);
    var etH = d.getUTCHours() + d.getUTCMinutes() / 60 - etOffH;
    var isRegular = etH >= 9.5 && etH < 16;
    if (!started && c.time >= prevDayStart && isRegular) started = true;
    if (started && isRegular) {
      var tp = (c.high + c.low + c.close) / 3;
      cumTP += tp * c.volume;
      cumVol += c.volume;
      result.push(cumVol > 0 ? cumTP / cumVol : null);
    } else {
      result.push(null);
    }
  });
  return result;
}

function jnl_calcDailySma5(dailyCandles, tradeDateStr) {
  if (!dailyCandles || !dailyCandles.length) return null;
  var cutoff = new Date(tradeDateStr + "T23:59:59Z").getTime() / 1e3;
  var eligible = dailyCandles.filter(function(c) {
    return c.time <= cutoff && c.close > 0;
  });
  if (eligible.length < 5) return null;
  var last5 = eligible.slice(-5);
  return last5.reduce(function(s, c) {
    return s + c.close;
  }, 0) / 5;
}

function jnl_calcDailyAtr(dailyCandles, period, tradeDateStr) {
  if (!dailyCandles || dailyCandles.length < 2) return null;
  var cutoff = new Date(tradeDateStr + "T23:59:59Z").getTime() / 1e3;
  var dc = dailyCandles.filter(function(c) {
    return c.time <= cutoff && c.close > 0;
  });
  if (dc.length < period + 1) return null;
  var trs = [];
  for (var i = Math.max(1, dc.length - period); i < dc.length; i++) {
    var hi = dc[i].high, lo = dc[i].low, pc = dc[i - 1].close;
    trs.push(Math.max(hi - lo, Math.abs(hi - pc), Math.abs(lo - pc)));
  }
  return trs.length ? trs.reduce(function(a, b) {
    return a + b;
  }, 0) / trs.length : null;
}

function jnl_calcDailySma5Series(dailyCandles, displayCandles) {
  if (!dailyCandles || !dailyCandles.length || !displayCandles || !displayCandles.length) return [];
  var smaByDate = {};
  for (var j = 4; j < dailyCandles.length; j++) {
    var s = 0;
    for (var k = j - 4; k <= j; k++) s += dailyCandles[k].close;
    var dayStr = new Date(dailyCandles[j].time * 1e3).toISOString().slice(0, 10);
    smaByDate[dayStr] = s / 5;
  }
  var result = [];
  displayCandles.forEach(function(c) {
    var dayStr = new Date(c.time * 1e3).toISOString().slice(0, 10);
    var val = smaByDate[dayStr];
    if (val == null) {
      var keys = Object.keys(smaByDate).sort();
      for (var ki = keys.length - 1; ki >= 0; ki--) {
        if (keys[ki] <= dayStr) {
          val = smaByDate[keys[ki]];
          break;
        }
      }
    }
    if (val != null) result.push({
      time: c.time,
      value: val
    });
  });
  return result;
}

function jnl_vcbDefaults() {
  return {
    clusterPct: 1.5,
    volMult: 1.2,
    lLookback: 3,
    lnCandleOn: true,
    lnBodyPct: .3,
    lnWickPct: .5,
    lnVolHi: true,
    lnMinScore: 1,
    leAbove5d: true,
    le5dRising: true,
    leAboveMa20: true,
    leVolSus: true,
    leMinScore: 1,
    sLookback: 3,
    snCandleOn: true,
    snBodyPct: .3,
    snWickPct: .5,
    snVolHi: true,
    snMinScore: 1,
    seBelow5d: true,
    seFade: true,
    se5dFalling: true,
    seBelowMa20: true,
    seVolSus: true,
    seMinScore: 1,
    bbLength: 20,
    bbMult: 2,
    bbLowerPct: 40,
    earnDateA: null,
    earnDateB: null,
    pivotLookback: 25,
    gapAtrMult: 1.5,
    atrLength: 14,
    lastHourStart: 15,
    ma5day: null
  };
}

function jnl_vcbMa5Day(oneMinCandles, chartCandles, resolution) {
  if (!oneMinCandles || !oneMinCandles.length || !chartCandles || !chartCandles.length) {
    return (chartCandles || []).map(function() {
      return null;
    });
  }
  var P = 1950;
  var sma = [], buf = [], sum = 0;
  for (var i = 0; i < oneMinCandles.length; i++) {
    var cl = oneMinCandles[i].close;
    buf.push(cl);
    sum += cl;
    if (buf.length > P) sum -= buf.shift();
    sma.push(buf.length === P ? sum / P : null);
  }
  var resSec = (resolution || 1) * 60;
  var out = [], j = 0, lastVal = null;
  for (var k = 0; k < chartCandles.length; k++) {
    var closeT = chartCandles[k].time + resSec;
    while (j < oneMinCandles.length && oneMinCandles[j].time < closeT) {
      lastVal = sma[j];
      j++;
    }
    out.push(lastVal);
  }
  return out;
}

function jnl_vcbCompute(candles, etOffH, optsIn) {
  var o = jnl_vcbDefaults();
  if (optsIn) for (var ok in optsIn) if (optsIn[ok] !== undefined) o[ok] = optsIn[ok];
  var n = candles.length;
  var ma5day = o.ma5day && o.ma5day.length === n ? o.ma5day : new Array(n).fill(null);
  var lb = o.pivotLookback;
  var out = {
    vwap1d: [],
    vwap2d: [],
    vwapW: [],
    vwapM: [],
    ma20: [],
    vwapHH: [],
    vwapLL: [],
    vwapWeekHH: [],
    vwapWeekLL: [],
    vwapEarnA: [],
    vwapEarnB: [],
    vwapSwLL: [],
    vwapSwHH: [],
    vwapGap: [],
    vwapLhLL: [],
    vwapLhHH: [],
    ma5day: ma5day,
    clusterA: [],
    clusterB: [],
    clusterANames: [],
    clusterBNames: [],
    pivLowAt: [],
    pivHighAt: [],
    longSignal: [],
    shortSignal: [],
    exitLong: [],
    longHard: [],
    longCore: [],
    longExtra: [],
    shortHard: [],
    shortCore: [],
    shortExtra: []
  };
  function mkVwap() {
    var pv = 0, vv = 0;
    return function(reset, tp, vol) {
      if (reset) {
        pv = tp * vol;
        vv = vol;
      } else {
        pv += tp * vol;
        vv += vol;
      }
      return vv > 0 ? pv / vv : null;
    };
  }
  function mkSma(period) {
    var buf = [], sum = 0;
    return function(v) {
      buf.push(v);
      sum += v;
      if (buf.length > period) sum -= buf.shift();
      return buf.length === period ? sum / period : null;
    };
  }
  function mkStdev(period) {
    var buf = [];
    return function(v) {
      buf.push(v);
      if (buf.length > period) buf.shift();
      if (buf.length < period) return null;
      var m = 0, i;
      for (i = 0; i < period; i++) m += buf[i];
      m /= period;
      var s = 0;
      for (i = 0; i < period; i++) s += (buf[i] - m) * (buf[i] - m);
      return Math.sqrt(s / period);
    };
  }
  function mkAtr(len) {
    var seed = [], rma = null;
    return function(tr) {
      if (rma === null) {
        seed.push(tr);
        if (seed.length < len) return null;
        rma = seed.reduce(function(a, b) {
          return a + b;
        }, 0) / len;
        return rma;
      }
      rma = (rma * (len - 1) + tr) / len;
      return rma;
    };
  }
  function mkHighest(period) {
    var buf = [];
    return function(v) {
      buf.push(v);
      if (buf.length > period) buf.shift();
      if (buf.length < period) return null;
      var hi = buf[0];
      for (var i = 1; i < buf.length; i++) if (buf[i] > hi) hi = buf[i];
      return hi;
    };
  }
  var vw1d = mkVwap(), vw2d = mkVwap(), vwW = mkVwap(), vwM = mkVwap();
  var vwHH = mkVwap(), vwLL = mkVwap(), vwWkHH = mkVwap(), vwWkLL = mkVwap();
  var vwEA = mkVwap(), vwEB = mkVwap();
  var sma20c = mkSma(20), sma20v = mkSma(20), bbSma = mkSma(o.bbLength), bbSd = mkStdev(o.bbLength);
  var atr = mkAtr(o.atrLength), hi30 = mkHighest(30);
  var dCount = 0;
  var hhIdx = -1, hhVal = 0, llIdx = -1, llVal = 1e10;
  var wkHHIdx = -1, wkHHVal = 0, wkLLIdx = -1, wkLLVal = 1e10;
  var earnABar = -1, earnBBar = -1;
  var swLLBar = -1, swLLPV = 0, swLLV = 0, swHHBar = -1, swHHPV = 0, swHHV = 0;
  var gapBar = -1, gapPV = 0, gapV = 0;
  var sessionStartBar = -1;
  var lhLLPrice = null, lhHHPrice = null, lhLLVol = null, lhHHVol = null;
  var prevLLPrice = null, prevHHPrice = null, prevLLVol = null, prevHHVol = null;
  var lhLLAnchor = -1, lhLLPV = 0, lhLLV = 0, lhHHAnchor = -1, lhHHPV = 0, lhHHV = 0;
  var prevDayKey = null, prevWeekKey = null, prevMonthKey = null;
  var prevInLowerZone = false;
  var NAMES = [ "1D", "2D", "W", "M", "HH", "LL", "WkHH", "WkLL", "EaA", "EaB", "SwLL", "SwHH", "LhLL", "LhHH", "Gap" ];
  function tpOf(c) {
    return (c.high + c.low + c.close) / 3;
  }
  for (var i = 0; i < n; i++) {
    var c = candles[i];
    var tp = tpOf(c);
    var vol = c.volume || 0;
    var d = new Date((c.time - etOffH * 3600) * 1e3);
    var dayKey = d.getUTCFullYear() + "-" + d.getUTCMonth() + "-" + d.getUTCDate();
    var dow = d.getUTCDay();
    var monday = new Date(d.getTime() - (dow === 0 ? 6 : dow - 1) * 864e5);
    var weekKey = monday.getUTCFullYear() + "-" + monday.getUTCMonth() + "-" + monday.getUTCDate();
    var monthKey = d.getUTCFullYear() + "-" + d.getUTCMonth();
    var barHour = d.getUTCHours();
    var isNewDay = prevDayKey !== null && dayKey !== prevDayKey;
    var isNewWeek = prevWeekKey !== null && weekKey !== prevWeekKey;
    var isNewMonth = prevMonthKey !== null && monthKey !== prevMonthKey;
    prevDayKey = dayKey;
    prevWeekKey = weekKey;
    prevMonthKey = monthKey;
    if (isNewDay) dCount += 1;
    var vwap_1d = vw1d(isNewDay, tp, vol);
    var vwap_2d = vw2d(isNewDay && dCount % 2 === 0, tp, vol);
    var vwap_w = vwW(isNewWeek, tp, vol);
    var vwap_m = vwM(isNewMonth, tp, vol);
    var ma20 = sma20c(c.close);
    if (isNewDay) {
      hhVal = c.high;
      hhIdx = i;
      llVal = c.low;
      llIdx = i;
    } else {
      if (c.high > hhVal) {
        hhVal = c.high;
        hhIdx = i;
      }
      if (c.low < llVal) {
        llVal = c.low;
        llIdx = i;
      }
    }
    var vwap_hh = vwHH(i === hhIdx && hhIdx >= 0, tp, vol);
    var vwap_ll = vwLL(i === llIdx && llIdx >= 0, tp, vol);
    if (isNewWeek) {
      wkHHVal = c.high;
      wkHHIdx = i;
      wkLLVal = c.low;
      wkLLIdx = i;
    } else {
      if (c.high > wkHHVal) {
        wkHHVal = c.high;
        wkHHIdx = i;
      }
      if (c.low < wkLLVal) {
        wkLLVal = c.low;
        wkLLIdx = i;
      }
    }
    var vwap_weekHH = vwWkHH(i === wkHHIdx && wkHHIdx >= 0, tp, vol);
    var vwap_weekLL = vwWkLL(i === wkLLIdx && wkLLIdx >= 0, tp, vol);
    var tMs = c.time * 1e3;
    var prevTMs = i > 0 ? candles[i - 1].time * 1e3 : null;
    var resetEarnA = o.earnDateA != null && tMs >= o.earnDateA && prevTMs !== null && prevTMs < o.earnDateA;
    var resetEarnB = o.earnDateB != null && tMs >= o.earnDateB && prevTMs !== null && prevTMs < o.earnDateB;
    if (resetEarnA) earnABar = i;
    if (resetEarnB) earnBBar = i;
    var vwap_earnA = vwEA(resetEarnA, tp, vol);
    var vwap_earnB = vwEB(resetEarnB, tp, vol);
    var vwap_earnA_out = earnABar >= 0 ? vwap_earnA : null;
    var vwap_earnB_out = earnBBar >= 0 ? vwap_earnB : null;
    var pivLow = null, pivHigh = null, j;
    if (i >= 2 * lb) {
      var ci = i - lb;
      var isPL = true, isPH = true;
      for (j = i - 2 * lb; j <= i; j++) {
        if (candles[j].low < candles[ci].low) isPL = false;
        if (candles[j].high > candles[ci].high) isPH = false;
        if (!isPL && !isPH) break;
      }
      if (isPL) pivLow = candles[ci].low;
      if (isPH) pivHigh = candles[ci].high;
    }
    if (pivLow !== null) {
      swLLBar = i - lb;
      swLLPV = 0;
      swLLV = 0;
      for (j = lb; j >= 0; j--) {
        swLLPV += tpOf(candles[i - j]) * (candles[i - j].volume || 0);
        swLLV += candles[i - j].volume || 0;
      }
    } else if (swLLBar >= 0) {
      swLLPV += tp * vol;
      swLLV += vol;
    }
    if (pivHigh !== null) {
      swHHBar = i - lb;
      swHHPV = 0;
      swHHV = 0;
      for (j = lb; j >= 0; j--) {
        swHHPV += tpOf(candles[i - j]) * (candles[i - j].volume || 0);
        swHHV += candles[i - j].volume || 0;
      }
    } else if (swHHBar >= 0) {
      swHHPV += tp * vol;
      swHHV += vol;
    }
    var vwap_swLL = swLLBar >= 0 && swLLV > 0 ? swLLPV / swLLV : null;
    var vwap_swHH = swHHBar >= 0 && swHHV > 0 ? swHHPV / swHHV : null;
    var trv = i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close));
    var atrVal = atr(trv);
    var isGapBar = i > 0 && atrVal !== null && Math.abs(c.open - candles[i - 1].close) >= atrVal * o.gapAtrMult;
    if (isGapBar) {
      gapBar = i;
      gapPV = tp * vol;
      gapV = vol;
    } else if (gapBar >= 0) {
      gapPV += tp * vol;
      gapV += vol;
    }
    var vwap_gap = gapBar >= 0 && gapV > 0 ? gapPV / gapV : null;
    if (isNewDay) sessionStartBar = i;
    var inLastHour = barHour >= o.lastHourStart && sessionStartBar >= 0;
    if (isNewDay) {
      prevLLPrice = lhLLPrice;
      prevHHPrice = lhHHPrice;
      prevLLVol = lhLLVol;
      prevHHVol = lhHHVol;
      lhLLPrice = null;
      lhHHPrice = null;
      lhLLVol = null;
      lhHHVol = null;
    }
    if (inLastHour && !isNewDay) {
      if (lhLLPrice === null || c.low < lhLLPrice) {
        lhLLPrice = c.low;
        lhLLVol = vol;
      }
      if (lhHHPrice === null || c.high > lhHHPrice) {
        lhHHPrice = c.high;
        lhHHVol = vol;
      }
    }
    var prevLLOk = prevLLPrice !== null && prevLLVol !== null;
    var prevHHOk = prevHHPrice !== null && prevHHVol !== null;
    if (isNewDay && prevLLOk) {
      lhLLAnchor = i;
      lhLLPV = prevLLPrice * prevLLVol + tp * vol;
      lhLLV = prevLLVol + vol;
    } else if (lhLLAnchor >= 0) {
      lhLLPV += tp * vol;
      lhLLV += vol;
    }
    if (isNewDay && prevHHOk) {
      lhHHAnchor = i;
      lhHHPV = prevHHPrice * prevHHVol + tp * vol;
      lhHHV = prevHHVol + vol;
    } else if (lhHHAnchor >= 0) {
      lhHHPV += tp * vol;
      lhHHV += vol;
    }
    var vwap_lhLL = lhLLAnchor >= 0 && lhLLV > 0 ? lhLLPV / lhLLV : null;
    var vwap_lhHH = lhHHAnchor >= 0 && lhHHV > 0 ? lhHHPV / lhHHV : null;
    var p = [ vwap_1d, vwap_2d, vwap_w, vwap_m, vwap_hh, vwap_ll, vwap_weekHH, vwap_weekLL, vwap_earnA_out, vwap_earnB_out, vwap_swLL, vwap_swHH, vwap_lhLL, vwap_lhHH, vwap_gap ];
    var loA = null, hiB = null, loN = "", hiN = "";
    for (var r = 0; r < 15; r++) {
      var ref = p[r];
      if (ref === null) continue;
      var thr = ref * o.clusterPct / 100;
      var tCount = 0, aCount = 0, sumP = 0, member = [], kk;
      for (kk = 0; kk < 15; kk++) {
        var inCl = p[kk] !== null && Math.abs(p[kk] - ref) <= thr;
        member.push(inCl);
        if (inCl) {
          if (kk < 4) tCount++; else aCount++;
          sumP += p[kk];
        }
      }
      var total = tCount + aCount;
      if (!(total >= 2 && tCount >= 1)) continue;
      var avg = sumP / total;
      var names = "";
      for (kk = 0; kk < 15; kk++) if (member[kk]) names += NAMES[kk] + " ";
      if (loA === null || avg < loA) {
        loA = avg;
        loN = names;
      }
      if (hiB === null || avg > hiB) {
        hiB = avg;
        hiN = names;
      }
    }
    var singleCluster = loA !== null && hiB !== null && Math.abs(loA - hiB) < loA * o.clusterPct / 100;
    var clusterA = loA;
    var clusterB = singleCluster ? null : hiB;
    var avgVol = sma20v(vol);
    var highVol = avgVol !== null && vol >= avgVol * o.volMult;
    var twoClusters = clusterA !== null && clusterB !== null;
    var barRange = c.high - c.low;
    var barBody = Math.abs(c.close - c.open);
    var upperWick = c.high - Math.max(c.close, c.open);
    var lowerWick = Math.min(c.close, c.open) - c.low;
    var bodyPct = barRange > 0 ? barBody / barRange : 0;
    var uWickR = barRange > 0 ? upperWick / barRange : 1;
    var lWickR = barRange > 0 ? lowerWick / barRange : 1;
    var volSus3 = avgVol !== null && i >= 2 && vol >= avgVol * o.volMult && (candles[i - 1].volume || 0) >= avgVol * o.volMult && (candles[i - 2].volume || 0) >= avgVol * o.volMult;
    var ma5 = ma5day[i] != null ? ma5day[i] : null;
    var ma5prev = i > 0 && ma5day[i - 1] != null ? ma5day[i - 1] : null;
    var ma5Rising = ma5 !== null && ma5prev !== null && ma5 > ma5prev;
    var ma5Falling = ma5 !== null && ma5prev !== null && ma5 < ma5prev;
    var touch = o.clusterPct / 100;
    var hi30v = hi30(c.high);
    var lhcPrevAbove = false;
    if (clusterB !== null) {
      for (j = 1; j <= o.lLookback; j++) {
        if (i - j >= 0 && candles[i - j].close > clusterB) {
          lhcPrevAbove = true;
          break;
        }
      }
    }
    var lhcLowInZone = clusterB !== null && c.low <= clusterB * (1 + touch);
    var lhcLowFloor = clusterB !== null && c.low >= clusterB * (1 - touch);
    var lhcCloseAbove = clusterB !== null && c.close > clusterB;
    var longHard = twoClusters && lhcPrevAbove && lhcLowInZone && lhcLowFloor && lhcCloseAbove;
    var lnCandleOk = c.close > c.open && bodyPct >= o.lnBodyPct && uWickR <= o.lnWickPct;
    var longCoreScore = (o.lnCandleOn && lnCandleOk ? 1 : 0) + (o.lnVolHi && highVol ? 1 : 0);
    var longCore = longCoreScore >= o.lnMinScore;
    var longExtraScore = (o.leAbove5d && ma5 !== null && c.close > ma5 ? 1 : 0) + (o.le5dRising && ma5Rising ? 1 : 0) + (o.leAboveMa20 && ma20 !== null && c.close > ma20 ? 1 : 0) + (o.leVolSus && volSus3 ? 1 : 0);
    var longExtra = longExtraScore >= o.leMinScore;
    var shcPrevBelow = false;
    if (clusterA !== null) {
      for (j = 1; j <= o.sLookback; j++) {
        if (i - j >= 0 && candles[i - j].close < clusterA) {
          shcPrevBelow = true;
          break;
        }
      }
    }
    var shcHighInZone = clusterA !== null && c.high >= clusterA * (1 - touch);
    var shcHighCeil = clusterA !== null && c.high <= clusterA * (1 + touch);
    var shcCloseBelow = clusterA !== null && c.close < clusterA;
    var shortHard = twoClusters && shcPrevBelow && shcHighInZone && shcHighCeil && shcCloseBelow;
    var snCandleOk = c.close < c.open && bodyPct >= o.snBodyPct && lWickR <= o.snWickPct;
    var shortCoreScore = (o.snCandleOn && snCandleOk ? 1 : 0) + (o.snVolHi && highVol ? 1 : 0);
    var shortCore = shortCoreScore >= o.snMinScore;
    var seFadeOk = ma5 !== null && hi30v !== null && hi30v > ma5 * 1.05;
    var shortExtraScore = (o.seBelow5d && ma5 !== null && c.close < ma5 ? 1 : 0) + (o.seFade && seFadeOk ? 1 : 0) + (o.se5dFalling && ma5Falling ? 1 : 0) + (o.seBelowMa20 && ma20 !== null && c.close < ma20 ? 1 : 0) + (o.seVolSus && volSus3 ? 1 : 0);
    var shortExtra = shortExtraScore >= o.seMinScore;
    var longSignal = longHard && longCore && longExtra;
    var shortSignal = shortHard && shortCore && shortExtra;
    var bbBasis = bbSma(c.close);
    var bbDevV = bbSd(c.close);
    var inLowerZone = false;
    if (bbBasis !== null && bbDevV !== null) {
      var bbU = bbBasis + o.bbMult * bbDevV, bbL = bbBasis - o.bbMult * bbDevV;
      var bbRng = bbU - bbL;
      var pctB = bbRng !== 0 ? (c.close - bbL) / bbRng : 0;
      inLowerZone = c.close < c.open && pctB <= o.bbLowerPct / 100;
    }
    var exitLong = inLowerZone && prevInLowerZone;
    prevInLowerZone = inLowerZone;
    out.vwap1d.push(vwap_1d);
    out.vwap2d.push(vwap_2d);
    out.vwapW.push(vwap_w);
    out.vwapM.push(vwap_m);
    out.ma20.push(ma20);
    out.vwapHH.push(vwap_hh);
    out.vwapLL.push(vwap_ll);
    out.vwapWeekHH.push(vwap_weekHH);
    out.vwapWeekLL.push(vwap_weekLL);
    out.vwapEarnA.push(vwap_earnA_out);
    out.vwapEarnB.push(vwap_earnB_out);
    out.vwapSwLL.push(vwap_swLL);
    out.vwapSwHH.push(vwap_swHH);
    out.vwapGap.push(vwap_gap);
    out.vwapLhLL.push(vwap_lhLL);
    out.vwapLhHH.push(vwap_lhHH);
    out.clusterA.push(clusterA);
    out.clusterB.push(clusterB);
    out.clusterANames.push(loN.trim());
    out.clusterBNames.push(hiN.trim());
    out.pivLowAt.push(pivLow !== null ? i - lb : null);
    out.pivHighAt.push(pivHigh !== null ? i - lb : null);
    out.longSignal.push(longSignal);
    out.shortSignal.push(shortSignal);
    out.exitLong.push(exitLong);
    out.longHard.push(longHard);
    out.longCore.push(longCore);
    out.longExtra.push(longExtra);
    out.shortHard.push(shortHard);
    out.shortCore.push(shortCore);
    out.shortExtra.push(shortExtra);
  }
  return out;
}

function jnl_vcbDetectBounce(candles, vcb, idx, side) {
  var o = jnl_vcbDefaults();
  var t = o.clusterPct / 100;
  var isLong = side !== "short";
  var best = {
    checked: true,
    engineSignal: false,
    hard: false,
    level: null,
    levelVal: null,
    coreScore: 0,
    extraScore: 0,
    atBar: null,
    nearZone: false
  };
  if (!candles || !candles.length || !vcb || idx == null || idx < 0 || idx >= candles.length) return best;
  function volAvg20(i) {
    if (i < 19) return null;
    var s = 0;
    for (var k = i - 19; k <= i; k++) s += candles[k].volume || 0;
    return s / 20;
  }
  var bestRank = -1;
  for (var b = Math.max(0, idx - 2); b <= idx; b++) {
    var c = candles[b];
    if (isLong ? vcb.longSignal[b] : vcb.shortSignal[b]) best.engineSignal = true;
    var levels = [ [ "1D", vcb.vwap1d[b] ], [ "2D", vcb.vwap2d[b] ], [ "W", vcb.vwapW[b] ], [ "ClusterA", vcb.clusterA[b] ], [ "ClusterB", vcb.clusterB[b] ] ];
    for (var li = 0; li < levels.length; li++) {
      var L = levels[li][1];
      if (L == null) continue;
      var near, hard, cameFrom = false, j;
      if (isLong) {
        near = c.low <= L * (1 + t) && c.low >= L * (1 - t);
        for (j = 1; j <= 3; j++) if (b - j >= 0 && candles[b - j].close > L) cameFrom = true;
        hard = near && cameFrom && c.close > L;
      } else {
        near = c.high >= L * (1 - t) && c.high <= L * (1 + t);
        for (j = 1; j <= 3; j++) if (b - j >= 0 && candles[b - j].close < L) cameFrom = true;
        hard = near && cameFrom && c.close < L;
      }
      if (near) best.nearZone = true;
      if (!hard) continue;
      var range = c.high - c.low, body = Math.abs(c.close - c.open);
      var bodyPct = range > 0 ? body / range : 0;
      var uW = range > 0 ? (c.high - Math.max(c.close, c.open)) / range : 1;
      var lW = range > 0 ? (Math.min(c.close, c.open) - c.low) / range : 1;
      var candleOk = isLong ? c.close > c.open && bodyPct >= o.lnBodyPct && uW <= o.lnWickPct : c.close < c.open && bodyPct >= o.snBodyPct && lW <= o.snWickPct;
      var av = volAvg20(b);
      var hiVol = av !== null && (c.volume || 0) >= av * o.volMult;
      var volSus = av !== null && b >= 2 && (c.volume || 0) >= av * o.volMult && (candles[b - 1].volume || 0) >= av * o.volMult && (candles[b - 2].volume || 0) >= av * o.volMult;
      var core = (candleOk ? 1 : 0) + (hiVol ? 1 : 0);
      var ma5 = vcb.ma5day[b], ma5p = b > 0 ? vcb.ma5day[b - 1] : null, ma20v = vcb.ma20[b];
      var extra = 0;
      if (ma5 != null && (isLong ? c.close > ma5 : c.close < ma5)) extra++;
      if (ma5 != null && ma5p != null && (isLong ? ma5 > ma5p : ma5 < ma5p)) extra++;
      if (ma20v != null && (isLong ? c.close > ma20v : c.close < ma20v)) extra++;
      if (volSus) extra++;
      var rank = (core + extra) * 4 + (li >= 3 ? 2 : 0) + (b === idx ? 1 : 0);
      if (rank > bestRank) {
        bestRank = rank;
        best.hard = true;
        best.level = levels[li][0];
        best.levelVal = L;
        best.coreScore = core;
        best.extraScore = extra;
        best.atBar = b;
      }
    }
  }
  return best;
}

function jnl_hpbDefaults() {
  return {
    bbLength: 21,
    bbMult: 2,
    zonePct: 25,
    minWick: 15,
    vwapTouch: .2,
    reqVol: false,
    biasStrict: true,
    useMaExit: false,
    maExitType: "SMA",
    maExitLen: 15,
    useZoneDur: false,
    zoneDurBars: 3,
    zoneDurType: "close",
    useSlope: true,
    slopePeriods: 3,
    slopeMinLong: 2,
    slopeResetX: true,
    bzStartHour: 9,
    bzStartMin: 30,
    bzEndHour: 13,
    bzEndMin: 0,
    bzBbLen: 20,
    bzBbMult: 2,
    bzSLookback: 3,
    bzSZonePct: 25,
    bzSOutsideThresh: 7,
    bzSSdvMult: .8,
    bzSBodyAtr: .2,
    bzSWickRatio: .5,
    bzLLookback: 4,
    bzLZonePct: 25,
    bzLOutsideThresh: 7,
    bzLSdvMult: .8,
    bzLBodyAtr: .2,
    bzLWickRatio: .5
  };
}

function jnl_hpbCompute(candles, etOffH, optsIn) {
  var o = jnl_hpbDefaults();
  if (optsIn) for (var ok in optsIn) if (optsIn[ok] !== undefined) o[ok] = optsIn[ok];
  var n = candles.length;
  var out = {
    dailyVwap: [],
    vwapStdev: [],
    vwap2day: [],
    llAvwap: [],
    atr14: [],
    l3BbEma: [],
    l3BbUpper: [],
    l3BbLower: [],
    l3TopZoneBot: [],
    l3BotZoneTop: [],
    l3ExitMa: [],
    l3LongBias: [],
    l3LongSig: [],
    l3SlopeScore: [],
    l3ZoneCount: [],
    bzBbUp: [],
    bzBbLo: [],
    bzRedZoneTop: [],
    bzGreenZoneBot: [],
    bzSma9: [],
    bzSma13: [],
    bzSma20: [],
    bzLVwapBand: [],
    bzSVwapBand: [],
    bzSessionOK: [],
    bzLZoneOK: [],
    bzSZoneOK: [],
    bzLVwapOK: [],
    bzSVwapOK: [],
    bzLMaTouch: [],
    bzSMaTouch: [],
    bzLMaHit: [],
    bzSMaHit: [],
    bzLongSig: [],
    bzShortSig: []
  };
  if (!n) return out;
  function mkSma(p) {
    var buf = [], sum = 0;
    return function(v) {
      buf.push(v);
      sum += v;
      if (buf.length > p) sum -= buf.shift();
      return buf.length === p ? sum / p : null;
    };
  }
  function mkStdev(p) {
    var buf = [];
    return function(v) {
      buf.push(v);
      if (buf.length > p) buf.shift();
      if (buf.length < p) return null;
      var m = 0, i;
      for (i = 0; i < p; i++) m += buf[i];
      m /= p;
      var s = 0;
      for (i = 0; i < p; i++) s += (buf[i] - m) * (buf[i] - m);
      return Math.sqrt(s / p);
    };
  }
  function mkEma(p) {
    var buf = [], sum = 0, e = null, k = 2 / (p + 1);
    return function(v) {
      if (e === null) {
        buf.push(v);
        sum += v;
        if (buf.length === p) {
          e = sum / p;
          return e;
        }
        return null;
      }
      e = v * k + e * (1 - k);
      return e;
    };
  }
  function mkWma(p) {
    var buf = [];
    return function(v) {
      buf.push(v);
      if (buf.length > p) buf.shift();
      if (buf.length < p) return null;
      var num = 0, den = 0;
      for (var i = 0; i < p; i++) {
        num += buf[i] * (i + 1);
        den += i + 1;
      }
      return num / den;
    };
  }
  function mkVwma(p) {
    var b1 = [], b2 = [], s1 = 0, s2 = 0;
    return function(c2, v2) {
      b1.push(c2 * v2);
      s1 += c2 * v2;
      b2.push(v2);
      s2 += v2;
      if (b1.length > p) {
        s1 -= b1.shift();
        s2 -= b2.shift();
      }
      return b1.length === p && s2 > 0 ? s1 / s2 : null;
    };
  }
  function mkAtr(len) {
    var seed = [], rma = null;
    return function(tr) {
      if (rma === null) {
        seed.push(tr);
        if (seed.length < len) return null;
        rma = seed.reduce(function(a, b) {
          return a + b;
        }, 0) / len;
        return rma;
      }
      rma = (rma * (len - 1) + tr) / len;
      return rma;
    };
  }
  var l3Ema = mkEma(o.bbLength), l3Sd = mkStdev(o.bbLength);
  var exitMa = o.maExitType === "EMA" ? mkEma(o.maExitLen) : o.maExitType === "WMA" ? mkWma(o.maExitLen) : o.maExitType === "VWMA" ? mkVwma(o.maExitLen) : mkSma(o.maExitLen);
  var atr = mkAtr(14);
  var bzBbSma = mkSma(o.bzBbLen), bzBbSd = mkStdev(o.bzBbLen);
  var sma9 = mkSma(9), sma13 = mkSma(13), sma20 = mkSma(20);
  var shPv = 0, shVol = 0, shPv2 = 0;
  var v2Pv = 0, v2V = 0, v2Days = 0;
  var avLlPv = 0, avLlV = 0, sLl = null;
  var zoneCount = 0;
  var slopeScore = 0, slopeRef = null, slopeWasAbove = null;
  var prevDayKey = null;
  for (var i = 0; i < n; i++) {
    var c = candles[i];
    var tp = (c.high + c.low + c.close) / 3;
    var vol = c.volume || 0;
    var d = new Date((c.time - etOffH * 3600) * 1e3);
    var dayKey = d.getUTCFullYear() + "-" + d.getUTCMonth() + "-" + d.getUTCDate();
    var etHour = d.getUTCHours(), etMin = d.getUTCMinutes();
    var isNewDay = prevDayKey !== null && dayKey !== prevDayKey;
    prevDayKey = dayKey;
    var trv = i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close));
    var atrVal = atr(trv);
    if (isNewDay) {
      shPv = 0;
      shVol = 0;
      shPv2 = 0;
    }
    shPv += tp * vol;
    shVol += vol;
    shPv2 += tp * tp * vol;
    var dv = shVol > 0 ? shPv / shVol : null;
    var vwapSd = null;
    if (dv !== null) vwapSd = Math.sqrt(Math.max(shPv2 / shVol - dv * dv, 0));
    if (isNewDay) {
      v2Days += 1;
      if (v2Days >= 2) {
        v2Pv = 0;
        v2V = 0;
        v2Days = 0;
      }
    }
    v2Pv += tp * vol;
    v2V += vol;
    var v2 = v2V > 0 ? v2Pv / v2V : null;
    if (isNewDay) {
      sLl = c.low;
      avLlPv = tp * vol;
      avLlV = vol;
    } else if (sLl === null) {
      sLl = c.low;
      avLlPv = tp * vol;
      avLlV = vol;
    } else if (c.low < sLl) {
      sLl = c.low;
      avLlPv = tp * vol;
      avLlV = vol;
    } else {
      avLlPv += tp * vol;
      avLlV += vol;
    }
    var llAv = avLlV > 0 ? avLlPv / avLlV : null;
    var bbEma = l3Ema(c.close);
    var bbSd = l3Sd(c.close);
    var bbUp = null, bbLo = null, bbRange = null, topZoneBot = null, botZoneTop = null, emaBuffer = null;
    if (bbEma !== null && bbSd !== null) {
      bbUp = bbEma + o.bbMult * bbSd;
      bbLo = bbEma - o.bbMult * bbSd;
      bbRange = bbUp - bbLo;
      topZoneBot = bbUp - bbRange * (o.zonePct / 100);
      botZoneTop = bbLo + bbRange * (o.zonePct / 100);
      emaBuffer = bbRange * .05;
    }
    var exMa = o.maExitType === "VWMA" ? exitMa(c.close, vol) : exitMa(c.close);
    var prevZoneCount = zoneCount;
    var inZone = false;
    if (bbEma !== null && topZoneBot !== null) {
      var bodyTop = Math.max(c.open, c.close), bodyBot = Math.min(c.open, c.close);
      inZone = o.zoneDurType === "close" ? c.close >= bbEma - emaBuffer && c.close <= topZoneBot + emaBuffer : o.zoneDurType === "low/high" ? c.low >= bbEma - emaBuffer && c.high <= topZoneBot + emaBuffer : bodyBot >= bbEma - emaBuffer && bodyTop <= topZoneBot + emaBuffer;
    }
    if (isNewDay) zoneCount = 0; else zoneCount = inZone ? zoneCount + 1 : 0;
    var fZoneLong = o.useZoneDur ? prevZoneCount >= o.zoneDurBars : true;
    var priceAbove = dv !== null ? c.close > dv : null;
    var vwapCross = slopeWasAbove !== null && priceAbove !== null && priceAbove !== slopeWasAbove;
    if (isNewDay) {
      slopeScore = 0;
      slopeRef = dv;
      slopeWasAbove = priceAbove;
    }
    if (o.slopeResetX && vwapCross && !isNewDay) {
      slopeScore = 0;
      slopeRef = dv;
    }
    slopeWasAbove = priceAbove;
    if (i % o.slopePeriods === 0 && slopeRef !== null && dv !== null) {
      if (dv > slopeRef) slopeScore += 1; else if (dv < slopeRef) slopeScore -= 1;
      slopeRef = dv;
    }
    var fSlopeLong = o.useSlope ? slopeScore >= o.slopeMinLong : true;
    var biasBase = dv !== null && bbEma !== null && c.close > dv && c.close > bbEma;
    var biasFull = biasBase && v2 !== null && llAv !== null && c.close > v2 && c.close > llAv;
    var longBias = o.biasStrict ? biasFull : biasBase;
    var longBiasC1 = false;
    if (i > 0) {
      var pc = candles[i - 1].close;
      var pdv = out.dailyVwap[i - 1], pbe = out.l3BbEma[i - 1];
      var pv2 = out.vwap2day[i - 1], pll = out.llAvwap[i - 1];
      longBiasC1 = o.biasStrict ? pdv !== null && pbe !== null && pv2 !== null && pll !== null && pc > pdv && pc > pbe && pc > pv2 && pc > pll : pdv !== null && pbe !== null && pc > pdv && pc > pbe;
    }
    var l3c1 = false, l3c2 = false;
    if (i > 0) {
      var p = candles[i - 1];
      var c1BodyBot = Math.min(p.open, p.close);
      var c1Range = p.high - p.low;
      var c1LowerWick = c1BodyBot - p.low;
      var c1LwickPct = c1Range > 0 ? c1LowerWick / c1Range * 100 : 0;
      var volOkLong = o.reqVol ? (c.volume || 0) > (p.volume || 0) : true;
      var tolp = o.vwapTouch / 100;
      var pdv1 = out.dailyVwap[i - 1], pv21 = out.vwap2day[i - 1], pll1 = out.llAvwap[i - 1];
      var lDvT = pdv1 !== null && p.low <= pdv1 * (1 + tolp) && p.low >= pdv1 * (1 - tolp);
      var lV2T = pv21 !== null && p.low <= pv21 * (1 + tolp) && p.low >= pv21 * (1 - tolp);
      var lAvT = pll1 !== null && p.low <= pll1 * (1 + tolp) && p.low >= pll1 * (1 - tolp);
      var anyLongVwap = lDvT || lV2T || lAvT;
      var pbbUp = out.l3BbUpper[i - 1];
      l3c1 = p.close < p.open && c1LwickPct >= o.minWick && anyLongVwap && pbbUp !== null && p.high < pbbUp;
      l3c2 = c.close > c.open && c.close > p.high && volOkLong;
    }
    var l3LongSig = longBiasC1 && longBias && l3c1 && l3c2 && fSlopeLong && fZoneLong;
    var sessStart = etHour > o.bzStartHour || etHour === o.bzStartHour && etMin >= o.bzStartMin;
    var sessEnd = etHour < o.bzEndHour || etHour === o.bzEndHour && etMin <= o.bzEndMin;
    var sessionOK = sessStart && sessEnd;
    var sVwapBand = dv !== null && vwapSd !== null ? dv - o.bzSSdvMult * vwapSd : null;
    var lVwapBand = dv !== null && vwapSd !== null ? dv + o.bzLSdvMult * vwapSd : null;
    var bzMid = bzBbSma(c.close), bzSd = bzBbSd(c.close);
    var bzUp = null, bzLo = null, redZoneTop = null, greenZoneBot = null;
    if (bzMid !== null && bzSd !== null) {
      bzUp = bzMid + o.bzBbMult * bzSd;
      bzLo = bzMid - o.bzBbMult * bzSd;
      var bzRange = bzUp - bzLo;
      redZoneTop = bzLo + o.bzSZonePct / 100 * bzRange;
      greenZoneBot = bzUp - o.bzLZonePct / 100 * bzRange;
    }
    var s9 = sma9(c.close), s13 = sma13(c.close), s20 = sma20(c.close);
    var barBody = Math.abs(c.close - c.open);
    var upperWick = c.high - Math.max(c.close, c.open);
    var lowerWick = Math.min(c.close, c.open) - c.low;
    var lZoneOK = false, q, cb, bTop, bBot;
    if (i >= o.bzLLookback - 1 && redZoneTop !== null) {
      var lTotal = 0, lBad = 0;
      for (q = 0; q < o.bzLLookback; q++) {
        cb = candles[i - q];
        bTop = Math.max(cb.open, cb.close);
        bBot = Math.min(cb.open, cb.close);
        lTotal += bTop - bBot;
        lBad += Math.max(0, Math.min(bTop, redZoneTop) - bBot);
      }
      lZoneOK = lTotal > 0 ? lBad / lTotal * 100 < o.bzLOutsideThresh : true;
    }
    var sZoneOK = false;
    if (i >= o.bzSLookback - 1 && greenZoneBot !== null) {
      var sTotal = 0, sBad = 0;
      for (q = 0; q < o.bzSLookback; q++) {
        cb = candles[i - q];
        bTop = Math.max(cb.open, cb.close);
        bBot = Math.min(cb.open, cb.close);
        sTotal += bTop - bBot;
        sBad += Math.max(0, bTop - Math.max(bBot, greenZoneBot));
      }
      sZoneOK = sTotal > 0 ? sBad / sTotal * 100 < o.bzSOutsideThresh : true;
    }
    var lBounceOk = c.close > c.open && atrVal !== null && barBody > atrVal * o.bzLBodyAtr && upperWick < barBody * o.bzLWickRatio;
    var sRejectOk = c.close < c.open && atrVal !== null && barBody > atrVal * o.bzSBodyAtr && lowerWick < barBody * o.bzSWickRatio;
    var lT9 = false, lT13 = false, lT20 = false, sT9 = false, sT13 = false, sT20 = false;
    if (i > 0) {
      var pb = candles[i - 1];
      var p9 = out.bzSma9[i - 1], p13 = out.bzSma13[i - 1], p20 = out.bzSma20[i - 1];
      lT9 = p9 !== null && s9 !== null && pb.low <= p9 && pb.high >= p9 && c.close > s9 && lBounceOk;
      lT13 = p13 !== null && s13 !== null && pb.low <= p13 && pb.high >= p13 && c.close > s13 && lBounceOk;
      lT20 = p20 !== null && s20 !== null && pb.low <= p20 && pb.high >= p20 && c.close > s20 && lBounceOk;
      sT9 = p9 !== null && s9 !== null && pb.low <= p9 && pb.high >= p9 && c.close < s9 && sRejectOk;
      sT13 = p13 !== null && s13 !== null && pb.low <= p13 && pb.high >= p13 && c.close < s13 && sRejectOk;
      sT20 = p20 !== null && s20 !== null && pb.low <= p20 && pb.high >= p20 && c.close < s20 && sRejectOk;
    }
    var lMaTouch = lT9 || lT13 || lT20;
    var sMaTouch = sT9 || sT13 || sT20;
    var lVwapOK = lVwapBand !== null && c.close > lVwapBand;
    var sVwapOK = sVwapBand !== null && c.close < sVwapBand;
    var bzLongSig = sessionOK && lVwapOK && lZoneOK && lMaTouch;
    var bzShortSig = sessionOK && sVwapOK && sZoneOK && sMaTouch;
    out.dailyVwap.push(dv);
    out.vwapStdev.push(vwapSd);
    out.vwap2day.push(v2);
    out.llAvwap.push(llAv);
    out.atr14.push(atrVal);
    out.l3BbEma.push(bbEma);
    out.l3BbUpper.push(bbUp);
    out.l3BbLower.push(bbLo);
    out.l3TopZoneBot.push(topZoneBot);
    out.l3BotZoneTop.push(botZoneTop);
    out.l3ExitMa.push(exMa);
    out.l3LongBias.push(longBias);
    out.l3LongSig.push(l3LongSig);
    out.l3SlopeScore.push(slopeScore);
    out.l3ZoneCount.push(zoneCount);
    out.bzBbUp.push(bzUp);
    out.bzBbLo.push(bzLo);
    out.bzRedZoneTop.push(redZoneTop);
    out.bzGreenZoneBot.push(greenZoneBot);
    out.bzSma9.push(s9);
    out.bzSma13.push(s13);
    out.bzSma20.push(s20);
    out.bzLVwapBand.push(lVwapBand);
    out.bzSVwapBand.push(sVwapBand);
    out.bzSessionOK.push(sessionOK);
    out.bzLZoneOK.push(lZoneOK);
    out.bzSZoneOK.push(sZoneOK);
    out.bzLVwapOK.push(lVwapOK);
    out.bzSVwapOK.push(sVwapOK);
    out.bzLMaTouch.push(lMaTouch);
    out.bzSMaTouch.push(sMaTouch);
    out.bzLMaHit.push(lT9 ? "SMA9" : lT13 ? "SMA13" : "SMA20");
    out.bzSMaHit.push(sT9 ? "SMA9" : sT13 ? "SMA13" : "SMA20");
    out.bzLongSig.push(bzLongSig);
    out.bzShortSig.push(bzShortSig);
  }
  return out;
}

function jnl_hpbDetectMaTouch(candles, hpb, idx, side) {
  var o = jnl_hpbDefaults();
  var isLong = side !== "short";
  var best = {
    checked: true,
    engineSignal: false,
    hard: false,
    ma: null,
    zoneOK: false,
    vwapBandOK: false,
    inSession: false,
    nearMa: false,
    atBar: null
  };
  if (!candles || !candles.length || !hpb || idx == null || idx < 0 || idx >= candles.length) return best;
  var bestRank = -1;
  for (var b = Math.max(1, idx - 2); b <= idx; b++) {
    var c = candles[b], p = candles[b - 1];
    if (isLong ? hpb.bzLongSig[b] : hpb.bzShortSig[b]) best.engineSignal = true;
    var body = Math.abs(c.close - c.open);
    var uW = c.high - Math.max(c.close, c.open);
    var lW = Math.min(c.close, c.open) - c.low;
    var atrVal = hpb.atr14[b];
    var bounceOk = isLong ? c.close > c.open && atrVal != null && body > atrVal * o.bzLBodyAtr && uW < body * o.bzLWickRatio : c.close < c.open && atrVal != null && body > atrVal * o.bzSBodyAtr && lW < body * o.bzSWickRatio;
    var mas = [ [ "SMA9", hpb.bzSma9 ], [ "SMA13", hpb.bzSma13 ], [ "SMA20", hpb.bzSma20 ] ];
    for (var mi = 0; mi < 3; mi++) {
      var maPrev = mas[mi][1][b - 1], maNow = mas[mi][1][b];
      if (maPrev == null || maNow == null) continue;
      var straddled = p.low <= maPrev && p.high >= maPrev;
      if (straddled) best.nearMa = true;
      var hard = straddled && bounceOk && (isLong ? c.close > maNow : c.close < maNow);
      if (!hard) continue;
      var zoneOK = isLong ? hpb.bzLZoneOK[b] : hpb.bzSZoneOK[b];
      var bandOK = isLong ? hpb.bzLVwapOK[b] : hpb.bzSVwapOK[b];
      var sess = hpb.bzSessionOK[b];
      var rank = (zoneOK ? 2 : 0) + (bandOK ? 2 : 0) + (sess ? 1 : 0) + (b === idx ? 1 : 0);
      if (rank > bestRank) {
        bestRank = rank;
        best.hard = true;
        best.ma = mas[mi][0];
        best.zoneOK = !!zoneOK;
        best.vwapBandOK = !!bandOK;
        best.inSession = !!sess;
        best.atBar = b;
      }
    }
  }
  return best;
}

function jnl_linReg(slice) {
  var n = slice.length;
  if (n < 2) return {
    slope: 0,
    r2: 0
  };
  var sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (var i = 0; i < n; i++) {
    sx += i;
    sy += slice[i];
    sxx += i * i;
    sxy += i * slice[i];
    syy += slice[i] * slice[i];
  }
  var denom = n * sxx - sx * sx;
  if (denom === 0) return {
    slope: 0,
    r2: 0
  };
  var slope = (n * sxy - sx * sy) / denom;
  var intercept = (sy - slope * sx) / n;
  var yMean = sy / n;
  var ssTot = syy - n * yMean * yMean;
  if (ssTot === 0) return {
    slope: slope,
    r2: 1
  };
  var ssRes = 0;
  for (var i = 0; i < n; i++) {
    var diff = slice[i] - (slope * i + intercept);
    ssRes += diff * diff;
  }
  return {
    slope: slope,
    r2: Math.max(0, 1 - ssRes / ssTot)
  };
}

function jnl_slopeProfile(values, atIndex, midPrice) {
  function profile(win) {
    if (atIndex < win - 1 || midPrice <= 0) return {
      slopePct: 0,
      r2: 0,
      signal: 0
    };
    var slice = values.slice(atIndex - win + 1, atIndex + 1);
    var lr = jnl_linReg(slice);
    var slopePct = lr.slope / midPrice * 100;
    return {
      slopePct: slopePct,
      r2: lr.r2,
      signal: slopePct * lr.r2
    };
  }
  var s5 = profile(5);
  var s15 = profile(15);
  var s30 = profile(30);
  s5.accel = s5.signal - s30.signal;
  s15.accel = s15.signal - s30.signal;
  s30.accel = 0;
  return {
    s5: s5,
    s15: s15,
    s30: s30
  };
}

function jnl_candlePattern(candles, atIndex) {
  if (atIndex < 4) return "unknown";
  var recent = candles.slice(atIndex - 4, atIndex + 1);
  var c = recent[4];
  var body = Math.abs(c.close - c.open);
  var range = c.high - c.low;
  var lowerWick = Math.min(c.open, c.close) - c.low;
  var upperWick = c.high - Math.max(c.open, c.close);
  var bodyPct = range > 0 ? body / range : 0;
  if (bodyPct < .1) return "doji";
  if (lowerWick >= 2 * body && upperWick < body) return "hammer";
  if (upperWick >= 2 * body && lowerWick < body) return "inverted_hammer";
  var prior = recent[3];
  var priorBody = Math.abs(prior.close - prior.open);
  var isEngulf = body > priorBody * 1.1 && (c.close > c.open && prior.close < prior.open || c.close < c.open && prior.close > prior.open);
  if (isEngulf) return "engulfing";
  var dir = c.close > c.open ? 1 : -1;
  var run = 0;
  for (var i = 0; i < 5; i++) {
    if ((recent[i].close > recent[i].open ? 1 : -1) === dir) run++;
  }
  if (run >= 4) return "momentum";
  var hiAll = Math.max.apply(null, recent.map(function(r) {
    return r.high;
  }));
  var loAll = Math.min.apply(null, recent.map(function(r) {
    return r.low;
  }));
  if (c.close > 0 && (hiAll - loAll) / c.close < .005) return "consolidation";
  return "other";
}

function jnl_calcEntrySnapshot(trade, allCandles, dayCandles, dailyCandles, etOffH, resolution, oneMinCandles) {
  if (!allCandles || !allCandles.length) return null;
  var entryTs = Math.floor(trade.entryTs / 1e3);
  var idx = -1;
  for (var i = 0; i < allCandles.length; i++) {
    if (allCandles[i].time <= entryTs) idx = i;
  }
  if (idx < 0) idx = 0;
  var dayIdx = 0;
  if (dayCandles && dayCandles.length) {
    for (var i = 0; i < dayCandles.length; i++) {
      if (dayCandles[i].time <= entryTs) dayIdx = i;
    }
  }
  var dc = dayCandles && dayCandles.length ? dayCandles : allCandles;
  var price = trade.entryPrice;
  var allCloses = allCandles.map(function(c) {
    return c.close;
  });
  for (var i = 1; i < allCloses.length; i++) {
    if (!allCloses[i] || isNaN(allCloses[i])) allCloses[i] = allCloses[i - 1] || 0;
  }
  var ema9vals = jnl_calcEma(allCloses, 9);
  var ema13vals = jnl_calcEma(allCloses, 13);
  var ema20vals = jnl_calcEma(allCloses, 20);
  var bb = jnl_calcBB(allCloses, 20, 2);
  var oneMinSrc = oneMinCandles && oneMinCandles.length ? oneMinCandles : (resolution || 1) === 1 ? allCandles : null;
  var sma5dArr;
  if (oneMinSrc) {
    sma5dArr = jnl_vcbMa5Day(oneMinSrc, allCandles, resolution || 1);
  } else {
    var barsPerDay5d = Math.round(390 / (resolution || 1));
    sma5dArr = jnl_calcSma(allCloses, 5 * barsPerDay5d);
  }
  var vcbSnap = jnl_vcbCompute(allCandles, etOffH, {
    ma5day: sma5dArr
  });
  var hpbSnap = jnl_hpbCompute(allCandles, etOffH, {});
  var vwapVals = vcbSnap.vwap1d;
  var wVwapVals = vcbSnap.vwapW;
  var twoDVwapVals = vcbSnap.vwap2d;
  function nearestNonNull(arr, i) {
    for (var d = 0; d <= 30; d++) {
      if (i - d >= 0 && arr[i - d] != null && !isNaN(arr[i - d])) return arr[i - d];
    }
    return null;
  }
  var ema9 = nearestNonNull(ema9vals, idx);
  var ema13 = nearestNonNull(ema13vals, idx);
  var ema20 = nearestNonNull(ema20vals, idx);
  var sma5d = nearestNonNull(sma5dArr, idx) || jnl_calcDailySma5(dailyCandles, trade.date);
  var vwapFilled = function() {
    var last = null;
    return vwapVals.map(function(v) {
      if (v != null) {
        last = v;
        return v;
      }
      return last;
    });
  }();
  var vwap = nearestNonNull(vwapFilled, idx);
  var wVwap = nearestNonNull(wVwapVals, idx);
  var bbU = nearestNonNull(bb.upper, idx);
  var bbL = nearestNonNull(bb.lower, idx);
  var bbM = bbU != null && bbL != null ? (bbU + bbL) / 2 : null;
  var dayHigh = null, dayLow = null;
  for (var i = 0; i <= dayIdx && i < dc.length; i++) {
    if (dayHigh === null || dc[i].high > dayHigh) dayHigh = dc[i].high;
    if (dayLow === null || dc[i].low < dayLow) dayLow = dc[i].low;
  }
  var pm = jnl_pmHiLo(dc, etOffH);
  var ah = jnl_ahHiLo(dc, etOffH);
  function rel(level) {
    return level != null && price > 0 ? (price - level) / price * 100 : null;
  }
  function eAt(arr) {
    return arr && arr[idx] != null ? arr[idx] : null;
  }
  var volEntry = allCandles[idx] ? allCandles[idx].volume : 0;
  var volSum = 0, volCount = 0;
  for (var i = 0; i < idx && i < allCandles.length; i++) {
    if (allCandles[i].volume > 0) {
      volSum += allCandles[i].volume;
      volCount++;
    }
  }
  var volAvg = volCount > 0 ? volSum / volCount : volEntry;
  var volPrior = idx > 0 && allCandles[idx - 1] ? allCandles[idx - 1].volume : volEntry;
  function slopeOf(vals) {
    var filtered = vals.slice(0, idx + 1).map(function(v) {
      return v != null && !isNaN(v) ? v : null;
    });
    for (var fi = 1; fi < filtered.length; fi++) {
      if (filtered[fi] == null) filtered[fi] = filtered[fi - 1];
    }
    var nonNull = filtered.filter(function(v) {
      return v != null;
    });
    return nonNull.length >= 5 ? jnl_slopeProfile(filtered, filtered.length - 1, price) : null;
  }
  var sp = {
    price: jnl_slopeProfile(allCloses, idx, price),
    ema9: ema9 != null ? slopeOf(ema9vals) : null,
    ema13: ema13 != null ? slopeOf(ema13vals) : null,
    ema20: ema20 != null ? slopeOf(ema20vals) : null,
    vwap: vwap != null ? slopeOf(vwapFilled) : null,
    wVwap: wVwap != null ? slopeOf(wVwapVals) : null
  };
  var twoD = nearestNonNull(twoDVwapVals, idx);
  sp.twoDVwap = twoD != null ? slopeOf(twoDVwapVals) : null;
  var dir = trade.side === "long" ? 1 : -1;
  var aligned = 0;
  [ sp.price, sp.ema9, sp.ema20, sp.vwap ].forEach(function(s) {
    if (s && s.s5 && s.s5.signal * dir > .001) aligned++;
  });
  var ema13AboveEma20 = ema13 != null && ema20 != null ? ema13 > ema20 : null;
  var ema9AboveEma13 = ema9 != null && ema13 != null ? ema9 > ema13 : null;
  var fullBullStack = ema9AboveEma13 === true && ema13AboveEma20 === true;
  var fullBearStack = ema9AboveEma13 === false && ema13AboveEma20 === false;
  var vwapSignal = sp.vwap && sp.vwap.s5 ? sp.vwap.s5.signal : null;
  var vwapAligned = vwapSignal != null ? vwapSignal * dir > .001 ? "with" : vwapSignal * dir < -.001 ? "against" : "flat" : null;
  var bbBandwidthPct = bbU != null && bbL != null && bbM != null && bbM > 0 ? (bbU - bbL) / bbM * 100 : null;
  var bbPositionPct = price != null && bbU != null && bbL != null && bbU - bbL > 0 ? (price - bbL) / (bbU - bbL) * 100 : null;
  var bbZone = null;
  if (price != null && bbU != null && bbL != null && bbM != null) {
    var rng = bbU - bbL;
    if (price > bbU) bbZone = "above_upper"; else if (price < bbL) bbZone = "below_lower"; else if (price > bbM + rng * .25) bbZone = "upper_25"; else if (price < bbM - rng * .25) bbZone = "lower_25"; else bbZone = "mid_50";
  }
  var slopeBbWidth = null;
  if (bbU != null && bbL != null) {
    var widths = [];
    for (var i = 0; i <= idx; i++) {
      var w = bb.upper[i] != null && bb.lower[i] != null ? bb.upper[i] - bb.lower[i] : null;
      widths.push(w);
    }
    for (var i = 1; i < widths.length; i++) {
      if (widths[i] == null) widths[i] = widths[i - 1];
    }
    var nw = widths.filter(function(v) {
      return v != null;
    });
    if (nw.length >= 5) slopeBbWidth = jnl_slopeProfile(widths, widths.length - 1, bbM || price);
  }
  var marketBias = trade.marketBias || null;
  var hotSectors = trade.hotSectors || [];
  var d = new Date(trade.entryTs);
  var etH = d.getUTCHours() + d.getUTCMinutes() / 60 - etOffH;
  var minFromOpen = Math.round((etH - 9.5) * 60);
  var sessionPeriod = minFromOpen < 0 ? "pre" : minFromOpen < 60 ? "early" : minFromOpen < 210 ? "mid" : "late";
  var etDate = new Date(trade.entryTs - etOffH * 36e5);
  var dayOfWeek = etDate.getUTCDay();
  var pattern = jnl_candlePattern(dayCandles && dayCandles.length ? dayCandles : allCandles, dayIdx);
  return {
    priceRelVwap: rel(vwap),
    priceRelEma9: rel(ema9),
    priceRelEma13: rel(ema13),
    priceRelEma20: rel(ema20),
    priceRelBbUpper: rel(bbU),
    priceRelBbLower: rel(bbL),
    priceRelBbMid: rel(bbM),
    priceRelPmHigh: rel(pm.high),
    priceRelPmLow: rel(pm.low),
    priceRelAhHigh: rel(ah.high),
    priceRelAhLow: rel(ah.low),
    priceRelWVwap: rel(wVwap),
    priceRelTwoDVwap: rel(twoD),
    priceRel5dMa: rel(sma5d),
    vwapVal: vwap,
    ema9Val: ema9,
    ema13Val: ema13,
    ema20Val: ema20,
    wVwapVal: wVwap,
    twoDVwapVal: twoD,
    bbUpperVal: bbU,
    bbLowerVal: bbL,
    sma5dVal: sma5d,
    pmHighVal: pm.high,
    pmLowVal: pm.low,
    ahHighVal: ah.high,
    ahLowVal: ah.low,
    volumeAtEntry: volEntry,
    volumeRelSessionAvg: volAvg > 0 ? volEntry / volAvg : null,
    volumeRelPriorBar: volPrior > 0 ? volEntry / volPrior : null,
    slopePrice: sp.price,
    slopeEma9: sp.ema9,
    slopeEma13: sp.ema13,
    slopeEma20: sp.ema20,
    slopeVwap: sp.vwap,
    slopeWVwap: sp.wVwap,
    slopeTwoDVwap: sp.twoDVwap,
    slopeAlignment: aligned,
    ema13AboveEma20: ema13AboveEma20,
    ema9AboveEma13: ema9AboveEma13,
    fullBullStack: fullBullStack,
    fullBearStack: fullBearStack,
    vwapAligned: vwapAligned,
    vwapSignal: vwapSignal,
    bbBandwidthPct: bbBandwidthPct,
    bbPositionPct: bbPositionPct,
    bbZone: bbZone,
    slopeBbWidth: slopeBbWidth,
    marketBias: marketBias,
    hotSectors: hotSectors,
    sessionPeriod: sessionPeriod,
    minutesFromOpen: minFromOpen,
    dayOfWeek: dayOfWeek,
    candlePattern: pattern,
    clusterAVal: vcbSnap.clusterA[idx] != null ? vcbSnap.clusterA[idx] : null,
    clusterBVal: vcbSnap.clusterB[idx] != null ? vcbSnap.clusterB[idx] : null,
    vwapBounce: jnl_vcbDetectBounce(allCandles, vcbSnap, idx, trade.side),
    maTouch: jnl_hpbDetectMaTouch(allCandles, hpbSnap, idx, trade.side),
    l3PullbackLong: hpbSnap.l3LongSig[idx] || idx > 0 && hpbSnap.l3LongSig[idx - 1] || idx > 1 && hpbSnap.l3LongSig[idx - 2] || false,
    snapshotVersion: 2,
    mVwapVal: eAt(vcbSnap.vwapM),
    priceRelMVwap: rel(eAt(vcbSnap.vwapM)),
    vwapHHVal: eAt(vcbSnap.vwapHH),
    priceRelVwapHH: rel(eAt(vcbSnap.vwapHH)),
    vwapLLVal: eAt(vcbSnap.vwapLL),
    priceRelVwapLL: rel(eAt(vcbSnap.vwapLL)),
    weekHHVal: eAt(vcbSnap.vwapWeekHH),
    priceRelWeekHH: rel(eAt(vcbSnap.vwapWeekHH)),
    weekLLVal: eAt(vcbSnap.vwapWeekLL),
    priceRelWeekLL: rel(eAt(vcbSnap.vwapWeekLL)),
    gapVwapVal: eAt(vcbSnap.vwapGap),
    priceRelGapVwap: rel(eAt(vcbSnap.vwapGap)),
    lhLLVal: eAt(vcbSnap.vwapLhLL),
    priceRelLhLL: rel(eAt(vcbSnap.vwapLhLL)),
    lhHHVal: eAt(vcbSnap.vwapLhHH),
    priceRelLhHH: rel(eAt(vcbSnap.vwapLhHH)),
    priceRelClusterA: rel(eAt(vcbSnap.clusterA)),
    priceRelClusterB: rel(eAt(vcbSnap.clusterB)),
    clusterANames: vcbSnap.clusterANames[idx] || "",
    clusterBNames: vcbSnap.clusterBNames[idx] || "",
    sma9Val: eAt(hpbSnap.bzSma9),
    priceRelSma9: rel(eAt(hpbSnap.bzSma9)),
    sma13Val: eAt(hpbSnap.bzSma13),
    priceRelSma13: rel(eAt(hpbSnap.bzSma13)),
    sma20Val: eAt(hpbSnap.bzSma20),
    priceRelSma20: rel(eAt(hpbSnap.bzSma20)),
    vwapSigmaUpVal: eAt(hpbSnap.bzLVwapBand),
    priceRelSigmaUp: rel(eAt(hpbSnap.bzLVwapBand)),
    vwapSigmaDnVal: eAt(hpbSnap.bzSVwapBand),
    priceRelSigmaDn: rel(eAt(hpbSnap.bzSVwapBand)),
    vwapStdevVal: eAt(hpbSnap.vwapStdev),
    atr14Val: eAt(hpbSnap.atr14),
    l3Bias: !!hpbSnap.l3LongBias[idx],
    l3SlopeScore: hpbSnap.l3SlopeScore[idx] != null ? hpbSnap.l3SlopeScore[idx] : null,
    bzSessionOK: !!hpbSnap.bzSessionOK[idx],
    bzZoneOK: trade.side === "short" ? !!hpbSnap.bzSZoneOK[idx] : !!hpbSnap.bzLZoneOK[idx],
    bzVwapBandOK: trade.side === "short" ? !!hpbSnap.bzSVwapOK[idx] : !!hpbSnap.bzLVwapOK[idx],
    capturedAt: Date.now()
  };
}

function jnl_calcExitStats(trade, dayCandles, dailyAtr) {
  if (!dayCandles || !dayCandles.length || !trade.exitTs) return null;
  var entryTs = Math.floor(trade.entryTs / 1e3);
  var exitTs = Math.floor(trade.exitTs / 1e3);
  var isLong = trade.side === "long";
  var entry = trade.entryPrice;
  var exit = trade.exitPrice;
  var slice = dayCandles.filter(function(c) {
    return c.time >= entryTs && c.time <= exitTs;
  });
  if (!slice.length) return null;
  var mae = isLong ? Math.min.apply(null, slice.map(function(c) {
    return c.low;
  })) : Math.max.apply(null, slice.map(function(c) {
    return c.high;
  }));
  var mfe = isLong ? Math.max.apply(null, slice.map(function(c) {
    return c.high;
  })) : Math.min.apply(null, slice.map(function(c) {
    return c.low;
  }));
  var riskTaken = Math.abs(entry - mae);
  var rewardTaken = Math.abs(exit - entry);
  var available = Math.abs(mfe - entry);
  var rMultiple = riskTaken > 0 ? rewardTaken / riskTaken : null;
  var capturePct = available > 0 ? Math.min(100, rewardTaken / available * 100) : null;
  var verdict;
  if (capturePct === null) {
    verdict = "no exit data";
  } else if (riskTaken > 0 && Math.abs(exit - mae) / entry < .002) {
    verdict = "stopped_out";
  } else if (capturePct >= 80) {
    verdict = "excellent";
  } else if (capturePct >= 50) {
    verdict = "good";
  } else if (capturePct >= 30) {
    verdict = "early";
  } else {
    verdict = "very_early";
  }
  var postSlice = dayCandles.filter(function(c) {
    return c.time > exitTs && c.time <= exitTs + 1800;
  });
  var maxFavAfter = null;
  if (postSlice.length) {
    maxFavAfter = isLong ? Math.max.apply(null, postSlice.map(function(c) {
      return c.high;
    })) - exit : exit - Math.min.apply(null, postSlice.map(function(c) {
      return c.low;
    }));
  }
  return {
    mae: mae,
    mfe: mfe,
    maePct: entry > 0 ? (mae - entry) / entry * 100 : null,
    mfePct: entry > 0 ? (mfe - entry) / entry * 100 : null,
    riskTaken: riskTaken,
    rMultiple: rMultiple ? Math.round(rMultiple * 100) / 100 : null,
    capturePct: capturePct ? Math.round(capturePct) : null,
    verdict: verdict,
    maxFavorableAfterExit: maxFavAfter ? Math.round(maxFavAfter * 100) / 100 : null,
    postExitBars: postSlice.length,
    dailyAtr: dailyAtr || null,
    exitSignals: []
  };
}

function jnl_detectExitSignals(trade, dayCandles, allCandles, dailyAtr) {
  if (!dayCandles || !dayCandles.length || !dailyAtr) return [];
  var isLong = trade.side === "long";
  var entryTs = Math.floor(trade.entryTs / 1e3);
  var exitTs = trade.exitTs ? Math.floor(trade.exitTs / 1e3) : dayCandles[dayCandles.length - 1].time;
  var entryPrice = trade.entryPrice;
  var slice = dayCandles.filter(function(c) {
    return c.time >= entryTs && c.time <= exitTs;
  });
  if (slice.length < 3) return [];
  var preEntry = dayCandles.filter(function(c) {
    return c.time < entryTs && c.volume > 0;
  });
  var volAvg = preEntry.length ? preEntry.reduce(function(s, c) {
    return s + c.volume;
  }, 0) / preEntry.length : slice[0].volume || 1;
  var avgBody = slice.reduce(function(s, c) {
    return s + Math.abs(c.close - c.open);
  }, 0) / slice.length;
  var allClosesForEma = (allCandles || dayCandles).map(function(c) {
    return c.close || 0;
  });
  for (var fi = 1; fi < allClosesForEma.length; fi++) {
    if (!allClosesForEma[fi]) allClosesForEma[fi] = allClosesForEma[fi - 1];
  }
  var ema20arr = jnl_calcEma(allClosesForEma, 20);
  var timeToAllIdx = {};
  (allCandles || dayCandles).forEach(function(c, i) {
    timeToAllIdx[c.time] = i;
  });
  var signals = [];
  for (var i = 2; i < slice.length; i++) {
    var c0 = slice[i - 2], c1 = slice[i - 1], c2 = slice[i];
    if (isLong) {
      if (c0.close < c0.open && c1.close < c1.open && c2.close < c2.open) {
        var lls = (c1.low < c0.low ? 1 : 0) + (c2.low < c1.low ? 1 : 0);
        if (lls >= 2) {
          signals.push({
            type: "consec_red",
            at: c2.time,
            label: "3 red candles (" + lls + " lower lows)"
          });
          i += 2;
        }
      }
    } else {
      if (c0.close > c0.open && c1.close > c1.open && c2.close > c2.open) {
        var hhs = (c1.high > c0.high ? 1 : 0) + (c2.high > c1.high ? 1 : 0);
        if (hhs >= 2) {
          signals.push({
            type: "consec_green",
            at: c2.time,
            label: "3 green candles (" + hhs + " higher highs)"
          });
          i += 2;
        }
      }
    }
  }
  for (var i = 0; i < slice.length - 7; i++) {
    var move = isLong ? slice[i].close - entryPrice : entryPrice - slice[i].close;
    if (move < dailyAtr) continue;
    var hi = slice[i].high, lo = slice[i].low;
    for (var j = i + 1; j < i + 7; j++) {
      hi = Math.max(hi, slice[j].high);
      lo = Math.min(lo, slice[j].low);
    }
    if (hi - lo > dailyAtr * .15) continue;
    for (var k = i + 7; k < slice.length; k++) {
      if (isLong && slice[k].close < lo || !isLong && slice[k].close > hi) {
        signals.push({
          type: "consol_break",
          at: slice[k].time,
          label: "consolidation breakdown (range " + ((hi - lo) / dailyAtr * 100).toFixed(0) + "% ATR)"
        });
        break;
      }
    }
  }
  for (var i = 1; i < slice.length; i++) {
    var idx = timeToAllIdx[slice[i].time];
    var idxP = timeToAllIdx[slice[i - 1].time];
    if (idx == null || idxP == null || ema20arr[idx] == null || ema20arr[idxP] == null) continue;
    var crossBelow = isLong ? slice[i - 1].close >= ema20arr[idxP] && slice[i].close < ema20arr[idx] : slice[i - 1].close <= ema20arr[idxP] && slice[i].close > ema20arr[idx];
    if (crossBelow && slice[i].volume > volAvg * 1.2) {
      signals.push({
        type: "below_ema20",
        at: slice[i].time,
        label: "crossed EMA20 (" + (slice[i].volume / volAvg).toFixed(1) + "× vol)"
      });
    }
  }
  for (var i = 1; i < slice.length; i++) {
    var move = isLong ? slice[i].high - entryPrice : entryPrice - slice[i].low;
    if (move < dailyAtr * 1.5) continue;
    var c = slice[i];
    var body = Math.abs(c.close - c.open) || 1e-4;
    var upperWick = c.high - Math.max(c.open, c.close);
    var lowerWick = Math.min(c.open, c.close) - c.low;
    var range = c.high - c.low || 1e-4;
    var hasWick = isLong ? upperWick >= 2 * body && upperWick > range * .5 : lowerWick >= 2 * body && lowerWick > range * .5;
    if (hasWick && c.volume > volAvg) {
      signals.push({
        type: "high_wick",
        at: c.time,
        label: "shooting star (" + (move / dailyAtr).toFixed(1) + "ATR, " + (c.volume / volAvg).toFixed(1) + "× vol)"
      });
    }
  }
  for (var i = 0; i < slice.length; i++) {
    var move = isLong ? slice[i].high - entryPrice : entryPrice - slice[i].low;
    if (move < dailyAtr * 1.5) continue;
    var body = Math.abs(slice[i].close - slice[i].open);
    if (slice[i].volume > volAvg * 3 && body > avgBody) {
      signals.push({
        type: "exhaustion",
        at: slice[i].time,
        label: "exhaustion (" + (slice[i].volume / volAvg).toFixed(1) + "× vol, " + (move / dailyAtr).toFixed(1) + "ATR)"
      });
    }
  }
  var seen = {}, out = [];
  signals.forEach(function(s) {
    if (!seen[s.type]) {
      seen[s.type] = true;
      out.push(s);
    }
  });
  out.sort(function(a, b) {
    return a.at - b.at;
  });
  return out;
}

function jnl_scoreVwapBounce(snap, trade) {
  if (!snap) return 0;
  var dir = trade.side === "long" ? 1 : -1;
  var vb = snap.vwapBounce;
  if (vb && vb.checked) {
    if (vb.engineSignal) return 1;
    if (trade.side === "long" && snap.l3PullbackLong) return .95;
    if (vb.hard) {
      var s = .55 + Math.min(2, vb.coreScore) * .125 + Math.min(4, vb.extraScore) * .05;
      if (vb.level === "ClusterA" || vb.level === "ClusterB") s += .05;
      return Math.min(1, s);
    }
    var w = vb.nearZone ? .25 : 0;
    if (vb.nearZone && snap.slopeVwap && snap.slopeVwap.s5 && snap.slopeVwap.s5.signal * dir > .001) w += .1;
    return w;
  }
  var score = 0;
  if (snap.priceRelVwap !== null && Math.abs(snap.priceRelVwap) < .5) score += .25; else if (snap.priceRelVwap !== null && Math.abs(snap.priceRelVwap) < 1) score += .1;
  if (snap.priceRelVwap !== null && snap.priceRelVwap * dir < .2) score += .25;
  if (snap.slopeVwap && snap.slopeVwap.s5 && snap.slopeVwap.s5.signal * dir > .001) score += .2;
  if (snap.slopePrice && snap.slopePrice.s5 && snap.slopePrice.s5.accel * dir > 0) score += .15;
  if (snap.volumeRelPriorBar && snap.volumeRelPriorBar > 1.2) score += .1;
  if (snap.vwapVal == null) score *= .5;
  return Math.min(1, score);
}

function jnl_scoreMaBounce(snap, trade) {
  if (!snap) return 0;
  var dir = trade.side === "long" ? 1 : -1;
  var mt = snap.maTouch;
  if (mt && mt.checked) {
    if (mt.engineSignal) return 1;
    if (mt.hard) {
      var s = .55 + (mt.zoneOK ? .15 : 0) + (mt.vwapBandOK ? .15 : 0) + (mt.inSession ? .1 : 0);
      return Math.min(1, s);
    }
    var w = mt.nearMa ? .25 : 0;
    if (mt.nearMa && snap.slopeEma9 && snap.slopeEma9.s15 && snap.slopeEma9.s15.signal * dir > .001) w += .1;
    return w;
  }
  var score = 0;
  var nearEma9 = snap.priceRelEma9 !== null && Math.abs(snap.priceRelEma9) < .5;
  var nearEma20 = snap.priceRelEma20 !== null && Math.abs(snap.priceRelEma20) < .5;
  if (nearEma9 || nearEma20) score += .3; else if (snap.priceRelEma9 !== null && Math.abs(snap.priceRelEma9) < 1 || snap.priceRelEma20 !== null && Math.abs(snap.priceRelEma20) < 1) score += .12;
  if (snap.slopeEma9 && snap.slopeEma9.s15 && snap.slopeEma9.s15.signal * dir > .001) score += .2;
  if (snap.slopeEma20 && snap.slopeEma20.s15 && snap.slopeEma20.s15.signal * dir > .001) score += .1;
  if (snap.priceRelEma9 !== null && snap.priceRelEma20 !== null && snap.priceRelEma9 * dir > 0 && snap.priceRelEma20 * dir > 0) score += .15;
  if (snap.slopePrice && snap.slopePrice.s5 && snap.slopePrice.s5.accel * dir > 0) score += .15;
  return Math.min(1, score);
}

function jnl_scoreCatchLowHigh(snap, trade) {
  if (!snap) return 0;
  var dir = trade.side === "long" ? 1 : -1;
  var score = 0;
  var nearDayExt = trade.side === "long" && snap.priceRelAhLow != null && Math.abs(snap.priceRelAhLow) < .5 || trade.side === "short" && snap.priceRelAhHigh != null && Math.abs(snap.priceRelAhHigh) < .5;
  var nearPmExt = trade.side === "long" && snap.priceRelPmLow != null && Math.abs(snap.priceRelPmLow) < .5 || trade.side === "short" && snap.priceRelPmHigh != null && Math.abs(snap.priceRelPmHigh) < .5;
  if (nearDayExt || nearPmExt) score += .35; else if (trade.side === "long" && snap.priceRelAhLow != null && Math.abs(snap.priceRelAhLow) < 1 || trade.side === "short" && snap.priceRelAhHigh != null && Math.abs(snap.priceRelAhHigh) < 1) score += .15;
  if (snap.candlePattern === "hammer" || snap.candlePattern === "engulfing" || snap.candlePattern === "doji") score += .25;
  if (snap.volumeRelPriorBar && snap.volumeRelPriorBar > 1.5) score += .2;
  if (snap.slopePrice && snap.slopePrice.s5 && snap.slopePrice.s5.signal * dir > 0) score += .15;
  if (snap.slopePrice && snap.slopePrice.s30 && snap.slopePrice.s30.signal * dir < -.001) score += .05;
  return Math.min(1, score);
}

function jnl_assignSetup(snap, trade) {
  var scores = {
    vwap_bounce: jnl_scoreVwapBounce(snap, trade),
    ma_bounce: jnl_scoreMaBounce(snap, trade),
    catch_low_high: jnl_scoreCatchLowHigh(snap, trade)
  };
  var best = "unknown", bestScore = .4;
  Object.keys(scores).forEach(function(k) {
    if (scores[k] > bestScore) {
      best = k;
      bestScore = scores[k];
    }
  });
  return {
    setup: best,
    scores: scores,
    topScore: bestScore
  };
}

function jnl_entryQualityScore(snap, setupScore, trade) {
  if (trade && trade.checklistPass != null && trade.checklistTotal > 0) {
    return Math.round(trade.checklistPass / trade.checklistTotal * 100);
  }
  if (!snap) return null;
  var slopeAlignFraction = (snap.slopeAlignment || 0) / 4;
  var volumeConfirm = snap.volumeRelSessionAvg ? Math.min(1, (snap.volumeRelSessionAvg - 1) / 2 + .5) : .5;
  var timingBonus = snap.sessionPeriod === "early" ? 1 : snap.sessionPeriod === "mid" ? .8 : .5;
  return Math.round(slopeAlignFraction * 30 + (setupScore || 0) * 40 + volumeConfirm * 15 + timingBonus * 15);
}

var JNL_SETUP_LABELS = {
  vwap_bounce: "VWAP Bounce",
  ma_bounce: "MA Bounce",
  catch_low_high: "Catch Low/High",
  unknown: "?"
};

var JNL_SETUP_COLORS = {
  vwap_bounce: "#06b6d4",
  ma_bounce: "#f59e0b",
  catch_low_high: "#a78bfa",
  unknown: "#475569"
};

var JNL_VERDICT_LABELS = {
  excellent: "Excellent capture",
  good: "Good exit",
  early: "Left money on table",
  very_early: "Exited very early",
  stopped_out: "Stopped out",
  "no exit data": "—"
};

function jnl_setupLabel(trade) {
  var s = trade.setupOverride || trade.setup || "unknown";
  return s;
}

function jnl_renderSetupChip(trade) {
  var key = jnl_setupLabel(trade);
  var label = JNL_SETUP_LABELS[key] || key;
  var color = JNL_SETUP_COLORS[key] || "#475569";
  var isOverridden = trade.setupOverride ? " ✎" : "";
  return '<span class="jnl-setup-chip" data-trade-id="' + trade.id + '" style="cursor:pointer;font-size:10px;font-weight:600;color:' + color + ";background:" + color + "22;padding:2px 7px;border-radius:4px;border:1px solid " + color + '44">' + label + isOverridden + "</span>";
}

function jnl_renderEntryQualityBar(score) {
  if (score === null || score === undefined) return "";
  var color = score >= 70 ? "#22c55e" : score >= 40 ? "#f59e0b" : "#ef4444";
  var filled = Math.round(score / 10);
  var bar = "█".repeat(filled) + "░".repeat(10 - filled);
  return '<span style="font-size:10px;color:' + color + ';font-family:monospace">' + bar + '</span> <span style="font-size:10px;color:' + color + '">' + score + "/100</span>";
}

function jnl_renderExitRow(exitStats, trade) {
  if (!exitStats) return "";
  var verdictLabel = JNL_VERDICT_LABELS[exitStats.verdict] || exitStats.verdict;
  var capColor = exitStats.capturePct >= 70 ? "#22c55e" : exitStats.capturePct >= 40 ? "#f59e0b" : "#ef4444";
  var html = '<div style="margin-top:6px;padding-top:6px;border-top:1px solid #1e293b;font-size:10px;color:#475569;display:flex;flex-wrap:wrap;gap:6px 14px">' + '<span>MAE: <b style="color:#ef4444">' + (exitStats.maePct != null ? exitStats.maePct.toFixed(1) + "%" : "—") + "</b></span>" + '<span>MFE: <b style="color:#22c55e">' + (exitStats.mfePct != null ? (exitStats.mfePct >= 0 ? "+" : "") + exitStats.mfePct.toFixed(1) + "%" : "—") + "</b></span>" + '<span>Capture: <b style="color:' + capColor + '">' + (exitStats.capturePct != null ? exitStats.capturePct + "%" : "—") + "</b></span>" + '<span>R: <b style="color:#e2e8f0">' + (exitStats.rMultiple != null ? exitStats.rMultiple + "R" : "—") + "</b></span>" + '<span style="color:#64748b">' + verdictLabel + "</span>" + (exitStats.dailyAtr ? '<span style="color:#475569">ATR ' + exitStats.dailyAtr.toFixed(2) + "</span>" : "") + (exitStats.maxFavorableAfterExit ? '<span style="color:#64748b">+$' + exitStats.maxFavorableAfterExit + " left after exit</span>" : "") + "</div>";
  var sigs = exitStats.exitSignals;
  if (sigs && sigs.length) {
    var exitTs = trade && trade.exitTs ? Math.floor(trade.exitTs / 1e3) : null;
    var sigRows = sigs.map(function(s) {
      var etOff = new Date(s.at * 1e3).getUTCMonth() >= 2 && new Date(s.at * 1e3).getUTCMonth() <= 10 ? 4 : 5;
      var d = new Date(s.at * 1e3 - etOff * 36e5);
      var timeStr = d.getUTCHours().toString().padStart(2, "0") + ":" + d.getUTCMinutes().toString().padStart(2, "0") + " ET";
      var rel = "", relColor = "#64748b";
      if (exitTs != null) {
        if (s.at < exitTs) {
          rel = " ← before exit";
          relColor = "#f59e0b";
        } else if (s.at === exitTs) {
          rel = " ← at exit";
          relColor = "#22c55e";
        } else {
          rel = " ← after exit";
          relColor = "#64748b";
        }
      }
      return '<div style="padding:2px 0;font-size:10px">🔴 <span style="color:#e2e8f0">' + s.label + "</span>" + ' <span style="color:#475569">' + timeStr + "</span>" + '<span style="color:' + relColor + ';font-size:9px">' + rel + "</span></div>";
    }).join("");
    html += '<div style="padding:4px 0 2px;border-top:1px solid #1e293b;margin-top:4px">' + '<div style="color:#64748b;font-size:9px;letter-spacing:0.05em;margin-bottom:2px">EXIT SIGNALS</div>' + sigRows + "</div>";
  }
  var tradeId = trade ? trade.id : null;
  var exitReasonLabels = {
    consec_red: "3 Red Candles",
    consec_green: "3 Green Candles",
    consol_break: "Consol. Break",
    below_ema20: "Below EMA20",
    high_wick: "Shooting Star",
    exhaustion: "Exhaustion",
    other: "Other"
  };
  var override = trade && trade.exitReasonOverride;
  var activeReason = override;
  var isOverride = !!override;
  var conf = null;
  var note = null;
  var reasonHtml = "";
  if (activeReason) {
    var chipColor = isOverride ? "#7c3aed" : conf >= .7 ? "#22c55e" : conf >= .4 ? "#f59e0b" : "#64748b";
    var chipLabel = exitReasonLabels[activeReason] || activeReason;
    var confStr = conf != null ? " · " + Math.round(conf * 100) + "%" : "";
    var srcLabel = isOverride ? " ✏️" : " 🤖";
    reasonHtml = '<div style="display:flex;align-items:center;gap:6px;margin-top:4px;flex-wrap:wrap">' + '<span style="color:#64748b;font-size:9px">EXIT REASON:</span>' + '<span style="font-size:10px;padding:1px 6px;border-radius:3px;background:' + chipColor + "22;color:" + chipColor + ";border:1px solid " + chipColor + '44">' + chipLabel + confStr + srcLabel + "</span>" + (note ? '<span style="color:#475569;font-size:9px">' + note + "</span>" : "") + (tradeId ? '<button class="jnl-reason-open" data-trade-id="' + tradeId + '" style="font-size:9px;padding:1px 5px;background:#1e293b;color:#64748b;border:1px solid #334155;border-radius:3px;cursor:pointer">change</button>' : "") + "</div>";
  } else if (tradeId) {
    reasonHtml = '<div style="margin-top:4px">' + '<span style="color:#475569;font-size:9px">exit reason: </span>' + '<button class="jnl-reason-open" data-trade-id="' + tradeId + '" style="font-size:9px;padding:1px 6px;background:#1e293b;color:#7c3aed;border:1px solid #4c1d95;border-radius:3px;cursor:pointer">assign ▾</button>' + "</div>";
  }
  if (reasonHtml) html += reasonHtml;
  if (tradeId) {
    var isLong = trade.side === "long";
    var pickerOptions = [ {
      v: isLong ? "consec_red" : "consec_green",
      l: isLong ? "3 Red Candles (LL)" : "3 Green Candles (HH)"
    }, {
      v: "consol_break",
      l: "Consolidation Break"
    }, {
      v: "below_ema20",
      l: "Cross EMA20 + Vol"
    }, {
      v: "high_wick",
      l: isLong ? "Shooting Star" : "Hammer / Long Wick"
    }, {
      v: "exhaustion",
      l: "Exhaustion Candle"
    }, {
      v: "other",
      l: "Other"
    } ];
    var pickerBtns = pickerOptions.map(function(o) {
      var isActive = activeReason === o.v;
      return '<button class="jnl-reason-set" data-trade-id="' + tradeId + '" data-reason="' + o.v + '" ' + 'style="font-size:10px;padding:3px 8px;background:' + (isActive ? "#334155" : "#0f172a") + ";color:" + (isActive ? "#e2e8f0" : "#94a3b8") + ';border:1px solid #1e293b;border-radius:3px;cursor:pointer">' + o.l + (isActive ? " ✓" : "") + "</button>";
    }).join("");
    html += '<div id="jnl-reason-picker-' + tradeId + '" style="display:none;margin-top:4px;padding:6px;background:#0f172a;border:1px solid #1e293b;border-radius:4px">' + '<div style="color:#64748b;font-size:9px;margin-bottom:4px">SELECT EXIT REASON:</div>' + '<div style="display:flex;flex-wrap:wrap;gap:4px">' + pickerBtns + "</div>" + (override ? '<button class="jnl-reason-clear" data-trade-id="' + tradeId + '" style="margin-top:4px;font-size:9px;padding:2px 6px;background:#1e293b;color:#ef4444;border:1px solid #7f1d1d;border-radius:3px;cursor:pointer">clear override</button>' : "") + "</div>";
  }
  return html;
}

function jnl_computeAccountStats(trades) {
  var closed = trades.filter(function(t) {
    return !t.open && t.netPnl !== null;
  });
  if (!closed.length) return null;
  var wins = closed.filter(function(t) {
    return t.netPnl > 0;
  });
  var losses = closed.filter(function(t) {
    return t.netPnl < 0;
  });
  var totalPnl = closed.reduce(function(s, t) {
    return s + t.netPnl;
  }, 0);
  var grossWin = wins.reduce(function(s, t) {
    return s + t.netPnl;
  }, 0);
  var grossLoss = Math.abs(losses.reduce(function(s, t) {
    return s + t.netPnl;
  }, 0));
  var avgWin = wins.length ? grossWin / wins.length : 0;
  var avgLoss = losses.length ? grossLoss / losses.length : 0;
  var pf = grossLoss > 0 ? grossWin / grossLoss : null;
  var expectancy = closed.length > 0 ? wins.length / closed.length * avgWin - losses.length / closed.length * avgLoss : 0;
  var rMults = closed.filter(function(t) {
    return t.exitAnalysis && t.exitAnalysis.rMultiple !== null;
  });
  var avgR = rMults.length ? rMults.reduce(function(s, t) {
    return s + t.exitAnalysis.rMultiple;
  }, 0) / rMults.length : null;
  var sorted = closed.slice().sort(function(a, b) {
    return b.netPnl - a.netPnl;
  });
  var streak = 0, streakDir = 0;
  for (var i = closed.length - 1; i >= 0; i--) {
    var dir = closed[i].netPnl > 0 ? 1 : -1;
    if (i === closed.length - 1) {
      streak = 1;
      streakDir = dir;
    } else if (dir === streakDir) streak++; else break;
  }
  var withDur = closed.filter(function(t) {
    return t.durationMs;
  });
  var avgDurMs = withDur.length ? withDur.reduce(function(s, t) {
    return s + t.durationMs;
  }, 0) / withDur.length : null;
  return {
    totalTrades: trades.length,
    closedTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? wins.length / closed.length * 100 : 0,
    totalPnl: totalPnl,
    avgTrade: closed.length ? totalPnl / closed.length : 0,
    avgWin: avgWin,
    avgLoss: avgLoss,
    profitFactor: pf,
    expectancy: expectancy,
    avgR: avgR,
    bestTrade: sorted[0] || null,
    worstTrade: sorted[sorted.length - 1] || null,
    streak: streak,
    streakDir: streakDir,
    avgDurMs: avgDurMs
  };
}

function jnl_computeSetupStats(trades) {
  var grouped = {};
  trades.forEach(function(t) {
    var setup = t.setupOverride || t.setup;
    if (!setup || setup === "unknown") return;
    if (!grouped[setup]) grouped[setup] = [];
    grouped[setup].push(t);
  });
  var result = [];
  Object.keys(grouped).forEach(function(setup) {
    var ts = grouped[setup];
    var closed = ts.filter(function(t) {
      return !t.open && t.netPnl !== null;
    });
    if (!closed.length) return;
    var wins = closed.filter(function(t) {
      return t.netPnl > 0;
    });
    var totalPnl = closed.reduce(function(s, t) {
      return s + t.netPnl;
    }, 0);
    var rMults = closed.filter(function(t) {
      return t.exitAnalysis && t.exitAnalysis.rMultiple !== null;
    });
    var avgR = rMults.length ? rMults.reduce(function(s, t) {
      return s + t.exitAnalysis.rMultiple;
    }, 0) / rMults.length : null;
    var caps = closed.filter(function(t) {
      return t.exitAnalysis && t.exitAnalysis.capturePct !== null;
    });
    var avgCap = caps.length ? caps.reduce(function(s, t) {
      return s + t.exitAnalysis.capturePct;
    }, 0) / caps.length : null;
    var bySession = {};
    [ "early", "mid", "late" ].forEach(function(p) {
      var seg = closed.filter(function(t) {
        return t.snapshot && t.snapshot.sessionPeriod === p;
      });
      if (seg.length) bySession[p] = {
        n: seg.length,
        winRate: seg.filter(function(t) {
          return t.netPnl > 0;
        }).length / seg.length * 100
      };
    });
    var byAlign = {};
    [ 0, 1, 2, 3, 4 ].forEach(function(a) {
      var seg = closed.filter(function(t) {
        return t.snapshot && t.snapshot.slopeAlignment === a;
      });
      if (seg.length) byAlign[a] = {
        n: seg.length,
        winRate: seg.filter(function(t) {
          return t.netPnl > 0;
        }).length / seg.length * 100
      };
    });
    result.push({
      setup: setup,
      trades: ts.length,
      closed: closed.length,
      winRate: closed.length ? wins.length / closed.length * 100 : 0,
      totalPnl: totalPnl,
      avgPnl: closed.length ? totalPnl / closed.length : 0,
      avgR: avgR,
      avgCapture: avgCap,
      bySession: bySession,
      bySlope: byAlign
    });
  });
  result.sort(function(a, b) {
    return b.winRate - a.winRate;
  });
  return result;
}

function jnl_renderAccountStats(trades) {
  var el = document.getElementById("jnl-account-stats");
  if (!el) return;
  var st = jnl_computeAccountStats(trades);
  if (!st || st.closedTrades < 1) {
    el.style.display = "none";
    return;
  }
  el.style.display = "block";
  var closed = trades.filter(function(t) {
    return !t.open && t.netPnl !== null;
  }).sort(function(a, b) {
    return a.entryTs - b.entryTs;
  });
  var cumPnl = [], cum = 0;
  closed.forEach(function(t) {
    cum += t.netPnl;
    cumPnl.push(cum);
  });
  var minV = Math.min.apply(null, cumPnl), maxV = Math.max.apply(null, cumPnl);
  var range = maxV - minV || 1;
  var W = 140, H = 36;
  var pts = cumPnl.map(function(v, i) {
    var x = Math.round(i / Math.max(1, cumPnl.length - 1) * W);
    var y = Math.round((1 - (v - minV) / range) * H);
    return x + "," + y;
  }).join(" ");
  var sparkColor = st.totalPnl >= 0 ? "#22c55e" : "#ef4444";
  var sparkline = cumPnl.length > 1 ? '<svg width="' + W + '" height="' + H + '" style="display:inline-block;vertical-align:middle"><polyline points="' + pts + '" fill="none" stroke="' + sparkColor + '" stroke-width="1.5"/></svg>' : "";
  var streakLabel = st.streakDir > 0 ? st.streak + "W streak" : st.streak + "L streak";
  var streakColor = st.streakDir > 0 ? "#22c55e" : "#ef4444";
  el.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">' + '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' + sparkline + "<div>" + '<div style="font-size:13px;font-weight:700;color:' + (st.totalPnl >= 0 ? "#22c55e" : "#ef4444") + '">' + jnl_fmt$(st.totalPnl) + " net</div>" + '<div style="font-size:10px;color:#64748b">' + st.closedTrades + " closed trades</div>" + "</div>" + '<div style="font-size:11px;color:#94a3b8;display:grid;grid-template-columns:1fr 1fr;gap:2px 16px">' + '<span>Win rate: <b style="color:#e2e8f0">' + st.winRate.toFixed(0) + "%</b></span>" + '<span>Profit factor: <b style="color:#e2e8f0">' + (st.profitFactor ? st.profitFactor.toFixed(2) : "—") + "</b></span>" + '<span>Avg winner: <b style="color:#22c55e">' + jnl_fmt$(st.avgWin) + "</b></span>" + '<span>Avg loser: <b style="color:#ef4444">-' + jnl_fmt$(st.avgLoss) + "</b></span>" + '<span>Avg R: <b style="color:#e2e8f0">' + (st.avgR ? st.avgR.toFixed(1) + "R" : "—") + "</b></span>" + '<span>Expectancy: <b style="color:' + (st.expectancy >= 0 ? "#22c55e" : "#ef4444") + '">' + jnl_fmt$(st.expectancy) + "/trade</b></span>" + (st.avgDurMs ? '<span>Avg duration: <b style="color:#e2e8f0">' + jnl_fmtDur(st.avgDurMs) + "</b></span>" : "") + '<span style="color:' + streakColor + '">' + streakLabel + "</span>" + "</div>" + "</div>" + (st.bestTrade ? '<div style="font-size:10px;color:#64748b;text-align:right">' + 'Best: <b style="color:#22c55e">' + st.bestTrade.ticker + " " + jnl_fmt$(st.bestTrade.netPnl) + "</b><br>" + 'Worst: <b style="color:#ef4444">' + st.worstTrade.ticker + " " + jnl_fmt$(st.worstTrade.netPnl) + "</b>" + "</div>" : "") + "</div>";
}

function jnl_renderSetupStatsSection(trades) {
  var el = document.getElementById("jnl-setup-stats");
  if (!el) return;
  var stats = jnl_computeSetupStats(trades);
  var visible = stats.filter(function(s) {
    return s.closed >= 3;
  });
  var totalClosed = trades.filter(function(t) {
    return !t.open && t.netPnl !== null;
  }).length;
  if (!visible.length && totalClosed < 3) {
    el.style.display = "none";
    return;
  }
  if (!visible.length && totalClosed < 3) {
    el.style.display = "none";
    return;
  }
  el.style.display = "block";
  var html = '<div style="font-size:11px;font-weight:600;color:#94a3b8;margin-bottom:8px;letter-spacing:0.05em">BY SETUP</div>';
  html += '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:11px">';
  html += '<tr style="color:#475569;border-bottom:1px solid #1e293b">' + '<th style="text-align:left;padding:4px 8px 4px 0">Setup</th>' + '<th style="text-align:right;padding:4px 8px">Trades</th>' + '<th style="text-align:right;padding:4px 8px">Win%</th>' + '<th style="text-align:right;padding:4px 8px">Exp/tr</th>' + '<th style="text-align:right;padding:4px 8px">PF</th>' + '<th style="text-align:right;padding:4px 8px">Total</th>' + '<th style="text-align:right;padding:4px 8px">Avg R</th>' + '<th style="text-align:right;padding:4px 8px">Capture</th>' + '<th style="text-align:right;padding:4px 8px">Equity</th>' + "</tr>";
  visible.forEach(function(s) {
    var key = s.setup;
    var color = JNL_SETUP_COLORS[key] || "#475569";
    var wrColor = s.winRate >= 60 ? "#22c55e" : s.winRate >= 40 ? "#f59e0b" : "#ef4444";
    var sTrades = trades.filter(function(t) {
      return !t.open && t.netPnl !== null && jnl_setupLabel(t) === key;
    });
    var sm = jnl_accountMetrics(sTrades);
    var pfStr = sm.profitFactor === Infinity ? "∞" : sm.profitFactor !== null ? sm.profitFactor.toFixed(2) : "—";
    var pfColor = sm.profitFactor === null ? "#64748b" : sm.profitFactor >= 1.5 ? "#22c55e" : sm.profitFactor >= 1 ? "#f59e0b" : "#ef4444";
    var spark = jnl_equityCurveSvg(sTrades, 110, 26);
    html += '<tr style="border-bottom:1px solid #1e293b22">' + '<td style="padding:5px 8px 5px 0"><span style="color:' + color + ';font-weight:600">' + (JNL_SETUP_LABELS[key] || key) + "</span></td>" + '<td style="text-align:right;padding:5px 8px;color:#94a3b8">' + s.closed + "</td>" + '<td style="text-align:right;padding:5px 8px;color:' + wrColor + ';font-weight:600">' + s.winRate.toFixed(0) + "%</td>" + '<td style="text-align:right;padding:5px 8px;color:' + (s.avgPnl >= 0 ? "#22c55e" : "#ef4444") + '">' + jnl_fmt$(s.avgPnl) + "</td>" + '<td style="text-align:right;padding:5px 8px;color:' + pfColor + ';font-weight:600">' + pfStr + "</td>" + '<td style="text-align:right;padding:5px 8px;color:' + (sm.netPnl >= 0 ? "#22c55e" : "#ef4444") + ';font-weight:600">' + jnl_fmt$(sm.netPnl) + "</td>" + '<td style="text-align:right;padding:5px 8px;color:#e2e8f0">' + (s.avgR ? s.avgR.toFixed(1) + "R" : "—") + "</td>" + '<td style="text-align:right;padding:5px 8px;color:#e2e8f0">' + (s.avgCapture ? s.avgCapture.toFixed(0) + "%" : "—") + "</td>" + '<td style="text-align:right;padding:5px 8px;width:110px">' + (spark || "—") + "</td>" + "</tr>";
    if (s.closed >= 5) {
      var breakdown = "";
      if (Object.keys(s.bySession).length) {
        breakdown += '<span style="color:#475569">Time: ';
        Object.keys(s.bySession).forEach(function(p) {
          var b = s.bySession[p];
          breakdown += p + " " + b.winRate.toFixed(0) + "%(" + b.n + ")  ";
        });
        breakdown += "</span>";
      }
      if (breakdown) {
        html += '<tr><td colspan="9" style="padding:0 0 6px 0;font-size:10px">' + breakdown + "</td></tr>";
      }
    }
  });
  html += "</table></div>";
  el.innerHTML = html;
}

function jnl_mean(arr) {
  return arr.length ? arr.reduce(function(a, b) {
    return a + b;
  }, 0) / arr.length : null;
}

function jnl_stdev(arr) {
  if (arr.length < 2) return null;
  var m = jnl_mean(arr);
  return Math.sqrt(arr.reduce(function(a, b) {
    return a + (b - m) * (b - m);
  }, 0) / (arr.length - 1));
}

function jnl_dailyPnl(trades) {
  var days = {};
  (trades || []).forEach(function(t) {
    if (t.open || t.netPnl === null) return;
    if (!days[t.date]) days[t.date] = {
      pnl: 0,
      count: 0,
      wins: 0
    };
    days[t.date].pnl += t.netPnl;
    days[t.date].count++;
    if (t.netPnl > 0) days[t.date].wins++;
  });
  return days;
}

function jnl_equitySeries(trades) {
  var closed = (trades || []).filter(function(t) {
    return !t.open && t.netPnl !== null;
  }).slice().sort(function(a, b) {
    return (a.exitTs || a.entryTs) - (b.exitTs || b.entryTs);
  });
  var eq = 0, peak = 0, maxDD = 0, peakAtMaxDD = 0;
  var points = closed.map(function(t) {
    eq += t.netPnl;
    if (eq > peak) peak = eq;
    var dd = peak - eq;
    if (dd > maxDD) {
      maxDD = dd;
      peakAtMaxDD = peak;
    }
    return {
      ts: t.exitTs || t.entryTs,
      eq: eq,
      peak: peak,
      dd: dd
    };
  });
  return {
    points: points,
    maxDD: maxDD,
    maxDDPct: peakAtMaxDD > 0 ? maxDD / peakAtMaxDD * 100 : null
  };
}

function jnl_accountMetrics(trades) {
  var closed = (trades || []).filter(function(t) {
    return !t.open && t.netPnl !== null;
  });
  var wins = closed.filter(function(t) {
    return t.netPnl > 0;
  });
  var losses = closed.filter(function(t) {
    return t.netPnl < 0;
  });
  var netPnl = closed.reduce(function(a, t) {
    return a + t.netPnl;
  }, 0);
  var grossWin = wins.reduce(function(a, t) {
    return a + t.netPnl;
  }, 0);
  var grossLoss = losses.reduce(function(a, t) {
    return a + t.netPnl;
  }, 0);
  var winRate = closed.length ? wins.length / closed.length * 100 : null;
  var profitFactor = grossLoss < 0 ? grossWin / -grossLoss : grossWin > 0 ? Infinity : null;
  var expectancy = closed.length ? netPnl / closed.length : null;
  var rVals = closed.map(jnl_signedR).filter(function(r) {
    return r !== null;
  });
  var expectancyR = rVals.length ? jnl_mean(rVals) : null;
  var avgWin = wins.length ? grossWin / wins.length : null;
  var avgLoss = losses.length ? grossLoss / losses.length : null;
  var payoff = avgWin !== null && avgLoss !== null && avgLoss < 0 ? avgWin / -avgLoss : null;
  var es = jnl_equitySeries(closed);
  var rStd = jnl_stdev(rVals);
  var sqn = rStd > 0 ? jnl_mean(rVals) / rStd * Math.sqrt(Math.min(rVals.length, 100)) : null;
  var kelly = payoff !== null && winRate !== null ? (winRate / 100 - (1 - winRate / 100) / payoff) * 100 : null;
  var recovery = es.maxDD > 0 ? netPnl / es.maxDD : null;
  var dvals = Object.values(jnl_dailyPnl(closed)).map(function(d) {
    return d.pnl;
  });
  var dStd = jnl_stdev(dvals);
  var consistency = dStd > 0 ? jnl_mean(dvals) / dStd * Math.sqrt(252) : null;
  var holdWin = jnl_mean(wins.map(function(t) {
    return t.durationMs;
  }).filter(function(d) {
    return d != null;
  }));
  var holdLoss = jnl_mean(losses.map(function(t) {
    return t.durationMs;
  }).filter(function(d) {
    return d != null;
  }));
  var fees = closed.reduce(function(a, t) {
    return a + (t.totalComm || 0);
  }, 0);
  var byTime = closed.slice().sort(function(a, b) {
    return a.entryTs - b.entryTs;
  });
  var ws = 0, ls = 0, maxWs = 0, maxLs = 0;
  byTime.forEach(function(t) {
    if (t.netPnl > 0) {
      ws++;
      ls = 0;
    } else if (t.netPnl < 0) {
      ls++;
      ws = 0;
    }
    if (ws > maxWs) maxWs = ws;
    if (ls > maxLs) maxLs = ls;
  });
  var longs = closed.filter(function(t) {
    return t.side === "long";
  });
  var shorts = closed.filter(function(t) {
    return t.side === "short";
  });
  return {
    closed: closed.length,
    wins: wins.length,
    losses: losses.length,
    netPnl: netPnl,
    grossWin: grossWin,
    grossLoss: grossLoss,
    winRate: winRate,
    profitFactor: profitFactor,
    expectancy: expectancy,
    expectancyR: expectancyR,
    avgWin: avgWin,
    avgLoss: avgLoss,
    payoff: payoff,
    maxDD: es.maxDD,
    maxDDPct: es.maxDDPct,
    sqn: sqn,
    kelly: kelly,
    recovery: recovery,
    consistency: consistency,
    holdWin: holdWin,
    holdLoss: holdLoss,
    fees: fees,
    maxWinStreak: maxWs,
    maxLossStreak: maxLs,
    longCount: longs.length,
    longPnl: longs.reduce(function(a, t) {
      return a + t.netPnl;
    }, 0),
    shortCount: shorts.length,
    shortPnl: shorts.reduce(function(a, t) {
      return a + t.netPnl;
    }, 0),
    rCount: rVals.length
  };
}

function jnl_equityCurveSvg(trades, w, h) {
  var es = jnl_equitySeries(trades);
  var pts = es.points;
  if (pts.length < 2) return "";
  w = w || 600;
  h = h || 150;
  var pad = 6;
  var vals = [];
  pts.forEach(function(p) {
    vals.push(p.eq, p.peak);
  });
  vals.push(0);
  var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
  if (max === min) max = min + 1;
  function X(i) {
    return pad + i / (pts.length - 1) * (w - 2 * pad);
  }
  function Y(v) {
    return h - pad - (v - min) / (max - min) * (h - 2 * pad);
  }
  var eqPath = pts.map(function(p, i) {
    return (i ? "L" : "M") + X(i).toFixed(1) + "," + Y(p.eq).toFixed(1);
  }).join("");
  var pkPath = pts.map(function(p, i) {
    return (i ? "L" : "M") + X(i).toFixed(1) + "," + Y(p.peak).toFixed(1);
  }).join("");
  var ddPoly = pts.map(function(p, i) {
    return X(i).toFixed(1) + "," + Y(p.peak).toFixed(1);
  }).concat(pts.slice().reverse().map(function(p, i) {
    return X(pts.length - 1 - i).toFixed(1) + "," + Y(p.eq).toFixed(1);
  })).join(" ");
  var zeroY = Y(0);
  return '<svg viewBox="0 0 ' + w + " " + h + '" style="width:100%;height:auto;display:block">' + '<line x1="' + pad + '" y1="' + zeroY.toFixed(1) + '" x2="' + (w - pad) + '" y2="' + zeroY.toFixed(1) + '" stroke="#334155" stroke-width="1" stroke-dasharray="3,3"/>' + '<polygon points="' + ddPoly + '" fill="#ef4444" opacity="0.13"/>' + '<path d="' + pkPath + '" fill="none" stroke="#475569" stroke-width="1" stroke-dasharray="2,3"/>' + '<path d="' + eqPath + '" fill="none" stroke="#3b82f6" stroke-width="2"/>' + "</svg>";
}

function jnl_donutSvg(pct, color) {
  var r = 24, c = 2 * Math.PI * r;
  var filled = Math.max(0, Math.min(100, pct)) / 100 * c;
  return '<svg viewBox="0 0 64 64" style="width:58px;height:58px">' + '<circle cx="32" cy="32" r="' + r + '" fill="none" stroke="#1e293b" stroke-width="7"/>' + '<circle cx="32" cy="32" r="' + r + '" fill="none" stroke="' + color + '" stroke-width="7" stroke-linecap="round" ' + 'stroke-dasharray="' + filled.toFixed(1) + " " + c.toFixed(1) + '" transform="rotate(-90 32 32)"/>' + '<text x="32" y="36" text-anchor="middle" fill="#e2e8f0" font-size="13" font-weight="700">' + Math.round(pct) + "%</text>" + "</svg>";
}

function jnl_renderOverviewDash(trades) {
  var el = document.getElementById("jnl-overview-dash");
  if (!el) return;
  var m = jnl_accountMetrics(trades);
  if (!m.closed) {
    el.innerHTML = "";
    return;
  }
  function pn(v) {
    return v >= 0 ? "#22c55e" : "#ef4444";
  }
  function f2(v, suf) {
    return v === null || v === undefined || !isFinite(v) ? v === Infinity ? "∞" : "—" : v.toFixed(2) + (suf || "");
  }
  var openCount = (trades || []).filter(function(t) {
    return t.open;
  }).length;
  var longPct = m.closed ? m.longCount / m.closed * 100 : 0;
  var heroHtml = '<div class="jnl-hero-row">' + '<div class="jnl-kpi" style="display:flex;flex-direction:column;justify-content:center">' + '<div class="k-label">CLOSED P&amp;L</div>' + '<div style="font-size:26px;font-weight:800;color:' + pn(m.netPnl) + ';font-variant-numeric:tabular-nums">' + jnl_fmt$(m.netPnl) + "</div>" + '<div class="k-sub" style="color:#94a3b8">' + m.closed + " closed" + (openCount ? " · " + openCount + " open" : "") + " · " + m.wins + "W / " + m.losses + "L</div>" + "</div>" + '<div class="jnl-kpi" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px">' + jnl_donutSvg(m.winRate || 0, m.winRate >= 50 ? "#22c55e" : "#3b82f6") + '<div class="k-sub">Win %</div></div>' + '<div class="jnl-kpi" style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px">' + jnl_donutSvg(longPct, "#3b82f6") + '<div class="k-sub">Long %</div></div>' + "</div>";
  var insights = jnl_computeInsights(trades);
  var insightsHtml = insights.length ? '<div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:10px 12px;margin-bottom:10px">' + '<div style="color:#475569;font-size:9px;font-weight:700;letter-spacing:.08em;margin-bottom:6px">💡 INSIGHTS</div>' + insights.map(function(ins) {
    return '<div style="font-size:11px;color:#cbd5e1;padding:3px 0;border-left:2px solid ' + (ins.good ? "#22c55e" : "#ef4444") + ';padding-left:8px;margin:4px 0">' + ins.text + "</div>";
  }).join("") + "</div>" : "";
  function tile(label, value, color, sub, meaning) {
    return '<div class="jnl-kpi"><div class="k-label">' + label + "</div>" + '<div class="k-value" style="color:' + color + '">' + value + "</div>" + (sub ? '<div class="k-sub" style="color:#94a3b8">' + sub + "</div>" : "") + '<div class="k-sub">' + meaning + "</div></div>";
  }
  var pfStr = m.profitFactor === Infinity ? "∞" : m.profitFactor !== null ? m.profitFactor.toFixed(2) : "—";
  var pfColor = m.profitFactor === null ? "#64748b" : m.profitFactor >= 1.5 ? "#22c55e" : m.profitFactor >= 1 ? "#f59e0b" : "#ef4444";
  var html = heroHtml + insightsHtml + '<div class="jnl-kpi-grid">' + tile("NET P&amp;L", jnl_fmt$(m.netPnl), pn(m.netPnl), m.closed + " closed trades", "After " + jnl_fmt$(m.fees) + " fees") + tile("WIN RATE", m.winRate.toFixed(0) + "%", m.winRate >= 50 ? "#22c55e" : "#f59e0b", m.wins + "W / " + m.losses + "L", "Low win% is fine if payoff is high") + tile("PROFIT FACTOR", pfStr, pfColor, "$" + Math.round(m.grossWin) + " won / $" + Math.round(-m.grossLoss) + " lost", "$ won per $ lost — &gt;1.5 good, &gt;2 strong") + tile("EXPECTANCY", jnl_fmt$(m.expectancy), pn(m.expectancy), m.expectancyR !== null ? f2(m.expectancyR, "R") + " per trade" : "open charts for R", "Avg $ each trade is worth long-run") + tile("PAYOFF RATIO", m.payoff !== null ? m.payoff.toFixed(2) + ":1" : "—", m.payoff >= 1.5 ? "#22c55e" : "#f59e0b", "avg win " + jnl_fmt$(m.avgWin) + " / loss " + jnl_fmt$(m.avgLoss), "Avg winner vs avg loser size") + tile("MAX DRAWDOWN", jnl_fmt$(-m.maxDD), m.maxDD > 0 ? "#ef4444" : "#22c55e", m.maxDDPct !== null ? m.maxDDPct.toFixed(0) + "% off equity peak" : "", "Worst peak-to-trough giveback") + "</div>";
  var curve = jnl_equityCurveSvg(trades);
  if (curve) {
    html += '<div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:10px 12px;margin-bottom:10px">' + '<div style="color:#475569;font-size:9px;font-weight:700;letter-spacing:.08em;margin-bottom:4px">EQUITY CURVE <span style="color:#ef444488">▮ drawdown</span></div>' + curve + "</div>";
  }
  function chip(label, val, color) {
    return "<span>" + label + ' <b style="color:' + (color || "#e2e8f0") + '">' + val + "</b></span>";
  }
  html += '<div class="jnl-ratio-strip">' + chip("SQN", f2(m.sqn), m.sqn >= 2 ? "#22c55e" : m.sqn >= 1 ? "#f59e0b" : "#ef4444") + chip("Kelly", m.kelly !== null ? m.kelly.toFixed(0) + "%" : "—", m.kelly > 0 ? "#22c55e" : "#ef4444") + chip("Recovery", f2(m.recovery), m.recovery >= 2 ? "#22c55e" : "#e2e8f0") + chip("Consistency", f2(m.consistency)) + chip("Long", m.longCount + " · " + jnl_fmt$(m.longPnl), pn(m.longPnl)) + chip("Short", m.shortCount + " · " + jnl_fmt$(m.shortPnl), pn(m.shortPnl)) + chip("Streaks", m.maxWinStreak + "W / " + m.maxLossStreak + "L") + "</div>" + '<div style="color:#475569;font-size:9px;margin-top:4px">SQN: edge quality (mean R / stdev R × √N) — &gt;2 good, &gt;3 excellent · Kelly: % risk edge math allows (use a fraction) · ' + "Recovery: net profit ÷ max drawdown · Consistency: daily P&amp;L Sharpe-style, annualized.</div>";
  el.innerHTML = html;
}

function jnl_renderCalendarTab(trades) {
  var el = document.getElementById("jnl-calendar-dash");
  if (!el) return;
  var days = jnl_dailyPnl(trades);
  var keys = Object.keys(days).sort();
  if (!keys.length) {
    el.innerHTML = '<div class="jnl-corr-note">No closed trades yet.</div>';
    return;
  }
  var month;
  try {
    month = localStorage.getItem("jnl_cal_month");
  } catch (_) {}
  if (!month || !/^\d{4}-\d{2}$/.test(month)) month = keys[keys.length - 1].slice(0, 7);
  var y = parseInt(month.slice(0, 4), 10), mo = parseInt(month.slice(5, 7), 10);
  var maxAbs = 0;
  keys.forEach(function(k) {
    if (k.slice(0, 7) === month) maxAbs = Math.max(maxAbs, Math.abs(days[k].pnl));
  });
  var first = new Date(Date.UTC(y, mo - 1, 1));
  var dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  var monthNames = [ "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" ];
  var html = '<div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:10px 12px">' + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">' + '<button class="jnl-corr-tab-btn jnl-cal-nav" data-cal-dir="-1">‹</button>' + '<span style="color:#94a3b8;font-size:12px;font-weight:700">' + monthNames[mo - 1] + " " + y + "</span>" + '<button class="jnl-corr-tab-btn jnl-cal-nav" data-cal-dir="1">›</button></div>';
  html += '<div class="jnl-cal-grid">' + [ "Mon", "Tue", "Wed", "Thu", "Fri", "Week" ].map(function(d, i) {
    return '<div style="color:' + (i === 5 ? "#93c5fd" : "#475569") + ';font-size:9px;font-weight:700;text-align:center">' + d + "</div>";
  }).join("");
  var monthTotal = 0, monthTrades = 0;
  var dow0 = (first.getUTCDay() + 6) % 7;
  var cells = [], weekSum = 0, weekHas = false;
  function flushWeek() {
    cells.push('<div class="jnl-cal-cell" style="background:#0b1220;border:1px solid #1e293b">' + (weekHas ? '<div style="font-size:10px;font-weight:700;color:' + (weekSum >= 0 ? "#22c55e" : "#ef4444") + '">' + jnl_fmt$(weekSum) + "</div>" : '<div style="color:#1e293b">—</div>') + "</div>");
    weekSum = 0;
    weekHas = false;
  }
  if (dow0 < 5) for (var pad = 0; pad < dow0; pad++) cells.push("<div></div>");
  for (var d = 1; d <= dim; d++) {
    var dt = new Date(Date.UTC(y, mo - 1, d));
    var dw = (dt.getUTCDay() + 6) % 7;
    if (dw > 4) {
      if (dw === 5) flushWeek();
      continue;
    }
    var key = month + "-" + String(d).padStart(2, "0");
    var rec = days[key];
    if (rec) {
      monthTotal += rec.pnl;
      monthTrades += rec.count;
      weekSum += rec.pnl;
      weekHas = true;
    }
    var bg = "#0b1220", fg = "#334155";
    if (rec) {
      var inten = maxAbs > 0 ? Math.min(1, Math.abs(rec.pnl) / maxAbs) : 0;
      bg = rec.pnl >= 0 ? "rgba(34,197,94," + (.1 + .35 * inten).toFixed(2) + ")" : "rgba(239,68,68," + (.1 + .35 * inten).toFixed(2) + ")";
      fg = rec.pnl >= 0 ? "#22c55e" : "#ef4444";
    }
    cells.push('<div class="jnl-cal-cell" style="background:' + bg + ";border:1px solid " + (rec ? fg + "55" : "#1e293b") + '">' + '<div style="color:#475569;font-size:8px">' + d + "</div>" + (rec ? '<div style="color:' + fg + ';font-size:10px;font-weight:700">' + jnl_fmt$(rec.pnl) + "</div>" + '<div style="color:#64748b;font-size:8px">T:' + rec.count + "</div>" : "") + "</div>");
    if (dw === 4) flushWeek();
  }
  if (weekHas) flushWeek();
  html += cells.join("") + "</div>";
  html += '<div style="margin-top:8px;font-size:11px;color:#94a3b8">Month: <b style="color:' + (monthTotal >= 0 ? "#22c55e" : "#ef4444") + '">' + jnl_fmt$(monthTotal) + "</b> · " + monthTrades + " trades</div></div>";
  el.innerHTML = html;
  el.querySelectorAll(".jnl-cal-nav").forEach(function(btn) {
    btn.addEventListener("click", function() {
      var dir = parseInt(btn.getAttribute("data-cal-dir"), 10);
      var nm = mo + dir, ny = y;
      if (nm < 1) {
        nm = 12;
        ny--;
      }
      if (nm > 12) {
        nm = 1;
        ny++;
      }
      try {
        localStorage.setItem("jnl_cal_month", ny + "-" + String(nm).padStart(2, "0"));
      } catch (_) {}
      jnl_renderCalendarTab(jnl_scopedTrades());
    });
  });
}

function jnl_bucketStats(trades, keyFn, order) {
  var b = {};
  (trades || []).forEach(function(t) {
    if (t.open || t.netPnl === null) return;
    var k = keyFn(t);
    if (k === null || k === undefined) return;
    if (!b[k]) b[k] = {
      n: 0,
      wins: 0,
      pnl: 0
    };
    b[k].n++;
    b[k].pnl += t.netPnl;
    if (t.netPnl > 0) b[k].wins++;
  });
  return (order || Object.keys(b).sort()).filter(function(k) {
    return b[k];
  }).map(function(k) {
    return {
      label: k,
      n: b[k].n,
      winRate: b[k].n ? b[k].wins / b[k].n * 100 : null,
      pnl: b[k].pnl,
      exp: b[k].pnl / b[k].n
    };
  });
}

function jnl_hourKey(t) {
  if (!t.entryTs) return null;
  var h = new Date(t.entryTs - jnl_etOffsetMs(t.date)).getUTCHours();
  return String(h).padStart(2, "0") + ":00";
}

var JNL_DOW_NAMES = [ "Mon", "Tue", "Wed", "Thu", "Fri" ];

function jnl_dowKey(t) {
  var dw = (new Date(t.date + "T12:00Z").getUTCDay() + 6) % 7;
  return dw < 5 ? JNL_DOW_NAMES[dw] : null;
}

var JNL_PRICE_BUCKETS = [ [ 0, 2, "$0–2" ], [ 2, 5, "$2–5" ], [ 5, 10, "$5–10" ], [ 10, 20, "$10–20" ], [ 20, 50, "$20–50" ], [ 50, 100, "$50–100" ], [ 100, Infinity, "$100+" ] ];

function jnl_priceKey(t) {
  if (t.entryPrice == null) return null;
  for (var i = 0; i < JNL_PRICE_BUCKETS.length; i++) {
    if (t.entryPrice >= JNL_PRICE_BUCKETS[i][0] && t.entryPrice < JNL_PRICE_BUCKETS[i][1]) return JNL_PRICE_BUCKETS[i][2];
  }
  return null;
}

var JNL_SIZE_BUCKETS = [ [ 0, 100, "0–99 sh" ], [ 100, 500, "100–499" ], [ 500, 1e3, "500–999" ], [ 1e3, 2e3, "1000–1999" ], [ 2e3, Infinity, "2000+" ] ];

function jnl_sizeKey(t) {
  if (t.shares == null) return null;
  for (var i = 0; i < JNL_SIZE_BUCKETS.length; i++) {
    if (t.shares >= JNL_SIZE_BUCKETS[i][0] && t.shares < JNL_SIZE_BUCKETS[i][1]) return JNL_SIZE_BUCKETS[i][2];
  }
  return null;
}

function jnl_barTable(title, rows) {
  var maxAbs = 0;
  rows.forEach(function(r) {
    maxAbs = Math.max(maxAbs, Math.abs(r.pnl));
  });
  return '<div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:10px 12px;margin-bottom:10px">' + '<div style="color:#94a3b8;font-size:11px;font-weight:700;margin-bottom:8px">' + title + "</div>" + rows.map(function(r) {
    var pct = maxAbs > 0 ? Math.round(Math.abs(r.pnl) / maxAbs * 100) : 0;
    var color = r.pnl >= 0 ? "#22c55e" : "#ef4444";
    return '<div style="padding:4px 0 7px">' + '<div style="display:flex;justify-content:space-between;align-items:baseline;font-size:11px">' + '<span style="color:#cbd5e1">' + r.label + "</span>" + '<span style="color:' + color + ';font-weight:700;font-variant-numeric:tabular-nums">' + jnl_fmt$(r.pnl) + "</span>" + "</div>" + '<div style="height:4px;border-radius:2px;background:#1e293b;margin:4px 0 2px;overflow:hidden">' + '<div style="height:100%;width:' + Math.max(pct, r.pnl !== 0 ? 2 : 0) + "%;background:" + color + '"></div>' + "</div>" + '<div style="font-size:9px;color:#64748b">' + r.n + " trades · win " + (r.winRate !== null ? r.winRate.toFixed(0) + "%" : "—") + " · " + jnl_fmt$(r.exp) + "/trade</div>" + "</div>";
  }).join("") + "</div>";
}

function jnl_renderTimeTab(trades) {
  var el = document.getElementById("jnl-time-dash");
  if (!el) return;
  var closed = (trades || []).filter(function(t) {
    return !t.open && t.netPnl !== null;
  });
  if (!closed.length) {
    el.innerHTML = '<div class="jnl-corr-note">No closed trades yet.</div>';
    return;
  }
  var hourRows = jnl_bucketStats(closed, jnl_hourKey);
  var dowRows = jnl_bucketStats(closed, jnl_dowKey, JNL_DOW_NAMES);
  var sessRows = jnl_bucketStats(closed, function(t) {
    return t.snapshot && t.snapshot.sessionPeriod ? t.snapshot.sessionPeriod : null;
  }, [ "open_drive", "early", "mid", "late", "close" ]);
  var priceRows = jnl_bucketStats(closed, jnl_priceKey, JNL_PRICE_BUCKETS.map(function(b) {
    return b[2];
  }));
  var sizeRows = jnl_bucketStats(closed, jnl_sizeKey, JNL_SIZE_BUCKETS.map(function(b) {
    return b[2];
  }));
  var html = jnl_barTable("Hourly (ET entry)", hourRows) + jnl_barTable("Weekly", dowRows);
  if (sessRows.length) html += jnl_barTable("Session period", sessRows);
  html += jnl_barTable("Entry price", priceRows) + jnl_barTable("Position size", sizeRows);
  var m = jnl_accountMetrics(closed);
  if (m.holdWin !== null || m.holdLoss !== null) {
    var verdict = m.holdWin !== null && m.holdLoss !== null ? m.holdWin < m.holdLoss ? '<span style="color:#f59e0b">Winners are held SHORTER than losers — classic “cut winners early, let losers run”. Worth attacking first.</span>' : '<span style="color:#22c55e">Winners are held longer than losers — healthy trade management.</span>' : "";
    html += '<div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:10px 12px">' + '<div style="color:#475569;font-size:9px;font-weight:700;letter-spacing:.08em;margin-bottom:6px">HOLD TIME</div>' + '<div style="font-size:11px;color:#94a3b8">Avg winner held <b style="color:#22c55e">' + jnl_fmtDur(m.holdWin) + '</b> · avg loser held <b style="color:#ef4444">' + jnl_fmtDur(m.holdLoss) + "</b></div>" + '<div style="font-size:10px;margin-top:4px">' + verdict + "</div></div>";
  }
  el.innerHTML = html;
}

function jnl_renderRiskTab(trades) {
  var el = document.getElementById("jnl-risk-dash");
  if (!el) return;
  var closed = (trades || []).filter(function(t) {
    return !t.open && t.netPnl !== null;
  });
  if (!closed.length) {
    el.innerHTML = '<div class="jnl-corr-note">No closed trades yet.</div>';
    return;
  }
  function histSvg(buckets, title, sub) {
    var maxN = Math.max.apply(null, buckets.map(function(b) {
      return b.n;
    }).concat([ 1 ]));
    var w = 600, h = 130, pad = 6, bw = (w - 2 * pad) / buckets.length;
    var bars = buckets.map(function(b, i) {
      var bh = b.n / maxN * (h - 34);
      var x = pad + i * bw;
      return '<rect x="' + (x + 3).toFixed(1) + '" y="' + (h - 22 - bh).toFixed(1) + '" width="' + (bw - 6).toFixed(1) + '" height="' + Math.max(bh, b.n ? 2 : 0).toFixed(1) + '" rx="2" fill="' + b.color + '" opacity="0.85"/>' + (b.n ? '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (h - 26 - bh).toFixed(1) + '" text-anchor="middle" fill="#94a3b8" font-size="10">' + b.n + "</text>" : "") + '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (h - 8) + '" text-anchor="middle" fill="#475569" font-size="9">' + b.label + "</text>";
    }).join("");
    return '<div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:10px 12px;margin-bottom:10px">' + '<div style="color:#475569;font-size:9px;font-weight:700;letter-spacing:.08em">' + title + "</div>" + (sub ? '<div style="color:#64748b;font-size:9px;margin-bottom:2px">' + sub + "</div>" : "") + '<svg viewBox="0 0 ' + w + " " + h + '" style="width:100%;height:auto;display:block">' + bars + "</svg></div>";
  }
  var rEdges = [ [ -Infinity, -2, "≤−2R" ], [ -2, -1, "−2..−1" ], [ -1, 0, "−1..0" ], [ 0, 1, "0..1" ], [ 1, 2, "1..2" ], [ 2, 3, "2..3" ], [ 3, Infinity, "&gt;3R" ] ];
  var rVals = closed.map(jnl_signedR).filter(function(r) {
    return r !== null;
  });
  var m = jnl_accountMetrics(closed);
  function tile(label, val, color, note) {
    return '<div style="flex:1;min-width:84px"><div style="font-size:9px;color:#64748b">' + label + "</div>" + '<div style="font-size:14px;font-weight:700;color:' + (color || "#e2e8f0") + '">' + val + "</div>" + (note ? '<div style="font-size:8px;color:#475569">' + note + "</div>" : "") + "</div>";
  }
  var pf = m.profitFactor, pfStr = pf == null ? "—" : pf === Infinity ? "∞" : pf.toFixed(2);
  var html = '<div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:10px 12px;margin-bottom:10px">' + '<div style="color:#475569;font-size:9px;font-weight:700;letter-spacing:.08em;margin-bottom:6px">RISK SNAPSHOT · ' + m.closed + " closed trades</div>" + '<div style="display:flex;gap:14px;flex-wrap:wrap">' + tile("Win rate", m.winRate != null ? m.winRate.toFixed(0) + "%" : "—", m.winRate >= 50 ? "#86efac" : "#fbbf24", m.wins + "W / " + m.losses + "L") + tile("Avg win", jnl_fmt$(m.avgWin || 0), "#86efac", "when you win") + tile("Avg loss", jnl_fmt$(m.avgLoss || 0), "#fca5a5", "when you lose") + tile("Payoff", m.payoff == null ? "—" : m.payoff.toFixed(2) + ":1", "#93c5fd", "win ÷ loss size") + tile("Profit factor", pfStr, pf >= 1.3 ? "#86efac" : pf >= 1 ? "#fbbf24" : "#fca5a5", ">1 = profitable") + tile("Expectancy", jnl_fmt$(m.expectancy || 0), (m.expectancy || 0) >= 0 ? "#86efac" : "#fca5a5", "avg/trade" + (m.expectancyR != null ? " · " + m.expectancyR.toFixed(2) + "R" : "")) + tile("Max drawdown", "−" + jnl_fmt$(Math.abs(m.maxDD || 0)).replace("-", ""), "#fca5a5", m.maxDDPct != null ? m.maxDDPct.toFixed(0) + "% dip" : "peak→valley") + tile("Worst streak", (m.maxLossStreak || 0) + " losses", "#fca5a5", "in a row") + tile("Fees paid", jnl_fmt$(m.fees || 0), "#94a3b8", "commissions") + "</div>" + '<div style="color:#475569;font-size:9px;margin-top:6px">Long-run profitable when <b>profit factor &gt; 1</b> AND <b>expectancy &gt; 0</b>. Payoff Z:1 = your average win is Z× your average loss — a low win-rate still wins if the payoff is big enough.</div>' + "</div>";
  if (rVals.length >= 3) {
    html += histSvg(rEdges.map(function(e) {
      var n = rVals.filter(function(r) {
        return r > e[0] && r <= e[1];
      }).length;
      return {
        label: e[2],
        n: n,
        color: e[1] <= 0 ? "#ef4444" : "#22c55e"
      };
    }), "R-MULTIPLE — reward vs the risk/heat you took", rVals.length + " trades · R = result ÷ how far it went against you first. +2R = made 2× the heat; bars right of 0 = winners, the >3R tail is your payoff.");
  } else {
    html += '<div class="jnl-corr-note">R-distribution needs ≥3 trades with R (open their charts once to compute risk).</div>';
  }
  var pnls = closed.map(function(t) {
    return t.netPnl;
  });
  var absMax = Math.max.apply(null, pnls.map(Math.abs));
  if (absMax > 0) {
    var step = absMax / 3;
    var edges = [ -3, -2, -1, 0, 1, 2, 3 ].map(function(k) {
      return k * step;
    });
    var buckets = [];
    for (var i = 0; i < edges.length - 1; i++) {
      var lo = edges[i], hi = edges[i + 1];
      buckets.push({
        label: jnl_fmt$(lo).replace(".00", "") + "…",
        n: pnls.filter(function(p) {
          return p > lo && p <= hi;
        }).length,
        color: hi <= 0 ? "#ef4444" : "#22c55e"
      });
    }
    html += histSvg(buckets, "P&amp;L DISTRIBUTION ($)", "shape check: many small red + few large green = low-win-rate edge working");
  }
  var withExit = closed.filter(function(t) {
    return t.exitAnalysis && t.exitAnalysis.capturePct != null;
  });
  if (withExit.length) {
    var avgCapture = jnl_mean(withExit.map(function(t) {
      return t.exitAnalysis.capturePct;
    }));
    var missed = withExit.reduce(function(a, t) {
      var mfeP = t.exitAnalysis.mfePct, moveP = t.pctMove;
      if (mfeP == null || moveP == null || t.entryPrice == null) return a;
      var missPct = Math.max(0, mfeP - Math.max(0, moveP * (t.side === "short" ? -1 : 1)));
      return a + missPct / 100 * t.entryPrice * (t.closedShares || t.shares || 0);
    }, 0);
    var avgMae = jnl_mean(withExit.map(function(t) {
      return t.exitAnalysis.maePct;
    }).filter(function(v) {
      return v != null;
    }));
    html += '<div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:10px 12px">' + '<div style="color:#475569;font-size:9px;font-weight:700;letter-spacing:.08em;margin-bottom:6px">TRADE MANAGEMENT · ' + withExit.length + " trades analyzed</div>" + '<div style="font-size:11px;color:#94a3b8;display:flex;gap:16px;flex-wrap:wrap">' + '<span>Avg MFE captured <b style="color:' + (avgCapture >= 60 ? "#22c55e" : "#f59e0b") + '">' + avgCapture.toFixed(0) + "%</b></span>" + '<span>Missed profits ≈ <b style="color:#f59e0b">' + jnl_fmt$(missed) + "</b></span>" + (avgMae != null ? '<span>Avg MAE <b style="color:#ef4444">' + avgMae.toFixed(1) + "%</b></span>" : "") + '</div><div style="color:#475569;font-size:9px;margin-top:4px">MFE = best the trade ever got (favorable). MAE = worst it got against you (the heat). Captured % = how much of the best move you actually took; Missed profits = what was left on the table after your exit.</div></div>';
  }
  var noExit = closed.length - withExit.length;
  if (noExit > 0) html += '<div class="jnl-corr-note">' + noExit + " trades have no exit analysis yet — open their charts once.</div>";
  el.innerHTML = html;
}

function jnl_computeInsights(trades) {
  var closed = (trades || []).filter(function(t) {
    return !t.open && t.netPnl !== null;
  });
  if (closed.length < 5) return [];
  var grossWin = closed.reduce(function(a, t) {
    return a + Math.max(0, t.netPnl);
  }, 0);
  var grossLoss = closed.reduce(function(a, t) {
    return a + Math.min(0, t.netPnl);
  }, 0);
  var dims = [ {
    name: "the {l} hour",
    fn: jnl_hourKey
  }, {
    name: "{l}s",
    fn: jnl_dowKey
  }, {
    name: "{l} stocks",
    fn: jnl_priceKey
  }, {
    name: "{l} positions",
    fn: jnl_sizeKey
  }, {
    name: "the {l} setup",
    fn: function(t) {
      var s = jnl_setupLabel(t);
      return s && s !== "unknown" ? JNL_SETUP_LABELS[s] || s : null;
    }
  }, {
    name: "{l} trades",
    fn: function(t) {
      return t.side;
    }
  } ];
  var found = [];
  dims.forEach(function(dim) {
    var rows = jnl_bucketStats(closed, dim.fn);
    rows.forEach(function(r) {
      if (r.n < 2) return;
      found.push({
        name: dim.name.replace("{l}", r.label),
        pnl: r.pnl,
        n: r.n,
        winRate: r.winRate,
        share: r.pnl >= 0 ? grossWin > 0 ? r.pnl / grossWin * 100 : null : grossLoss < 0 ? r.pnl / grossLoss * 100 : null
      });
    });
  });
  found.sort(function(a, b) {
    return Math.abs(b.pnl) - Math.abs(a.pnl);
  });
  var out = [], pos = 0, neg = 0;
  for (var i = 0; i < found.length && out.length < 4; i++) {
    var f = found[i];
    if (f.pnl >= 0 && pos >= 2) continue;
    if (f.pnl < 0 && neg >= 2) continue;
    if (f.pnl >= 0) pos++; else neg++;
    var shareTxt = f.share !== null ? " (" + Math.round(f.share) + "% of all " + (f.pnl >= 0 ? "profits" : "losses") + ")" : "";
    out.push({
      good: f.pnl >= 0,
      text: f.pnl >= 0 ? f.name.charAt(0).toUpperCase() + f.name.slice(1) + " contributed " + jnl_fmt$(f.pnl) + shareTxt + " across " + f.n + " trades (win " + Math.round(f.winRate) + "%)." : f.name.charAt(0).toUpperCase() + f.name.slice(1) + " cost " + jnl_fmt$(f.pnl) + shareTxt + " across " + f.n + " trades (win " + Math.round(f.winRate) + "%)."
    });
  }
  return out;
}

function jnl_statsCatalog(trades) {
  var closed = (trades || []).filter(function(t) {
    return !t.open && t.netPnl !== null;
  });
  var open = (trades || []).filter(function(t) {
    return t.open;
  });
  var m = jnl_accountMetrics(closed);
  var wins = closed.filter(function(t) {
    return t.netPnl > 0;
  });
  var losses = closed.filter(function(t) {
    return t.netPnl < 0;
  });
  var pnls = closed.map(function(t) {
    return t.netPnl;
  });
  var best = pnls.length ? Math.max.apply(null, pnls) : null;
  var worst = pnls.length ? Math.min.apply(null, pnls) : null;
  var days = jnl_dailyPnl(closed);
  var nDays = Object.keys(days).length;
  function durSum(list) {
    return list.reduce(function(a, t) {
      return a + (t.durationMs || 0);
    }, 0);
  }
  var durs = closed.map(function(t) {
    return t.durationMs;
  }).filter(function(d) {
    return d != null;
  });
  var vol = closed.reduce(function(a, t) {
    return a + (t.shares || 0);
  }, 0);
  var volW = wins.reduce(function(a, t) {
    return a + (t.shares || 0);
  }, 0);
  var volL = losses.reduce(function(a, t) {
    return a + (t.shares || 0);
  }, 0);
  function M(name, val, color) {
    return {
      name: name,
      val: val,
      color: color || "#e2e8f0"
    };
  }
  function $c(v) {
    return v >= 0 ? "#22c55e" : "#ef4444";
  }
  function $f(v) {
    return v === null || v === undefined ? "—" : jnl_fmt$(v);
  }
  function nf(v, d) {
    return v === null || v === undefined || !isFinite(v) ? v === Infinity ? "∞" : "—" : v.toFixed(d === undefined ? 2 : d);
  }
  function kf(v) {
    return v >= 1e3 ? (v / 1e3).toFixed(1) + "K" : String(v);
  }
  var groups = [ {
    name: "📈 Performance & P&L",
    metrics: [ M("Total net P&L", $f(m.netPnl), $c(m.netPnl)), M("Profit P&L (winners)", $f(m.grossWin), "#22c55e"), M("Loss P&L (losers)", $f(m.grossLoss), "#ef4444"), M("Expectancy / trade", $f(m.expectancy), $c(m.expectancy)), M("Avg P&L / day", nDays ? $f(m.netPnl / nDays) : "—", $c(m.netPnl)), M("Best trade", $f(best), "#22c55e"), M("Worst trade", $f(worst), "#ef4444"), M("P&L stdev", $f(jnl_stdev(pnls)), "#f59e0b"), M("Profit-only stdev", $f(jnl_stdev(wins.map(function(t) {
      return t.netPnl;
    }))), "#f59e0b"), M("Loss-only stdev", $f(jnl_stdev(losses.map(function(t) {
      return t.netPnl;
    }))), "#f59e0b") ]
  }, {
    name: "🔁 Trade Statistics",
    metrics: [ M("Closed trades", m.closed), M("Open trades", open.length), M("Winning trades", m.wins, "#22c55e"), M("Losing trades", m.losses, "#ef4444"), M("Win rate", m.winRate !== null ? m.winRate.toFixed(1) + "%" : "—", m.winRate >= 50 ? "#22c55e" : "#f59e0b"), M("Profit factor", nf(m.profitFactor), m.profitFactor >= 1.5 ? "#22c55e" : "#f59e0b"), M("Payoff ratio", m.payoff !== null ? nf(m.payoff) + ":1" : "—"), M("Avg winner", $f(m.avgWin), "#22c55e"), M("Avg loser", $f(m.avgLoss), "#ef4444"), M("Long trades", m.longCount + " · " + $f(m.longPnl), $c(m.longPnl)), M("Short trades", m.shortCount + " · " + $f(m.shortPnl), $c(m.shortPnl)), M("Max win streak", m.maxWinStreak + "W", "#22c55e"), M("Max loss streak", m.maxLossStreak + "L", "#ef4444") ]
  }, {
    name: "⏱ Time Analysis",
    metrics: [ M("Total time in trades", jnl_fmtDur(durSum(closed))), M("Winning trades duration", jnl_fmtDur(durSum(wins)), "#22c55e"), M("Losing trades duration", jnl_fmtDur(durSum(losses)), "#ef4444"), M("Avg duration", jnl_fmtDur(jnl_mean(durs))), M("Max duration", durs.length ? jnl_fmtDur(Math.max.apply(null, durs)) : "—"), M("Min duration", durs.length ? jnl_fmtDur(Math.min.apply(null, durs)) : "—"), M("Avg winner hold", jnl_fmtDur(m.holdWin), "#22c55e"), M("Avg loser hold", jnl_fmtDur(m.holdLoss), "#ef4444") ]
  }, {
    name: "💸 Costs & Fees",
    metrics: [ M("Total fees", $f(m.fees), "#f59e0b"), M("Avg fees / trade", m.closed ? $f(m.fees / m.closed) : "—"), M("Avg fees / day", nDays ? $f(m.fees / nDays) : "—"), M("Fees % of profits", m.grossWin > 0 ? (m.fees / m.grossWin * 100).toFixed(1) + "%" : "—", "#f59e0b") ]
  }, {
    name: "📦 Volume Analysis",
    metrics: [ M("Total volume", kf(vol)), M("Winning volume", kf(volW), "#22c55e"), M("Losing volume", kf(volL), "#ef4444"), M("Avg shares / trade", m.closed ? kf(Math.round(vol / m.closed)) : "—"), M("Max shares", closed.length ? kf(Math.max.apply(null, closed.map(function(t) {
      return t.shares || 0;
    }))) : "—"), M("P&L per share", vol > 0 ? "$" + (m.netPnl / vol).toFixed(3) : "—", $c(m.netPnl)) ]
  } ];
  var symbols = jnl_bucketStats(closed, function(t) {
    return t.ticker;
  }).sort(function(a, b) {
    return Math.abs(b.pnl) - Math.abs(a.pnl);
  }).slice(0, 10);
  return {
    groups: groups,
    symbols: symbols
  };
}

function jnl_renderStatsCatalog(trades) {
  var el = document.getElementById("jnl-stats-catalog");
  if (!el) return;
  var closed = (trades || []).filter(function(t) {
    return !t.open && t.netPnl !== null;
  });
  if (!closed.length) {
    el.innerHTML = '<div class="jnl-corr-note">No closed trades yet.</div>';
    return;
  }
  var cat = jnl_statsCatalog(trades);
  var html = cat.groups.map(function(g, gi) {
    return '<details class="jnl-stat-group"' + (gi === 0 ? " open" : "") + "><summary>" + g.name + ' <span style="color:#475569;font-weight:400">· ' + g.metrics.length + " metrics</span></summary>" + '<div class="jnl-stat-cards">' + g.metrics.map(function(mt) {
      return '<div class="jnl-stat-card"><div class="s-name">' + mt.name + '</div><div class="s-val" style="color:' + mt.color + '">' + mt.val + "</div></div>";
    }).join("") + "</div></details>";
  }).join("");
  if (cat.symbols.length) {
    html += '<details class="jnl-stat-group" open><summary>🏷 Symbol Analysis <span style="color:#475569;font-weight:400">· top ' + cat.symbols.length + "</span></summary>" + '<div class="jnl-rec-wrap"><table class="jnl-corr-table">' + '<thead><tr><th style="text-align:left">Symbol</th><th>N</th><th>Win%</th><th>Net</th><th>Exp/tr</th></tr></thead><tbody>' + cat.symbols.map(function(s) {
      return '<tr><td class="jnl-rec-lbl" style="font-weight:700;color:#e2e8f0">' + s.label + "</td><td>" + s.n + "</td>" + '<td style="color:' + (s.winRate >= 50 ? "#22c55e" : "#f59e0b") + '">' + s.winRate.toFixed(0) + "%</td>" + '<td style="color:' + (s.pnl >= 0 ? "#22c55e" : "#ef4444") + ';font-weight:700">' + jnl_fmt$(s.pnl) + "</td>" + "<td>" + jnl_fmt$(s.exp) + "</td></tr>";
    }).join("") + "</tbody></table></div></details>";
  }
  el.innerHTML = html;
}

function jnl_dayStats(dayTrades) {
  var closed = dayTrades.filter(function(t) {
    return !t.open && t.netPnl !== null;
  });
  var wins = closed.filter(function(t) {
    return t.netPnl > 0;
  });
  var gw = wins.reduce(function(a, t) {
    return a + t.netPnl;
  }, 0);
  var gl = closed.reduce(function(a, t) {
    return a + Math.min(0, t.netPnl);
  }, 0);
  var gross = closed.reduce(function(a, t) {
    return a + (t.grossPnl != null ? t.grossPnl : t.netPnl);
  }, 0);
  var fees = closed.reduce(function(a, t) {
    return a + (t.totalComm || 0);
  }, 0);
  var withExit = closed.filter(function(t) {
    return t.exitAnalysis;
  });
  return {
    net: closed.reduce(function(a, t) {
      return a + t.netPnl;
    }, 0),
    gross: gross,
    fees: fees,
    count: dayTrades.length,
    closed: closed.length,
    winRate: closed.length ? wins.length / closed.length * 100 : null,
    pf: gl < 0 ? gw / -gl : gw > 0 ? Infinity : null,
    avgMfe: withExit.length ? jnl_mean(withExit.map(function(t) {
      return t.exitAnalysis.mfePct;
    }).filter(function(v) {
      return v != null;
    })) : null,
    avgMae: withExit.length ? jnl_mean(withExit.map(function(t) {
      return t.exitAnalysis.maePct;
    }).filter(function(v) {
      return v != null;
    })) : null
  };
}

var __jnlDayNotes = {};

function jnl_loadDayNotes(cb) {
  try {
    chrome.storage.local.get([ "smb_jnl_daynotes" ], function(d) {
      try {
        __jnlDayNotes = d.smb_jnl_daynotes ? JSON.parse(d.smb_jnl_daynotes) : {};
      } catch (_) {
        __jnlDayNotes = {};
      }
      if (cb) cb();
    });
  } catch (_) {
    if (cb) cb();
  }
}

function jnl_dayNoteKey(date) {
  var acctEl = document.getElementById("jnl-filter-account");
  return (acctEl && acctEl.value ? acctEl.value : "all") + "|" + date;
}

function jnl_saveDayNote(date, text) {
  var k = jnl_dayNoteKey(date);
  if (text && text.trim()) __jnlDayNotes[k] = text.trim(); else delete __jnlDayNotes[k];
  try {
    chrome.storage.local.set({
      smb_jnl_daynotes: JSON.stringify(__jnlDayNotes)
    });
  } catch (_) {}
}

function jnl_renderDayHeader(date, dayTrades) {
  var s = jnl_dayStats(dayTrades);
  var color = s.net >= 0 ? "#22c55e" : "#ef4444";
  var note = __jnlDayNotes[jnl_dayNoteKey(date)];
  var dObj = new Date(date + "T12:00Z");
  var nice = [ "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" ][dObj.getUTCDay()] + ", " + [ "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec" ][dObj.getUTCMonth()] + " " + dObj.getUTCDate() + ", " + dObj.getUTCFullYear();
  function cell(l, v, c) {
    return '<div><span style="color:#475569">' + l + '</span> <b style="color:' + (c || "#e2e8f0") + '">' + v + "</b></div>";
  }
  return '<div class="jnl-day-head" style="border-left-color:' + color + '">' + '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px">' + '<span style="color:#94a3b8;font-size:11px;font-weight:600">' + nice + "</span>" + '<span style="display:flex;align-items:center;gap:8px">' + '<span style="font-size:17px;font-weight:800;color:' + color + '">' + jnl_fmt$(s.net) + "</span>" + '<button class="jnl-corr-tab-btn jnl-day-note-btn" data-day="' + date + '">📝</button>' + "</span>" + "</div>" + '<div class="jnl-day-grid">' + cell("Return $", jnl_fmt$(s.gross), s.gross >= 0 ? "#22c55e" : "#ef4444") + cell("Fees", jnl_fmt$(s.fees)) + cell("Net $", jnl_fmt$(s.net), color) + cell("Trades", s.count) + cell("Win %", s.winRate !== null ? s.winRate.toFixed(0) + "%" : "—", s.winRate >= 50 ? "#22c55e" : "#f59e0b") + cell("Profit factor", s.pf === Infinity ? "∞" : s.pf !== null ? s.pf.toFixed(2) : "—") + (s.avgMfe != null ? cell("Avg MFE", s.avgMfe.toFixed(1) + "%", "#22c55e") : "") + (s.avgMae != null ? cell("Avg MAE", s.avgMae.toFixed(1) + "%", "#ef4444") : "") + "</div>" + (note ? '<div class="jnl-day-note-text" style="margin-top:6px;font-size:10px;color:#94a3b8;font-style:italic">' + note.replace(/</g, "&lt;") + "</div>" : "") + '<div class="jnl-day-note-editor" data-day="' + date + '" style="display:none;margin-top:6px">' + '<textarea class="jnl-day-note-ta" style="width:100%;height:52px;background:#0b1220;border:1px solid #334155;border-radius:6px;color:#e2e8f0;font-size:11px;padding:6px;box-sizing:border-box" placeholder="Day note — discipline, names in play, lessons…">' + (note ? note.replace(/</g, "&lt;") : "") + "</textarea>" + '<button class="jnl-corr-tab-btn jnl-day-note-save" data-day="' + date + '" style="margin-top:4px">Save note</button>' + "</div>" + "</div>";
}

function jnl_dashActiveTab() {
  var def = __jnlTrades && __jnlTrades.length ? "overview" : "trades";
  try {
    return localStorage.getItem("jnl_dash_tab") || def;
  } catch (_) {
    return def;
  }
}

function jnl_dashApplyVisibility() {
  var active = jnl_dashActiveTab();
  document.querySelectorAll(".jnl-dash-tab").forEach(function(btn) {
    var tab = btn.getAttribute("data-dash-tab");
    var panel = document.getElementById("jnl-tab-" + tab);
    if (panel) panel.classList[tab === active ? "add" : "remove"]("active");
    btn.classList[tab === active ? "add" : "remove"]("active");
  });
}

function jnl_dashTab(tab) {
  if (!tab) return;
  try {
    localStorage.setItem("jnl_dash_tab", tab);
  } catch (_) {}
  jnl_dashApplyVisibility();
}

function jnl_magnitudeSettings() {
  var def = {
    mode: "pct",
    pct: 25,
    rWin: 2,
    rLoss: -1,
    usdWin: 300,
    usdLoss: 200
  };
  try {
    var s = JSON.parse(localStorage.getItem("jnl_magnitude") || "{}");
    Object.keys(def).forEach(function(k) {
      if (s[k] === undefined || s[k] === null || s[k] === "") s[k] = def[k];
    });
    return s;
  } catch (_) {
    return def;
  }
}

function jnl_saveMagnitudeSettings(s) {
  try {
    localStorage.setItem("jnl_magnitude", JSON.stringify(s));
  } catch (_) {}
}

function jnl_signedR(t) {
  var r = t.exitAnalysis && t.exitAnalysis.rMultiple != null ? t.exitAnalysis.rMultiple : null;
  if (r == null || t.netPnl == null) return null;
  return t.netPnl >= 0 ? r : -r;
}

function jnl_classifyMagnitude(trades, s) {
  var out = {
    byId: {},
    cutWin: null,
    cutLoss: null,
    rMissing: 0
  };
  var closed = (trades || []).filter(function(t) {
    return !t.open && t.netPnl !== null;
  });
  if (!closed.length) return out;
  var winners = closed.filter(function(t) {
    return t.netPnl > 0;
  }).sort(function(a, b) {
    return b.netPnl - a.netPnl;
  });
  var losers = closed.filter(function(t) {
    return t.netPnl < 0;
  }).sort(function(a, b) {
    return a.netPnl - b.netPnl;
  });
  var kW = winners.length ? Math.max(1, Math.ceil(winners.length * s.pct / 100)) : 0;
  var kL = losers.length ? Math.max(1, Math.ceil(losers.length * s.pct / 100)) : 0;
  var pctCutWin = kW ? winners[kW - 1].netPnl : null;
  var pctCutLoss = kL ? losers[kL - 1].netPnl : null;
  function pctClass(t) {
    if (pctCutWin !== null && t.netPnl >= pctCutWin && t.netPnl > 0) return "big_win";
    if (pctCutLoss !== null && t.netPnl <= pctCutLoss && t.netPnl < 0) return "big_loss";
    return "small";
  }
  closed.forEach(function(t) {
    var cls;
    if (s.mode === "usd") {
      cls = t.netPnl >= s.usdWin ? "big_win" : t.netPnl <= -Math.abs(s.usdLoss) ? "big_loss" : "small";
    } else if (s.mode === "r") {
      var r = jnl_signedR(t);
      if (r === null) {
        out.rMissing++;
        cls = pctClass(t);
      } else cls = t.netPnl > 0 && r >= s.rWin ? "big_win" : t.netPnl < 0 && r <= s.rLoss ? "big_loss" : "small";
    } else {
      cls = pctClass(t);
    }
    out.byId[t.id] = cls;
  });
  out.cutWin = s.mode === "usd" ? s.usdWin : s.mode === "r" ? null : pctCutWin;
  out.cutLoss = s.mode === "usd" ? -Math.abs(s.usdLoss) : s.mode === "r" ? null : pctCutLoss;
  return out;
}

function jnl_renderMagnitudeSection(trades) {
  var el = document.getElementById("jnl-magnitude-stats");
  if (!el) return;
  var closed = (trades || []).filter(function(t) {
    return !t.open && t.netPnl !== null;
  });
  if (!closed.length) {
    el.innerHTML = "";
    return;
  }
  var s = jnl_magnitudeSettings();
  var mag = jnl_classifyMagnitude(closed, s);
  var bigW = closed.filter(function(t) {
    return mag.byId[t.id] === "big_win";
  });
  var bigL = closed.filter(function(t) {
    return mag.byId[t.id] === "big_loss";
  });
  var small = closed.filter(function(t) {
    return mag.byId[t.id] === "small";
  });
  function sum(list) {
    return list.reduce(function(a, t) {
      return a + t.netPnl;
    }, 0);
  }
  function avgR(list) {
    var rs = list.map(jnl_signedR).filter(function(r) {
      return r !== null;
    });
    return rs.length ? (rs.reduce(function(a, b) {
      return a + b;
    }, 0) / rs.length).toFixed(2) + "R" : "—";
  }
  var grossProfit = closed.filter(function(t) {
    return t.netPnl > 0;
  }).reduce(function(a, t) {
    return a + t.netPnl;
  }, 0);
  var grossLoss = closed.filter(function(t) {
    return t.netPnl < 0;
  }).reduce(function(a, t) {
    return a + t.netPnl;
  }, 0);
  var wShare = grossProfit > 0 ? Math.round(sum(bigW) / grossProfit * 100) : null;
  var lShare = grossLoss < 0 ? Math.round(sum(bigL) / grossLoss * 100) : null;
  function modeBtn(m, label) {
    return '<button class="jnl-corr-tab-btn jnl-mag-mode' + (s.mode === m ? " active" : "") + '" data-mag-mode="' + m + '">' + label + "</button>";
  }
  function inp(key, val, width) {
    return '<input class="jnl-mag-input" data-mag-key="' + key + '" type="number" step="any" value="' + val + '" ' + 'style="width:' + (width || 52) + 'px;background:#0f172a;border:1px solid #334155;border-radius:4px;color:#e2e8f0;font-size:11px;padding:3px 5px">';
  }
  var settingsHtml = s.mode === "pct" ? "Top/bottom " + inp("pct", s.pct) + " % of winners/losers by $" + (mag.cutWin !== null || mag.cutLoss !== null ? ' <span style="color:#475569">(now: win ≥ ' + (mag.cutWin !== null ? jnl_fmt$(mag.cutWin) : "—") + " · loss ≤ " + (mag.cutLoss !== null ? jnl_fmt$(mag.cutLoss) : "—") + ")</span>" : "") : s.mode === "r" ? "Big win ≥ " + inp("rWin", s.rWin) + " R · big loss ≤ " + inp("rLoss", s.rLoss) + " R" + (mag.rMissing ? ' <span style="color:#f59e0b">(' + mag.rMissing + " trades without R use the " + s.pct + "% rule — open their charts once)</span>" : "") : "Big win ≥ $" + inp("usdWin", s.usdWin, 64) + " · big loss ≤ −$" + inp("usdLoss", s.usdLoss, 64);
  function statLine(color, label, list, share, shareWord) {
    return '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:baseline;padding:3px 0;font-size:11px">' + '<b style="color:' + color + ';min-width:92px">' + label + "</b>" + '<span style="color:#e2e8f0">' + list.length + " trades</span>" + '<span style="color:' + color + ';font-weight:700">' + jnl_fmt$(sum(list)) + "</span>" + '<span style="color:#94a3b8">avg R ' + avgR(list) + "</span>" + (share != null ? '<span style="color:#475569">' + share + "% of all " + shareWord + "</span>" : "") + "</div>";
  }
  function alignRates(list) {
    var by = {};
    list.forEach(function(t) {
      var rec = t.checklistRecord && t.checklistRecord.length ? t.checklistRecord : t.snapshot ? jnl_computeChecklist(t.snapshot, t).items : null;
      if (!rec) return;
      rec.forEach(function(it) {
        if (it.good !== true && it.good !== false) return;
        var k = it.key || it.label;
        if (!by[k]) by[k] = {
          label: it.nlabel || it.label,
          al: 0,
          n: 0
        };
        by[k].n++;
        if (it.good) by[k].al++;
      });
    });
    return by;
  }
  var sepHtml = "";
  if (bigW.length >= 2 && bigL.length >= 2) {
    var wRates = alignRates(bigW), lRates = alignRates(bigL);
    var rows = [];
    var sepKeys = {};
    Object.keys(wRates).forEach(function(k) {
      sepKeys[k] = true;
    });
    Object.keys(lRates).forEach(function(k) {
      sepKeys[k] = true;
    });
    Object.keys(sepKeys).forEach(function(k) {
      var w = wRates[k], l = lRates[k];
      var wp = w ? Math.round(w.al / w.n * 100) : null;
      var lp = l ? Math.round(l.al / l.n * 100) : null;
      rows.push({
        label: w && w.label || l && l.label || k,
        wp: wp,
        lp: lp,
        wn: w ? w.n : 0,
        ln: l ? l.n : 0,
        d: wp != null && lp != null ? wp - lp : null
      });
    });
    rows.sort(function(a, b) {
      return Math.abs(b.d || 0) - Math.abs(a.d || 0);
    });
    if (rows.length) {
      var sepCell = function(p, n) {
        return p == null ? '<td style="color:#475569">—<div style="color:#475569;font-size:9px">not measured</div></td>' : "<td>" + p + '%<div style="color:#475569;font-size:9px">' + n + " checks</div></td>";
      };
      var sepRow = function(r) {
        var dc = r.d == null ? "#475569" : r.d > 0 ? "#22c55e" : r.d < 0 ? "#ef4444" : "#64748b";
        return '<tr><td class="jnl-rec-lbl">' + r.label + "</td>" + sepCell(r.wp, r.wn) + sepCell(r.lp, r.ln) + '<td style="color:' + dc + ';font-weight:700">' + (r.d == null ? "—" : (r.d > 0 ? "+" : "") + r.d + "pp") + "</td></tr>";
      };
      var sepThead = '<thead><tr><th style="text-align:left">Checkpoint</th><th style="color:#22c55e">Aligned in big wins</th><th style="color:#ef4444">Aligned in big losses</th><th>Δ</th></tr></thead>';
      var sepAll = rows.length > 12 ? '<details class="jnl-chk-all"><summary>▸ Show all ' + rows.length + ' checkpoints</summary><div class="jnl-rec-wrap"><table class="jnl-corr-table">' + sepThead + "<tbody>" + rows.map(sepRow).join("") + "</tbody></table></div></details>" : "";
      sepHtml = '<div class="jnl-corr-subhead">What separates big winners from big losers</div>' + '<div class="jnl-rec-wrap"><table class="jnl-corr-table">' + sepThead + "<tbody>" + rows.slice(0, 12).map(sepRow).join("") + "</tbody></table></div>" + sepAll;
    }
  } else {
    sepHtml = '<div class="jnl-corr-note">Need ≥2 big winners and ≥2 big losers (with recorded checklists) for the separation table — have ' + bigW.length + " / " + bigL.length + ".</div>";
  }
  var setups = {};
  closed.forEach(function(t) {
    var st = jnl_setupLabel(t);
    if (!setups[st]) setups[st] = {
      bw: [],
      bl: [],
      sm: []
    };
    var c = mag.byId[t.id];
    (c === "big_win" ? setups[st].bw : c === "big_loss" ? setups[st].bl : setups[st].sm).push(t);
  });
  var setupHtml = '<div class="jnl-corr-subhead">By setup</div>' + '<div class="jnl-rec-wrap"><table class="jnl-corr-table">' + '<thead><tr><th style="text-align:left">Setup</th><th style="color:#22c55e">Big wins</th><th style="color:#ef4444">Big losses</th><th>Small</th><th>Net $</th></tr></thead><tbody>' + Object.keys(setups).map(function(st) {
    var g = setups[st];
    var net = sum(g.bw) + sum(g.bl) + sum(g.sm);
    return '<tr><td class="jnl-rec-lbl">' + (JNL_SETUP_LABELS[st] || st) + "</td>" + "<td>" + g.bw.length + ' <span style="color:#475569;font-size:9px">' + jnl_fmt$(sum(g.bw)) + "</span></td>" + "<td>" + g.bl.length + ' <span style="color:#475569;font-size:9px">' + jnl_fmt$(sum(g.bl)) + "</span></td>" + "<td>" + g.sm.length + "</td>" + '<td style="color:' + (net >= 0 ? "#22c55e" : "#ef4444") + ';font-weight:700">' + jnl_fmt$(net) + "</td></tr>";
  }).join("") + "</tbody></table></div>";
  el.innerHTML = '<div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:10px 12px">' + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:4px">' + '<span style="color:#64748b;font-size:10px;font-weight:600">💰 BIG WINNERS vs BIG LOSERS · ' + closed.length + " closed</span>" + '<span style="display:flex;gap:4px">' + modeBtn("pct", "Percentile") + modeBtn("r", "R-multiple") + modeBtn("usd", "Fixed $") + "</span>" + "</div>" + '<div style="color:#94a3b8;font-size:10px;margin-bottom:6px">' + settingsHtml + "</div>" + statLine("#22c55e", "▲ Big winners", bigW, wShare, "profits") + statLine("#ef4444", "▼ Big losers", bigL, lShare, "losses") + statLine("#64748b", "· Small trades", small, null, "") + sepHtml + setupHtml + "</div>";
  el.querySelectorAll(".jnl-mag-mode").forEach(function(btn) {
    btn.addEventListener("click", function() {
      var ns = jnl_magnitudeSettings();
      ns.mode = btn.getAttribute("data-mag-mode");
      jnl_saveMagnitudeSettings(ns);
      jnl_renderList();
    });
  });
  el.querySelectorAll(".jnl-mag-input").forEach(function(input) {
    input.addEventListener("change", function() {
      var ns = jnl_magnitudeSettings();
      var v = parseFloat(input.value);
      if (!isNaN(v)) ns[input.getAttribute("data-mag-key")] = v;
      jnl_saveMagnitudeSettings(ns);
      jnl_renderList();
    });
  });
}

var __jnlCorrelations = null;

function jnl_computeCorrelations(trades) {
  var closed = trades.filter(function(t) {
    return !t.open && t.netPnl !== null && t.snapshot;
  });
  if (closed.length < 5) return null;
  function grp(list) {
    if (!list.length) return null;
    var wins = list.filter(function(t) {
      return t.netPnl > 0;
    });
    var rs = list.filter(function(t) {
      return t.exitAnalysis && t.exitAnalysis.rMultiple != null;
    });
    var caps = list.filter(function(t) {
      return t.exitAnalysis && t.exitAnalysis.capturePct != null;
    });
    return {
      n: list.length,
      winRate: Math.round(wins.length / list.length * 100),
      avgPnl: Math.round(list.reduce(function(s, t) {
        return s + t.netPnl;
      }, 0) / list.length * 100) / 100,
      avgR: rs.length ? Math.round(rs.reduce(function(s, t) {
        return s + t.exitAnalysis.rMultiple;
      }, 0) / rs.length * 100) / 100 : null,
      avgCapture: caps.length ? Math.round(caps.reduce(function(s, t) {
        return s + t.exitAnalysis.capturePct;
      }, 0) / caps.length) : null
    };
  }
  function byKey(list, keyFn) {
    var map = {};
    list.forEach(function(t) {
      var k = keyFn(t) || "Unknown";
      if (!map[k]) map[k] = [];
      map[k].push(t);
    });
    return Object.keys(map).map(function(k) {
      return {
        label: k,
        stats: grp(map[k])
      };
    }).filter(function(b) {
      return b.stats.n >= 2;
    }).sort(function(a, b) {
      return b.stats.winRate - a.stats.winRate;
    });
  }
  function checklistCorr(tradeList, minBucket) {
    var buckets = {};
    tradeList.forEach(function(trade) {
      jnl_computeChecklist(trade.snapshot, trade).items.forEach(function(it) {
        if (!buckets[it.label]) buckets[it.label] = {
          pass: [],
          fail: []
        };
        if (it.good === true) buckets[it.label].pass.push(trade);
        if (it.good === false) buckets[it.label].fail.push(trade);
      });
    });
    var rows = [];
    Object.keys(buckets).forEach(function(label) {
      var b = buckets[label];
      var ps = b.pass.length >= (minBucket || 3) ? grp(b.pass) : null;
      var fs = b.fail.length >= (minBucket || 3) ? grp(b.fail) : null;
      if (!ps && !fs) return;
      rows.push({
        label: label,
        pass: ps,
        fail: fs,
        impact: ps && fs ? ps.winRate - fs.winRate : null
      });
    });
    rows.sort(function(a, b) {
      return Math.abs(b.impact || 0) - Math.abs(a.impact || 0);
    });
    return rows;
  }
  var withDur = closed.filter(function(t) {
    return t.durationMs;
  }).sort(function(a, b) {
    return a.durationMs - b.durationMs;
  });
  var q = Math.floor(withDur.length / 4);
  var durCorr = null;
  if (q >= 2) {
    var qMs = function(i) {
      return Math.round(withDur[i].durationMs / 6e4);
    };
    durCorr = [ {
      label: "Quick (<" + qMs(q - 1) + "m)",
      stats: grp(withDur.slice(0, q))
    }, {
      label: "Short",
      stats: grp(withDur.slice(q, q * 2))
    }, {
      label: "Medium",
      stats: grp(withDur.slice(q * 2, q * 3))
    }, {
      label: "Long (>" + qMs(q * 3) + "m)",
      stats: grp(withDur.slice(q * 3))
    } ].filter(function(b) {
      return b.stats && b.stats.n >= 2;
    });
  }
  var setupCorr = {};
  var setupGroups = {};
  closed.forEach(function(t) {
    var s = t.setup || "unknown";
    if (!setupGroups[s]) setupGroups[s] = [];
    setupGroups[s].push(t);
  });
  Object.keys(setupGroups).forEach(function(s) {
    if (setupGroups[s].length < 5) return;
    setupCorr[s] = checklistCorr(setupGroups[s], 2);
  });
  var longs = closed.filter(function(t) {
    return t.side === "long";
  });
  var shorts = closed.filter(function(t) {
    return t.side === "short";
  });
  return {
    total: closed.length,
    overall: grp(closed),
    longStats: longs.length ? grp(longs) : null,
    shortStats: shorts.length ? grp(shorts) : null,
    checklistCorr: checklistCorr(closed, 3),
    checklistCorrLong: checklistCorr(longs, 2),
    checklistCorrShort: checklistCorr(shorts, 2),
    bySession: byKey(closed, function(t) {
      return t.snapshot && t.snapshot.sessionPeriod;
    }),
    byDay: byKey(closed, function(t) {
      if (!t.date) return null;
      return [ "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat" ][new Date(t.date + "T12:00:00Z").getUTCDay()];
    }),
    bySetup: byKey(closed, function(t) {
      return t.setup || "unknown";
    }),
    byRegime: byKey(closed, function(t) {
      return t.marketBias || null;
    }),
    bySector: byKey(closed, function(t) {
      return t.inHotSector === true ? "Hot sector" : t.inHotSector === false ? "Cold sector" : null;
    }),
    durCorr: durCorr,
    setupCorr: setupCorr
  };
}

function jnl_gradeTrade(trade, corr) {
  if (!corr || !trade.snapshot || corr.total < 10) return null;
  var sideTable = (trade.side === "short" ? corr.checklistCorrShort : corr.checklistCorrLong) || corr.checklistCorr;
  var highImpact = sideTable.filter(function(c) {
    return c.impact != null && c.impact >= 15 && c.pass && c.pass.n >= 3;
  }).slice(0, 8);
  if (highImpact.length < 3) return null;
  var byLabel = {};
  jnl_computeChecklist(trade.snapshot, trade).items.forEach(function(it) {
    byLabel[it.label] = it.good;
  });
  var hits = highImpact.filter(function(c) {
    return byLabel[c.label] === true;
  }).length;
  var pct = hits / highImpact.length;
  if (pct >= .85) return "A+";
  if (pct >= .7) return "A";
  if (pct >= .55) return "A-";
  if (pct >= .4) return "B";
  return "C";
}

function jnl_renderTradeGrade(grade) {
  if (!grade) return "";
  var gradeColorMap = {
    "A+": "#fbbf24",
    A: "#22c55e",
    "A-": "#06b6d4",
    B: "#f59e0b",
    C: "#ef4444"
  };
  var c = gradeColorMap[grade] || "#475569";
  return '<span style="font-size:10px;font-weight:700;color:' + c + ";background:" + c + "22;padding:1px 6px;border-radius:3px;border:1px solid " + c + '44;margin-left:4px">' + grade + "</span>";
}

function jnl_recordCorrRows(list) {
  var by = {}, order = [];
  list.forEach(function(t) {
    var rec = t.checklistRecord && t.checklistRecord.length ? t.checklistRecord : t.snapshot ? jnl_computeChecklist(t.snapshot, t).items : null;
    if (!rec) return;
    var win = t.netPnl > 0;
    rec.forEach(function(it) {
      if (it.good !== true && it.good !== false) return;
      var b = by[it.key || it.label];
      if (!b) {
        b = by[it.key || it.label] = {
          key: it.key || it.label,
          label: it.label,
          nlabel: it.nlabel || it.label,
          aW: 0,
          aL: 0,
          nW: 0,
          nL: 0
        };
        order.push(b);
      }
      if (it.good) {
        if (win) b.aW++; else b.aL++;
      } else {
        if (win) b.nW++; else b.nL++;
      }
    });
  });
  order.forEach(function(b) {
    b.aN = b.aW + b.aL;
    b.nN = b.nW + b.nL;
    b.tot = b.aN + b.nN;
    b.aWin = b.aN ? b.aW / b.aN : null;
    b.nWin = b.nN ? b.nW / b.nN : null;
    b.edge = b.aWin != null && b.nWin != null ? Math.round((b.aWin - b.nWin) * 100) : null;
    var SHRINK_K = 8;
    b.edgeAdj = b.edge != null ? b.edge * (b.tot / (b.tot + SHRINK_K)) : 0;
  });
  order.sort(function(a, b) {
    return Math.abs(b.edgeAdj) - Math.abs(a.edgeAdj) || b.tot - a.tot;
  });
  return order;
}

function jnl_winSignal(items, corrRows, opts) {
  opts = opts || {};
  var minN = opts.minN || 8;
  var minEdge = opts.minEdge || 15;
  var minConfirm = opts.minConfirm || 4;
  var byKey = {};
  (corrRows || []).forEach(function(b) {
    if (b && b.key != null) byKey[b.key] = b;
  });
  var confirms = [], redFlags = [], missed = [], net = 0, posAvail = 0;
  (items || []).forEach(function(it) {
    if (it.good !== true && it.good !== false) return;
    var b = byKey[it.key != null ? it.key : it.label];
    if (!b || b.edge == null) return;
    var n = typeof b.tot === "number" ? b.tot : (b.aN || 0) + (b.nN || 0);
    if (n < minN || Math.abs(b.edge) < minEdge) return;
    var w = typeof b.edgeAdj === "number" ? b.edgeAdj : b.edge;
    if (b.edge > 0) posAvail++;
    if (it.good) {
      net += w;
      if (b.edge > 0) confirms.push({
        label: it.label,
        edge: b.edge,
        n: n
      }); else redFlags.push({
        label: it.nlabel || it.label,
        edge: b.edge,
        n: n
      });
    } else if (b.edge > 0) {
      missed.push({
        label: it.label,
        edge: b.edge,
        n: n
      });
    }
  });
  [ confirms, redFlags, missed ].forEach(function(a) {
    a.sort(function(x, y) {
      return Math.abs(y.edge) - Math.abs(x.edge);
    });
  });
  var signal = redFlags.length ? "AVOID" : confirms.length >= minConfirm && net > 0 ? "GO" : confirms.length ? "CAUTION" : "WAIT";
  return {
    signal: signal,
    net: Math.round(net),
    confirms: confirms,
    redFlags: redFlags,
    missed: missed,
    posAvail: posAvail,
    minConfirm: minConfirm
  };
}

var __jnlCorrGroupMode = null;

var __jnlCorrTradeScope = null;

function jnl_renderCorrelationSection(corr) {
  var el = document.getElementById("jnl-corr-stats");
  if (!el) return;
  if (__jnlCorrGroupMode === null) {
    try {
      __jnlCorrGroupMode = localStorage.getItem("jnl_corr_group") || "side";
    } catch (_) {
      __jnlCorrGroupMode = "side";
    }
  }
  if (__jnlCorrTradeScope === null) {
    try {
      __jnlCorrTradeScope = localStorage.getItem("jnl_corr_tradescope") || "all";
    } catch (_) {
      __jnlCorrTradeScope = "all";
    }
  }
  var mode = __jnlCorrGroupMode;
  var tScope = __jnlCorrTradeScope;
  var closed = jnl_scopedTrades().filter(function(t) {
    return !t.open && t.netPnl !== null && (t.checklistRecord && t.checklistRecord.length || t.snapshot);
  });
  var bigNote = "";
  if (tScope === "big" && closed.length) {
    var magC = jnl_classifyMagnitude(closed, jnl_magnitudeSettings());
    closed = closed.filter(function(t) {
      return magC.byId[t.id] === "big_win" || magC.byId[t.id] === "big_loss";
    });
    bigNote = '<div style="color:#f59e0b;font-size:9px;margin-bottom:6px">Big winners &amp; big losers only (rule set in the 💰 panel above) — "win" here means BIG win.</div>';
  }
  function winColor(pct) {
    return pct >= 70 ? "#22c55e" : pct >= 50 ? "#f59e0b" : "#ef4444";
  }
  function winRateOf(list) {
    if (!list.length) return null;
    return Math.round(list.filter(function(t) {
      return t.netPnl > 0;
    }).length / list.length * 100);
  }
  if (!closed.length) {
    var totalClosed = (__jnlTrades || []).filter(function(t) {
      return !t.open && t.netPnl !== null;
    }).length;
    el.style.display = "block";
    el.innerHTML = '<div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:12px 14px">' + '<div style="color:#64748b;font-size:10px;font-weight:600;margin-bottom:8px">📊 CORRELATION ANALYSIS</div>' + '<div style="color:#94a3b8;font-size:11px;line-height:1.6;margin-bottom:8px">' + "Shows, per checkpoint, how often you <b>win when the checkpoint is aligned</b> vs when it is not. " + '"Aligned" follows the trade direction: above VWAP for longs, below for shorts; BB upper zone for longs; slope up for longs.' + "</div>" + '<div style="background:#0a1628;border-left:2px solid #1e40af;border-radius:0 4px 4px 0;padding:6px 10px;font-size:10px;color:#93c5fd">' + "→ Open 📈 Chart once on each closed trade to record its checklist.<br>" + '<span style="color:#475569">Progress: 0 of ' + totalClosed + " closed trades recorded.</span>" + "</div>" + "</div>";
    return;
  }
  var SETUP_ORDER = [ "vwap_bounce", "ma_bounce", "catch_low_high", "unknown" ];
  function setupOf(t) {
    return jnl_setupLabel(t);
  }
  function setupName(s) {
    return JNL_SETUP_LABELS[s] || s;
  }
  function winCell(win, n) {
    return win == null || !n ? '<td style="color:#475569">—</td>' : "<td>" + Math.round(win * 100) + '%<div style="color:#475569;font-size:9px">' + n + " trades</div></td>";
  }
  function edgeCell(b) {
    if (b.edge == null) return '<td style="color:#475569">—</td>';
    var strong = b.edge > 0 ? "#22c55e" : b.edge < 0 ? "#ef4444" : "#64748b";
    var col = b.tot >= 20 ? strong : b.tot >= 8 ? b.edge > 0 ? "#4d7c50" : b.edge < 0 ? "#7c4d4d" : "#64748b" : "#64748b";
    var tag = b.tot < 8 ? '<div style="color:#475569;font-size:9px">thin · n=' + b.tot + "</div>" : b.tot < 20 ? '<div style="color:#475569;font-size:9px">n=' + b.tot + "</div>" : "";
    return '<td style="color:' + col + ';font-weight:700">' + (b.edge > 0 ? "+" : "") + b.edge + "pp" + tag + "</td>";
  }
  function subTable(title, list, useNeutral) {
    var wr = winRateOf(list);
    var head = '<div class="jnl-corr-subhead">' + title + " · " + list.length + " trades" + (wr != null ? ' · <b style="color:' + winColor(wr) + '">' + wr + "% win</b>" : "") + "</div>";
    if (list.length < 3) {
      return head + '<div class="jnl-corr-note">Needs at least 3 closed trades — has ' + list.length + ".</div>";
    }
    var rows = jnl_recordCorrRows(list);
    if (!rows.length) {
      return head + '<div class="jnl-corr-note">No checklist records yet — open 📈 Chart on these trades once.</div>';
    }
    function corrRow(b) {
      return "<tr>" + '<td class="jnl-rec-lbl">' + (useNeutral ? b.nlabel : b.label) + "</td>" + winCell(b.aWin, b.aN) + winCell(b.nWin, b.nN) + edgeCell(b) + "</tr>";
    }
    var corrThead = "<thead><tr>" + '<th style="text-align:left">Checkpoint</th>' + '<th style="color:#22c55e">✓ Aligned win%</th>' + '<th style="color:#ef4444">✗ Not-aligned win%</th>' + "<th>Edge</th>" + "</tr></thead>";
    var topTable = '<div class="jnl-rec-wrap"><table class="jnl-corr-table">' + corrThead + "<tbody>" + rows.slice(0, 12).map(corrRow).join("") + "</tbody></table></div>";
    var allExp = "";
    if (rows.length > 12) {
      allExp = '<details class="jnl-chk-all"><summary>▸ Show all ' + rows.length + " checkpoints</summary>" + '<div class="jnl-rec-wrap"><table class="jnl-corr-table">' + corrThead + "<tbody>" + rows.map(corrRow).join("") + "</tbody></table></div>" + '<div class="jnl-corr-note">All ' + rows.length + " also in the CSV export.</div></details>";
    }
    return head + topTable + allExp;
  }
  function sideHeader(side, list) {
    var color = side === "long" ? "#22c55e" : "#ef4444";
    var arrow = side === "long" ? "▲" : "▼";
    var wr = winRateOf(list);
    return '<div class="jnl-corr-sidehead" style="color:' + color + '">' + arrow + " " + side.toUpperCase() + " TRADES" + '<span style="color:#475569;font-weight:400;font-size:10px;margin-left:8px">' + list.length + " closed" + (wr != null ? " · " + wr + "% win" : "") + "</span></div>";
  }
  var html = '<div style="background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:10px 12px">';
  html += '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:4px">' + '<span style="color:#64748b;font-size:10px;font-weight:600">📊 CORRELATION ANALYSIS · ' + closed.length + " trades</span>" + '<span style="display:flex;gap:4px;flex-wrap:wrap">' + '<button data-corr-tab="side" class="jnl-corr-tab-btn' + (mode === "side" ? " active" : "") + '">Side ▸ Setup</button>' + '<button data-corr-tab="setup" class="jnl-corr-tab-btn' + (mode === "setup" ? " active" : "") + '">Setup ▸ Side</button>' + '<button data-corr-tab="trades-all" class="jnl-corr-tab-btn' + (tScope === "all" ? " active" : "") + '">All trades</button>' + '<button data-corr-tab="trades-big" class="jnl-corr-tab-btn' + (tScope === "big" ? " active" : "") + '">Big only</button>' + "</span>" + "</div>";
  html += '<div style="color:#475569;font-size:9px;margin-bottom:8px">' + "Aligned = checkpoint agrees with the trade direction (above VWAP / BB upper zone / slope up for longs — mirrored for shorts). " + "Edge = win% when aligned − win% when not aligned (so +pp means the checkpoint helped). " + "Faded rows / “thin” = small sample — treat with caution." + "</div>" + bigNote;
  if (mode === "side") {
    [ "long", "short" ].forEach(function(side) {
      var sideList = closed.filter(function(t) {
        return t.side === side;
      });
      html += sideHeader(side, sideList);
      if (!sideList.length) {
        html += '<div class="jnl-corr-note">No closed ' + side + " trades yet.</div>";
        return;
      }
      html += subTable("All setups", sideList, false);
      SETUP_ORDER.forEach(function(s) {
        var list = sideList.filter(function(t) {
          return setupOf(t) === s;
        });
        if (!list.length) return;
        html += subTable((side === "long" ? "Long" : "Short") + " · " + setupName(s), list, false);
      });
      html += '<div style="height:10px"></div>';
    });
  } else {
    SETUP_ORDER.forEach(function(s) {
      var setupList = closed.filter(function(t) {
        return setupOf(t) === s;
      });
      if (!setupList.length) return;
      var wr = winRateOf(setupList);
      html += '<div class="jnl-corr-sidehead" style="color:#93c5fd">' + setupName(s).toUpperCase() + '<span style="color:#475569;font-weight:400;font-size:10px;margin-left:8px">' + setupList.length + " closed" + (wr != null ? " · " + wr + "% win" : "") + "</span></div>";
      var longs = setupList.filter(function(t) {
        return t.side === "long";
      });
      var shorts = setupList.filter(function(t) {
        return t.side === "short";
      });
      if (longs.length) html += subTable(setupName(s) + " · Long", longs, false);
      if (shorts.length) html += subTable(setupName(s) + " · Short", shorts, false);
      if (longs.length && shorts.length) html += subTable(setupName(s) + " · Long + Short", setupList, true);
      html += '<div style="height:10px"></div>';
    });
  }
  if (corr) {
    function breakdown(list) {
      return (list || []).map(function(b) {
        return '<span style="margin-right:10px;font-size:10px;white-space:nowrap"><span style="color:#64748b">' + b.label + ": </span>" + '<b style="color:' + winColor(b.stats.winRate) + '">' + b.stats.winRate + "%</b>" + '<span style="color:#334155;font-size:9px"> (' + b.stats.n + ")</span></span>";
      }).join("");
    }
    html += '<div style="color:#475569;font-size:9px;font-weight:600;letter-spacing:0.08em;margin-top:6px;margin-bottom:4px;border-top:1px solid #1e293b;padding-top:8px">TIMING &amp; CONTEXT</div>';
    html += '<div style="margin-bottom:3px"><span style="color:#64748b;font-size:9px">Session: </span>' + breakdown(corr.bySession) + "</div>";
    html += '<div style="margin-bottom:3px"><span style="color:#64748b;font-size:9px">Day: </span>' + breakdown(corr.byDay) + "</div>";
    if (corr.durCorr && corr.durCorr.length) html += '<div style="margin-bottom:3px"><span style="color:#64748b;font-size:9px">Duration: </span>' + breakdown(corr.durCorr) + "</div>";
    if (corr.byRegime.some(function(b) {
      return b.stats.n >= 2;
    })) html += '<div style="margin-bottom:3px"><span style="color:#64748b;font-size:9px">Market regime: </span>' + breakdown(corr.byRegime) + "</div>";
    if (corr.bySector.some(function(b) {
      return b.stats.n >= 2;
    })) html += '<div style="margin-bottom:3px"><span style="color:#64748b;font-size:9px">Sector heat: </span>' + breakdown(corr.bySector) + "</div>";
  }
  html += "</div>";
  el.style.display = "block";
  el.innerHTML = html;
}

function jnl_corrTab(tab) {
  if (!tab) return;
  if (tab === "trades-all" || tab === "trades-big") {
    __jnlCorrTradeScope = tab === "trades-big" ? "big" : "all";
    try {
      localStorage.setItem("jnl_corr_tradescope", __jnlCorrTradeScope);
    } catch (_) {}
  } else {
    __jnlCorrGroupMode = tab === "setup" ? "setup" : "side";
    try {
      localStorage.setItem("jnl_corr_group", __jnlCorrGroupMode);
    } catch (_) {}
  }
  jnl_renderCorrelationSection(__jnlCorrelations);
}

function jnl_renderChart(trade, allCandles, dayCandles, dailyCandles, resolution, oneMinCandles) {
  if (!allCandles || !allCandles.length) {
    jnl_setChartStatus("No candle data available for this date.", true);
    return;
  }
  var LW = window.LightweightCharts;
  if (!LW) {
    jnl_setChartStatus("Chart library not loaded.", true);
    return;
  }
  var mainEl = document.getElementById("jnl-chart-container");
  var volEl = document.getElementById("jnl-vol-container");
  if (!mainEl || !volEl) return;
  mainEl.innerHTML = "";
  volEl.innerHTML = "";
  var etOffH = jnl_etOffsetMs(trade.date) / 36e5;
  var displayCandles = allCandles && allCandles.length ? allCandles : dayCandles;
  var closes = allCandles.map(function(c) {
    return c.close;
  });
  var scaleOpts = {
    handleScale: {
      mouseWheel: true,
      pinchScale: true,
      axisPressedMouseMove: {
        time: true,
        price: true
      }
    },
    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: true
    }
  };
  function fmtEtTime(unixSec) {
    var d = new Date(unixSec * 1e3 - etOffH * 36e5);
    var hh = d.getUTCHours().toString().padStart(2, "0");
    var mm = d.getUTCMinutes().toString().padStart(2, "0");
    return hh + ":" + mm + " ET";
  }
  function etTickMark(time, type) {
    var d = new Date(time * 1e3 - etOffH * 36e5);
    if (type <= 2) {
      var mo = (d.getUTCMonth() + 1).toString().padStart(2, "0");
      var dy = d.getUTCDate().toString().padStart(2, "0");
      return mo + "/" + dy;
    }
    var hh = d.getUTCHours().toString().padStart(2, "0");
    var mm = d.getUTCMinutes().toString().padStart(2, "0");
    return hh + ":" + mm;
  }
  var chart = LW.createChart(mainEl, Object.assign({
    width: mainEl.offsetWidth || 760,
    height: mainEl.offsetHeight || 380,
    layout: {
      background: {
        color: "#0f172a"
      },
      textColor: "#94a3b8"
    },
    grid: {
      vertLines: {
        color: "#1e293b"
      },
      horzLines: {
        color: "#1e293b"
      }
    },
    crosshair: {
      mode: LW.CrosshairMode.Normal
    },
    rightPriceScale: {
      borderColor: "#1e293b",
      autoScale: true
    },
    localization: {
      timeFormatter: fmtEtTime
    },
    timeScale: {
      borderColor: "#1e293b",
      timeVisible: true,
      secondsVisible: false,
      tickMarkFormatter: etTickMark
    },
    handleScale: {
      mouseWheel: true,
      pinchScale: true,
      axisPressedMouseMove: {
        time: true,
        price: true
      }
    },
    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: true
    }
  }, scaleOpts));
  __jnlChart = chart;
  function isRegular(unixSec) {
    var etH = new Date(unixSec * 1e3).getUTCHours() + new Date(unixSec * 1e3).getUTCMinutes() / 60 - etOffH;
    return etH >= 9.5 && etH < 16;
  }
  var candleSeries = chart.addCandlestickSeries({
    upColor: "#22c55e",
    downColor: "#ef4444",
    borderUpColor: "#22c55e",
    borderDownColor: "#ef4444",
    wickUpColor: "#22c55e",
    wickDownColor: "#ef4444"
  });
  candleSeries.setData(displayCandles.map(function(c) {
    var reg = isRegular(c.time);
    var bull = c.close >= c.open;
    return {
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      color: reg ? bull ? "#22c55e" : "#ef4444" : bull ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)",
      borderColor: reg ? bull ? "#22c55e" : "#ef4444" : "rgba(100,116,139,0.4)",
      wickColor: reg ? bull ? "#22c55e" : "#ef4444" : "rgba(100,116,139,0.4)"
    };
  }));
  var sessionBg = chart.addHistogramSeries({
    priceScaleId: "session-bg",
    lastValueVisible: false,
    priceLineVisible: false
  });
  chart.priceScale("session-bg").applyOptions({
    visible: false,
    scaleMargins: {
      top: 0,
      bottom: 0
    }
  });
  sessionBg.setData(displayCandles.filter(function(c) {
    return !isRegular(c.time);
  }).map(function(c) {
    return {
      time: c.time,
      value: 1,
      color: "rgba(30,58,138,0.45)"
    };
  }));
  var dayTimeSet = {};
  displayCandles.forEach(function(c) {
    dayTimeSet[c.time] = true;
  });
  var vcbMa5;
  var oneMin = oneMinCandles && oneMinCandles.length ? oneMinCandles : (resolution || 1) === 1 ? allCandles : null;
  if (oneMin) {
    vcbMa5 = jnl_vcbMa5Day(oneMin, allCandles, resolution || 1);
  } else {
    var sma5dFb = jnl_calc5dMaSeries(allCandles, resolution || 1);
    var m5map = {};
    sma5dFb.forEach(function(pt) {
      m5map[pt.time] = pt.value;
    });
    vcbMa5 = allCandles.map(function(c) {
      return m5map[c.time] != null ? m5map[c.time] : null;
    });
  }
  var vcb = jnl_vcbCompute(allCandles, etOffH, {
    ma5day: vcbMa5
  });
  function vcbLine(vals, color, lw, title, opts) {
    opts = opts || {};
    var data = [], any = false;
    for (var vi = 0; vi < allCandles.length; vi++) {
      var t = allCandles[vi].time;
      if (!dayTimeSet[t]) continue;
      if (vals[vi] != null) {
        data.push({
          time: t,
          value: vals[vi]
        });
        any = true;
      } else if (opts.linebr) data.push({
        time: t
      });
    }
    if (!any) return;
    var s = chart.addLineSeries({
      color: color,
      lineWidth: lw,
      priceLineVisible: false,
      lastValueVisible: !!opts.lastVal,
      title: title
    });
    s.setData(data);
  }
  vcbLine(vcb.vwap1d, "rgb(161,8,211)", 2, "1D VWAP", {
    lastVal: true
  });
  vcbLine(vcb.vwap2d, "rgb(249,8,193)", 2, "2D VWAP");
  vcbLine(vcb.vwapW, "rgb(43,153,237)", 2, "W-VWAP");
  vcbLine(vcb.vwapM, "rgb(255,152,0)", 2, "M-VWAP");
  var hpb = jnl_hpbCompute(allCandles, etOffH, {});
  vcbLine(hpb.bzSma9, "#00bcd4", 1, "SMA 9");
  vcbLine(hpb.bzSma13, "#9c27b0", 1, "SMA 13");
  vcbLine(hpb.bzSma20, "#ffffff", 1, "SMA 20");
  var bb = jnl_calcBB(closes, 20, 2);
  var bbUpper = [], bbLower = [], bbMid = [];
  allCandles.forEach(function(c, i) {
    if (bb.upper[i] !== null && dayTimeSet[c.time]) {
      bbUpper.push({
        time: c.time,
        value: bb.upper[i]
      });
      bbLower.push({
        time: c.time,
        value: bb.lower[i]
      });
      bbMid.push({
        time: c.time,
        value: (bb.upper[i] + bb.lower[i]) / 2
      });
    }
  });
  if (bbUpper.length) {
    var bbU = chart.addLineSeries({
      color: "#475569",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false
    });
    bbU.setData(bbUpper);
    var bbL = chart.addLineSeries({
      color: "#475569",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false
    });
    bbL.setData(bbLower);
    try {
      var zoneU = chart.addAreaSeries({
        topColor: "rgba(34,197,94,0.18)",
        bottomColor: "rgba(34,197,94,0.0)",
        lineColor: "transparent",
        lineWidth: 0,
        priceLineVisible: false,
        lastValueVisible: false
      });
      zoneU.setData(bbUpper);
    } catch (_) {}
    try {
      var zoneL = chart.addAreaSeries({
        topColor: "rgba(239,68,68,0.18)",
        bottomColor: "rgba(239,68,68,0.0)",
        lineColor: "transparent",
        lineWidth: 0,
        priceLineVisible: false,
        lastValueVisible: false
      });
      zoneL.setData(bbLower);
    } catch (_) {}
  }
  vcbLine(vcbMa5, "rgb(255,165,0)", 2, "5D MA", {
    lastVal: true
  });
  var pm = jnl_pmHiLo(dayCandles && dayCandles.length ? dayCandles : allCandles, etOffH);
  if (pm.high) candleSeries.createPriceLine({
    price: pm.high,
    color: "#a78bfa",
    lineWidth: 1,
    lineStyle: 2,
    axisLabelVisible: true,
    title: "PM H"
  });
  if (pm.low) candleSeries.createPriceLine({
    price: pm.low,
    color: "#a78bfa",
    lineWidth: 1,
    lineStyle: 2,
    axisLabelVisible: true,
    title: "PM L"
  });
  var ah = jnl_ahHiLo(dayCandles && dayCandles.length ? dayCandles : allCandles, etOffH);
  if (ah.high) candleSeries.createPriceLine({
    price: ah.high,
    color: "#fb923c",
    lineWidth: 1,
    lineStyle: 2,
    axisLabelVisible: true,
    title: "AH H"
  });
  if (ah.low) candleSeries.createPriceLine({
    price: ah.low,
    color: "#fb923c",
    lineWidth: 1,
    lineStyle: 2,
    axisLabelVisible: true,
    title: "AH L"
  });
  var markers = [];
  (trade.entryFills || []).forEach(function(f) {
    markers.push({
      time: Math.floor(f.ts / 6e4) * 60,
      position: "belowBar",
      color: "#22c55e",
      shape: "arrowUp",
      text: "E $" + f.price.toFixed(2)
    });
  });
  (trade.exitFills || []).forEach(function(f) {
    markers.push({
      time: Math.floor(f.ts / 6e4) * 60,
      position: "aboveBar",
      color: "#ef4444",
      shape: "arrowDown",
      text: "X $" + f.price.toFixed(2)
    });
  });
  markers.sort(function(a, b) {
    return a.time - b.time;
  });
  if (markers.length) candleSeries.setMarkers(markers);
  var entryT = Math.floor(trade.entryTs / 6e4) * 60;
  var exitT = trade.exitTs ? Math.floor(trade.exitTs / 6e4) * 60 : entryT + 3600;
  chart.timeScale().fitContent();
  if ((resolution || 1) <= 1) {
    requestAnimationFrame(function() {
      chart.timeScale().setVisibleRange({
        from: entryT - 1800,
        to: exitT + 1800
      });
    });
  }
  var volChart = LW.createChart(volEl, Object.assign({
    width: volEl.offsetWidth || 760,
    height: volEl.offsetHeight || 80,
    layout: {
      background: {
        color: "#0f172a"
      },
      textColor: "#94a3b8"
    },
    grid: {
      vertLines: {
        color: "#1e293b"
      },
      horzLines: {
        color: "#1e293b"
      }
    },
    rightPriceScale: {
      borderColor: "#1e293b",
      scaleMargins: {
        top: .1,
        bottom: 0
      }
    },
    localization: {
      timeFormatter: fmtEtTime
    },
    timeScale: {
      borderColor: "#1e293b",
      timeVisible: true,
      secondsVisible: false,
      visible: false,
      tickMarkFormatter: etTickMark
    },
    crosshair: {
      mode: LW.CrosshairMode.Normal
    }
  }, scaleOpts));
  __jnlVolChart = volChart;
  var volSeries = volChart.addHistogramSeries({
    color: "#1e40af",
    priceFormat: {
      type: "volume"
    },
    priceScaleId: "",
    scaleMargins: {
      top: .1,
      bottom: 0
    }
  });
  volSeries.setData(displayCandles.map(function(c) {
    return {
      time: c.time,
      value: c.volume,
      color: c.close >= c.open ? "rgba(34,197,94,0.5)" : "rgba(239,68,68,0.5)"
    };
  }));
  volChart.timeScale().fitContent();
  if ((resolution || 1) <= 1) {
    requestAnimationFrame(function() {
      try {
        volChart.timeScale().setVisibleRange({
          from: entryT - 1800,
          to: exitT + 1800
        });
      } catch (_) {}
    });
  }
  chart.subscribeCrosshairMove(function(param) {
    if (param.time) volChart.setCrosshairPosition(NaN, param.time, volSeries); else volChart.clearCrosshairPosition();
  });
  chart.timeScale().subscribeVisibleTimeRangeChange(function() {
    try {
      volChart.timeScale().setVisibleRange(chart.timeScale().getVisibleRange());
    } catch (_) {}
  });
}

document.addEventListener("DOMContentLoaded", function() {
  [ [ "jnl-finnhub-key", "smb_jnl_finnhub_key" ], [ "jnl-polygon-key", "smb_jnl_polygon_key" ] ].forEach(function(pair) {
    var el = document.getElementById(pair[0]);
    if (!el) return;
    chrome.storage.local.get([ pair[1] ], function(d) {
      if (d[pair[1]]) el.value = d[pair[1]];
    });
    el.addEventListener("change", function(e) {
      var o = {};
      o[pair[1]] = e.target.value.trim();
      chrome.storage.local.set(o);
    });
  });
  var importBtn = document.getElementById("jnl-import-btn");
  if (importBtn) {
    importBtn.addEventListener("click", jnl_handleImport);
  }
  jnl_loadFeeProfiles(function() {
    jnl_feeInitUI();
  });
  chrome.storage.local.get([ "smb_jnl_checklist_res" ], function(d) {
    var r = parseInt(d.smb_jnl_checklist_res);
    if (r === 1 || r === 5) __jnlChecklistRes = r;
    jnl_setActiveChkTfBtn(__jnlChecklistRes);
  });
  var fileInput = document.getElementById("jnl-file-input");
  if (fileInput) {
    fileInput.addEventListener("change", function(e) {
      var file = e.target.files[0];
      if (!file) return;
      var reader = new FileReader;
      reader.onload = function(ev) {
        var ta = document.getElementById("jnl-csv-input");
        if (ta) ta.value = ev.target.result;
        jnl_handleImport();
        e.target.value = "";
      };
      reader.readAsText(file);
    });
  }
  var clearBtn = document.getElementById("jnl-clear-btn");
  if (clearBtn) {
    clearBtn.addEventListener("click", function() {
      if (clearBtn.getAttribute("data-armed") !== "1") {
        clearBtn.setAttribute("data-armed", "1");
        clearBtn.textContent = "⚠ Click again to clear ALL";
        clearBtn.style.color = "#ef4444";
        clearBtn.style.borderColor = "#7f1d1d";
        setTimeout(function() {
          clearBtn.removeAttribute("data-armed");
          clearBtn.textContent = "🗑 Clear all";
          clearBtn.style.color = "#64748b";
          clearBtn.style.borderColor = "#334155";
        }, 4e3);
        return;
      }
      clearBtn.removeAttribute("data-armed");
      clearBtn.textContent = "🗑 Clear all";
      clearBtn.style.color = "#64748b";
      clearBtn.style.borderColor = "#334155";
      jnl_save([]);
      var ta = document.getElementById("jnl-csv-input");
      if (ta) ta.value = "";
      var fi = document.getElementById("jnl-file-input");
      if (fi) fi.value = "";
      var msg = document.getElementById("jnl-import-msg");
      if (msg) {
        msg.textContent = "Cleared.";
        msg.style.color = "#64748b";
      }
      jnl_renderList();
      var bar = document.getElementById("jnl-stats-bar");
      if (bar) bar.style.display = "none";
    });
  }
  [ "jnl-filter-ticker", "jnl-filter-side", "jnl-sort", "jnl-filter-account", "jnl-filter-source" ].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("change", jnl_renderList);
    if (el && id === "jnl-filter-ticker") el.addEventListener("input", jnl_renderList);
  });
  var exportRecBtn = document.getElementById("jnl-export-records-btn");
  if (exportRecBtn) exportRecBtn.addEventListener("click", jnl_exportRecordsCSV);
  var closeBtn = document.getElementById("jnl-chart-close");
  if (closeBtn) closeBtn.addEventListener("click", jnl_closeChart);
  var closeBtnBottom = document.getElementById("jnl-chart-close-bottom");
  if (closeBtnBottom) closeBtnBottom.addEventListener("click", jnl_closeChart);
  var modal = document.getElementById("jnl-chart-modal");
  if (modal) {
    modal.addEventListener("click", function(e) {
      if (e.target === modal) jnl_closeChart();
    });
  }
  document.querySelectorAll(".jnl-res-btn").forEach(function(btn) {
    btn.addEventListener("click", function() {
      var res = parseInt(btn.getAttribute("data-res"));
      if (res === __jnlCurrentRes) return;
      __jnlCurrentRes = res;
      jnl_setActiveResBtn(res);
      if (__jnlCurrentTrade) jnl_loadAndRenderChart(__jnlCurrentTrade, res);
    });
  });
  document.querySelectorAll(".jnl-chktf-btn").forEach(function(btn) {
    btn.addEventListener("click", function() {
      var res = parseInt(btn.getAttribute("data-chktf"));
      if (!(res === 1 || res === 5) || res === __jnlChecklistRes) return;
      __jnlChecklistRes = res;
      chrome.storage.local.set({
        smb_jnl_checklist_res: res
      });
      jnl_setActiveChkTfBtn(res);
      __jnlCurrentRes = res;
      jnl_setActiveResBtn(res);
      if (__jnlCurrentTrade) jnl_loadAndRenderChart(__jnlCurrentTrade, res);
    });
  });
  jnl_loadDayNotes(function() {
    jnl_load(function(trades) {
      if (trades.length) {
        jnl_renderList();
        jnl_renderStatsBar(trades);
      }
    });
  });
});

function jnl_openExitReasonPicker(tradeId) {
  var el = document.getElementById("jnl-reason-picker-" + tradeId);
  if (el) el.style.display = el.style.display === "none" ? "block" : "none";
}

function jnl_setExitReasonOverride(tradeId, reason) {
  var trade = __jnlTrades.find(function(t) {
    return t.id === tradeId;
  });
  if (!trade) return;
  trade.exitReasonOverride = reason;
  trade._mut = Date.now();
  jnl_save(__jnlTrades);
  var el = document.getElementById("jnl-exit-row-" + tradeId);
  if (el && trade.exitAnalysis) el.innerHTML = jnl_renderExitRow(trade.exitAnalysis, trade);
}

function jnl_clearExitReasonOverride(tradeId) {
  var trade = __jnlTrades.find(function(t) {
    return t.id === tradeId;
  });
  if (!trade) return;
  delete trade.exitReasonOverride;
  jnl_save(__jnlTrades);
  var el = document.getElementById("jnl-exit-row-" + tradeId);
  if (el && trade.exitAnalysis) el.innerHTML = jnl_renderExitRow(trade.exitAnalysis, trade);
}

var JNL_PRESERVE_ON_REIMPORT = [ "snapshot", "checklistRecord", "exitAnalysis", "setup", "setupScores", "setupOverride", "exitReasonOverride" ];

function jnl_mergeImported(incoming) {
  function baseKey(t) {
    return t.ticker + "|" + t.date + "|" + t.entryTs;
  }
  function accountsMatch(a, b) {
    var an = jnl_normAccount(a.account), bn = jnl_normAccount(b.account);
    return !an || !bn || an === bn;
  }
  function sameFills(a, b) {
    return a.entryTs === b.entryTs && a.exitTs === b.exitTs && a.shares === b.shares && a.entryPrice === b.entryPrice && a.exitPrice === b.exitPrice && a.grossPnl === b.grossPnl && (a.csvComm || 0) === (b.csvComm || 0);
  }
  var added = 0, updated = 0, unchanged = 0;
  var keep = (__jnlTrades || []).slice();
  var seen = {};
  incoming.forEach(function(nt) {
    var k = baseKey(nt);
    if (seen[k] && nt.account) nt.id = k + "|" + nt.account;
    seen[k] = true;
  });
  incoming.forEach(function(nt) {
    var idx = -1;
    for (var i = 0; i < keep.length; i++) {
      if (baseKey(keep[i]) === baseKey(nt) && accountsMatch(keep[i], nt)) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      while (keep.some(function(t) {
        return t.id === nt.id;
      })) {
        nt.id = nt.id + "|" + (nt.account || "x");
      }
      keep.push(nt);
      added++;
      return;
    }
    var old = keep[idx];
    JNL_PRESERVE_ON_REIMPORT.forEach(function(f) {
      if (nt[f] == null && old[f] != null) nt[f] = old[f];
    });
    if (!nt.account && old.account) nt.account = old.account;
    if (!nt.exitTs && old.exitTs) {
      [ "exitTs", "exitPrice", "grossPnl", "netPnl", "pctMove", "durationMs", "totalComm", "csvComm", "closedShares", "exitFills" ].forEach(function(f) {
        if (old[f] != null) nt[f] = old[f];
      });
      nt.open = old.open;
    }
    if (sameFills(old, nt)) unchanged++; else updated++;
    keep[idx] = nt;
  });
  keep.sort(function(a, b) {
    return b.entryTs - a.entryTs;
  });
  jnl_save(keep);
  return {
    added: added,
    updated: updated,
    unchanged: unchanged
  };
}

function jnl_handleImport() {
  var ta = document.getElementById("jnl-csv-input");
  var msg = document.getElementById("jnl-import-msg");
  if (!ta || !ta.value.trim()) {
    if (msg) {
      msg.textContent = "Paste a CSV first.";
      msg.style.color = "#f59e0b";
    }
    return;
  }
  var parsed = jnl_parseCSV(ta.value.trim());
  if (parsed.error) {
    if (msg) {
      msg.textContent = "✕ " + parsed.error;
      msg.style.color = "#ef4444";
    }
    return;
  }
  var fmt = parsed.format === "tv" ? "TradingView" : parsed.format === "tvjournal" ? "TradingView journal" : parsed.format === "ttporders" ? "Trade the Pool (orders history)" : "Trade the Pool";
  var srcShort = parsed.format === "tv" ? "TradingView" : parsed.format === "tvjournal" ? "TV journal" : parsed.format === "ttporders" ? "TTP orders" : "TTP fills";
  var acctEl = document.getElementById("jnl-account-label");
  var acctLabel = acctEl ? acctEl.value.trim() : "";
  var trades = jnl_matchFills(parsed.fills, {
    source: srcShort,
    accountLabel: acctLabel || null
  });
  var orphans = trades.orphanExits || [];
  var orphanNote = "";
  if (orphans.length) {
    var oTickers = orphans.map(function(o) {
      return o.ticker;
    }).filter(function(v, i, a) {
      return a.indexOf(v) === i;
    });
    orphanNote = " ⚠ " + orphans.length + " exit-only fill group(s) (" + oTickers.slice(0, 5).join(", ") + (oTickers.length > 5 ? "…" : "") + ") had no matching entry in this file — import the file that contains the open (or the day it opened).";
  }
  if (!trades.length) {
    if (msg) {
      msg.textContent = "✕ No round-trip trades found (need matching buys & sells). " + parsed.fills.length + " fills parsed." + orphanNote;
      msg.style.color = "#ef4444";
    }
    return;
  }
  var untagged = trades.filter(function(t) {
    return !t.account;
  });
  if (untagged.length) {
    if (msg) {
      msg.textContent = "✕ Account required — " + untagged.length + " of " + trades.length + " trade(s) have no account. Enter an Account / broker label above, then Import again.";
      msg.style.color = "#ef4444";
    }
    var lbl = document.getElementById("jnl-account-label");
    if (lbl) {
      lbl.style.borderColor = "#ef4444";
      lbl.focus();
    }
    return;
  }
  trades.forEach(jnl_applyFeeProfile);
  var res = jnl_mergeImported(trades);
  var feeHint = "";
  try {
    var accts = {};
    trades.forEach(function(t) {
      if (t.account) accts[t.account] = true;
    });
    var noProf = Object.keys(accts).filter(function(a) {
      var p = typeof jnl_feeProfileFor === "function" ? jnl_feeProfileFor(a) : null;
      return !p || !Array.isArray(p.rules) || !p.rules.length;
    });
    var zeroComm = trades.every(function(t) {
      return !t.totalComm;
    });
    if (zeroComm && noProf.length) feeHint = " ⚠ Commissions are $0 — set a fee profile for " + noProf.join(", ") + " (Journal → Fees) to apply them.";
  } catch (_) {}
  if (msg) {
    msg.textContent = "✓ " + res.added + " new · " + res.updated + " updated (fills refreshed, analysis kept) · " + res.unchanged + " unchanged — " + fmt + " (" + parsed.fills.length + " fills)." + feeHint + orphanNote;
    msg.style.color = feeHint || orphanNote ? "#f59e0b" : "#22c55e";
  }
  jnl_renderList();
  jnl_renderStatsBar(jnl_scopedTrades());
  var det = document.getElementById("jnl-import-details");
  if (det) det.open = false;
}

document.addEventListener("click", function(e) {
  var btn = e.target.closest(".jnl-reason-open, .jnl-reason-set, .jnl-reason-clear, .jnl-corr-tab-btn, .jnl-dash-tab");
  if (!btn) return;
  if (btn.classList.contains("jnl-reason-open")) jnl_openExitReasonPicker(btn.getAttribute("data-trade-id")); else if (btn.classList.contains("jnl-reason-set")) jnl_setExitReasonOverride(btn.getAttribute("data-trade-id"), btn.getAttribute("data-reason")); else if (btn.classList.contains("jnl-reason-clear")) jnl_clearExitReasonOverride(btn.getAttribute("data-trade-id")); else if (btn.classList.contains("jnl-dash-tab")) jnl_dashTab(btn.getAttribute("data-dash-tab")); else if (btn.classList.contains("jnl-trades-view")) {
    try {
      localStorage.setItem("jnl_trades_view", btn.getAttribute("data-view") || "byday");
    } catch (_) {}
    jnl_renderList();
  } else if (btn.classList.contains("jnl-day-note-btn")) {
    var ed = btn.closest(".jnl-day-head");
    ed = ed ? ed.querySelector(".jnl-day-note-editor") : null;
    if (ed) ed.style.display = ed.style.display === "none" ? "block" : "none";
  } else if (btn.classList.contains("jnl-day-note-save")) {
    var wrap = btn.closest(".jnl-day-note-editor");
    var ta = wrap ? wrap.querySelector(".jnl-day-note-ta") : null;
    jnl_saveDayNote(btn.getAttribute("data-day"), ta ? ta.value : "");
    jnl_renderList();
  } else if (btn.classList.contains("jnl-corr-tab-btn")) jnl_corrTab(btn.getAttribute("data-corr-tab"));
});

document.addEventListener("click", function(e) {
  var btn = e.target.closest(".jnl-del-btn");
  if (!btn) return;
  if (btn.getAttribute("data-armed") !== "1") {
    btn.setAttribute("data-armed", "1");
    btn.textContent = "delete?";
    btn.style.color = "#ef4444";
    btn.style.borderColor = "#7f1d1d";
    setTimeout(function() {
      btn.removeAttribute("data-armed");
      btn.textContent = "🗑";
      btn.style.color = "#64748b";
      btn.style.borderColor = "#334155";
    }, 3e3);
    return;
  }
  var id = btn.getAttribute("data-trade-id");
  jnl_save(__jnlTrades.filter(function(t) {
    return t.id !== id;
  }));
  jnl_renderList();
});
