// /api/snapshot.js
// =============================================================================
//  BTC Live Snapshot · Vercel Edge Function
// =============================================================================
//  Agregat data real-time dari banyak sumber publik (no API key) lalu return
//  satu JSON gepeng yang siap dipakai frontend & dipipe ke Gemini.
//
//  Kenapa Edge?
//   - Cold start kecil (~50ms vs 500-1500ms node serverless)
//   - Distribusi global (CDN edge), dekat ke user
//   - Cocok untuk fan-out fetch paralel
//
//  Output shape (semua optional - errors di-collect, gak fatal):
//   {
//     ts,
//     ticker:    { price, change24h, volume24h, high24h, low24h },
//     orderBook: { bids[], asks[], bidWall, askWall, ratio },
//     funding:   { fundingRate, markPrice, nextFundingTime },
//     klines:    [closes...],   // 168 candles 1h
//     fearGreed: { value, label, history[] },
//     coingecko: { change7d, change30d, marketCap, ath, athDistance },
//     global:    { btcDominance, totalMcap },
//     mempool:   { fastestFee, halfHourFee, hourFee, economyFee, minimumFee },
//     network:   { hashrate, difficulty, blockHeight },
//     news:      [{ title, source, ts, url }, ...],
//     errors:    [{ source, msg }, ...]
//   }
// =============================================================================

export const config = { runtime: 'edge' };

// ─────────────────────────────────────────────────────────────────────────────
//  Fetch helpers (with timeout)
// ─────────────────────────────────────────────────────────────────────────────
const TIMEOUT_DEFAULT = 4500;

async function fetchJSON(url, timeout = TIMEOUT_DEFAULT) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'accept': 'application/json', 'user-agent': 'btc-bandarmologi/2.0' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} · ${url.slice(0, 80)}`);
    return await r.json();
  } finally {
    clearTimeout(tid);
  }
}

async function fetchText(url, timeout = TIMEOUT_DEFAULT) {
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} · ${url.slice(0, 80)}`);
    return await r.text();
  } finally {
    clearTimeout(tid);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Data sources
// ─────────────────────────────────────────────────────────────────────────────
async function sourceTicker() {
  const d = await fetchJSON('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT');
  return {
    price: +d.lastPrice,
    change24h: +d.priceChangePercent,
    volume24h: +d.quoteVolume,
    high24h: +d.highPrice,
    low24h: +d.lowPrice,
  };
}

async function sourceOrderBook() {
  const d = await fetchJSON('https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=500');
  const toWall = arr => arr
    .map(r => ({ price: +r[0], qty: +r[1], total: +r[0] * +r[1] }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);
  const bids = toWall(d.bids);
  const asks = toWall(d.asks);
  const bidWall = bids.reduce((s, b) => s + b.total, 0);
  const askWall = asks.reduce((s, a) => s + a.total, 0);
  return { bids, asks, bidWall, askWall, ratio: bidWall / (bidWall + askWall) };
}

async function sourceFunding() {
  const d = await fetchJSON('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT');
  return {
    fundingRate: +d.lastFundingRate * 100,
    markPrice: +d.markPrice,
    nextFundingTime: d.nextFundingTime,
  };
}

async function sourceKlines() {
  const d = await fetchJSON('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=168');
  return d.map(k => +k[4]); // close prices
}

async function sourceFearGreed() {
  const d = await fetchJSON('https://api.alternative.me/fng/?limit=30');
  return {
    value: +d.data[0].value,
    label: d.data[0].value_classification,
    history: d.data.slice().reverse().map(x => ({ ts: +x.timestamp * 1000, v: +x.value })),
  };
}

async function sourceCoinGecko() {
  const d = await fetchJSON(
    'https://api.coingecko.com/api/v3/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false'
  );
  const m = d.market_data;
  return {
    change7d: m.price_change_percentage_7d,
    change30d: m.price_change_percentage_30d,
    marketCap: m.market_cap.usd,
    ath: m.ath.usd,
    athDistance: m.ath_change_percentage.usd,
  };
}

async function sourceGlobal() {
  const d = await fetchJSON('https://api.coingecko.com/api/v3/global');
  return {
    btcDominance: d.data.market_cap_percentage.btc,
    totalMcap: d.data.total_market_cap.usd,
  };
}

async function sourceMempool() {
  return fetchJSON('https://mempool.space/api/v1/fees/recommended');
}

async function sourceNetwork() {
  const [hashrate, difficulty, height] = await Promise.all([
    fetchText('https://blockchain.info/q/hashrate'),
    fetchText('https://blockchain.info/q/getdifficulty'),
    fetchText('https://blockchain.info/q/getblockcount'),
  ]);
  return {
    hashrate: +hashrate,
    difficulty: +difficulty,
    blockHeight: +height,
  };
}

async function sourceNews() {
  const d = await fetchJSON(
    'https://min-api.cryptocompare.com/data/v2/news/?lang=EN&categories=BTC&sortOrder=popular&limit=8',
    5500
  );
  return (d.Data || []).slice(0, 8).map(n => ({
    title: n.title,
    source: n.source_info?.name || n.source || 'unknown',
    ts: n.published_on * 1000,
    url: n.url,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Handler
// ─────────────────────────────────────────────────────────────────────────────
const SOURCES = [
  ['ticker',    sourceTicker],
  ['orderBook', sourceOrderBook],
  ['funding',   sourceFunding],
  ['klines',    sourceKlines],
  ['fearGreed', sourceFearGreed],
  ['coingecko', sourceCoinGecko],
  ['global',    sourceGlobal],
  ['mempool',   sourceMempool],
  ['network',   sourceNetwork],
  ['news',      sourceNews],
];

export default async function handler() {
  const t0 = Date.now();
  const results = await Promise.allSettled(SOURCES.map(([, fn]) => fn()));

  const snapshot = { ts: Date.now() };
  const errors = [];

  results.forEach((r, i) => {
    const [label] = SOURCES[i];
    if (r.status === 'fulfilled') {
      snapshot[label] = r.value;
    } else {
      const msg = String(r.reason?.message || r.reason || 'unknown').slice(0, 200);
      errors.push({ source: label, msg });
    }
  });

  snapshot.errors = errors;
  snapshot.fetchMs = Date.now() - t0;

  return new Response(JSON.stringify(snapshot), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 's-maxage=10, stale-while-revalidate=30',
      'access-control-allow-origin': '*',
    },
  });
}
