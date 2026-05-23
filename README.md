# BTC Bandarmology Intelligence · Gemini Edition

Live Bitcoin trading dashboard dengan AI bandarmologi analysis menggunakan **Google Gemini API**. BYOK (Bring Your Own Key) — user paste API key sendiri di UI, disimpan di browser localStorage.

## Struktur

```
btc-bandarmology/
├── api/
│   └── snapshot.js   ← Vercel Edge function (agregat data live)
├── index.html        ← Shell HTML
├── app.js            ← Seluruh frontend logic + Gemini client
├── vercel.json       ← framework=null
├── .env.example      ← (kosong, tidak ada env yang dibutuhkan)
└── .gitignore
```

## Perubahan Major dari Versi Lama

### Penyebab 504 di versi lama

| # | Masalah | Penyebab |
|---|---------|----------|
| 1 | Vercel Hobby max 60s | Browser → Vercel → Gemini → Vercel → Browser, 2-hop dengan cold start |
| 2 | Region routing | Vercel default region US East → Gemini API → response. User Indonesia harus tunggu round trip jauh |
| 3 | Margin terlalu sempit | `UPSTREAM_TIMEOUT_MS = 55000` di Vercel max 60s, hampir tidak ada buffer untuk cold start |
| 4 | Parsing fragile | Regex parsing `text.replace(/\`\`\`json/g, '')` rawan gagal |
| 5 | Tidak ada retry | Error transient (500/503 sesaat) langsung gagal total |
| 6 | Multi-provider bloat | Code 2x lipat untuk fitur yang akhirnya dipangkas |

### Solusi di versi baru

| Lama | Baru |
|------|------|
| Browser → Vercel proxy → Gemini | **Browser → Gemini langsung** (Gemini support CORS!) |
| Regex parsing markdown JSON | `responseMimeType: 'application/json'` + `responseSchema` (Google API memaksa output sesuai schema) |
| Anthropic SDK + Gemini SDK | Gemini saja |
| `maxDuration: 60` (Vercel limit) | 90s di browser AbortController (no Vercel constraint) |
| Manual JSON parsing | Auto-parsed (`responseMimeType` jamin valid JSON) |
| No retry | Auto-retry 1x untuk transient 5xx errors |

## Cara Deploy

1. Push code ke GitHub
2. https://vercel.com/new → Import repo
3. **Framework Preset: `Other`** (BUKAN Create React App)
4. Build/Install/Output Directory: kosongkan
5. Klik **Deploy** — **tidak ada env vars yang perlu di-set**!
6. Setelah live, klik **"Setup Key"** di header → paste Gemini key → Save

## Cara dapat Gemini API Key

1. Buka [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
2. Login dengan Google account
3. **Create API key** — free tier sudah aktif default
4. Copy → paste di dashboard → Save

**Free tier cukup**: 1500 request/hari untuk `gemini-2.5-flash`. Lebih dari cukup buat ratusan analisis.

## Model yang Tersedia

| Model | Cost/call (estimasi) | Latency | Use case |
|-------|----------------------|---------|----------|
| **gemini-2.5-flash** (default) | ~$0.001 | 5-12s | Best balance speed/quality |
| gemini-2.5-pro | ~$0.01 | 15-30s | Analisis lebih dalam, slower |
| gemini-2.0-flash | ~$0.0005 | 4-10s | Termurah, cukup untuk quick check |

Switch model kapan saja di Settings panel.

## Cara user pakai

1. Buka dashboard → snapshot tick auto-load (~1-2 detik dari Vercel Edge)
2. Klik **Setup Key** (kalau belum) → paste Gemini API key → **Test** → **Save**
3. Klik **Generate AI Analysis** → ~5-15 detik → Trade Action Panel muncul

## Endpoint

- `GET /api/snapshot` — agregat live tick (~300ms-2s)

Tidak ada `/api/analyze` lagi — browser langsung panggil Google API.

## Output JSON dari AI (structured schema)

Gemini diberi `responseSchema` sehingga output selalu valid sesuai struktur:

```json
{
  "tradeAction": {
    "direction": "LONG" | "SHORT" | "WAIT",
    "horizon": "1-3 hari",
    "confidence": "LOW" | "MEDIUM" | "HIGH",
    "entryLow": 95000, "entryHigh": 96000,
    "stopLoss": 92000,
    "takeProfit1": 100000, "takeProfit2": 105000,
    "riskRewardRatio": 2.5,
    "positionSize": "1-2% portfolio",
    "invalidationReason": "...",
    "actionReasoning": "..."
  },
  "signal": "STRONG_BUY" | "BUY" | "NEUTRAL" | "CAUTION" | "AVOID",
  "signalReasoning": ["r1", "r2", "r3"],
  "supportLevel": 93500,
  "resistanceLevel": 97500,
  "whaleSummary": "...",
  "newsHeadlines": ["h1", "h2", "h3"],
  "riskWarning": "..."
}
```

Aturan ketat yang di-enforce di prompt:
- LONG → `SL < entryLow < entryHigh < TP1 < TP2`
- SHORT → `TP2 < TP1 < entryLow < entryHigh < SL`
- WAIT → semua harga ≈ current price
- R:R minimum 1.5, kalau tidak → otomatis WAIT
- Mixed/kontra signal → WAIT

## Troubleshooting

### "API key invalid"
Pastikan key benar diawali `AIza`. Generate ulang di [aistudio.google.com](https://aistudio.google.com/app/apikey). Klik **Test** dulu sebelum Save.

### "Rate limit / kuota habis"
Free tier reset 24 jam. Tunggu, atau switch ke model 2.0-flash (kuota terpisah).

### "Timeout 90s"
Sangat jarang dengan direct browser call. Kalau terjadi:
- Cek koneksi internet
- Switch ke `gemini-2.5-flash` (default, paling cepat)

### Snapshot error sebagian
Beberapa source (mempool.space, blockchain.info, CryptoCompare) kadang flaky. Snapshot tetap jalan dengan data yang available — error per source di-collect di `snapshot.errors[]`.

### "react-scripts: command not found"
Vercel salah deteksi framework. Project Settings → Framework Preset: **Other** → redeploy.

## Security note

API key disimpan di **browser localStorage**, terlihat di network tab saat call ke Google. Ini aman karena:
- Key milik user sendiri, tidak share
- Google API key untuk Gemini dirancang untuk client-side use (mirip Stripe publishable key)
- Tidak ada server kami yang menyimpan/melihat key

Kalau mau lebih ketat, generate key dengan restrictions di Google Cloud Console (HTTP referrer = domain Vercel kamu).

## Disclaimer

Bukan saran finansial. DYOR.
