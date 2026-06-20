import { useState, useEffect, useRef, useCallback, memo } from "react";

// ─────────────────────────────────────────────────────────────
// !! CONFIGURATION — FILL THIS IN BEFORE DEPLOYING !!
// Replace with your Cloudflare Worker URL after setup
// ─────────────────────────────────────────────────────────────
const WORKER_URL = "https://signal-ema-av.r-fella10.workers.dev";

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────

const STOCKS = [
  { symbol: "AAPL",  name: "Apple Inc.",          group: "MAG7" },
  { symbol: "MSFT",  name: "Microsoft Corp.",     group: "MAG7" },
  { symbol: "GOOGL", name: "Alphabet Inc.",       group: "MAG7" },
  { symbol: "AMZN",  name: "Amazon.com Inc.",     group: "MAG7" },
  { symbol: "NVDA",  name: "NVIDIA Corp.",        group: "MAG7" },
  { symbol: "META",  name: "Meta Platforms Inc.", group: "MAG7" },
  { symbol: "TSLA",  name: "Tesla Inc.",          group: "MAG7" },
  { symbol: "SPY",   name: "SPDR S&P 500 ETF",   group: "ETF"  },
  { symbol: "QQQ",   name: "Invesco QQQ ETF",     group: "ETF"  },
];

const TIMEFRAMES = [
  { key: "1d",  label: "Daily" },
  { key: "1h",  label: "1H"   },
  { key: "15m", label: "15M"  },
  { key: "5m",  label: "5M"   },
];

// Alpha Vantage interval strings per timeframe
const AV_INTERVAL = { "1h": "60min", "15m": "15min", "5m": "5min" };

// How often to auto-refresh (5 min = 300s — respects free tier 500 calls/day)
const SCAN_SECS = 300;

// Cache TTL: don't re-fetch the same symbol+timeframe within this window (ms)
const CACHE_TTL = 4 * 60 * 1000; // 4 minutes

const C = {
  bg:     "#07070e",
  card:   "rgba(255,255,255,0.025)",
  border: "rgba(255,255,255,0.06)",
  cyan:   "#06b6d4",
  amber:  "#f59e0b",
  bull:   "#22c55e",
  bear:   "#ef4444",
  text:   "#e2e8f0",
  muted:  "#475569",
  dim:    "#1e293b",
  soft:   "#64748b",
  hdr:    "#0d0d18",
};

// ─────────────────────────────────────────────────────────────
// MATH — unchanged from demo version
// ─────────────────────────────────────────────────────────────

function calcEMA(prices, period) {
  const n = prices.length;
  if (n < period) return new Array(n).fill(null);
  const k = 2 / (period + 1);
  const out = new Array(n).fill(null);
  out[period - 1] = prices.slice(0, period).reduce((a, b) => a + b) / period;
  for (let i = period; i < n; i++) {
    out[i] = prices[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

function calcRSI(prices, period = 14) {
  if (prices.length <= period) return null;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = prices[i] - prices[i - 1];
    ag += Math.max(d, 0);
    al += Math.max(-d, 0);
  }
  ag /= period;
  al /= period;
  for (let i = period + 1; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function analyzeEMAs(e13, e48) {
  const pairs = [];
  for (let i = e13.length - 1; i >= 0 && pairs.length < 2; i--) {
    if (e13[i] !== null && e48[i] !== null) pairs.unshift([e13[i], e48[i]]);
  }
  if (pairs.length < 2) return null;
  const [prev, curr] = pairs;
  const gap = ((curr[0] - curr[1]) / curr[1]) * 100;
  const pA = prev[0] > prev[1];
  const cA = curr[0] > curr[1];
  const crossType = !pA && cA ? "bullish" : pA && !cA ? "bearish" : null;
  return {
    crossType,
    position: cA ? "above" : "below",
    gap,
    gapAbs: Math.abs(gap),
    approaching: Math.abs(gap) < 0.3 && !crossType,
    ema13: curr[0],
    ema48: curr[1],
  };
}

// ─────────────────────────────────────────────────────────────
// LIVE DATA LAYER
// ─────────────────────────────────────────────────────────────

// Parse Alpha Vantage JSON response into arrays of close prices + volumes
function parseAVData(avJson, tfKey) {
  const KEY_MAP = {
    "1d":  "Time Series (Daily)",
    "1h":  "Time Series (60min)",
    "15m": "Time Series (15min)",
    "5m":  "Time Series (5min)",
  };
  const seriesKey = KEY_MAP[tfKey];
  const series = avJson[seriesKey];

  // Alpha Vantage rate-limit / error detection
  if (!series) {
    const note = avJson["Note"] || avJson["Information"] || avJson["Error Message"] || "";
    if (note.toLowerCase().includes("rate") || note.toLowerCase().includes("limit")) {
      throw new Error("RATE_LIMITED");
    }
    if (note) throw new Error("AV_ERROR: " + note.slice(0, 80));
    throw new Error("NO_DATA");
  }

  // AV returns newest-first; reverse to chronological order
  const entries = Object.entries(series).reverse();

  // Keep last 120 bars — enough for EMA48 + RSI14 + display buffer
  const slice = entries.slice(-120);

  const prices  = slice.map(([, bar]) => parseFloat(bar["4. close"]));
  const volumes = slice.map(([, bar]) => parseInt(bar["5. volume"] || "0", 10));

  if (prices.length < 50) throw new Error("INSUFFICIENT_BARS");

  return { prices, volumes };
}

// Fetch one stock through the Cloudflare Worker and return the full data object
async function fetchStock(stock, tfKey) {
  const isDaily  = tfKey === "1d";
  const avFunc   = isDaily ? "TIME_SERIES_DAILY" : "TIME_SERIES_INTRADAY";
  const interval = AV_INTERVAL[tfKey];

  const payload = {
    function:   avFunc,
    symbol:     stock.symbol,
    outputsize: "compact",          // last 100 bars — enough for our math
    ...(interval ? { interval } : {}),
  };

  const res = await fetch(`${WORKER_URL}/av`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const avJson = await res.json();
  const { prices, volumes } = parseAVData(avJson, tfKey);

  // Run the same math as the demo version — nothing changes here
  const e13      = calcEMA(prices, 13);
  const e48      = calcEMA(prices, 48);
  const rsi      = calcRSI(prices);
  const analysis = analyzeEMAs(e13, e48);

  const recentVols = volumes.slice(-20);
  const avgVol     = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;

  return {
    symbol:   stock.symbol,
    price:    prices.at(-1),
    prices:   prices.slice(-80),
    ema13Arr: e13.slice(-80),
    ema48Arr: e48.slice(-80),
    analysis,
    rsi,
    volRatio:  avgVol > 0 ? volumes.at(-1) / avgVol : 1,
    dataSource: "live",             // used by StockCard live indicator
    fetchedAt:  Date.now(),
  };
}

// Fetch all 9 stocks sequentially. Uses in-memory cache to skip fresh entries.
// Falls back to stale cache if a fetch fails. 400ms delay between calls
// keeps us well under Alpha Vantage's 25 req/min limit.
async function fetchAllLive(tfKey, cacheRef, onProgress) {
  const results = {};
  let rateLimited = false;

  for (let i = 0; i < STOCKS.length; i++) {
    const stock    = STOCKS[i];
    const cacheKey = `${stock.symbol}-${tfKey}`;
    const cached   = cacheRef.current.get(cacheKey);

    // Use cache if it is fresh enough
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
      results[stock.symbol] = { ...cached, dataSource: "cached" };
      onProgress(i + 1, STOCKS.length);
      continue;
    }

    try {
      if (rateLimited) {
        // If we hit the rate limit, use stale cache or skip
        if (cached) {
          results[stock.symbol] = { ...cached, dataSource: "cached" };
        }
        onProgress(i + 1, STOCKS.length);
        continue;
      }

      const data = await fetchStock(stock, tfKey);
      cacheRef.current.set(cacheKey, data);
      results[stock.symbol] = data;
    } catch (err) {
      if (err.message === "RATE_LIMITED") {
        rateLimited = true;
      }
      // Fall back to stale cache if it exists
      if (cached) {
        results[stock.symbol] = { ...cached, dataSource: "cached" };
      } else {
        // No cache at all — mark as error so the card shows skeleton
        results[stock.symbol] = null;
      }
    }

    onProgress(i + 1, STOCKS.length);

    // 400ms between calls — safe margin under AV's rate limit
    if (i < STOCKS.length - 1) {
      await new Promise(r => setTimeout(r, 400));
    }
  }

  return { results, rateLimited };
}

// ─────────────────────────────────────────────────────────────
// SPARKLINE — memo prevents re-render unless props change
// ─────────────────────────────────────────────────────────────

const Sparkline = memo(function Sparkline({ prices, e13, e48 }) {
  const W = 134, H = 42;
  if (!prices?.length) return <div style={{ width: W, height: H }} />;

  const n   = Math.min(70, prices.length);
  const p   = prices.slice(-n);
  const a   = e13.slice(-n);
  const b   = e48.slice(-n);
  const all = [...p, ...a.filter(Boolean), ...b.filter(Boolean)];
  const lo  = Math.min(...all);
  const hi  = Math.max(...all);
  const rng = hi - lo || 1;

  const px = (i) => ((i / (n - 1)) * W).toFixed(1);
  const py = (v)  => (H * 0.93 - ((v - lo) / rng) * H * 0.86).toFixed(1);

  const mkPath = (arr) => {
    let d = "", on = false;
    arr.forEach((v, i) => {
      if (v === null) { on = false; return; }
      d += (on ? " L " : " M ") + px(i) + " " + py(v);
      on = true;
    });
    return d;
  };

  const vi = [];
  for (let i = 0; i < n; i++) {
    if (a[i] !== null && b[i] !== null) vi.push(i);
  }
  let shade = "";
  if (vi.length > 1) {
    const fwd = vi.map((i) => `${px(i)},${py(a[i])}`).join(" L ");
    const bck = vi.slice().reverse().map((i) => `${px(i)},${py(b[i])}`).join(" L ");
    shade = `M ${fwd} L ${bck} Z`;
  }

  const lastA    = a.filter(Boolean).at(-1);
  const lastB    = b.filter(Boolean).at(-1);
  const bullZone = lastA > lastB;

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
      {shade && (
        <path d={shade}
          fill={bullZone ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)"} />
      )}
      <path d={mkPath(p)} fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth="1" />
      <path d={mkPath(b)} fill="none" stroke={C.amber} strokeWidth="1.5" opacity="0.72" />
      <path d={mkPath(a)} fill="none" stroke={C.cyan}  strokeWidth="1.5" opacity="0.92" />
    </svg>
  );
});

// ─────────────────────────────────────────────────────────────
// SKELETON CARD
// ─────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div style={{ borderRadius:"10px", padding:"14px", background:C.card, border:`1px solid ${C.border}` }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:"10px" }}>
        <div>
          <div style={{ width:44, height:14, background:"rgba(255,255,255,0.06)",
            borderRadius:4, marginBottom:6, animation:"skelPulse 1.4s ease-in-out infinite" }} />
          <div style={{ width:88, height:9, background:"rgba(255,255,255,0.03)",
            borderRadius:3, animation:"skelPulse 1.4s ease-in-out infinite" }} />
        </div>
        <div style={{ width:55, height:14, background:"rgba(255,255,255,0.04)",
          borderRadius:4, animation:"skelPulse 1.4s ease-in-out infinite" }} />
      </div>
      <div style={{ width:"100%", height:42, background:"rgba(255,255,255,0.03)",
        borderRadius:4, marginBottom:10, animation:"skelPulse 1.4s ease-in-out infinite" }} />
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:5, marginBottom:9 }}>
        {[0,1].map(i=>(
          <div key={i} style={{ height:34, background:"rgba(255,255,255,0.03)",
            borderRadius:4, animation:"skelPulse 1.4s ease-in-out infinite" }} />
        ))}
      </div>
      <div style={{ height:9, background:"rgba(255,255,255,0.02)",
        borderRadius:3, animation:"skelPulse 1.4s ease-in-out infinite" }} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// STOCK CARD — shows live / cached / error indicator dot
// ─────────────────────────────────────────────────────────────

const StockCard = memo(function StockCard({ stock, data }) {
  if (!data) return <SkeletonCard />;

  const ana      = data?.analysis;
  const hasCross = !!ana?.crossType;
  const isAppr   = !!ana?.approaching;

  const statusColor = hasCross
    ? (ana.crossType === "bullish" ? C.bull : C.bear)
    : isAppr ? C.amber
    : ana?.position === "above" ? C.cyan : C.muted;

  const statusLabel = hasCross
    ? (ana.crossType === "bullish" ? "▲ BULLISH CROSS" : "▼ BEARISH CROSS")
    : isAppr ? "◈ APPROACHING"
    : ana?.position === "above" ? "△ ABOVE EMA48" : "▽ BELOW EMA48";

  const rsiColor = !data?.rsi ? C.soft
    : data.rsi >= 70 ? C.bear : data.rsi <= 30 ? C.bull : C.soft;

  const volColor = !data?.volRatio ? C.soft
    : data.volRatio >= 1.5 ? C.bull : data.volRatio <= 0.5 ? C.bear : C.soft;

  // Data source indicator
  const dotColor  = data.dataSource === "live" ? C.bull
    : data.dataSource === "cached" ? C.amber : C.muted;
  const dotTitle  = data.dataSource === "live" ? "Live data"
    : data.dataSource === "cached" ? "Cached data" : "Unavailable";

  return (
    <div style={{
      position: "relative", overflow: "hidden", borderRadius: "10px", padding: "14px",
      background: hasCross
        ? `rgba(${ana.crossType === "bullish" ? "34,197,94" : "239,68,68"},0.06)` : C.card,
      border: `1px solid ${hasCross ? statusColor + "48" : isAppr ? C.amber + "32" : C.border}`,
      boxShadow: hasCross
        ? `0 0 32px rgba(${ana.crossType === "bullish" ? "34,197,94" : "239,68,68"},0.1)` : "none",
      transition: "all 0.45s ease",
    }}>
      {(hasCross || isAppr) && (
        <div style={{
          position:"absolute", top:0, left:0, right:0, height:"2px",
          background:`linear-gradient(90deg,transparent,${statusColor}${hasCross?"":"80"},transparent)`,
        }} />
      )}

      {/* Data source dot — top-left corner */}
      <div title={dotTitle} style={{
        position:"absolute", top:8, right:8,
        width:5, height:5, borderRadius:"50%",
        background: dotColor,
        boxShadow: data.dataSource === "live" ? `0 0 6px ${C.bull}` : "none",
      }} />

      {/* Symbol + price */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:"10px" }}>
        <div>
          <div style={{ fontSize:"14px", fontWeight:700, color:C.text, letterSpacing:"0.05em" }}>
            {stock.symbol}
          </div>
          <div style={{ fontSize:"9px", color:C.dim, marginTop:"2px" }}>{stock.name}</div>
        </div>
        <div style={{ textAlign:"right", paddingRight:"10px" }}>
          <div style={{ fontSize:"13px", fontWeight:600, color:C.text }}>
            ${data.price?.toFixed(2)}
          </div>
          <div style={{ fontSize:"9px", fontWeight:700, color:statusColor, marginTop:"2px", letterSpacing:"0.07em" }}>
            {statusLabel}
          </div>
        </div>
      </div>

      {/* Sparkline */}
      <div style={{ marginBottom:"10px" }}>
        <Sparkline prices={data.prices} e13={data.ema13Arr} e48={data.ema48Arr} />
        <div style={{ display:"flex", gap:"10px", fontSize:"8px", marginTop:"3px" }}>
          <span style={{ color:C.cyan+"60" }}>━ EMA13</span>
          <span style={{ color:C.amber+"60" }}>━ EMA48</span>
        </div>
      </div>

      {/* EMA boxes */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"5px", marginBottom:"9px" }}>
        {[
          ["EMA 13", ana?.ema13, C.cyan,  "rgba(6,182,212,0.07)"],
          ["EMA 48", ana?.ema48, C.amber, "rgba(245,158,11,0.07)"],
        ].map(([label, val, col, bg]) => (
          <div key={label} style={{ background:bg, padding:"4px 8px", borderRadius:"4px" }}>
            <div style={{ fontSize:"8px", color:C.muted }}>{label}</div>
            <div style={{ fontSize:"10px", fontWeight:600, color:col }}>
              {val != null ? `$${val.toFixed(2)}` : "—"}
            </div>
          </div>
        ))}
      </div>

      {/* Stats */}
      <div style={{ display:"flex", justifyContent:"space-between", fontSize:"9px" }}>
        <span>
          <span style={{ color:C.muted }}>GAP </span>
          <span style={{ color:ana?.gap!=null?(ana.gap>0?C.cyan:"#f87171"):C.soft }}>
            {ana?.gap!=null?`${ana.gap>0?"+":""}${ana.gap.toFixed(2)}%`:"—"}
          </span>
        </span>
        <span>
          <span style={{ color:C.muted }}>RSI </span>
          <span style={{ color:rsiColor }}>{data.rsi!=null?data.rsi.toFixed(1):"—"}</span>
        </span>
        <span>
          <span style={{ color:C.muted }}>VOL </span>
          <span style={{ color:volColor }}>
            {data.volRatio!=null?`${data.volRatio.toFixed(1)}x`:"—"}
          </span>
        </span>
      </div>
    </div>
  );
});

// ─────────────────────────────────────────────────────────────
// SENTIMENT BAR
// ─────────────────────────────────────────────────────────────

const SentimentBar = memo(function SentimentBar({ stocks }) {
  const vals  = Object.values(stocks).filter(Boolean);
  const bulls = vals.filter(d => d.analysis?.crossType === "bullish").length;
  const bears = vals.filter(d => d.analysis?.crossType === "bearish").length;
  const apprs = vals.filter(d => d.analysis?.approaching).length;
  const above = vals.filter(d =>
    d.analysis?.position === "above" && !d.analysis?.crossType && !d.analysis?.approaching
  ).length;

  const pct       = ((bulls + above) / STOCKS.length * 100).toFixed(0);
  const sentiment = bulls > bears + 1 ? "RISK ON" : bears > bulls + 1 ? "RISK OFF" : "MIXED";
  const sColor    = sentiment === "RISK ON" ? C.bull : sentiment === "RISK OFF" ? C.bear : C.amber;

  return (
    <div style={{
      marginBottom:"22px", padding:"10px 16px",
      background:"rgba(255,255,255,0.015)", border:`1px solid ${C.border}`,
      borderRadius:"8px", display:"flex", alignItems:"center", gap:"18px", flexWrap:"wrap",
    }}>
      <div style={{ display:"flex", alignItems:"center", gap:"7px" }}>
        <div style={{ width:"6px", height:"6px", borderRadius:"50%",
          background:sColor, boxShadow:`0 0 8px ${sColor}` }} />
        <span style={{ fontSize:"10px", fontWeight:700, color:sColor, letterSpacing:"0.1em" }}>
          {sentiment}
        </span>
      </div>
      <div style={{ flex:1, minWidth:"100px", height:"4px",
        background:"rgba(255,255,255,0.06)", borderRadius:"2px", overflow:"hidden" }}>
        <div style={{
          width:`${pct}%`, height:"100%",
          background:`linear-gradient(90deg,${C.bull},${C.cyan})`,
          borderRadius:"2px", transition:"width 0.9s ease",
        }} />
      </div>
      <div style={{ display:"flex", gap:"14px", fontSize:"9px", flexWrap:"wrap" }}>
        <span><span style={{ color:C.bull,  fontWeight:700 }}>{bulls}</span><span style={{ color:C.muted }}> CROSS↑</span></span>
        <span><span style={{ color:C.bear,  fontWeight:700 }}>{bears}</span><span style={{ color:C.muted }}> CROSS↓</span></span>
        <span><span style={{ color:C.amber, fontWeight:700 }}>{apprs}</span><span style={{ color:C.muted }}> NEAR</span></span>
        <span><span style={{ color:C.soft,  fontWeight:700 }}>{above}</span><span style={{ color:C.muted }}> ABOVE</span></span>
      </div>
    </div>
  );
});

// ─────────────────────────────────────────────────────────────
// TOAST — handles signal alerts + system messages
// ─────────────────────────────────────────────────────────────

function Toast({ items }) {
  return (
    <div style={{
      position:"fixed", bottom:"20px", right:"20px",
      zIndex:9999, display:"flex", flexDirection:"column",
      gap:"8px", pointerEvents:"none", maxWidth:"280px",
    }}>
      {items.map(t => {
        const isSystem = !!t._msg;
        return (
          <div key={t.id} style={{
            padding:"11px 16px", borderRadius:"9px",
            fontFamily:"'IBM Plex Mono','Fira Code',monospace", fontSize:"10px",
            background: isSystem ? "rgba(245,158,11,0.12)"
              : t.type === "bullish" ? "rgba(34,197,94,0.14)" : "rgba(239,68,68,0.14)",
            border:`1px solid ${isSystem ? "rgba(245,158,11,0.4)"
              : t.type === "bullish" ? "rgba(34,197,94,0.48)" : "rgba(239,68,68,0.48)"}`,
            color: isSystem ? C.amber : t.type === "bullish" ? C.bull : C.bear,
            boxShadow:"0 8px 32px rgba(0,0,0,0.55)",
            backdropFilter:"blur(16px)",
            animation:"toastIn 0.28s ease",
          }}>
            {isSystem ? (
              <div style={{ fontWeight:600, letterSpacing:"0.04em", lineHeight:1.5 }}>
                ⚠️ {t._msg}
              </div>
            ) : (
              <>
                <div style={{ fontWeight:700, letterSpacing:"0.06em", marginBottom:"3px" }}>
                  {t.type === "bullish" ? "▲" : "▼"} {t.symbol} · {t.type.toUpperCase()} CROSS
                </div>
                <div style={{ opacity:0.75, fontSize:"9px" }}>
                  ${t.price?.toFixed(2)} &nbsp;·&nbsp; RSI {t.rsi?.toFixed(1)} &nbsp;·&nbsp;
                  Vol {t.volRatio?.toFixed(1)}x &nbsp;·&nbsp; {t.tf}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// STATUS BANNER — replaces the old disclaimer for live mode
// ─────────────────────────────────────────────────────────────

function StatusBanner({ apiStatus, onDismiss, show }) {
  if (!show) return null;
  const isError      = apiStatus === "rate_limited" || apiStatus === "error";
  const accentColor  = isError ? C.amber : C.bull;
  const msg = apiStatus === "rate_limited"
    ? "Alpha Vantage rate limit reached. Showing cached data. Resets in ~1 minute."
    : apiStatus === "error"
    ? "Unable to reach data source. Displaying last cached prices. Check your Worker URL."
    : null;

  if (msg) return (
    <div style={{
      padding:"9px 16px", marginBottom:"16px",
      background:`${accentColor}08`, border:`1px solid ${accentColor}30`,
      borderRadius:"6px", fontSize:"9px", color:accentColor,
      letterSpacing:"0.04em", lineHeight:1.8,
      display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:"12px",
    }}>
      <span>⚠ {msg}</span>
      <button onClick={onDismiss} style={{
        background:"none", border:"none", cursor:"pointer",
        color:C.muted, fontSize:"12px", padding:"0 2px", lineHeight:1, flexShrink:0,
      }}>✕</button>
    </div>
  );

  return (
    <div style={{
      padding:"8px 16px", marginBottom:"14px",
      background:"rgba(34,197,94,0.04)", border:"1px solid rgba(34,197,94,0.15)",
      borderRadius:"6px", fontSize:"9px", color:C.soft,
      letterSpacing:"0.04em", lineHeight:1.8,
      display:"flex", justifyContent:"space-between", alignItems:"center", gap:"12px",
    }}>
      <span>
        <span style={{ color:C.bull, fontWeight:700 }}>● LIVE DATA</span>
        {" "}— Real market prices via Alpha Vantage (15-min delay on free tier).
        Not financial advice. Do not make investment decisions from this tool.
      </span>
      <button onClick={onDismiss} style={{
        background:"none", border:"none", cursor:"pointer",
        color:C.muted, fontSize:"12px", padding:"0 2px", lineHeight:1, flexShrink:0,
      }}>✕</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// LOGO + DIVIDER
// ─────────────────────────────────────────────────────────────

function LogoMark({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display:"block", flexShrink:0 }}>
      <defs>
        <filter id="logoGlow">
          <feGaussianBlur stdDeviation="1.2" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <path d="M2 17 Q7 15 11 12 Q16 9 22 7"
        fill="none" stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round" opacity="0.85" />
      <path d="M2 15 Q6 13 10 12 Q15 11 22 9"
        fill="none" stroke="#06b6d4" strokeWidth="1.8"
        strokeLinecap="round" filter="url(#logoGlow)" />
      <circle cx="11.5" cy="12" r="2.1" fill="#06b6d4" filter="url(#logoGlow)" />
    </svg>
  );
}

function Divider({ label }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:"10px", marginBottom:"10px" }}>
      <div style={{ fontSize:"9px", letterSpacing:"0.22em", color:C.dim, fontWeight:600, whiteSpace:"nowrap" }}>
        {label}
      </div>
      <div style={{ flex:1, height:"1px", background:"rgba(255,255,255,0.04)" }} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────

export default function SignalEMA() {
  const [tf,            setTf]           = useState(TIMEFRAMES[0]);
  const [stocks,        setStocks]       = useState({});
  const [signals,       setSignals]      = useState([]);          // empty — no fake seeds
  const [toasts,        setToasts]       = useState([]);
  const [scanning,      setScanning]     = useState(false);
  const [countdown,     setCountdown]    = useState(SCAN_SECS);
  const [notifOn,       setNotifOn]      = useState(false);
  const [notifDenied,   setNotifDenied]  = useState(false);
  const [scanCount,     setScanCount]    = useState(0);
  const [lastScan,      setLastScan]     = useState(null);
  const [showBanner,    setShowBanner]   = useState(true);
  const [apiStatus,     setApiStatus]    = useState("ok");        // "ok"|"rate_limited"|"error"
  const [fetchProgress, setFetchProgress]= useState({ done:0, total:STOCKS.length });

  // Refs — mirror state so interval callbacks always see current values
  const signalsRef  = useRef([]);
  const tfRef       = useRef(tf);
  const notifRef    = useRef(false);
  const scanningRef = useRef(false);
  const cacheRef    = useRef(new Map());    // in-memory data cache
  const prevStocksRef = useRef({});        // previous scan results for cross detection

  signalsRef.current  = signals;
  tfRef.current       = tf;
  notifRef.current    = notifOn;
  scanningRef.current = scanning;

  // ── Core async scan ───────────────────────────────────────
  const runScan = useCallback(async (timeframe, emitSignals = true) => {
    if (scanningRef.current) return;           // prevent overlapping scans
    setScanning(true);
    setFetchProgress({ done: 0, total: STOCKS.length });

    const onProgress = (done, total) => setFetchProgress({ done, total });

    const { results: data, rateLimited } = await fetchAllLive(
      timeframe.key, cacheRef, onProgress
    );

    setApiStatus(rateLimited ? "rate_limited" : "ok");

    // Cross detection — compare against previous scan results
    const fresh = [];
    if (emitSignals && Object.keys(prevStocksRef.current).length > 0) {
      STOCKS.forEach(s => {
        const prev = prevStocksRef.current[s.symbol];
        const curr = data[s.symbol];
        if (!prev?.analysis || !curr?.analysis) return;

        const hadCross = !!prev.analysis.crossType;
        const hasCross = !!curr.analysis.crossType;
        const isNewCross = hasCross && !hadCross;
        if (!isNewCross) return;

        const type = curr.analysis.crossType;

        // Duplicate guard: same symbol + type within 5 minutes
        const dup = signalsRef.current.find(
          x => x.symbol === s.symbol && x.type === type && Date.now() - x.time < 300_000
        );
        if (dup) return;

        const sig = {
          id:       `${s.symbol}-${type}-${Date.now()}`,
          symbol:   s.symbol,
          type,
          price:    curr.price,
          ema13:    curr.analysis.ema13,
          ema48:    curr.analysis.ema48,
          gap:      curr.analysis.gap,
          rsi:      curr.rsi,
          volRatio: curr.volRatio,
          time:     Date.now(),
          tf:       timeframe.label,
        };
        fresh.push(sig);

        // Toast
        const toastId = sig.id;
        setToasts(prev => [...prev, { ...sig }].slice(-3));
        setTimeout(() => setToasts(prev => prev.filter(t => t.id !== toastId)), 4800);

        // Browser notification
        if (notifRef.current && typeof Notification !== "undefined"
            && Notification.permission === "granted") {
          new Notification(
            `${type === "bullish" ? "🟢" : "🔴"} ${s.symbol} · ${timeframe.label}`,
            { body: `${type.toUpperCase()} Cross  |  $${curr.price?.toFixed(2)}  |  RSI ${curr.rsi?.toFixed(1) ?? "N/A"}` }
          );
        }
      });
    }

    prevStocksRef.current = data;
    setStocks(data);
    if (fresh.length) setSignals(prev => [...fresh, ...prev].slice(0, 60));
    setLastScan(new Date());
    setScanCount(c => c + 1);
    setScanning(false);
    setCountdown(SCAN_SECS);
  }, []);

  // Initial load on mount
  useEffect(() => { runScan(TIMEFRAMES[0], false); }, []);

  // Timeframe switch — invalidate and refetch immediately
  const prevTfKey = useRef(tf.key);
  useEffect(() => {
    if (tf.key === prevTfKey.current) return;
    prevTfKey.current = tf.key;
    prevStocksRef.current = {};              // reset cross detection on TF change
    runScan(tf, false);
    setCountdown(SCAN_SECS);
  }, [tf.key, runScan]);

  // Auto-scan countdown — pauses while a scan is in flight
  useEffect(() => {
    const timer = setInterval(() => {
      if (scanningRef.current) return;       // pause during active scan
      setCountdown(c => {
        if (c <= 1) {
          runScan(tfRef.current, true);
          return SCAN_SECS;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [runScan]);

  // Notifications
  const enableNotifications = async () => {
    if (typeof Notification === "undefined") {
      const id = "notif-unsupported";
      setToasts(prev => [...prev, { id, _msg:"Notifications not supported in this browser." }].slice(-3));
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === "denied") {
      setNotifDenied(true);
      const id = "notif-denied-" + Date.now();
      setToasts(prev => [...prev, {
        id, _msg: "Notifications blocked. Go to browser Settings → Site Settings to enable."
      }].slice(-3));
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 6000);
    }
    setNotifOn(permission === "granted");
  };

  // Derived values
  const activeCrosses  = Object.values(stocks).filter(d => d?.analysis?.crossType).length;
  const approaching    = Object.values(stocks).filter(d => d?.analysis?.approaching).length;
  const scanProgress   = ((SCAN_SECS - countdown) / SCAN_SECS * 100).toFixed(1);
  const liveCount      = Object.values(stocks).filter(d => d?.dataSource === "live").length;
  const fetchingLabel  = scanning
    ? `FETCHING ${fetchProgress.done}/${fetchProgress.total}`
    : null;

  // Format countdown as MM:SS for 5-minute interval
  const countdownFmt = countdown >= 60
    ? `${Math.floor(countdown/60)}:${String(countdown%60).padStart(2,"0")}`
    : `${countdown}s`;

  return (
    <div style={{
      minHeight:"100vh", background:C.bg,
      fontFamily:"'IBM Plex Mono','Fira Code','Courier New',monospace",
      color:C.text, padding:"18px 22px",
    }}>
      <style>{`
        @keyframes toastIn   { from { opacity:0; transform:translateX(18px) } to { opacity:1; transform:translateX(0) } }
        @keyframes scanBlink { 0%,100% { opacity:0.35 } 50% { opacity:1 } }
        @keyframes skelPulse { 0%,100% { opacity:0.4  } 50% { opacity:0.7 } }
        @keyframes livePulse { 0%,100% { opacity:0.7  } 50% { opacity:1  } }
      `}</style>

      {/* Ambient orbs */}
      <div style={{ position:"fixed", inset:0, pointerEvents:"none", zIndex:0, overflow:"hidden" }}>
        <div style={{ position:"absolute", top:"-12%", left:"-4%", width:"520px", height:"520px",
          background:"radial-gradient(circle,rgba(6,182,212,0.08) 0%,transparent 62%)", filter:"blur(35px)" }} />
        <div style={{ position:"absolute", bottom:"-8%", right:"-6%", width:"580px", height:"580px",
          background:"radial-gradient(circle,rgba(139,92,246,0.055) 0%,transparent 60%)", filter:"blur(35px)" }} />
      </div>

      <Toast items={toasts} />

      <div style={{ position:"relative", zIndex:1, maxWidth:"1180px", margin:"0 auto" }}>

        {/* ── HEADER ─────────────────────────────────────────── */}
        <div style={{ marginBottom:"18px", paddingBottom:"16px", borderBottom:"1px solid rgba(6,182,212,0.12)" }}>
          <div style={{
            display:"flex", justifyContent:"space-between", alignItems:"flex-start",
            flexWrap:"wrap", gap:"12px", marginBottom:"12px",
          }}>

            {/* Brand + live badge */}
            <div>
              <div style={{ display:"flex", alignItems:"center", gap:"10px", marginBottom:"5px" }}>
                <LogoMark size={26} />
                <span style={{ fontSize:"22px", fontWeight:800, color:C.cyan, letterSpacing:"0.12em" }}>
                  Signal<span style={{ color:C.text }}>EMA</span>
                </span>

                {/* Live data badge */}
                {!scanning && liveCount > 0 && (
                  <span style={{
                    display:"flex", alignItems:"center", gap:"5px",
                    fontSize:"9px", color:C.bull, letterSpacing:"0.08em",
                    background:"rgba(34,197,94,0.08)",
                    border:"1px solid rgba(34,197,94,0.25)",
                    borderRadius:"20px", padding:"2px 8px",
                  }}>
                    <span style={{ width:"5px", height:"5px", borderRadius:"50%",
                      background:C.bull, display:"inline-block",
                      animation:"livePulse 1.8s ease-in-out infinite" }} />
                    LIVE
                  </span>
                )}

                {/* Fetch progress */}
                {scanning && (
                  <span style={{
                    display:"flex", alignItems:"center", gap:"5px",
                    fontSize:"9px", color:C.cyan, animation:"scanBlink 1s infinite",
                  }}>
                    <span style={{ width:"5px", height:"5px", borderRadius:"50%",
                      background:C.cyan, display:"inline-block" }} />
                    {fetchingLabel || "SCANNING"}
                  </span>
                )}
              </div>
              <div style={{ fontSize:"10px", color:C.muted, letterSpacing:"0.06em",
                borderLeft:`2px solid ${C.cyan}45`, paddingLeft:"10px", fontStyle:"italic" }}>
                Real market data · EMA 13/48 crossover scanner
              </div>
            </div>

            {/* Controls */}
            <div style={{ display:"flex", gap:"6px", flexWrap:"wrap", alignItems:"center" }}>
              {/* Timeframe tabs */}
              <div style={{ display:"flex", gap:"2px", background:"rgba(255,255,255,0.025)",
                padding:"3px", borderRadius:"7px", border:`1px solid ${C.border}` }}>
                {TIMEFRAMES.map(t => (
                  <button key={t.key} onClick={() => setTf(t)} style={{
                    padding:"5px 11px", fontSize:"10px", cursor:"pointer",
                    border:"none", borderRadius:"5px", fontFamily:"inherit",
                    fontWeight: tf.key === t.key ? 700 : 400,
                    background: tf.key === t.key ? "rgba(6,182,212,0.18)" : "transparent",
                    color:      tf.key === t.key ? C.cyan : C.soft,
                    transition: "all 0.15s",
                  }}>{t.label}</button>
                ))}
              </div>

              {/* Manual refresh */}
              <button
                onClick={() => !scanning && runScan(tf, true)}
                disabled={scanning}
                style={{
                  padding:"6px 13px", fontSize:"10px",
                  cursor: scanning ? "default" : "pointer",
                  border:`1px solid ${C.cyan}35`, fontFamily:"inherit",
                  background: scanning ? `${C.cyan}08` : `${C.cyan}12`,
                  color:C.cyan, borderRadius:"6px", fontWeight:600,
                  opacity: scanning ? 0.6 : 1,
                }}>
                {scanning ? "⟳ FETCHING…" : `⟳ ${countdownFmt}`}
              </button>

              {/* Notifications */}
              <button
                onClick={notifOn ? () => setNotifOn(false) : enableNotifications}
                title={notifDenied && !notifOn ? "Blocked — change in browser settings" : ""}
                style={{
                  padding:"6px 13px", fontSize:"10px", cursor:"pointer",
                  border:`1px solid ${notifOn ? C.bull+"45"
                    : notifDenied ? "rgba(239,68,68,0.35)" : "rgba(255,255,255,0.08)"}`,
                  background: notifOn ? "rgba(34,197,94,0.1)"
                    : notifDenied ? "rgba(239,68,68,0.06)" : "rgba(255,255,255,0.02)",
                  color: notifOn ? C.bull : notifDenied ? C.bear : C.soft,
                  borderRadius:"6px", fontFamily:"inherit", fontWeight: notifOn ? 700 : 400,
                }}>
                {notifOn ? "🔔 ON" : notifDenied ? "🚫 BLOCKED" : "🔕 OFF"}
              </button>
            </div>
          </div>

          {/* Stats + progress strip */}
          <div style={{ display:"flex", gap:"6px", flexWrap:"wrap", alignItems:"center" }}>
            {activeCrosses > 0 && (
              <div style={{ padding:"3px 10px", background:"rgba(34,197,94,0.1)",
                border:"1px solid rgba(34,197,94,0.3)", borderRadius:"20px",
                fontSize:"9px", color:C.bull, fontWeight:700 }}>
                {activeCrosses} CROSS{activeCrosses > 1 ? "ES" : ""} LIVE
              </div>
            )}
            {approaching > 0 && (
              <div style={{ padding:"3px 10px", background:"rgba(245,158,11,0.08)",
                border:"1px solid rgba(245,158,11,0.28)", borderRadius:"20px",
                fontSize:"9px", color:C.amber, fontWeight:700 }}>
                {approaching} APPROACHING
              </div>
            )}
            <div style={{ padding:"3px 10px", background:"rgba(255,255,255,0.03)",
              border:`1px solid ${C.border}`, borderRadius:"20px", fontSize:"9px", color:C.soft }}>
              {signals.length} signal{signals.length !== 1 ? "s" : ""} this session
            </div>
            {lastScan && (
              <div style={{ padding:"3px 10px", background:"rgba(255,255,255,0.03)",
                border:`1px solid ${C.border}`, borderRadius:"20px", fontSize:"9px", color:C.soft }}>
                Scan #{scanCount} · {lastScan.toLocaleTimeString()}
              </div>
            )}

            {/* Scan progress bar */}
            <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:"7px" }}>
              <div style={{ fontSize:"8px", color:C.dim }}>NEXT REFRESH</div>
              <div style={{ width:"72px", height:"3px", background:"rgba(255,255,255,0.06)",
                borderRadius:"2px", overflow:"hidden" }}>
                <div style={{
                  width: scanning ? "100%" : `${scanProgress}%`,
                  height:"100%",
                  background: scanning
                    ? `linear-gradient(90deg,${C.cyan}60,${C.cyan})`
                    : `linear-gradient(90deg,${C.cyan}80,${C.cyan})`,
                  borderRadius:"2px",
                  transition: scanning ? "none" : "width 1s linear",
                }} />
              </div>
              <div style={{ fontSize:"8px", color:C.dim, minWidth:"28px" }}>
                {scanning ? "…" : countdownFmt}
              </div>
            </div>
          </div>
        </div>

        {/* ── STATUS / DISCLAIMER BANNER ──────────────────── */}
        <StatusBanner
          apiStatus={apiStatus}
          onDismiss={() => setShowBanner(false)}
          show={showBanner}
        />

        {/* ── SENTIMENT BAR ──────────────────────────────── */}
        {Object.keys(stocks).length > 0 && <SentimentBar stocks={stocks} />}

        {/* ── MAGNIFICENT 7 ──────────────────────────────── */}
        <div style={{ marginBottom:"26px" }}>
          <Divider label="MAGNIFICENT 7" />
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(268px,1fr))", gap:"10px" }}>
            {STOCKS.filter(s => s.group === "MAG7").map(s => (
              <StockCard key={s.symbol} stock={s} data={stocks[s.symbol]} />
            ))}
          </div>
        </div>

        {/* ── MARKET ETFS ────────────────────────────────── */}
        <div style={{ marginBottom:"26px" }}>
          <Divider label="MARKET ETFS" />
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(268px,1fr))", gap:"10px" }}>
            {STOCKS.filter(s => s.group === "ETF").map(s => (
              <StockCard key={s.symbol} stock={s} data={stocks[s.symbol]} />
            ))}
          </div>
        </div>

        {/* ── SIGNAL LOG ─────────────────────────────────── */}
        <div style={{ marginBottom:"20px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:"8px", marginBottom:"10px" }}>
            <div style={{ fontSize:"9px", letterSpacing:"0.22em", color:C.dim, fontWeight:600 }}>
              SIGNAL LOG <span style={{ color:C.cyan }}>({signals.length})</span>
            </div>
            <div style={{ flex:1, height:"1px", background:"rgba(255,255,255,0.04)" }} />
            <button onClick={() => setSignals([])}
              style={{ padding:"2px 9px", fontSize:"8px", cursor:"pointer",
                border:`1px solid ${C.border}`, background:"transparent",
                color:C.muted, borderRadius:"3px", fontFamily:"inherit" }}>
              CLEAR
            </button>
          </div>

          {signals.length === 0 ? (
            <div style={{
              background:"rgba(255,255,255,0.012)", border:`1px solid ${C.border}`,
              borderRadius:"8px", padding:"28px 16px", textAlign:"center",
              fontSize:"10px", color:C.muted,
            }}>
              Waiting for first EMA cross to be detected…
              <div style={{ fontSize:"9px", color:C.dim, marginTop:"6px" }}>
                Crosses are logged here with full EMA, RSI and volume data.
              </div>
            </div>
          ) : (
            <div style={{ background:"rgba(255,255,255,0.012)", border:`1px solid ${C.border}`,
              borderRadius:"8px", overflow:"hidden" }}>
              <div style={{ overflowX:"auto", maxHeight:"230px", overflowY:"auto" }}>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:"9px", minWidth:"700px" }}>
                  <thead>
                    <tr style={{ borderBottom:`1px solid ${C.border}`, position:"sticky", top:0, background:C.hdr }}>
                      {["TIME","SYMBOL","SIGNAL","PRICE","EMA 13","EMA 48","GAP %","RSI","VOL","TF"].map(h => (
                        <th key={h} style={{ padding:"8px 12px", textAlign:"left",
                          color:C.dim, fontWeight:600, letterSpacing:"0.1em", fontSize:"8px" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {signals.map(sig => (
                      <tr key={sig.id} style={{ borderBottom:"1px solid rgba(255,255,255,0.03)" }}>
                        <td style={{ padding:"8px 12px", color:C.muted }}>{new Date(sig.time).toLocaleTimeString()}</td>
                        <td style={{ padding:"8px 12px", color:C.text, fontWeight:700 }}>{sig.symbol}</td>
                        <td style={{ padding:"8px 12px", color: sig.type==="bullish"?C.bull:C.bear, fontWeight:700 }}>
                          {sig.type==="bullish"?"▲ BULLISH":"▼ BEARISH"}
                        </td>
                        <td style={{ padding:"8px 12px", color:"#94a3b8" }}>${sig.price?.toFixed(2)}</td>
                        <td style={{ padding:"8px 12px", color:C.cyan }}>{sig.ema13?`$${sig.ema13.toFixed(2)}`:"—"}</td>
                        <td style={{ padding:"8px 12px", color:C.amber }}>{sig.ema48?`$${sig.ema48.toFixed(2)}`:"—"}</td>
                        <td style={{ padding:"8px 12px", color:sig.gap>0?C.bull:C.bear }}>
                          {sig.gap!=null?`${sig.gap>0?"+":""}${sig.gap.toFixed(2)}%`:"—"}
                        </td>
                        <td style={{ padding:"8px 12px", color:sig.rsi>=70?C.bear:sig.rsi<=30?C.bull:C.soft }}>
                          {sig.rsi?.toFixed(1)??"—"}
                        </td>
                        <td style={{ padding:"8px 12px", color:sig.volRatio>=1.5?C.bull:C.soft }}>
                          {sig.volRatio?.toFixed(1)??"—"}x
                        </td>
                        <td style={{ padding:"8px 12px", color:C.dim }}>{sig.tf}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* ── LEGEND ─────────────────────────────────────── */}
        <div style={{ padding:"12px 16px", background:"rgba(6,182,212,0.02)",
          border:"1px solid rgba(6,182,212,0.07)", borderRadius:"6px",
          display:"flex", gap:"16px", flexWrap:"wrap",
          fontSize:"8px", color:C.dim, letterSpacing:"0.03em", alignItems:"center" }}>
          <span><span style={{ color:C.cyan }}>━ EMA13</span> fast</span>
          <span><span style={{ color:C.amber }}>━ EMA48</span> slow</span>
          <span><span style={{ color:C.bull }}>▲ BULLISH</span> 13 crosses above 48</span>
          <span><span style={{ color:C.bear }}>▼ BEARISH</span> 13 crosses below 48</span>
          <span><span style={{ color:C.amber }}>◈ APPROACHING</span> gap &lt;0.3%</span>
          <span>RSI <span style={{ color:C.bear }}>≥70</span> overbought · <span style={{ color:C.bull }}>≤30</span> oversold</span>
          <span>VOL <span style={{ color:C.bull }}>≥1.5x</span> avg</span>
          <span style={{ marginLeft:"auto" }}>
            <span style={{ color:C.bull }}>●</span> Live &nbsp;
            <span style={{ color:C.amber }}>●</span> Cached &nbsp;
            <span style={{ color:C.muted }}>●</span> Unavail
          </span>
        </div>

      </div>
    </div>
  );
}
