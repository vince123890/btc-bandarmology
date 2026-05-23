// =============================================================================
//  BTC BANDARMOLOGI DASHBOARD · Gemini-only edition
// =============================================================================
//
//  Arsitektur (vs versi lama):
//    Lama: Browser → Vercel proxy → Anthropic/Gemini → balik
//          (sering 504 karena Vercel Hobby 60s + cold start dari Indonesia)
//    Baru: Browser → Gemini API langsung (Gemini support CORS)
//          + Vercel cuma untuk snapshot data (Binance dll yang block CORS)
//
//  Keuntungan:
//    • Tidak ada Vercel timeout — browser hold connection sendiri
//    • Latency lebih rendah (1 hop, bukan 2)
//    • Struktur JSON pasti valid (responseMimeType + responseSchema)
//    • Code 60% lebih ringkas (no Claude branch, no proxy parsing)
// =============================================================================

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'btc_bandarmologi_gemini_key';
const STORAGE_MODEL = 'btc_bandarmologi_gemini_model';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Model pilihan (urut dari paling efisien)
const GEMINI_MODELS = [
  { id: 'gemini-2.5-flash',      label: 'Gemini 2.5 Flash',      cost: '~$0.001', latency: '5-12s', default: true  },
  { id: 'gemini-2.5-pro',        label: 'Gemini 2.5 Pro',        cost: '~$0.01',  latency: '15-30s', default: false },
  { id: 'gemini-2.0-flash',      label: 'Gemini 2.0 Flash',      cost: '~$0.0005',latency: '4-10s', default: false },
];

// Timeout di browser (tidak ada batas Vercel di sini!)
const ANALYZE_TIMEOUT_MS = 90_000;   // 90 detik
const TEST_TIMEOUT_MS    = 20_000;   // 20 detik

// ─────────────────────────────────────────────────────────────────────────────
//  State
// ─────────────────────────────────────────────────────────────────────────────
const state = {
  // Data
  snapshot: null,
  analysis: null,
  // UX
  loading: false,
  analyzing: false,
  error: null,
  analyzeError: null,
  analyzeHint: null,
  // Timestamps
  lastFetch: null,
  lastAnalyze: null,
  // Config
  apiKey: '',
  model: 'gemini-2.5-flash',
  // Settings panel
  showSettings: false,
  showKeyValue: false,
  testResult: null,
  testing: false,
  // Transient draft — preserve input value across re-renders
  // (null = pakai state.apiKey; string = user lagi ngetik)
  keyDraft: null,
};

// Hydrate dari localStorage
try {
  state.apiKey = localStorage.getItem(STORAGE_KEY) || '';
  state.model = localStorage.getItem(STORAGE_MODEL) || 'gemini-2.5-flash';
} catch (_) { /* localStorage blocked → in-memory only */ }

// ─────────────────────────────────────────────────────────────────────────────
//  Formatters
// ─────────────────────────────────────────────────────────────────────────────
const fmt = {
  usd: (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }),
  pct: (n) => n == null ? '—' : (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '%',
  ago: (n) => {
    if (!n) return '';
    const s = Math.floor((Date.now() - n) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  },
  maskKey: (k) => {
    if (!k) return '';
    if (k.length < 12) return '••••';
    return k.slice(0, 6) + '••••••••' + k.slice(-4);
  },
};

const pctFrom = (from, to) => (!from || !to) ? null : ((to - from) / from) * 100;

// ─────────────────────────────────────────────────────────────────────────────
//  HTML escape (cegah XSS dari snapshot/AI output)
// ─────────────────────────────────────────────────────────────────────────────
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Gemini API client (DIRECT dari browser, no Vercel proxy)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Schema untuk structured JSON output — Gemini akan memaksa output sesuai
 * format ini. Tidak perlu lagi parsing regex/markdown.
 */
const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    tradeAction: {
      type: 'object',
      properties: {
        direction:          { type: 'string', enum: ['LONG', 'SHORT', 'WAIT'] },
        horizon:            { type: 'string' },
        confidence:         { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
        entryLow:           { type: 'number' },
        entryHigh:          { type: 'number' },
        stopLoss:           { type: 'number' },
        takeProfit1:        { type: 'number' },
        takeProfit2:        { type: 'number' },
        riskRewardRatio:    { type: 'number' },
        positionSize:       { type: 'string' },
        invalidationReason: { type: 'string' },
        actionReasoning:    { type: 'string' },
      },
      required: ['direction', 'horizon', 'confidence', 'entryLow', 'entryHigh',
                 'stopLoss', 'takeProfit1', 'takeProfit2', 'riskRewardRatio',
                 'positionSize', 'invalidationReason', 'actionReasoning'],
    },
    signal:           { type: 'string', enum: ['STRONG_BUY', 'BUY', 'NEUTRAL', 'CAUTION', 'AVOID'] },
    signalReasoning:  { type: 'array', items: { type: 'string' } },
    supportLevel:     { type: 'number' },
    resistanceLevel:  { type: 'number' },
    whaleSummary:     { type: 'string' },
    newsHeadlines:    { type: 'array', items: { type: 'string' } },
    riskWarning:      { type: 'string' },
  },
  required: ['tradeAction', 'signal', 'signalReasoning', 'supportLevel',
             'resistanceLevel', 'whaleSummary', 'newsHeadlines', 'riskWarning'],
};

/**
 * Build prompt yang concise tapi lengkap. Tidak perlu ulangi struktur JSON
 * di prompt karena responseSchema sudah memaksa output.
 */
function buildPrompt(s) {
  const newsLines = (s.news && s.news.length > 0)
    ? s.news.slice(0, 8).map((n, i) => `${i + 1}. [${n.source}] ${n.title}`).join('\n')
    : '(berita tidak tersedia — analisis murni dari data on-chain & order book)';

  const num = (v, decimals = 2) => v == null ? 'N/A' : Number(v).toFixed(decimals);
  const big = (v, divisor = 1e9, suffix = 'B') =>
    v == null ? 'N/A' : '$' + (v / divisor).toFixed(2) + suffix;

  return `Kamu adalah Bitcoin bandarmologi trader senior dengan 10+ tahun pengalaman membaca order flow dan smart money behavior.

Analisis snapshot REAL-TIME berikut, lalu berikan trade action plan terstruktur.

═══ HARGA & MARKET ═══
• BTC/USDT spot: $${num(s.ticker?.price, 2)}
• 24h change: ${num(s.ticker?.change24h)}% | High/Low: $${num(s.ticker?.high24h, 0)} / $${num(s.ticker?.low24h, 0)}
• 7d / 30d: ${num(s.coingecko?.change7d)}% / ${num(s.coingecko?.change30d)}%
• Market cap: ${big(s.coingecko?.marketCap, 1e12, 'T')}
• 24h volume: ${big(s.ticker?.volume24h)}
• BTC dominance: ${num(s.global?.btcDominance)}%
• ATH distance: ${num(s.coingecko?.athDistance)}%

═══ ORDER BOOK & DERIVATIVES ═══
• Funding rate (perp): ${num(s.funding?.fundingRate, 4)}%  ${(s.funding?.fundingRate ?? 0) > 0.01 ? '(longs crowded)' : (s.funding?.fundingRate ?? 0) < -0.01 ? '(shorts crowded)' : '(neutral)'}
• Top bid walls: ${big(s.orderBook?.bidWall, 1e6, 'M')}
• Top ask walls: ${big(s.orderBook?.askWall, 1e6, 'M')}
• Bid dominance: ${s.orderBook?.ratio ? (s.orderBook.ratio * 100).toFixed(1) + '%' : 'N/A'}
• Best bid: $${num(s.orderBook?.bids?.[0]?.price, 0)} (${num(s.orderBook?.bids?.[0]?.qty)} BTC)
• Best ask: $${num(s.orderBook?.asks?.[0]?.price, 0)} (${num(s.orderBook?.asks?.[0]?.qty)} BTC)

═══ SENTIMENT & NETWORK ═══
• Fear & Greed: ${s.fearGreed?.value ?? 'N/A'} (${s.fearGreed?.label ?? 'N/A'})
• Hashrate: ${s.network?.hashrate ? (s.network.hashrate / 1e9).toFixed(2) + ' EH/s' : 'N/A'}
• Mempool fast fee: ${s.mempool?.fastestFee ?? 'N/A'} sat/vB

═══ BERITA TERKINI (CryptoCompare) ═══
${newsLines}

TUGAS:
Analisis dengan kaidah bandarmologi: cermati di mana whale walls, funding bias, sentiment, dan flow berita.
Berikan trade action plan untuk horizon 1-3 hari (atau lebih sesuai kondisi).

ATURAN KETAT (PASTI DIPATUHI):
• LONG → stopLoss < entryLow < entryHigh < takeProfit1 < takeProfit2
• SHORT → takeProfit2 < takeProfit1 < entryLow < entryHigh < stopLoss
• WAIT → semua harga ≈ harga current (set entryLow=entryHigh=stopLoss=takeProfit1=takeProfit2=harga current)
• riskRewardRatio minimum 1.5 untuk LONG/SHORT (kalau tidak tercapai → WAIT)
• Mixed/kontra signal → WAIT (jangan paksa direction)
• signalReasoning: tepat 3 poin singkat
• newsHeadlines: top 3 headline relevan dari berita di atas

OUTPUT: JSON valid sesuai schema. Bahasa Indonesia untuk semua field text.`;
}

/**
 * Inti: panggil Gemini API langsung dari browser dengan structured output.
 *
 * @param {string} apiKey  - User's Gemini API key
 * @param {string} modelId - Model ID (e.g. 'gemini-2.5-flash')
 * @param {string} prompt  - The analysis prompt
 * @param {AbortSignal} signal - For cancellation
 * @returns {Promise<{ parsed: object, raw: string, usage: object, elapsed: number }>}
 */
async function callGemini(apiKey, modelId, prompt, signal) {
  const url = `${GEMINI_BASE}/${modelId}:generateContent`;
  const t0 = Date.now();

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        topP: 0.95,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
        responseSchema: ANALYSIS_SCHEMA,
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
      ],
    }),
    signal,
  });

  const elapsed = Date.now() - t0;

  // ── Handle HTTP error ─────────────────────────────────────────────────────
  if (!res.ok) {
    const errText = await res.text();
    let detail = errText, gStatus = '';
    try {
      const j = JSON.parse(errText);
      detail = j.error?.message || errText;
      gStatus = j.error?.status || '';
    } catch (_) {}
    const err = new Error((gStatus ? `[${gStatus}] ` : '') + detail.slice(0, 400));
    err.status = res.status;
    err.gStatus = gStatus;
    err.elapsed = elapsed;
    throw err;
  }

  const data = await res.json();

  // ── Handle blocked / no candidate ─────────────────────────────────────────
  if (data.promptFeedback?.blockReason) {
    const err = new Error(`Prompt blocked: ${data.promptFeedback.blockReason}`);
    err.status = 502;
    throw err;
  }
  const cand = data.candidates?.[0];
  if (!cand) {
    const err = new Error('No candidate in Gemini response');
    err.status = 502;
    throw err;
  }
  if (cand.finishReason === 'SAFETY' || cand.finishReason === 'RECITATION') {
    const err = new Error(`Stopped by Gemini: ${cand.finishReason}`);
    err.status = 502;
    throw err;
  }
  if (cand.finishReason === 'MAX_TOKENS') {
    const err = new Error('Response truncated (MAX_TOKENS) — coba ulang atau pakai model Pro');
    err.status = 502;
    throw err;
  }

  const raw = (cand.content?.parts || []).map(p => p.text).filter(Boolean).join('\n');
  if (!raw) {
    const err = new Error('Empty response from Gemini');
    err.status = 502;
    throw err;
  }

  // ── Parse (responseMimeType=application/json sudah jamin JSON valid) ─────
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // Fallback: extract { ... } block (jaga2 kalau model ngeyel)
    const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) {
      const err = new Error('Gemini returned non-JSON despite responseMimeType: ' + e.message);
      err.status = 502;
      err.raw = raw.slice(0, 500);
      throw err;
    }
    parsed = JSON.parse(raw.slice(start, end + 1));
  }

  return {
    parsed,
    raw,
    usage: data.usageMetadata || {},
    elapsed,
    finishReason: cand.finishReason,
  };
}

/**
 * Wrapper dengan retry untuk transient errors.
 */
async function callGeminiWithRetry(apiKey, modelId, prompt, signal) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await callGemini(apiKey, modelId, prompt, signal);
    } catch (err) {
      lastErr = err;
      // Tidak retry kalau: auth error (401/403), bad request (400), atau user abort
      if (err.status === 400 || err.status === 401 || err.status === 403) throw err;
      if (signal?.aborted) throw err;
      if (attempt === 1) {
        await new Promise(r => setTimeout(r, 1500)); // wait sebelum retry
      }
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Snapshot fetch (Vercel edge function)
// ─────────────────────────────────────────────────────────────────────────────
async function loadSnapshot() {
  state.loading = true;
  state.error = null;
  render();

  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch('/api/snapshot', { signal: ctrl.signal });
    clearTimeout(tid);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    state.snapshot = await r.json();
    state.lastFetch = Date.now();
  } catch (e) {
    state.error = e.name === 'AbortError' ? 'Timeout 12s saat fetch snapshot' : e.message;
  } finally {
    state.loading = false;
    render();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  AI Analysis (browser → Gemini langsung)
// ─────────────────────────────────────────────────────────────────────────────
let _analysisAbortCtrl = null;

async function loadAnalysis() {
  if (!state.snapshot) return;

  if (!state.apiKey) {
    state.showSettings = true;
    state.analyzeError = 'API key Gemini belum di-set. Buka Settings di atas.';
    render();
    return;
  }

  state.analyzing = true;
  state.analyzeError = null;
  state.analyzeHint = null;
  render();

  // Setup abort controller untuk timeout
  _analysisAbortCtrl = new AbortController();
  const timeoutId = setTimeout(() => _analysisAbortCtrl.abort(), ANALYZE_TIMEOUT_MS);

  try {
    const prompt = buildPrompt(state.snapshot);
    const result = await callGeminiWithRetry(
      state.apiKey,
      state.model,
      prompt,
      _analysisAbortCtrl.signal
    );

    const analysis = result.parsed;
    analysis._meta = {
      model: state.model,
      elapsedMs: result.elapsed,
      finishReason: result.finishReason,
      usage: result.usage,
    };

    state.analysis = analysis;
    state.lastAnalyze = Date.now();
  } catch (err) {
    if (err.name === 'AbortError' || _analysisAbortCtrl?.signal.aborted) {
      state.analyzeError = `Timeout ${ANALYZE_TIMEOUT_MS / 1000}s`;
      state.analyzeHint = 'Coba lagi atau ganti model ke Gemini 2.5 Flash (lebih cepat).';
    } else if (err.status === 401 || err.status === 403) {
      state.analyzeError = `Auth gagal (${err.status})`;
      state.analyzeHint = 'API key invalid atau expired. Generate ulang di aistudio.google.com';
    } else if (err.status === 429) {
      state.analyzeError = 'Rate limit / kuota habis';
      state.analyzeHint = 'Tunggu 1 menit atau cek quota di aistudio.google.com';
    } else if (err.status === 400) {
      state.analyzeError = 'Bad request: ' + (err.message || '').slice(0, 200);
      state.analyzeHint = 'Mungkin model tidak support fitur ini — coba switch model di Settings.';
    } else {
      state.analyzeError = err.message || 'Unknown error';
      state.analyzeHint = err.status ? `HTTP ${err.status}` : 'Cek koneksi & coba lagi.';
    }
  } finally {
    clearTimeout(timeoutId);
    _analysisAbortCtrl = null;
    state.analyzing = false;
    render();
  }
}

function cancelAnalysis() {
  if (_analysisAbortCtrl) {
    _analysisAbortCtrl.abort();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Test API Key (langsung ke Gemini, no proxy)
// ─────────────────────────────────────────────────────────────────────────────
async function testApiKey() {
  const input = document.getElementById('api-key-input');
  const key = input ? input.value.trim() : state.apiKey;
  if (!key) {
    alert('Masukkan API key dulu');
    return;
  }

  state.testing = true;
  state.testResult = null;
  render();

  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), TEST_TIMEOUT_MS);

    const r = await fetch(`${GEMINI_BASE}/${state.model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Reply with just: OK' }] }],
        generationConfig: { maxOutputTokens: 100, temperature: 0.1 },
      }),
      signal: ctrl.signal,
    });
    clearTimeout(tid);

    const elapsed = Date.now() - t0;
    const bodyText = await r.text();
    let body;
    try { body = JSON.parse(bodyText); } catch (_) {}

    if (!r.ok) {
      const detail = body?.error?.message || bodyText.slice(0, 300);
      const gStatus = body?.error?.status || '';
      state.testResult = {
        ok: false,
        status: r.status,
        detail: (gStatus ? `[${gStatus}] ` : '') + detail,
        elapsedMs: elapsed,
      };
    } else {
      const cand = body?.candidates?.[0];
      const reply = cand?.content?.parts?.[0]?.text || '';
      state.testResult = {
        ok: true,
        status: 200,
        reply: reply.slice(0, 100),
        model: state.model,
        finishReason: cand?.finishReason,
        usage: body?.usageMetadata,
        elapsedMs: elapsed,
      };
    }
  } catch (e) {
    state.testResult = {
      ok: false,
      error: e.name === 'AbortError'
        ? `Test timeout ${TEST_TIMEOUT_MS / 1000}s — cek koneksi internet`
        : 'Network error: ' + e.message,
      elapsedMs: Date.now() - t0,
    };
  } finally {
    state.testing = false;
    render();
    setTimeout(() => { const i = document.getElementById('api-key-input'); if (i) i.focus(); }, 0);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Settings actions
// ─────────────────────────────────────────────────────────────────────────────
function toggleSettings() {
  state.showSettings = !state.showSettings;
  state.testResult = null;
  if (!state.showSettings) {
    state.keyDraft = null;     // ← clear draft saat panel ditutup tanpa save
  }
  render();
}

function saveApiKey() {
  const input = document.getElementById('api-key-input');
  if (!input) return;
  const key = input.value.trim();
  if (!key) { alert('API key kosong'); return; }
  if (!key.startsWith('AIza')) {
    if (!confirm('Key biasanya diawali "AIza". Lanjut save?')) return;
  }
  state.apiKey = key;
  try { localStorage.setItem(STORAGE_KEY, key); } catch (_) {}
  state.keyDraft = null;       // ← clear draft (sudah saved ke state.apiKey)
  state.showSettings = false;
  state.analyzeError = null;
  state.analyzeHint = null;
  render();
}

function clearApiKey() {
  if (!confirm('Hapus API key dari browser?')) return;
  state.apiKey = '';
  state.keyDraft = null;       // ← clear draft juga
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  state.testResult = null;
  render();
}

function toggleShowKey() {
  state.showKeyValue = !state.showKeyValue;
  render();
  setTimeout(() => { const i = document.getElementById('api-key-input'); if (i) i.focus(); }, 0);
}

function selectModel(id) {
  state.model = id;
  try { localStorage.setItem(STORAGE_MODEL, id); } catch (_) {}
  state.testResult = null;
  render();
}

// ─────────────────────────────────────────────────────────────────────────────
//  (View functions di bawah — di file terpisah `view.js`)
// ─────────────────────────────────────────────────────────────────────────────

// =============================================================================
//  VIEWS — semua functions yang return HTML strings
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
//  SVG helpers
// ─────────────────────────────────────────────────────────────────────────────
function sparkSVG(values, color = '#3b82f6', w = 600, h = 80) {
  if (!values || values.length < 2) return '';
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="w-full h-full">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" />
  </svg>`;
}

function gaugeSVG(value) {
  if (value == null) return '';
  const angle = (value / 100) * 180 - 90;
  const color = value < 25 ? '#ef4444'
              : value < 45 ? '#f59e0b'
              : value < 55 ? '#eab308'
              : value < 75 ? '#84cc16'
              : '#22c55e';
  const dashLen = (value / 100) * 251;
  const x2 = 100 + 65 * Math.cos((angle - 90) * Math.PI / 180);
  const y2 = 100 + 65 * Math.sin((angle - 90) * Math.PI / 180);
  return `<svg viewBox="0 0 200 110" class="w-full h-full">
    <path d="M 20 100 A 80 80 0 0 1 180 100" stroke="#27272a" stroke-width="8" fill="none" />
    <path d="M 20 100 A 80 80 0 0 1 180 100" stroke="${color}" stroke-width="8" fill="none" stroke-dasharray="${dashLen} 251" stroke-linecap="round" />
    <line x1="100" y1="100" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#fafafa" stroke-width="2" />
    <circle cx="100" cy="100" r="4" fill="#fafafa" />
  </svg>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Settings panel
// ─────────────────────────────────────────────────────────────────────────────
function viewSettings() {
  if (!state.showSettings) return '';

  const inputType = state.showKeyValue ? 'text' : 'password';

  const modelButtons = GEMINI_MODELS.map(m => {
    const active = state.model === m.id;
    return `<button onclick="window._app.selectModel('${m.id}')"
      class="text-left border ${active
        ? 'border-blue-500 bg-blue-500/10 text-blue-300'
        : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:border-zinc-600'} px-3 py-2.5 transition-colors">
      <div class="flex items-center justify-between gap-2 mb-0.5">
        <span class="text-xs font-medium">${esc(m.label)}</span>
        ${active ? '<span class="text-[9px] text-blue-400">●</span>' : ''}
      </div>
      <div class="text-[10px] text-zinc-500 sans">${esc(m.cost)} · ${esc(m.latency)}</div>
    </button>`;
  }).join('');

  const testBlock = (() => {
    if (!state.testResult) return '';
    const tr = state.testResult;
    if (tr.ok) {
      return `<div class="mt-2 border border-emerald-500/30 bg-emerald-500/5 p-3 text-[11px] sans">
        <div class="text-emerald-400 font-medium mb-1">✓ Connection OK · ${tr.elapsedMs}ms</div>
        <div class="text-zinc-400">Model: <code class="text-zinc-300">${esc(tr.model || '—')}</code></div>
        ${tr.reply ? `<div class="text-zinc-400 mt-1">Reply: <code class="text-zinc-300">${esc(tr.reply)}</code></div>` : ''}
        ${tr.usage ? `<div class="text-[10px] text-zinc-500 mt-1">Tokens: ${esc(JSON.stringify(tr.usage))}</div>` : ''}
      </div>`;
    }
    return `<div class="mt-2 border border-red-500/30 bg-red-500/5 p-3 text-[11px] sans">
      <div class="text-red-400 font-medium mb-1">✗ Test failed · status ${esc(tr.status || '—')}</div>
      ${tr.detail ? `<div class="text-zinc-400 break-words">${esc(tr.detail)}</div>` : ''}
      ${tr.error ? `<div class="text-zinc-400 break-words">${esc(tr.error)}</div>` : ''}
    </div>`;
  })();

  return `<div class="border-2 border-blue-500/40 bg-zinc-950 p-6 mb-3 slide-down">
    <div class="flex items-start justify-between mb-4">
      <div>
        <div class="flex items-center gap-2 mb-1">
          <span class="text-blue-400 text-lg">⚙</span>
          <span class="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Settings · Gemini API</span>
        </div>
        <h2 class="serif text-2xl text-zinc-100">Configure <span class="italic text-blue-400">Google Gemini</span></h2>
      </div>
      <button onclick="window._app.toggleSettings()" class="text-zinc-500 hover:text-zinc-300 text-xl leading-none" title="Close">✕</button>
    </div>

    <!-- Model selection -->
    <div class="mb-5">
      <label class="block text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-2">Choose Model</label>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-2">${modelButtons}</div>
    </div>

    <!-- API Key input -->
    <div class="grid grid-cols-12 gap-4">
      <div class="col-span-12 md:col-span-8">
        <label class="block text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-2">
          API Key
          ${state.apiKey
            ? `<span class="text-emerald-400 ml-2">● configured</span>`
            : `<span class="text-amber-400 ml-2">○ not set</span>`}
        </label>
        <div class="flex gap-2">
          <div class="flex-1 relative">
            <input
              id="api-key-input"
              type="${inputType}"
              value="${esc(state.keyDraft != null ? state.keyDraft : state.apiKey)}"
              placeholder="AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
              class="w-full bg-black border border-zinc-700 px-3 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-blue-500 transition-colors"
              autocomplete="off"
              spellcheck="false"
            />
            <button onclick="window._app.toggleShowKey()" class="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-wider text-zinc-500 hover:text-blue-400 px-2">
              ${state.showKeyValue ? 'Hide' : 'Show'}
            </button>
          </div>
          <button onclick="window._app.testApiKey()" ${state.testing ? 'disabled' : ''}
            class="border border-zinc-700 hover:border-zinc-500 px-4 py-2.5 text-[10px] uppercase tracking-[0.15em] text-zinc-300 transition-colors disabled:opacity-50">
            ${state.testing ? 'Testing...' : 'Test'}
          </button>
          <button onclick="window._app.saveApiKey()"
            class="bg-blue-500 hover:bg-blue-400 text-black px-5 py-2.5 text-[10px] uppercase tracking-[0.15em] font-medium transition-colors">
            Save
          </button>
        </div>
        ${testBlock}
        ${state.apiKey ? `<div class="mt-2 flex items-center gap-2 text-[11px]">
          <span class="text-zinc-500 sans">Saved: <code class="text-zinc-400">${esc(fmt.maskKey(state.apiKey))}</code></span>
          <span class="text-zinc-600">·</span>
          <button onclick="window._app.clearApiKey()" class="text-red-400/80 hover:text-red-400 uppercase tracking-wider">Clear</button>
        </div>` : `<div class="mt-2 text-[11px] text-zinc-500 sans">Belum ada key tersimpan</div>`}
      </div>

      <div class="col-span-12 md:col-span-4 text-xs text-zinc-400 sans space-y-2 border-l border-zinc-800 pl-4">
        <p class="text-zinc-300"><strong>Cara dapat key:</strong></p>
        <ol class="list-decimal list-inside space-y-1 text-zinc-500">
          <li>Buka <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener" class="text-blue-400 hover:underline">aistudio.google.com</a></li>
          <li>Login dengan Google → Free tier aktif default</li>
          <li>Create API Key → copy → paste di sini</li>
        </ol>
        <div class="text-[10px] text-zinc-600 pt-2 border-t border-zinc-800/60 space-y-1">
          <p>🔒 Key disimpan di browser kamu (localStorage), tidak pernah ke server kami.</p>
          <p>⚡ Browser panggil Gemini API langsung — no proxy, no timeout Vercel.</p>
          <p>💸 Free tier: 1500 request/hari untuk Flash, cukup buat puluhan analisis.</p>
        </div>
      </div>
    </div>
  </div>`;
}

function viewApiKeyBadge() {
  const hasKey = !!state.apiKey;
  const cfg = hasKey
    ? { border: 'border-emerald-500/30 bg-emerald-500/5 hover:border-emerald-500/60', dot: 'bg-emerald-500', text: 'text-emerald-400', label: 'Gemini ✓' }
    : { border: 'border-blue-500/40 bg-blue-500/10 hover:bg-blue-500/20', dot: 'bg-blue-400 pulse-dot', text: 'text-blue-300', label: 'Setup Key' };
  return `<button onclick="window._app.toggleSettings()" class="flex items-center gap-1.5 px-2.5 py-1 border ${cfg.border} transition-colors">
    <span class="w-1.5 h-1.5 rounded-full ${cfg.dot}"></span>
    <span class="text-[10px] uppercase tracking-[0.15em] ${cfg.text}">${cfg.label}</span>
  </button>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Trade Action Hero — kartu utama berisi LONG/SHORT/WAIT decision
// ─────────────────────────────────────────────────────────────────────────────
function viewTradeActionHero(analysis, currentPrice) {
  if (!analysis || !analysis.tradeAction) return '';
  const a = analysis.tradeAction;

  // Style per direction
  const cfg = {
    LONG:  { label: 'LONG',  sub: 'Buy & hold',   icon: '↗', border: 'border-emerald-500/50', bg: 'bg-emerald-500/[0.07]', text: 'text-emerald-400', glow: 'shadow-[0_0_60px_-15px_rgba(16,185,129,0.4)]' },
    SHORT: { label: 'SHORT', sub: 'Sell / short', icon: '↘', border: 'border-red-500/50',     bg: 'bg-red-500/[0.07]',     text: 'text-red-400',     glow: 'shadow-[0_0_60px_-15px_rgba(239,68,68,0.4)]'  },
    WAIT:  { label: 'WAIT',  sub: 'Stand aside',  icon: '⏸', border: 'border-amber-500/50',   bg: 'bg-amber-500/[0.07]',   text: 'text-amber-400',   glow: 'shadow-[0_0_60px_-15px_rgba(245,158,11,0.3)]' },
  };
  const c = cfg[a.direction] || cfg.WAIT;
  const isWait = a.direction === 'WAIT';
  const confColors = {
    LOW:    'text-zinc-400 border-zinc-700',
    MEDIUM: 'text-amber-400 border-amber-500/40',
    HIGH:   'text-emerald-400 border-emerald-500/40',
  };

  const meta = analysis._meta || {};

  // Compute risk/reward percentages dari entry midpoint
  const entryMid = (a.entryLow + a.entryHigh) / 2;
  const riskPct  = entryMid && a.stopLoss   ? Math.abs((a.stopLoss   - entryMid) / entryMid) * 100 : null;
  const rew1     = entryMid && a.takeProfit1 ? Math.abs((a.takeProfit1 - entryMid) / entryMid) * 100 : null;
  const rew2     = entryMid && a.takeProfit2 ? Math.abs((a.takeProfit2 - entryMid) / entryMid) * 100 : null;

  // Price ladder
  const kindStyles = {
    tp:    { dot: 'bg-emerald-500', text: 'text-emerald-400', accent: 'border-l-emerald-500' },
    now:   { dot: 'bg-blue-400',    text: 'text-blue-300',    accent: 'border-l-blue-400'    },
    entry: { dot: 'bg-purple-400',  text: 'text-purple-300',  accent: 'border-l-purple-400'  },
    sl:    { dot: 'bg-red-500',     text: 'text-red-400',     accent: 'border-l-red-500'     },
  };

  let levels = [];
  if (!isWait) {
    if (a.direction === 'LONG') {
      levels = [
        { p: a.takeProfit2, l: 'TP2',     k: 'tp',    s: 'Target 2'  },
        { p: a.takeProfit1, l: 'TP1',     k: 'tp',    s: 'Target 1'  },
        { p: currentPrice,  l: 'NOW',     k: 'now',   s: 'Spot'      },
        { p: a.entryHigh,   l: 'ENTRY ↑', k: 'entry', s: 'Entry top' },
        { p: a.entryLow,    l: 'ENTRY ↓', k: 'entry', s: 'Entry bot' },
        { p: a.stopLoss,    l: 'SL',      k: 'sl',    s: 'Stop loss' },
      ];
    } else {
      levels = [
        { p: a.stopLoss,    l: 'SL',      k: 'sl',    s: 'Stop loss' },
        { p: a.entryHigh,   l: 'ENTRY ↑', k: 'entry', s: 'Entry top' },
        { p: a.entryLow,    l: 'ENTRY ↓', k: 'entry', s: 'Entry bot' },
        { p: currentPrice,  l: 'NOW',     k: 'now',   s: 'Spot'      },
        { p: a.takeProfit1, l: 'TP1',     k: 'tp',    s: 'Target 1'  },
        { p: a.takeProfit2, l: 'TP2',     k: 'tp',    s: 'Target 2'  },
      ];
    }
  }

  const ladderHTML = levels.map(lv => {
    const s = kindStyles[lv.k];
    const showPct = lv.k !== 'now' && lv.k !== 'entry';
    const pct = showPct ? pctFrom(currentPrice, lv.p) : null;
    return `<div class="flex items-center gap-3 px-3 py-2 border-l-2 ${s.accent} bg-zinc-950/60">
      <div class="w-1.5 h-1.5 rounded-full ${s.dot}"></div>
      <div class="text-[10px] uppercase tracking-wider w-16 ${s.text}">${esc(lv.l)}</div>
      <div class="text-base text-zinc-100 tabular-nums flex-1">${esc(fmt.usd(lv.p))}</div>
      ${pct != null ? `<div class="text-xs tabular-nums ${pct >= 0 ? 'text-emerald-400' : 'text-red-400'}">${esc(fmt.pct(pct))}</div>` : ''}
      <div class="text-[10px] text-zinc-500 sans w-20 text-right">${esc(lv.s)}</div>
    </div>`;
  }).join('');

  return `<div class="border-2 ${c.border} ${c.bg} p-6 mb-3 ${c.glow}">
    <div class="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-5 pb-5 border-b border-zinc-800/60">
      <div class="flex items-center gap-4">
        <div class="text-5xl ${c.text}">${c.icon}</div>
        <div>
          <div class="flex items-center gap-2 mb-1 flex-wrap">
            <span class="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Trade Action</span>
            <span class="text-[10px] text-zinc-600">·</span>
            <span class="text-[10px] uppercase tracking-[0.15em] text-zinc-500">${esc(a.horizon || '1–3 hari')}</span>
            ${meta.model ? `<span class="text-[10px] text-zinc-600">·</span>
              <span class="text-[10px] uppercase tracking-[0.15em] text-blue-400">🅖 ${esc(meta.model)}</span>` : ''}
            ${meta.elapsedMs ? `<span class="text-[10px] text-zinc-600">·</span>
              <span class="text-[10px] text-zinc-500">${(meta.elapsedMs/1000).toFixed(1)}s</span>` : ''}
          </div>
          <div class="text-5xl tracking-tight leading-none ${c.text}">${c.label}</div>
          <div class="text-xs text-zinc-500 mt-2 sans">${esc(c.sub)}</div>
        </div>
      </div>
      <div class="flex flex-wrap gap-2 md:gap-3 items-start">
        <div class="border px-3 py-2 ${confColors[a.confidence] || confColors.LOW}">
          <div class="text-[9px] uppercase tracking-[0.15em] text-zinc-500 mb-0.5">Confidence</div>
          <div class="text-sm">${esc(a.confidence || 'LOW')}</div>
        </div>
        ${!isWait ? `<div class="border border-zinc-700 px-3 py-2">
          <div class="text-[9px] uppercase tracking-[0.15em] text-zinc-500 mb-0.5">Risk : Reward</div>
          <div class="text-sm text-zinc-100">1 : ${a.riskRewardRatio ? esc(a.riskRewardRatio.toFixed(1)) : '—'}</div>
        </div>` : ''}
        <div class="border border-zinc-700 px-3 py-2">
          <div class="text-[9px] uppercase tracking-[0.15em] text-zinc-500 mb-0.5">Position</div>
          <div class="text-sm text-zinc-100">${esc(a.positionSize || '—')}</div>
        </div>
      </div>
    </div>

    ${isWait ? `
      <div class="text-center py-8">
        <p class="text-sm text-zinc-300 leading-relaxed sans max-w-2xl mx-auto italic">${esc(a.actionReasoning || '')}</p>
        ${a.invalidationReason ? `<div class="mt-6 text-xs text-zinc-500 sans">
          <span class="text-amber-400 uppercase tracking-wider text-[10px] mr-2">Watch for</span>${esc(a.invalidationReason)}
        </div>` : ''}
      </div>
    ` : `
      <div class="grid grid-cols-12 gap-6">
        <div class="col-span-12 md:col-span-6">
          <div class="text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-3">Price Ladder</div>
          <div class="space-y-1">${ladderHTML}</div>
        </div>
        <div class="col-span-12 md:col-span-6 flex flex-col gap-4">
          <div>
            <div class="text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-3">Reasoning</div>
            <p class="text-sm text-zinc-200 leading-relaxed sans">${esc(a.actionReasoning || '')}</p>
          </div>
          <div class="grid grid-cols-3 gap-2 mt-2">
            <div class="border border-red-500/30 bg-red-500/5 p-3">
              <div class="text-[10px] uppercase tracking-wider text-red-400/80 mb-1">Risk</div>
              <div class="text-base text-red-400 tabular-nums">${riskPct ? '-' + riskPct.toFixed(2) + '%' : '—'}</div>
              <div class="text-[10px] text-zinc-500 mt-0.5">to SL</div>
            </div>
            <div class="border border-emerald-500/30 bg-emerald-500/5 p-3">
              <div class="text-[10px] uppercase tracking-wider text-emerald-400/80 mb-1">TP1</div>
              <div class="text-base text-emerald-400 tabular-nums">${rew1 ? '+' + rew1.toFixed(2) + '%' : '—'}</div>
              <div class="text-[10px] text-zinc-500 mt-0.5">to target 1</div>
            </div>
            <div class="border border-emerald-500/30 bg-emerald-500/5 p-3">
              <div class="text-[10px] uppercase tracking-wider text-emerald-400/80 mb-1">TP2</div>
              <div class="text-base text-emerald-400 tabular-nums">${rew2 ? '+' + rew2.toFixed(2) + '%' : '—'}</div>
              <div class="text-[10px] text-zinc-500 mt-0.5">to target 2</div>
            </div>
          </div>
          ${a.invalidationReason ? `<div class="mt-1 pt-3 border-t border-zinc-800/60 text-xs text-zinc-400 sans leading-relaxed">
            <span class="text-amber-400 uppercase tracking-wider text-[10px] mr-2">Invalidation</span>${esc(a.invalidationReason)}
          </div>` : ''}
        </div>
      </div>
    `}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Generic cards
// ─────────────────────────────────────────────────────────────────────────────
function viewPlaceholder(label) {
  return `<div class="border border-zinc-800 bg-zinc-950 p-5">
    <div class="text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-3">${esc(label)}</div>
    <div class="text-zinc-700 text-sm">No data</div>
  </div>`;
}

function viewMetric(label, value, sub, color = 'text-zinc-100') {
  return `<div class="border border-zinc-800 bg-zinc-950 p-4 hover:border-zinc-700 transition-colors">
    <div class="text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-2">${esc(label)}</div>
    <div class="text-xl tabular-nums ${color}">${esc(value)}</div>
    ${sub ? `<div class="text-[11px] text-zinc-500 mt-1">${esc(sub)}</div>` : ''}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Price card (BTC spot + sparkline + 24h range)
// ─────────────────────────────────────────────────────────────────────────────
function viewPriceCard(snap) {
  if (!snap?.ticker) return viewPlaceholder('BTC / USD · Spot');
  const t  = snap.ticker;
  const cg = snap.coingecko || {};
  const g  = snap.global || {};
  const support    = snap.orderBook?.bids?.[0]?.price;
  const resistance = snap.orderBook?.asks?.[0]?.price;
  const pos = (support && resistance && t.price && resistance > support)
    ? Math.max(0, Math.min(100, ((t.price - support) / (resistance - support)) * 100))
    : 50;

  return `<div class="col-span-12 md:col-span-7 border border-zinc-800 bg-zinc-950 p-6">
    <div class="flex items-center justify-between mb-2">
      <span class="text-[10px] uppercase tracking-[0.15em] text-zinc-500">BTC / USDT · Live tick</span>
      <span class="text-[10px] text-zinc-600">Binance + CoinGecko</span>
    </div>
    <div class="flex items-baseline gap-4 mb-4">
      <div class="text-5xl tabular-nums text-zinc-100">${esc(fmt.usd(t.price))}</div>
      <div class="text-lg ${t.change24h >= 0 ? 'text-emerald-400' : 'text-red-400'}">
        ${t.change24h >= 0 ? '▲' : '▼'} ${esc(fmt.pct(t.change24h))}
      </div>
    </div>
    <div class="h-20 mb-4">${snap.klines && snap.klines.length ? sparkSVG(snap.klines, '#3b82f6') : ''}</div>
    <div class="mb-4">
      <div class="flex justify-between text-[10px] text-zinc-500 mb-2">
        <span>BID WALL ${esc(fmt.usd(support))}</span>
        <span class="text-blue-400">NOW ${esc(fmt.usd(t.price))}</span>
        <span>ASK WALL ${esc(fmt.usd(resistance))}</span>
      </div>
      <div class="relative h-2 bg-zinc-900">
        <div class="absolute inset-y-0 left-0 bg-emerald-500/20" style="width: 15%"></div>
        <div class="absolute inset-y-0 right-0 bg-red-500/20" style="width: 15%"></div>
        <div class="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-blue-400 rounded-full -ml-1.5" style="left: ${pos}%"></div>
      </div>
    </div>
    <div class="grid grid-cols-4 gap-3 pt-4 border-t border-zinc-800">
      <div><div class="text-[10px] uppercase text-zinc-500 mb-1">7d</div>
        <div class="text-sm ${cg.change7d >= 0 ? 'text-emerald-400' : 'text-red-400'}">${esc(fmt.pct(cg.change7d))}</div></div>
      <div><div class="text-[10px] uppercase text-zinc-500 mb-1">30d</div>
        <div class="text-sm ${cg.change30d >= 0 ? 'text-emerald-400' : 'text-red-400'}">${esc(fmt.pct(cg.change30d))}</div></div>
      <div><div class="text-[10px] uppercase text-zinc-500 mb-1">ATH dist</div>
        <div class="text-sm text-zinc-300">${esc(fmt.pct(cg.athDistance))}</div></div>
      <div><div class="text-[10px] uppercase text-zinc-500 mb-1">Dominance</div>
        <div class="text-sm text-blue-400">${g.btcDominance ? esc(g.btcDominance.toFixed(2) + '%') : '—'}</div></div>
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Whale Walls card — visual order book
// ─────────────────────────────────────────────────────────────────────────────
function viewWhaleWalls(snap) {
  if (!snap?.orderBook) return viewPlaceholder('Whale Walls');
  const ob = snap.orderBook;
  const allWalls = [
    ...ob.bids.map(b => ({ ...b, side: 'bid' })),
    ...ob.asks.map(a => ({ ...a, side: 'ask' })),
  ].sort((a, b) => a.price - b.price);
  const maxTotal = Math.max(...allWalls.map(w => w.total), 1);

  return `<div class="col-span-12 md:col-span-5 border border-zinc-800 bg-zinc-950 p-5">
    <div class="flex items-center justify-between mb-3">
      <span class="text-[10px] uppercase tracking-[0.15em] text-zinc-500">Whale Wall Map</span>
      <span class="text-[10px] text-zinc-600">Binance top 10</span>
    </div>
    <div class="flex justify-between text-xs mb-3">
      <span class="text-emerald-400">BID $${(ob.bidWall / 1e6).toFixed(2)}M</span>
      <span class="text-zinc-500">${(ob.ratio * 100).toFixed(0)}% bid dominance</span>
      <span class="text-red-400">$${(ob.askWall / 1e6).toFixed(2)}M ASK</span>
    </div>
    <div class="space-y-1">
      ${allWalls.map(w => {
        const widthPct = (w.total / maxTotal) * 100;
        return `<div class="flex items-center gap-2 text-[10px]">
          <span class="w-20 tabular-nums text-zinc-400">${esc(fmt.usd(w.price))}</span>
          <div class="flex-1 h-3 bg-zinc-900 relative">
            <div class="absolute inset-y-0 left-0 ${w.side === 'bid' ? 'bg-emerald-500/60' : 'bg-red-500/60'}" style="width: ${widthPct}%"></div>
          </div>
          <span class="w-16 text-right tabular-nums ${w.side === 'bid' ? 'text-emerald-400' : 'text-red-400'}">$${(w.total / 1e6).toFixed(2)}M</span>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Fear & Greed gauge
// ─────────────────────────────────────────────────────────────────────────────
function viewFearGreed(snap) {
  const fg = snap?.fearGreed;
  if (!fg) return viewPlaceholder('Fear & Greed');
  const color = fg.value < 25 ? '#ef4444'
              : fg.value < 45 ? '#f59e0b'
              : fg.value < 55 ? '#eab308'
              : fg.value < 75 ? '#84cc16'
              : '#22c55e';
  return `<div class="col-span-12 md:col-span-4 border border-zinc-800 bg-zinc-950 p-5 h-full">
    <div class="flex items-center justify-between mb-3">
      <span class="text-[10px] uppercase tracking-[0.15em] text-zinc-500">Fear & Greed</span>
      <span class="text-[10px] text-zinc-600">alternative.me</span>
    </div>
    <div class="relative h-24 mb-2">${gaugeSVG(fg.value)}</div>
    <div class="text-center">
      <div class="text-3xl tabular-nums" style="color: ${color}">${esc(fg.value)}</div>
      <div class="text-xs uppercase tracking-wider text-zinc-400 mt-1">${esc(fg.label || '')}</div>
    </div>
    ${fg.history && fg.history.length ? `<div class="h-10 mt-3">${sparkSVG(fg.history.map(h => h.v), color, 200, 40)}</div>` : ''}
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Signal chip (AI sentiment + reasoning)
// ─────────────────────────────────────────────────────────────────────────────
function viewSignal(analysis) {
  if (!analysis?.signal) return '';
  const map = {
    STRONG_BUY: { label: 'STRONG BUY', klass: 'text-emerald-400 border-emerald-500/40' },
    BUY:        { label: 'BUY',        klass: 'text-green-400 border-green-500/40' },
    NEUTRAL:    { label: 'NEUTRAL',    klass: 'text-amber-400 border-amber-500/40' },
    CAUTION:    { label: 'CAUTION',    klass: 'text-orange-400 border-orange-500/40' },
    AVOID:      { label: 'AVOID',      klass: 'text-red-400 border-red-500/40' },
  };
  const m = map[analysis.signal] || map.NEUTRAL;
  const textClass = m.klass.split(' ')[0];
  return `<div class="col-span-12 md:col-span-8 border ${m.klass} bg-zinc-950 p-5">
    <div class="flex items-baseline justify-between mb-2">
      <span class="text-[10px] uppercase tracking-[0.15em] text-zinc-500">Sentiment Signal</span>
      <span class="text-[10px] text-zinc-600">snapshot + AI</span>
    </div>
    <div class="text-2xl mb-3 ${textClass}">${esc(m.label)}</div>
    <ul class="space-y-1.5 text-xs">
      ${(analysis.signalReasoning || []).slice(0, 3).map(r =>
        `<li class="text-zinc-400 leading-relaxed"><span class="opacity-60">→ </span>${esc(r)}</li>`
      ).join('')}
    </ul>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Whale Summary + News headlines
// ─────────────────────────────────────────────────────────────────────────────
function viewWhaleNews(analysis) {
  if (!analysis) return '';
  return `<div class="col-span-12 border border-zinc-800 bg-zinc-950 p-5">
    <div class="flex items-center justify-between mb-3">
      <span class="text-[10px] uppercase tracking-[0.15em] text-zinc-500">Whale & Smart Money · 24h</span>
      <span class="text-[10px] text-zinc-600">snapshot data + CryptoCompare news</span>
    </div>
    <p class="text-sm text-zinc-300 leading-relaxed sans mb-4">${esc(analysis.whaleSummary || '—')}</p>
    <div class="pt-3 border-t border-zinc-800">
      <div class="text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-2">Top Headlines</div>
      <ul class="space-y-1.5">
        ${(analysis.newsHeadlines || []).map((h, i) => `<li class="text-xs text-zinc-400 leading-relaxed sans">
          <span class="text-blue-400/60 mr-2">${String(i + 1).padStart(2, '0')}</span>${esc(h)}
        </li>`).join('')}
      </ul>
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Call-to-action when no AI analysis yet
// ─────────────────────────────────────────────────────────────────────────────
function viewAICTA() {
  if (!state.apiKey) {
    return `<div class="border-2 border-dashed border-blue-500/40 bg-blue-500/[0.05] p-6 mb-3 text-center">
      <div class="text-blue-400 text-4xl mb-3">🔑</div>
      <div class="serif text-2xl text-zinc-100 mb-2">Setup <span class="italic text-blue-400">Gemini API Key</span> dulu</div>
      <div class="text-sm text-zinc-400 sans mb-4 max-w-xl mx-auto">
        Masukkan API key Google Gemini kamu. Disimpan di browser, dipakai per-request langsung ke Google API. Free tier sudah cukup buat puluhan analisis/hari.
      </div>
      <button onclick="window._app.toggleSettings()"
        class="bg-blue-500 hover:bg-blue-400 text-black px-5 py-2.5 text-[10px] uppercase tracking-[0.15em] font-medium transition-colors">
        ⚙ Configure API Key
      </button>
    </div>`;
  }
  const m = GEMINI_MODELS.find(x => x.id === state.model) || GEMINI_MODELS[0];
  return `<div class="border-2 border-dashed border-blue-500/30 bg-blue-500/[0.03] p-6 mb-3 text-center">
    <div class="text-blue-400 text-4xl mb-3">✦</div>
    <div class="text-sm text-zinc-300 sans mb-2">
      Tekan <span class="text-blue-400 font-medium">"Generate AI Analysis"</span> untuk dapat trade action plan
    </div>
    <div class="flex items-center justify-center gap-3 text-[11px] text-zinc-500 sans mt-2 flex-wrap">
      <span>🅖 ${esc(m.label)}</span>
      <span class="text-zinc-700">·</span>
      <span class="text-zinc-400">${esc(m.latency)}</span>
      <span class="text-zinc-700">·</span>
      <span>${esc(m.cost)}</span>
      <span class="text-zinc-700">·</span>
      <span class="text-emerald-500/70">Direct browser call (no proxy timeout)</span>
    </div>
  </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Analyzing progress bar (saat AI berjalan)
// ─────────────────────────────────────────────────────────────────────────────
function viewAnalyzingProgress() {
  if (!state.analyzing) return '';
  const m = GEMINI_MODELS.find(x => x.id === state.model) || GEMINI_MODELS[0];
  return `<div class="border-2 border-blue-500/40 bg-blue-500/5 p-6 mb-3">
    <div class="flex items-center justify-between mb-3">
      <div class="flex items-center gap-3">
        <div class="spin text-blue-400 text-xl">⟳</div>
        <div>
          <div class="text-sm text-blue-300 uppercase tracking-[0.15em]">Analyzing with ${esc(m.label)}</div>
          <div class="text-xs text-zinc-500 sans mt-1">Estimasi ${esc(m.latency)} · Browser hold connection langsung ke Gemini API</div>
        </div>
      </div>
      <button onclick="window._app.cancelAnalysis()"
        class="text-[10px] uppercase tracking-wider text-zinc-400 hover:text-red-400 border border-zinc-700 hover:border-red-500/50 px-3 py-1.5 transition-colors">
        Cancel
      </button>
    </div>
    <div class="h-1 bg-zinc-900 overflow-hidden">
      <div class="h-full bg-gradient-to-r from-blue-500 to-purple-500 progress-bar"></div>
    </div>
  </div>`;
}

// =============================================================================
//  MAIN RENDER
// =============================================================================
function render() {
  // ── Capture in-flight input value SEBELUM innerHTML hancurkan DOM ─────────
  // Ini fix utk bug: user ngetik di input → klik Test/Show → render() jalan →
  // input field di-recreate dengan value kosong (karena state.apiKey belum
  // di-save). Akhirnya saat klik Save, value-nya hilang.
  const liveKeyInput = document.getElementById('api-key-input');
  if (liveKeyInput && state.showSettings) {
    state.keyDraft = liveKeyInput.value;
  }

  const { snapshot, analysis, loading, analyzing, error, analyzeError, analyzeHint, lastFetch, lastAnalyze } = state;
  const dotClass = loading || analyzing
    ? 'bg-blue-400 pulse-dot'
    : snapshot ? 'bg-emerald-500' : 'bg-zinc-600';
  const statusText = loading ? 'Fetching live data'
    : analyzing ? 'Gemini analyzing'
    : snapshot ? 'Live tick · multi-source'
    : 'Idle';
  const hasKey = !!state.apiKey;

  let body = '';

  if (loading && !snapshot) {
    body = `<div class="border border-blue-500/30 bg-blue-500/5 p-12 mb-6 text-center">
      <div class="flex items-center justify-center gap-3 mb-4">
        <span class="text-blue-400 text-lg">🔍</span>
        <span class="text-sm text-blue-300 uppercase tracking-[0.15em]">Fetching live snapshot</span>
      </div>
      <div class="text-sm text-zinc-400 sans">Mengambil tick dari Binance, CoinGecko, mempool.space, alternative.me, blockchain.info, CryptoCompare...</div>
      <div class="h-1 bg-zinc-900 max-w-md mx-auto overflow-hidden mt-6">
        <div class="h-full shimmer"></div>
      </div>
    </div>`;
  } else if (error) {
    body = `<div class="border border-red-500/40 bg-red-500/5 p-6 mb-6">
      <div class="text-sm font-medium text-red-400 mb-1">⚠ Gagal fetch snapshot</div>
      <div class="text-xs text-red-400/70 break-all">${esc(error)}</div>
      <button onclick="window._app.loadSnapshot()"
        class="mt-3 text-xs text-blue-400 hover:text-blue-300 uppercase tracking-wider">→ Coba lagi</button>
    </div>`;
  } else if (snapshot) {
    const t = snapshot.ticker;
    const cg = snapshot.coingecko;
    const fund = snapshot.funding;
    const net = snapshot.network;
    const mp = snapshot.mempool;

    body = `
      ${analyzing ? viewAnalyzingProgress() : (analysis ? viewTradeActionHero(analysis, t?.price) : viewAICTA())}

      <div class="grid grid-cols-12 gap-3 mb-3">
        ${viewPriceCard(snapshot)}
        ${viewWhaleWalls(snapshot)}
      </div>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        ${viewMetric('Market Cap',
          cg?.marketCap ? '$' + (cg.marketCap / 1e12).toFixed(3) + 'T' : '—',
          t?.volume24h ? '24h vol $' + (t.volume24h / 1e9).toFixed(1) + 'B' : '',
          'text-blue-400')}
        ${viewMetric('Funding Rate',
          fund?.fundingRate != null ? fund.fundingRate.toFixed(4) + '%' : '—',
          fund?.fundingRate >= 0 ? 'Longs pay shorts 🔥' : 'Shorts pay longs ❄',
          fund?.fundingRate < 0 ? 'text-blue-400' : 'text-orange-400')}
        ${viewMetric('Hashrate',
          net?.hashrate ? (net.hashrate / 1e9).toFixed(2) + ' EH/s' : '—',
          net?.blockHeight ? 'Block #' + net.blockHeight.toLocaleString() : '',
          'text-purple-400')}
        ${viewMetric('Mempool Fee',
          mp?.fastestFee ? mp.fastestFee + ' sat/vB' : '—',
          mp?.economyFee ? 'Eco: ' + mp.economyFee + ' sat/vB' : '',
          'text-cyan-400')}
      </div>

      <div class="grid grid-cols-12 gap-3 mb-3">
        ${viewFearGreed(snapshot)}
        ${analysis ? viewSignal(analysis) : `<div class="col-span-12 md:col-span-8 border border-zinc-800 bg-zinc-950 p-5 flex items-center justify-center text-sm text-zinc-500 sans italic">
          ${hasKey ? 'Tekan "Generate AI Analysis" untuk dapat sinyal bandarmologi' : 'Setup API Key dulu untuk akses AI bandarmologi'}
        </div>`}
      </div>

      ${analysis ? `<div class="grid grid-cols-12 gap-3 mb-3">${viewWhaleNews(analysis)}</div>` : ''}

      ${analyzeError ? `<div class="border border-red-500/40 bg-red-500/5 p-4 mb-6">
        <div class="text-xs text-red-400 mb-1">⚠ AI analysis gagal: ${esc(analyzeError)}</div>
        ${analyzeHint ? `<div class="text-[11px] text-red-400/70 sans mt-1">${esc(analyzeHint)}</div>` : ''}
        <div class="mt-2 flex gap-3">
          <button onclick="window._app.loadAnalysis()" class="text-xs text-blue-400 hover:text-blue-300 uppercase tracking-wider">Retry</button>
          <button onclick="window._app.toggleSettings()" class="text-xs text-zinc-400 hover:text-zinc-200 uppercase tracking-wider">Edit Settings</button>
        </div>
      </div>` : ''}

      ${analysis?.riskWarning ? `<div class="border border-zinc-800 bg-zinc-950 p-4 mb-6">
        <span class="text-amber-400 uppercase tracking-wider text-[10px] mr-2">⚠ Risk</span>
        <span class="text-xs text-zinc-400 sans italic">${esc(analysis.riskWarning)}</span>
      </div>` : ''}

      ${snapshot.errors?.length ? `<div class="text-[10px] text-zinc-600 sans mb-4">
        ⚠ ${snapshot.errors.length} source error: ${esc(snapshot.errors.map(e => e.source).join(', '))}
      </div>` : ''}

      <footer class="border-t border-zinc-800 pt-4 flex items-center justify-between text-[10px] text-zinc-600 sans gap-4 flex-wrap">
        <div>Snapshot: Binance · CoinGecko · alternative.me · mempool.space · blockchain.info · CryptoCompare</div>
        <div>Bukan saran finansial · DYOR</div>
      </footer>
    `;
  }

  document.getElementById('app').innerHTML = `
    <header class="flex flex-col md:flex-row md:items-end md:justify-between gap-4 border-b border-zinc-800 pb-5 mb-6">
      <div>
        <div class="flex items-center gap-2 mb-1">
          <div class="w-2 h-2 rounded-full ${dotClass}"></div>
          <span class="text-[10px] uppercase tracking-[0.2em] text-zinc-500">${esc(statusText)}</span>
        </div>
        <h1 class="serif text-5xl text-zinc-100 leading-none">Bitcoin <span class="italic text-blue-400">Intelligence</span></h1>
        <p class="text-xs text-zinc-500 mt-2 sans">Live tick · AI bandarmologi · Google Gemini direct</p>
      </div>
      <div class="flex flex-col gap-2 items-start md:items-end">
        <div class="flex items-center gap-2 flex-wrap">
          ${viewApiKeyBadge()}
          <button onclick="window._app.loadSnapshot()" ${loading ? 'disabled' : ''}
            class="px-3 py-1.5 border border-zinc-700 hover:border-blue-500/50 hover:text-blue-300 text-[10px] uppercase tracking-[0.15em] text-zinc-400 transition-colors disabled:opacity-50 flex items-center gap-2">
            <span class="${loading ? 'spin' : ''}">↻</span>
            ${loading ? 'Loading...' : 'Refresh tick'}
          </button>
          <button onclick="window._app.loadAnalysis()" ${(!snapshot || analyzing) ? 'disabled' : ''}
            class="px-3 py-1.5 bg-blue-500 hover:bg-blue-400 text-black text-[10px] uppercase tracking-[0.15em] font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2">
            ✦ ${analyzing ? 'Analyzing...' : analysis ? 'Re-analyze' : 'Generate AI Analysis'}
          </button>
        </div>
        <div class="text-[10px] text-zinc-600 tabular-nums">
          ${lastFetch ? `tick ${esc(fmt.ago(lastFetch))}` : ''}${lastAnalyze ? ` · AI ${esc(fmt.ago(lastAnalyze))}` : ''}
        </div>
      </div>
    </header>

    ${viewSettings()}
    ${body}
  `;
}

// =============================================================================
//  BOOT
// =============================================================================
window._app = {
  loadSnapshot,
  loadAnalysis,
  cancelAnalysis,
  toggleSettings,
  saveApiKey,
  clearApiKey,
  toggleShowKey,
  testApiKey,
  selectModel,
};

// Initial load
loadSnapshot();

// Auto-refresh snapshot tiap 30s (skip kalau lagi loading / panel settings buka)
setInterval(() => {
  if (!state.loading && !state.analyzing && !state.showSettings) loadSnapshot();
}, 30_000);

// Re-render tiap 5s supaya "X ago" timestamp update
setInterval(() => {
  if (!state.showSettings) render();
}, 5_000);
