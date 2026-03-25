const { useState, useEffect, useRef, useCallback } = React;

// ─────────────────────────────────────────────────────────────────────────────
// Constants & helpers
// ─────────────────────────────────────────────────────────────────────────────
const STORAGE_KEY = "budget_app_v4";
const CURRENCIES = ["RON", "EUR", "USD"];
const CUR_SYM = { RON: "lei", EUR: "€", USD: "$" };
const CUR_COLOR = { RON: "#e94560", EUR: "#0fbcf9", USD: "#f5a623" };
const DEFAULT_RATES = { RON: 1, EUR: 5.09, USD: 4.41 };

// Fetch live rates — uses fawazahmed0/exchange-api on jsDelivr CDN
// Completely free, no API key, no rate limits, CORS enabled via CDN
async function fetchLiveRates() {
  const today = new Date().toISOString().slice(0, 10);
  // Try today's date first, fall back to latest
  const urls = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${today}/v1/currencies/eur.json`,
    "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/eur.json",
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const json = await res.json();
      // json.eur = { ron: 5.09, usd: 1.08, ... }
      const eurRON = json.eur?.ron;
      const eurUSD = json.eur?.usd;
      if (eurRON && eurUSD) {
        return {
          EUR: eurRON,
          USD: eurRON / eurUSD,
          date: json.date || today,
        };
      }
    } catch {}
  }
  return null;
}

const CATEGORIES = {
  needs:   ["Rent/Mortgage","Utilities","Groceries","Transport","Insurance","Healthcare"],
  wants:   ["Dining Out","Entertainment","Shopping","Subscriptions","Travel","Hobbies"],
  savings: ["Emergency Fund","Investments","Retirement","Debt Repayment","Goals"],
};
const CAT_COLOR = { needs: "#e94560", wants: "#f5a623", savings: "#0fbcf9" };

const defaultData = {
  name: "",
  monthlyIncome: "", incomeCurrency: "RON",
  monthlyIncomeRON: "",
  recurringExpenses: [],
  dailyExpenses: [],
  currentMonth: "",
  payday: null,
  onboardingDone: false,
  history: [],  // [{period, income, currency, needs, wants, savings, total}]
  rates: { EUR: 5.09, USD: 4.41 },
};

function loadData() {
  try { const r = localStorage.getItem(STORAGE_KEY); if (r) return { ...defaultData, ...JSON.parse(r) }; } catch {}
  return defaultData;
}
function saveData(d) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(d)); } catch {} }

function classify(name = "") {
  const n = name.toLowerCase();
  if (/(rent|mortgage|electric|gas|water|internet|grocer|supermarket|bus|metro|uber|taxi|insurance|doctor|hospital|medicine|fuel|petrol|chirie|curent|gaze|apa|mancare|transport)/.test(n)) return "needs";
  if (/(restaurant|cafe|coffee|pizza|netflix|spotify|amazon|cinema|movie|game|gym|bar|pub|shop|mall|cloth|travel|holiday)/.test(n)) return "wants";
  if (/(saving|invest|stock|fund|retirement|pension|loan|debt|credit|economii)/.test(n)) return "savings";
  return "wants";
}

function toRON(amount, cur, rates) {
  if (cur === "RON") return amount;
  return amount * (rates[cur] || DEFAULT_RATES[cur] || 1);
}
function fromRON(amount, cur, rates) {
  if (cur === "RON") return amount;
  return amount / (rates[cur] || DEFAULT_RATES[cur] || 1);
}
function convert(amount, from, to, rates) {
  return fromRON(toRON(amount, from, rates), to, rates);
}
function fmt(amount, cur) {
  const n = Math.abs(amount).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cur === "RON" ? `${n} lei` : `${CUR_SYM[cur]}${n}`;
}
function rgb(hex) {
  const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return r ? `${parseInt(r[1],16)},${parseInt(r[2],16)},${parseInt(r[3],16)}` : "255,255,255";
}

// ─────────────────────────────────────────────────────────────────────────────
// AI scanner
// ─────────────────────────────────────────────────────────────────────────────
async function toJpeg(file) {
  const url = URL.createObjectURL(file);
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1600; let { width: w, height: h } = img;
      if (w > MAX || h > MAX) { const s = MAX / Math.max(w, h); w = Math.round(w*s); h = Math.round(h*s); }
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      const ctx = c.getContext("2d"); ctx.fillStyle="#fff"; ctx.fillRect(0,0,w,h); ctx.drawImage(img,0,0,w,h);
      URL.revokeObjectURL(url); res(c.toDataURL("image/jpeg",0.92).split(",")[1]);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("load failed")); };
    img.src = url;
  });
}

async function scanReceipt(file) {
  const b64 = await toJpeg(file);
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type":"application/json", "anthropic-version":"2023-06-01", "anthropic-dangerous-direct-browser-access":"true" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514", max_tokens: 800,
      messages: [{ role: "user", content: [
        { type:"image", source:{ type:"base64", media_type:"image/jpeg", data: b64 } },
        { type:"text", text:`Receipt (possibly Romanian: RON/lei, bon fiscal, TVA, total de plata).
Return ONLY JSON, no markdown:
{"name":"merchant","amount":42.50,"currency":"RON","category":"Groceries","date":"YYYY-MM-DD","items":["item"]}
- amount = total paid; currency = RON/EUR/USD; if unreadable: {"error":"unreadable"}` }
      ]}]
    })
  });
  const raw = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${raw.slice(0,120)}`);
  const d = JSON.parse(raw);
  if (d.error) throw new Error(`${d.error.type}: ${d.error.message}`);
  const txt = d.content?.[0]?.text || "";
  if (!txt) throw new Error("Empty response");
  try { return JSON.parse(txt.replace(/```json|```/g,"").trim()); }
  catch { const m = txt.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); return { error: txt.slice(0,100) }; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Static styles (outside component = never recreated)
// ─────────────────────────────────────────────────────────────────────────────
const S = {
  app:      { fontFamily:"'DM Sans','Segoe UI',sans-serif", background:"#0a0a0f", color:"#f0f0f5", minHeight:"100vh", maxWidth:420, margin:"0 auto", position:"relative", paddingBottom:80, overflowX:"hidden" },
  header:   { padding:"52px 24px 20px", background:"linear-gradient(160deg,#13131f 0%,#0a0a0f 100%)" },
  card:     { background:"rgba(255,255,255,0.04)", borderRadius:20, padding:20, border:"1px solid rgba(255,255,255,0.07)" },
  input:    { width:"100%", background:"rgba(255,255,255,0.06)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:12, padding:"12px 14px", color:"#f0f0f5", fontSize:15, outline:"none", boxSizing:"border-box", fontFamily:"inherit" },
  btn:      (color="#e94560", full=false) => ({ background:color, color:"#fff", border:"none", borderRadius:14, padding:"14px 24px", fontSize:15, fontWeight:700, cursor:"pointer", width:full?"100%":"auto", fontFamily:"inherit" }),
  ghost:    { background:"rgba(255,255,255,0.06)", color:"rgba(255,255,255,0.6)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:14, padding:"14px 16px", fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:"inherit" },
  navBar:   { position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)", width:"100%", maxWidth:420, background:"rgba(10,10,15,0.95)", backdropFilter:"blur(20px)", borderTop:"1px solid rgba(255,255,255,0.07)", display:"flex", justifyContent:"space-around", padding:"10px 0 16px", zIndex:100 },
  navBtn:   (a) => ({ display:"flex", flexDirection:"column", alignItems:"center", gap:4, background:"none", border:"none", color:a?"#e94560":"rgba(255,255,255,0.35)", cursor:"pointer", fontSize:10, fontWeight:600, letterSpacing:"0.5px", textTransform:"uppercase" }),
  overlay:  { position:"fixed", inset:0, background:"rgba(0,0,0,0.75)", zIndex:200, display:"flex", alignItems:"flex-end", backdropFilter:"blur(4px)" },
  sheet:    { background:"#13131f", borderRadius:"24px 24px 0 0", padding:"28px 24px 40px", width:"100%", maxWidth:420, margin:"0 auto", border:"1px solid rgba(255,255,255,0.08)", maxHeight:"90vh", overflowY:"auto" },
  label:    { fontSize:12, fontWeight:600, color:"rgba(255,255,255,0.4)", letterSpacing:"0.8px", textTransform:"uppercase", marginBottom:6, display:"block" },
  pill:     (a, color="#e94560") => ({ padding:"6px 14px", borderRadius:50, fontSize:13, fontWeight:600, background:a?color:"rgba(255,255,255,0.06)", color:a?"#fff":"rgba(255,255,255,0.5)", border:"none", cursor:"pointer", fontFamily:"inherit" }),
};

// ─────────────────────────────────────────────────────────────────────────────
// Tiny components (all outside BudgetApp)
// ─────────────────────────────────────────────────────────────────────────────
const Icon = ({ d, size=18, stroke="currentColor" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d={d}/></svg>
);
const IC = {
  home:    "M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M9 22V12h6v10",
  plus:    "M12 5v14 M5 12h14",
  camera:  "M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  trash:   "M3 6h18 M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2",
  edit:    "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z",
  receipt: "M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z M9 7h6 M9 11h6 M9 15h4",
  x:       "M18 6L6 18 M6 6l12 12",
  wallet:  "M21 12V7H5a2 2 0 0 1 0-4h14v4 M3 5v14a2 2 0 0 0 2 2h16v-5 M18 12a1 1 0 0 0 0 2 1 1 0 0 0 0-2z",
  repeat:  "M17 1l4 4-4 4 M3 11V9a4 4 0 0 1 4-4h14 M7 23l-4-4 4-4 M21 13v2a4 4 0 0 1-4 4H3",
  sparkle: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z",
  cog:     "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
  history: "M12 8v4l3 3 M3.05 11a9 9 0 1 0 .5-3 M3 4v4h4",
};

function CircleProgress({ pct, color, size=64, stroke=5 }) {
  const r = (size-stroke)/2, circ = 2*Math.PI*r, dash = Math.min(pct/100,1)*circ;
  return (
    <svg width={size} height={size} style={{ transform:"rotate(-90deg)" }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={stroke}/>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={stroke}
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
        style={{ transition:"stroke-dasharray 0.6s cubic-bezier(0.34,1.56,0.64,1)" }}/>
    </svg>
  );
}

function CurPill({ label, active, color, onClick }) {
  return (
    <button onClick={onClick} style={{ padding:"5px 11px", borderRadius:50, fontSize:12, fontWeight:700, background:active?color:"rgba(255,255,255,0.06)", color:active?"#fff":"rgba(255,255,255,0.4)", border:`1px solid ${active?color:"rgba(255,255,255,0.08)"}`, cursor:"pointer" }}>
      {label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RatesModal — outside BudgetApp
// ─────────────────────────────────────────────────────────────────────────────
function RatesModal({ show, onClose, rates, liveRates, ratesLoading, onSave, onResetToLive }) {
  const [edit, setEdit] = useState({ EUR: "", USD: "", EUR_USD: "", USD_EUR: "" });
  if (!show) return null;

  const eurRON = rates.EUR || DEFAULT_RATES.EUR;
  const usdRON = rates.USD || DEFAULT_RATES.USD;
  const eurUSD = eurRON / usdRON;
  const usdEUR = usdRON / eurRON;

  return (
    <div style={{ ...S.overlay, zIndex:300 }} onClick={e => { if (e.target===e.currentTarget) onClose(); }}>
      <div style={S.sheet}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
          <h3 style={{ fontWeight:800, fontSize:18 }}>Exchange Rates</h3>
          <button style={{ background:"none", border:"none", color:"rgba(255,255,255,0.4)", cursor:"pointer" }} onClick={onClose}>
            <Icon d={IC.x} size={20}/>
          </button>
        </div>

        {/* Live rate status bar */}
        <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:16, padding:"8px 12px", borderRadius:10,
          background: ratesLoading ? "rgba(255,255,255,0.04)" : liveRates ? "rgba(74,222,158,0.08)" : "rgba(255,255,255,0.04)",
          border: `1px solid ${liveRates ? "rgba(74,222,158,0.2)" : "rgba(255,255,255,0.07)"}` }}>
          <div style={{ width:7, height:7, borderRadius:99, flexShrink:0,
            background: ratesLoading ? "#f5a623" : liveRates ? "#4ade9e" : "rgba(255,255,255,0.2)",
            boxShadow: liveRates ? "0 0 6px #4ade9e" : "none" }}/>
          <p style={{ fontSize:12, color: liveRates ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.3)" }}>
            {ratesLoading
              ? "Fetching live rates..."
              : liveRates
                ? `Live rates · ECB · ${liveRates.date}`
                : "Could not fetch live rates — using manual values"}
          </p>
        </div>

        <p style={{ fontSize:13, color:"rgba(255,255,255,0.4)", marginBottom:16, lineHeight:1.5 }}>
          Rates vs RON. Cross rates (EUR/USD) are derived automatically but can be overridden.
        </p>

        {/* ── vs RON section ── */}
        <p style={{ fontSize:11, fontWeight:700, color:"rgba(255,255,255,0.3)", letterSpacing:"0.8px", textTransform:"uppercase", marginBottom:10 }}>vs RON</p>
        {[
          { cur:"EUR", flag:"🇪🇺", placeholder:"5.0951" },
          { cur:"USD", flag:"🇺🇸", placeholder:"4.4087" },
        ].map(({ cur, flag, placeholder }) => (
          <div key={cur} style={{ ...S.card, marginBottom:10, padding:14 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ fontSize:18 }}>{flag}</span>
                <p style={{ fontWeight:700, fontSize:14 }}>1 {cur} = {(rates[cur]||DEFAULT_RATES[cur]).toFixed(4)} RON</p>
              </div>
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <input style={{ ...S.input, flex:1, fontSize:14, padding:"9px 12px" }}
                type="number" step="0.0001"
                placeholder={`e.g. ${placeholder}`}
                value={edit[cur]}
                onChange={e => setEdit(v => ({ ...v, [cur]: e.target.value }))}
              />
              <button style={S.btn("#0fbcf9")} onClick={() => {
                const val = parseFloat(edit[cur]);
                if (!isNaN(val) && val > 0) { onSave(cur, val); setEdit(v => ({ ...v, [cur]:"" })); }
              }}>Set</button>
              {liveRates?.[cur] && (
                <button style={{ ...S.ghost, fontSize:12, padding:"9px 12px", whiteSpace:"nowrap" }}
                  onClick={() => { onResetToLive(cur); setEdit(v=>({...v,[cur]:""})); }}
                  title="Reset to live ECB rate">
                  ↺ Live
                </button>
              )}
            </div>
          </div>
        ))}

        {/* ── Cross rates section ── */}
        <p style={{ fontSize:11, fontWeight:700, color:"rgba(255,255,255,0.3)", letterSpacing:"0.8px", textTransform:"uppercase", marginBottom:10, marginTop:16 }}>Cross Rates (EUR / USD)</p>
        {[
          { key:"EUR_USD", from:"EUR", to:"USD", flag:"🇪🇺→🇺🇸", derived:eurUSD,
            hint:"Changing this updates the USD/RON rate" },
          { key:"USD_EUR", from:"USD", to:"EUR", flag:"🇺🇸→🇪🇺", derived:usdEUR,
            hint:"Changing this updates the EUR/RON rate" },
        ].map(({ key, from, to, flag, derived, hint }) => (
          <div key={key} style={{ ...S.card, marginBottom:10, padding:14 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ fontSize:18 }}>{flag}</span>
                <div>
                  <p style={{ fontWeight:700, fontSize:14 }}>1 {from} = {derived.toFixed(4)} {to}</p>
                  <p style={{ fontSize:11, color:"rgba(255,255,255,0.3)", marginTop:2 }}>{hint}</p>
                </div>
              </div>
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <input style={{ ...S.input, flex:1, fontSize:14, padding:"9px 12px" }}
                type="number" step="0.0001"
                placeholder={derived.toFixed(4)}
                value={edit[key]}
                onChange={e => setEdit(v => ({ ...v, [key]: e.target.value }))}
              />
              <button style={S.btn("#f5a623")} onClick={() => {
                const val = parseFloat(edit[key]);
                if (!isNaN(val) && val > 0) {
                  // Derive the new RON rate for the "to" currency keeping "from" fixed
                  // 1 from = val to  →  toRON = fromRON / val
                  const fromRON = from === "RON" ? 1 : (rates[from] || DEFAULT_RATES[from]);
                  const newToRON = fromRON / val;
                  onSave(to, newToRON);
                  setEdit(v => ({ ...v, [key]:"" }));
                }
              }}>Set</button>
            </div>
          </div>
        ))}

        <button style={{ ...S.btn("#e94560",true), marginTop:12 }} onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ExpenseModal — outside BudgetApp
// ─────────────────────────────────────────────────────────────────────────────
function ExpenseModal({ modal, onClose, form, setForm, onAdd, isEditing, scanState, scanResult, scanError, onScanFile, onConfirmScan, onCancelScan, onRetryScan, rates, incomeCurrency }) {
  const fileRef   = useRef();
  const cameraRef = useRef();

  const type = modal;
  const needsRate = form.currency !== incomeCurrency;
  const rateFrom = incomeCurrency === "EUR" ? form.currency : incomeCurrency;
  const rateTo   = incomeCurrency === "EUR" ? incomeCurrency : form.currency;

  const getDefaultRate = (from, to, r) => {
    if (from === to) return 1;
    const fromRON = from === "RON" ? 1 : (r[from] || DEFAULT_RATES[from] || 1);
    const toRON   = to   === "RON" ? 1 : (r[to]   || DEFAULT_RATES[to]   || 1);
    return fromRON / toRON;
  };

  const buildExpRates = (from, to, customVal, baseRates) => {
    if (!customVal) return baseRates;
    const v = parseFloat(customVal);
    if (!v || isNaN(v)) return baseRates;
    const r = { ...baseRates };
    if (from === "RON" && to !== "RON")       r[to]   = 1 / v;
    else if (to === "RON" && from !== "RON")  r[from] = v;
    else if (from !== "RON" && to !== "RON")  r[to]   = r[from] / v;
    return r;
  };

  const defaultDisplayRate = getDefaultRate(rateFrom, rateTo, rates);
  const expRates = form.customRate ? buildExpRates(rateFrom, rateTo, form.customRate, rates) : rates;
  const convertedPreview = (form.amount && needsRate)
    ? convert(parseFloat(form.amount)||0, form.currency, incomeCurrency, expRates)
    : null;
  const rateLabel       = `1 ${rateFrom} = ___ ${rateTo}`;
  const ratePlaceholder = defaultDisplayRate.toFixed(4);

  if (!modal) return null;

  return (
    <div style={S.overlay} onClick={e => { if (e.target===e.currentTarget) onClose(); }}>
      <div style={S.sheet}>
        <style>{`@keyframes spin { to { transform:rotate(360deg); } }`}</style>

        {/* ── Scan result ── */}
        {scanState==="result" && scanResult ? (
          <>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
              <h3 style={{ fontWeight:800, fontSize:18 }}>Receipt Scanned ✓</h3>
              <button style={{ background:"none", border:"none", color:"rgba(255,255,255,0.4)", cursor:"pointer" }} onClick={onCancelScan}><Icon d={IC.x} size={20}/></button>
            </div>
            <div style={{ ...S.card, marginBottom:20, background:"rgba(15,188,249,0.06)", border:"1px solid rgba(15,188,249,0.2)" }}>
              {[["Merchant", scanResult.name,"#f0f0f5"],["Amount", fmt(parseFloat(scanResult.amount)||0, form.currency),"#0fbcf9"],["Category", scanResult.category,"#f0f0f5"]].map(([k,v,c])=>(
                <div key={k} style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                  <span style={{ fontSize:12, color:"rgba(255,255,255,0.4)", fontWeight:600, textTransform:"uppercase" }}>{k}</span>
                  <span style={{ fontWeight:700, color:c }}>{v}</span>
                </div>
              ))}
              {convertedPreview !== null && (
                <div style={{ borderTop:"1px solid rgba(255,255,255,0.08)", paddingTop:8, marginTop:4, display:"flex", justifyContent:"space-between" }}>
                  <span style={{ fontSize:12, color:"rgba(255,255,255,0.4)", fontWeight:600, textTransform:"uppercase" }}>Converted</span>
                  <span style={{ fontWeight:700, color:"#f5a623" }}>≈ {fmt(convertedPreview, incomeCurrency)}</span>
                </div>
              )}
              {scanResult.items?.length>0 && (
                <div style={{ marginTop:10, borderTop:"1px solid rgba(255,255,255,0.08)", paddingTop:8 }}>
                  {scanResult.items.slice(0,4).map((it,i)=><p key={i} style={{ fontSize:12, color:"rgba(255,255,255,0.4)" }}>• {it}</p>)}
                </div>
              )}
            </div>
            <p style={{ fontSize:13, color:"rgba(255,255,255,0.4)", marginBottom:14 }}>Save as:</p>
            <div style={{ display:"flex", gap:10 }}>
              <button style={S.btn("#e94560")} onClick={()=>onConfirmScan("recurring")}>Recurring</button>
              <button style={S.btn("#f5a623")} onClick={()=>onConfirmScan("daily")}>Daily</button>
              <button style={S.ghost} onClick={onCancelScan}>Cancel</button>
            </div>
          </>

        ) : scanState==="scanning" ? (
          <div style={{ textAlign:"center", padding:"40px 0" }}>
            <div style={{ fontSize:48, marginBottom:16, display:"inline-block", animation:"spin 1s linear infinite" }}>🔍</div>
            <p style={{ fontWeight:700, fontSize:17 }}>Scanning receipt...</p>
            <p style={{ fontSize:13, color:"rgba(255,255,255,0.4)", marginTop:6 }}>AI is reading your receipt</p>
          </div>

        ) : scanState==="error" ? (
          <div style={{ textAlign:"center", padding:"40px 0" }}>
            <div style={{ fontSize:48, marginBottom:16 }}>❌</div>
            <p style={{ fontWeight:700, fontSize:17 }}>Couldn't read receipt</p>
            <p style={{ fontSize:13, color:"rgba(255,255,255,0.4)", marginTop:6, marginBottom:8 }}>Try a clearer photo or add manually</p>
            {scanError && <p style={{ fontSize:11, color:"rgba(255,255,255,0.2)", marginBottom:20, padding:"8px 12px", background:"rgba(255,255,255,0.04)", borderRadius:8 }}>{scanError}</p>}
            <button style={S.btn("#e94560",true)} onClick={onRetryScan}>Try Again</button>
          </div>

        ) : (
          /* ── Manual form ── */
          <>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:22 }}>
              <h3 style={{ fontWeight:800, fontSize:18 }}>
                {isEditing ? "Edit Expense" : `Add ${type==="recurring"?"Recurring":"Daily"} Expense`}
              </h3>
              <button style={{ background:"none", border:"none", color:"rgba(255,255,255,0.4)", cursor:"pointer" }} onClick={onClose}><Icon d={IC.x} size={20}/></button>
            </div>

            {/* Scan buttons — only shown when adding new */}
            {!isEditing && (
              <>
                <div style={{ display:"flex", gap:8, marginBottom:18 }}>
                  <button style={{ flex:1, ...S.card, border:"1px solid rgba(15,188,249,0.3)", background:"rgba(15,188,249,0.06)", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:8, padding:"11px 14px" }}
                    onClick={()=>fileRef.current?.click()}>
                    <Icon d={IC.receipt} size={15} stroke="#0fbcf9"/>
                    <span style={{ fontSize:13, fontWeight:600, color:"#0fbcf9" }}>Upload Receipt</span>
                  </button>
                  <button style={{ flex:1, ...S.card, border:"1px solid rgba(245,166,35,0.3)", background:"rgba(245,166,35,0.06)", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:8, padding:"11px 14px" }}
                    onClick={()=>cameraRef.current?.click()}>
                    <Icon d={IC.camera} size={15} stroke="#f5a623"/>
                    <span style={{ fontSize:13, fontWeight:600, color:"#f5a623" }}>Camera</span>
                  </button>
                </div>
                <input ref={fileRef} type="file" accept="image/*" style={{ display:"none" }} onChange={e=>onScanFile(e.target.files[0])}/>
                <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display:"none" }} onChange={e=>onScanFile(e.target.files[0])}/>
                <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:18 }}>
                  <div style={{ flex:1, height:1, background:"rgba(255,255,255,0.07)" }}/>
                  <span style={{ fontSize:11, color:"rgba(255,255,255,0.2)", fontWeight:600 }}>OR MANUALLY</span>
                  <div style={{ flex:1, height:1, background:"rgba(255,255,255,0.07)" }}/>
                </div>
              </>
            )}

            {/* Name */}
            <div style={{ marginBottom:14 }}>
              <label style={S.label}>Name</label>
              <input style={S.input} value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Netflix, Kaufland..." />
            </div>

            {/* Amount + currency */}
            <div style={{ marginBottom:6 }}>
              <label style={S.label}>Amount & Currency</label>
              <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                <input style={{ ...S.input, flex:1 }} type="number" value={form.amount}
                  onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                  placeholder="0.00" />
                <div style={{ display:"flex", gap:4 }}>
                  {CURRENCIES.map(c => (
                    <CurPill key={c} label={c} active={form.currency===c} color={CUR_COLOR[c]}
                      onClick={() => setForm(f => ({ ...f, currency:c, customRate:"" }))} />
                  ))}
                </div>
              </div>
            </div>

            {/* Exchange rate — shown whenever expense currency ≠ income currency */}
            {needsRate && (
              <div style={{ ...S.card, padding:"12px 14px", marginBottom:14, background:"rgba(255,255,255,0.025)", marginTop:8 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                  <label style={{ ...S.label, marginBottom:0 }}>Rate: {rateLabel}</label>
                  <span style={{ fontSize:11, color:"rgba(255,255,255,0.25)", fontWeight:400 }}>blank = default</span>
                </div>
                <input style={{ ...S.input, fontSize:14, padding:"9px 12px" }}
                  type="number" step="0.0001"
                  placeholder={`default: ${ratePlaceholder}`}
                  value={form.customRate}
                  onChange={e => setForm(f => ({ ...f, customRate: e.target.value }))}
                />
                {convertedPreview !== null && form.amount && (
                  <p style={{ fontSize:12, color:"#0fbcf9", marginTop:7 }}>
                    ≈ {fmt(convertedPreview, incomeCurrency)}
                    {form.customRate
                      ? <span style={{ color:"#f5a623" }}> · custom rate</span>
                      : <span style={{ color:"rgba(255,255,255,0.3)" }}> · default rate</span>}
                  </p>
                )}
              </div>
            )}

            {/* Category */}
            <div style={{ marginBottom:14 }}>
              <label style={S.label}>Category</label>
              <div style={{ display:"flex", gap:8 }}>
                {["needs","wants","savings"].map(c => (
                  <button key={c} style={S.pill(form.category===c, CAT_COLOR[c])}
                    onClick={() => setForm(f => ({ ...f, category:c }))}>
                    {c.charAt(0).toUpperCase()+c.slice(1)}
                  </button>
                ))}
              </div>
            </div>

            {/* Subcategory */}
            <div style={{ marginBottom:22 }}>
              <label style={S.label}>Subcategory</label>
              <select style={S.input} value={form.subcat} onChange={e => setForm(f => ({ ...f, subcat:e.target.value }))}>
                <option value="">Select...</option>
                {CATEGORIES[form.category]?.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>

            <button style={S.btn("#e94560",true)} onClick={() => onAdd(type)}>{isEditing ? "Save Changes" : "Add Expense"}</button>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HomeTab — outside BudgetApp
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Budgie Logo
// ─────────────────────────────────────────────────────────────────────────────
function BudgieLogo({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bodyGrad" x1="10" y1="10" x2="54" y2="54" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#4ade9e"/>
          <stop offset="100%" stopColor="#0fbcf9"/>
        </linearGradient>
        <linearGradient id="bellyGrad" x1="24" y1="30" x2="44" y2="56" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#fffbe6"/>
          <stop offset="100%" stopColor="#f5e6a3"/>
        </linearGradient>
        <linearGradient id="wingGrad" x1="8" y1="20" x2="30" y2="50" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#22d4a0"/>
          <stop offset="100%" stopColor="#0891b2"/>
        </linearGradient>
      </defs>
      {/* Body */}
      <ellipse cx="34" cy="40" rx="18" ry="20" fill="url(#bodyGrad)"/>
      {/* Belly */}
      <ellipse cx="35" cy="46" rx="10" ry="12" fill="url(#bellyGrad)" opacity="0.9"/>
      {/* Wing */}
      <ellipse cx="20" cy="38" rx="10" ry="16" fill="url(#wingGrad)" transform="rotate(-15 20 38)"/>
      {/* Head */}
      <circle cx="38" cy="18" r="13" fill="url(#bodyGrad)"/>
      {/* Cheek patch */}
      <circle cx="44" cy="22" r="4" fill="#f97316" opacity="0.8"/>
      {/* Eye */}
      <circle cx="40" cy="15" r="4" fill="#fff"/>
      <circle cx="41" cy="15" r="2.2" fill="#1e293b"/>
      <circle cx="42" cy="14" r="0.8" fill="#fff"/>
      {/* Beak */}
      <path d="M33 20 L28 23 L33 25 Z" fill="#f5a623"/>
      {/* Head stripes */}
      <path d="M32 9 Q36 6 40 8" stroke="#22d4a0" strokeWidth="1.5" strokeLinecap="round" opacity="0.6"/>
      <path d="M34 7 Q38 4 43 6" stroke="#0fbcf9" strokeWidth="1.2" strokeLinecap="round" opacity="0.5"/>
      {/* Feet */}
      <path d="M28 58 L26 62 M28 58 L30 62 M28 58 L28 54" stroke="#f5a623" strokeWidth="1.8" strokeLinecap="round"/>
      <path d="M40 59 L38 63 M40 59 L42 63 M40 59 L40 55" stroke="#f5a623" strokeWidth="1.8" strokeLinecap="round"/>
      {/* Coin sparkle */}
      <circle cx="54" cy="12" r="7" fill="#f5a623" opacity="0.95"/>
      <text x="54" y="16" textAnchor="middle" fontSize="8" fontWeight="bold" fill="#fff">$</text>
    </svg>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// Onboarding Wizard
// ─────────────────────────────────────────────────────────────────────────────
function Onboarding({ onComplete }) {
  const [step, setStep]       = useState(0);
  const [income, setIncome]   = useState("");
  const [currency, setCurrency] = useState("RON");
  const [payday, setPayday]   = useState("");
  const [name, setName]       = useState("");

  const steps = [
    { id:"welcome" },
    { id:"name" },
    { id:"payday" },
    { id:"income" },
    { id:"done" },
  ];

  function next() { setStep(s => s + 1); }

  function finish() {
    onComplete({
      name: name.trim(),
      monthlyIncome: income,
      incomeCurrency: currency,
      monthlyIncomeRON: currency === "RON"
        ? income
        : (parseFloat(income) * (currency === "EUR" ? DEFAULT_RATES.EUR : DEFAULT_RATES.USD)).toString(),
      payday: parseInt(payday) || 1,
      onboardingDone: true,
      currentMonth: getPeriodKey(parseInt(payday) || 1),
    });
  }

  const canNext = {
    welcome: true,
    name:    name.trim().length > 0,
    payday:  payday !== "" && parseInt(payday) >= 1 && parseInt(payday) <= 31,
    income:  income !== "" && parseFloat(income) > 0,
    done:    true,
  };

  const current = steps[step].id;

  return (
    <div style={{ minHeight:"100vh", background:"#0a0a0f", display:"flex", flexDirection:"column", maxWidth:420, margin:"0 auto", padding:"0 24px" }}>
      <style>{`@keyframes fadeUp { from { opacity:0; transform:translateY(20px); } to { opacity:1; transform:translateY(0); } }`}</style>

      {/* Progress dots */}
      <div style={{ display:"flex", gap:6, justifyContent:"center", paddingTop:56, marginBottom:40 }}>
        {steps.map((s, i) => (
          <div key={i} style={{ width: i === step ? 20 : 7, height:7, borderRadius:99, background: i <= step ? "#4ade9e" : "rgba(255,255,255,0.1)", transition:"all 0.3s" }}/>
        ))}
      </div>

      <div style={{ flex:1, display:"flex", flexDirection:"column", justifyContent:"center", animation:"fadeUp 0.4s ease" }} key={step}>

        {/* ── Welcome ── */}
        {current === "welcome" && (
          <div style={{ textAlign:"center" }}>
            <BudgieLogo size={80}/>
            <h1 style={{ fontSize:32, fontWeight:900, marginTop:20, marginBottom:8, background:"linear-gradient(90deg,#4ade9e,#0fbcf9)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", display:"inline-block", paddingRight:4 }}>Budgie</h1>
            <p style={{ fontSize:16, color:"rgba(255,255,255,0.5)", marginBottom:12, lineHeight:1.6 }}>Your personal budget tracker.</p>
            <p style={{ fontSize:14, color:"rgba(255,255,255,0.3)", lineHeight:1.6 }}>Let's set up your profile in a few quick steps.</p>
          </div>
        )}

        {/* ── Name ── */}
        {current === "name" && (
          <div>
            <p style={{ fontSize:13, fontWeight:700, color:"#4ade9e", letterSpacing:"1px", textTransform:"uppercase", marginBottom:12 }}>Step 1 of 3</p>
            <h2 style={{ fontSize:26, fontWeight:900, marginBottom:8 }}>What's your name?</h2>
            <p style={{ fontSize:14, color:"rgba(255,255,255,0.4)", marginBottom:28, lineHeight:1.6 }}>We'll personalise your experience.</p>
            <input style={{ ...S.input, fontSize:18, padding:"14px 16px" }}
              autoFocus value={name} onChange={e => setName(e.target.value)}
              placeholder="Your first name..."
              onKeyDown={e => { if (e.key==="Enter" && canNext.name) next(); }}
            />
          </div>
        )}

        {/* ── Payday ── */}
        {current === "payday" && (
          <div>
            <p style={{ fontSize:13, fontWeight:700, color:"#4ade9e", letterSpacing:"1px", textTransform:"uppercase", marginBottom:12 }}>Step 2 of 3</p>
            <h2 style={{ fontSize:26, fontWeight:900, marginBottom:8 }}>When do you get paid?</h2>
            <p style={{ fontSize:14, color:"rgba(255,255,255,0.4)", marginBottom:28, lineHeight:1.6 }}>
              Your budget period will run from this day each month — expenses reset automatically when your next salary arrives.
            </p>
            <div style={{ position:"relative" }}>
              <input style={{ ...S.input, fontSize:24, fontWeight:800, padding:"16px", textAlign:"center" }}
                type="number" min="1" max="31" autoFocus
                value={payday} onChange={e => setPayday(e.target.value)}
                placeholder="e.g. 5"
                onKeyDown={e => { if (e.key==="Enter" && canNext.payday) next(); }}
              />
              <span style={{ position:"absolute", right:16, top:"50%", transform:"translateY(-50%)", fontSize:13, color:"rgba(255,255,255,0.3)", fontWeight:600 }}>day of month</span>
            </div>
            {payday && (
              <p style={{ fontSize:13, color:"rgba(255,255,255,0.4)", marginTop:12, textAlign:"center" }}>
                Budget resets on the <strong style={{ color:"#4ade9e" }}>{payday}{["st","nd","rd"][parseInt(payday)-1]||"th"}</strong> of each month
              </p>
            )}
          </div>
        )}

        {/* ── Income ── */}
        {current === "income" && (
          <div>
            <p style={{ fontSize:13, fontWeight:700, color:"#4ade9e", letterSpacing:"1px", textTransform:"uppercase", marginBottom:12 }}>Step 3 of 3</p>
            <h2 style={{ fontSize:26, fontWeight:900, marginBottom:8 }}>What's your monthly income?</h2>
            <p style={{ fontSize:14, color:"rgba(255,255,255,0.4)", marginBottom:28, lineHeight:1.6 }}>
              We'll use the 50-30-20 rule to split it into Needs, Wants and Savings.
            </p>
            <div style={{ marginBottom:16 }}>
              <label style={S.label}>Currency</label>
              <div style={{ display:"flex", gap:8 }}>
                {CURRENCIES.map(c => (
                  <CurPill key={c} label={c} active={currency===c} color={CUR_COLOR[c]} onClick={() => setCurrency(c)}/>
                ))}
              </div>
            </div>
            <input style={{ ...S.input, fontSize:24, fontWeight:800, padding:"16px", textAlign:"center" }}
              type="number" autoFocus
              value={income} onChange={e => setIncome(e.target.value)}
              placeholder="0"
              onKeyDown={e => { if (e.key==="Enter" && canNext.income) next(); }}
            />
            {income && parseFloat(income) > 0 && (
              <div style={{ marginTop:16, display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
                {[["Needs","50%", parseFloat(income)*0.5,"#e94560"],["Wants","30%",parseFloat(income)*0.3,"#f5a623"],["Savings","20%",parseFloat(income)*0.2,"#0fbcf9"]].map(([l,p,v,c])=>(
                  <div key={l} style={{ background:`rgba(${rgb(c)},0.08)`, borderRadius:12, padding:"10px 8px", textAlign:"center", border:`1px solid rgba(${rgb(c)},0.2)` }}>
                    <p style={{ fontSize:10, color:"rgba(255,255,255,0.4)", fontWeight:700, textTransform:"uppercase", letterSpacing:"0.5px" }}>{l}</p>
                    <p style={{ fontSize:15, fontWeight:800, color:c, marginTop:2 }}>{p}</p>
                    <p style={{ fontSize:11, color:"rgba(255,255,255,0.5)", marginTop:1 }}>{fmt(v, currency)}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Done ── */}
        {current === "done" && (
          <div style={{ textAlign:"center" }}>
            <div style={{ fontSize:64, marginBottom:16 }}>🎉</div>
            <h2 style={{ fontSize:28, fontWeight:900, marginBottom:8 }}>
              You're all set{name ? `, ${name}` : ""}!
            </h2>
            <p style={{ fontSize:14, color:"rgba(255,255,255,0.4)", lineHeight:1.6, marginBottom:12 }}>
              Your budget resets on the <strong style={{ color:"#4ade9e" }}>{payday}{["st","nd","rd"][parseInt(payday)-1]||"th"}</strong> of each month.<br/>
              Start by adding your recurring expenses.
            </p>
          </div>
        )}
      </div>

      {/* Bottom button */}
      <div style={{ paddingBottom:40, paddingTop:24 }}>
        <button
          style={{ ...S.btn("#4ade9e", true), color:"#0a0a0f", opacity: canNext[current] ? 1 : 0.4, fontSize:16 }}
          onClick={() => { if (!canNext[current]) return; current === "done" ? finish() : next(); }}
        >
          {current === "welcome" ? "Get Started" : current === "done" ? "Open Budgie" : "Continue →"}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Payday Reset Modal
// ─────────────────────────────────────────────────────────────────────────────
function PaydayResetModal({ show, userName, income, currency, onKeep, onUpdate }) {
  const [newIncome, setNewIncome] = useState("");
  const [newCurrency, setNewCurrency] = useState(currency);
  const [changing, setChanging] = useState(false);

  if (!show) return null;

  return (
    <div style={{ ...S.overlay, zIndex:400, alignItems:"center" }}>
      <div style={{ ...S.sheet, borderRadius:24, margin:"0 24px", padding:"32px 24px" }}>
        <div style={{ textAlign:"center", marginBottom:24 }}>
          <div style={{ fontSize:48, marginBottom:12 }}>💰</div>
          <h3 style={{ fontWeight:900, fontSize:22, marginBottom:6 }}>
            Payday{userName ? `, ${userName}` : ""}!
          </h3>
          <p style={{ fontSize:14, color:"rgba(255,255,255,0.4)", lineHeight:1.6 }}>
            A new budget period is starting. Daily expenses have been reset.
          </p>
        </div>

        <div style={{ ...S.card, marginBottom:20, padding:16, textAlign:"center" }}>
          <p style={{ fontSize:12, color:"rgba(255,255,255,0.4)", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.8px", marginBottom:4 }}>Current income</p>
          <p style={{ fontSize:28, fontWeight:900, color:"#4ade9e" }}>{fmt(parseFloat(income)||0, currency)}</p>
        </div>

        {!changing ? (
          <>
            <p style={{ fontSize:14, color:"rgba(255,255,255,0.5)", textAlign:"center", marginBottom:20 }}>Has your income changed?</p>
            <div style={{ display:"flex", gap:10 }}>
              <button style={{ ...S.btn("#4ade9e", true), color:"#0a0a0f", flex:1 }} onClick={onKeep}>
                No, same income
              </button>
              <button style={{ ...S.ghost, flex:1 }} onClick={() => setChanging(true)}>
                Yes, update it
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ marginBottom:14 }}>
              <label style={S.label}>New income</label>
              <input style={{ ...S.input, fontSize:20, fontWeight:800, padding:"14px", textAlign:"center" }}
                type="number" autoFocus
                value={newIncome} onChange={e => setNewIncome(e.target.value)}
                placeholder={income}
              />
            </div>
            <div style={{ marginBottom:20 }}>
              <label style={S.label}>Currency</label>
              <div style={{ display:"flex", gap:8 }}>
                {CURRENCIES.map(c => (
                  <CurPill key={c} label={c} active={newCurrency===c} color={CUR_COLOR[c]} onClick={() => setNewCurrency(c)}/>
                ))}
              </div>
            </div>
            <div style={{ display:"flex", gap:10 }}>
              <button style={{ ...S.btn("#4ade9e", true), color:"#0a0a0f", flex:1 }}
                onClick={() => {
                  const val = newIncome || income;
                  onUpdate(val, newCurrency);
                }}>
                Save & Continue
              </button>
              <button style={{ ...S.ghost }} onClick={() => setChanging(false)}>Back</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper — get current period key based on payday
// ─────────────────────────────────────────────────────────────────────────────
function getPeriodKey(payday) {
  const now   = new Date();
  const day   = now.getDate();
  const year  = now.getFullYear();
  const month = now.getMonth(); // 0-based
  // If today >= payday, period started this month; else it started last month
  if (day >= payday) {
    return `${year}-${String(month + 1).padStart(2, "0")}`;
  } else {
    const d = new Date(year, month - 1, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }
}

function HomeTab({ data, updateData, spentByType, totalSpent, allExpenses, incomeCurrency, rates, onOpenRates }) {
  const [editingIncome, setEditingIncome] = useState(false);
  const [incomeInput,   setIncomeInput]   = useState("");
  const income = parseFloat(data.monthlyIncome)||0;
  const sym    = CUR_SYM[incomeCurrency];

  return (
    <div>
      <div style={S.header}>
        {/* Budgie brand row */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <BudgieLogo size={44}/>
            <div>
              <p style={{ fontSize:26, fontWeight:900, letterSpacing:"0.5px", lineHeight:1.2, background:"linear-gradient(90deg,#4ade9e,#0fbcf9)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", paddingRight:"4px", paddingBottom:"2px", display:"inline-block" }}>Budgie</p>
              <p style={{ fontSize:11, color:"rgba(255,255,255,0.3)", fontWeight:600, letterSpacing:"1px", textTransform:"uppercase", marginTop:5 }}>Budget Tracker</p>
            </div>
          </div>
          <button style={{ background:"none", border:"none", cursor:"pointer", color:"rgba(255,255,255,0.3)", display:"flex", alignItems:"center", gap:5, fontSize:11, fontWeight:600 }} onClick={onOpenRates}>
            <Icon d={IC.cog} size={13}/> Rates
          </button>
        </div>

        {editingIncome ? (
          <input autoFocus type="number" value={incomeInput}
            onChange={e => setIncomeInput(e.target.value)}
            style={{ ...S.input, fontSize:34, fontWeight:800, padding:"4px 0", background:"none", border:"none", borderBottom:"2px solid #e94560", borderRadius:0, marginBottom:12 }}
            onBlur={() => {
              const val = parseFloat(incomeInput) || 0;
              const ronVal = val > 0 ? toRON(val, incomeCurrency, rates) : 0;
              updateData({ monthlyIncome: incomeInput, monthlyIncomeRON: ronVal.toString() });
              setEditingIncome(false);
            }}
            onKeyDown={e => { if (e.key==="Enter") {
              const val = parseFloat(incomeInput) || 0;
              const ronVal = val > 0 ? toRON(val, incomeCurrency, rates) : 0;
              updateData({ monthlyIncome: incomeInput, monthlyIncomeRON: ronVal.toString() });
              setEditingIncome(false);
            } }}
            placeholder="0" />
        ) : (
          <div style={{ display:"flex", alignItems:"baseline", gap:8, cursor:"pointer", marginBottom:12 }}
            onClick={() => { setIncomeInput(data.monthlyIncome); setEditingIncome(true); }}>
            <span style={{ fontSize:38, fontWeight:800, letterSpacing:"-1px" }}>{income>0?income.toLocaleString("ro-RO"):"—"}</span>
            <span style={{ fontSize:18, fontWeight:600, color:"rgba(255,255,255,0.5)" }}>{sym}</span>
            <Icon d={IC.edit} size={14} stroke="rgba(255,255,255,0.25)"/>
          </div>
        )}

        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:12, color:"rgba(255,255,255,0.35)", fontWeight:600 }}>Currency:</span>
          <div style={{ display:"flex", gap:5 }}>
            {CURRENCIES.map(c => (
              <CurPill key={c} label={c} active={incomeCurrency===c} color={CUR_COLOR[c]} onClick={() => {
                if (c === incomeCurrency) return;
                // Always convert from the canonical RON value to avoid drift
                const baseRON = parseFloat(data.monthlyIncomeRON) || parseFloat(data.monthlyIncome) || 0;
                if (baseRON > 0) {
                  const converted = c === "RON" ? baseRON : fromRON(baseRON, c, rates);
                  updateData({ incomeCurrency: c, monthlyIncome: parseFloat(converted.toFixed(2)).toString() });
                } else {
                  updateData({ incomeCurrency: c });
                }
              }}/>
            ))}
          </div>
        </div>
        {income===0 && <p style={{ fontSize:13, color:"rgba(255,255,255,0.35)", marginTop:8 }}>Tap the amount above to set your income</p>}
      </div>

      <div style={{ padding:"0 16px" }}>
        {income>0 && (
          <>
            {/* 50-30-20 cards */}
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:20 }}>
              {[
                { key:"needs",   label:"Needs",   pct:50, budget:income*0.5, color:"#e94560" },
                { key:"wants",   label:"Wants",   pct:30, budget:income*0.3, color:"#f5a623" },
                { key:"savings", label:"Savings", pct:20, budget:income*0.2, color:"#0fbcf9" },
              ].map(item => {
                const spent = spentByType[item.key]||0;
                const rem   = item.budget-spent;
                return (
                  <div key={item.key} style={{ ...S.card, padding:"14px 10px", textAlign:"center" }}>
                    <div style={{ position:"relative", display:"inline-block", marginBottom:8 }}>
                      <CircleProgress pct={item.budget>0?(spent/item.budget)*100:0} color={item.color} size={62} stroke={5}/>
                      <div style={{ position:"absolute", inset:0, display:"flex", alignItems:"center", justifyContent:"center" }}>
                        <span style={{ fontSize:13, fontWeight:800, color:item.color }}>{item.pct}%</span>
                      </div>
                    </div>
                    <p style={{ fontSize:11, fontWeight:700, color:"rgba(255,255,255,0.45)", textTransform:"uppercase", letterSpacing:"0.5px", marginBottom:2 }}>{item.label}</p>
                    <p style={{ fontSize:12, fontWeight:800, color:item.color }}>{fmt(item.budget, incomeCurrency)}</p>
                    <p style={{ fontSize:10, color:rem<0?"#e94560":"rgba(255,255,255,0.3)" }}>
                      {rem<0?`over ${fmt(Math.abs(rem),incomeCurrency)}`:`${fmt(rem,incomeCurrency)} left`}
                    </p>
                  </div>
                );
              })}
            </div>

            {/* Breakdown bars */}
            <div style={{ ...S.card, marginBottom:20 }}>
              <p style={{ fontSize:11, fontWeight:700, marginBottom:16, color:"rgba(255,255,255,0.5)", textTransform:"uppercase", letterSpacing:"0.8px" }}>Spending Breakdown</p>
              {[
                { label:"Needs (50%)",   budget:income*0.5, spent:spentByType.needs||0,   color:"#e94560", icon:IC.wallet },
                { label:"Wants (30%)",   budget:income*0.3, spent:spentByType.wants||0,   color:"#f5a623", icon:IC.sparkle },
                { label:"Savings (20%)", budget:income*0.2, spent:spentByType.savings||0, color:"#0fbcf9", icon:IC.wallet },
              ].map(({ label, budget, spent, color, icon }) => {
                const pct  = budget>0?Math.min((spent/budget)*100,100):0;
                const over = spent>budget;
                return (
                  <div key={label} style={{ marginBottom:16 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                        <div style={{ width:26, height:26, borderRadius:7, background:`rgba(${rgb(color)},0.15)`, display:"flex", alignItems:"center", justifyContent:"center" }}>
                          <Icon d={icon} size={13} stroke={color}/>
                        </div>
                        <span style={{ fontSize:13, fontWeight:600 }}>{label}</span>
                      </div>
                      <div style={{ textAlign:"right" }}>
                        <span style={{ fontSize:13, fontWeight:700, color:over?"#e94560":color }}>{fmt(spent,incomeCurrency)}</span>
                        <span style={{ fontSize:11, color:"rgba(255,255,255,0.3)" }}> / {fmt(budget,incomeCurrency)}</span>
                      </div>
                    </div>
                    <div style={{ height:6, background:"rgba(255,255,255,0.07)", borderRadius:99, overflow:"hidden" }}>
                      <div style={{ height:"100%", width:`${pct}%`, background:over?"#e94560":color, borderRadius:99, transition:"width 0.6s cubic-bezier(0.34,1.56,0.64,1)" }}/>
                    </div>
                    {over && <p style={{ fontSize:11, color:"#e94560", marginTop:3 }}>⚠ Over by {fmt(spent-budget,incomeCurrency)}</p>}
                  </div>
                );
              })}
            </div>

            {/* Summary row */}
            <div style={{ ...S.card, marginBottom:20, display:"flex" }}>
              {[
                { label:"Total Spent", value:fmt(totalSpent,incomeCurrency),              color:totalSpent>income?"#e94560":"#f0f0f5" },
                { label:"Remaining",   value:fmt(Math.abs(income-totalSpent),incomeCurrency), color:income-totalSpent<0?"#e94560":"#0fbcf9" },
                { label:"Expenses",    value:String(allExpenses.length),                   color:"#f0f0f5" },
              ].map((item,i) => (
                <div key={i} style={{ flex:1, textAlign:"center", borderRight:i<2?"1px solid rgba(255,255,255,0.07)":"none" }}>
                  <p style={{ fontSize:10, color:"rgba(255,255,255,0.35)", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.4px", marginBottom:4 }}>{item.label}</p>
                  <p style={{ fontSize:15, fontWeight:800, color:item.color }}>{item.value}</p>
                </div>
              ))}
            </div>
          </>
        )}

        {income===0 && (
          <div style={{ ...S.card, textAlign:"center", padding:"40px 24px" }}>
            <div style={{ fontSize:48, marginBottom:12 }}>💰</div>
            <p style={{ fontWeight:700, fontSize:17, marginBottom:8 }}>Set your monthly income</p>
            <p style={{ fontSize:14, color:"rgba(255,255,255,0.4)", marginBottom:20 }}>Tap the amount above to get started</p>
            <div style={{ background:"rgba(255,255,255,0.04)", borderRadius:14, padding:16, textAlign:"left" }}>
              {[["🔴","50%","Needs","Rent, food, bills"],["🟡","30%","Wants","Dining, shopping, fun"],["🔵","20%","Savings","Emergency fund, investments"]].map(([e,p,l,d])=>(
                <div key={l} style={{ display:"flex", gap:10, marginBottom:10 }}>
                  <span>{e}</span>
                  <div><span style={{ fontWeight:700, fontSize:13 }}>{p} {l}</span><p style={{ fontSize:12, color:"rgba(255,255,255,0.35)", margin:0 }}>{d}</p></div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ExpensesTab — outside BudgetApp
// ─────────────────────────────────────────────────────────────────────────────
function ExpensesTab({ data, updateData, incomeCurrency, rates, onOpenAdd, onOpenEdit }) {
  const [activeType, setActiveType] = useState("recurring");

  const list = activeType === "recurring" ? (data.recurringExpenses || []) : data.dailyExpenses;

  function remove(id) {
    if (activeType === "recurring") updateData({ recurringExpenses: data.recurringExpenses.filter(e => e.id !== id) });
    else updateData({ dailyExpenses: data.dailyExpenses.filter(e => e.id !== id) });
  }

  function ExpenseRow({ exp, onRemove, onEdit }) {
    const cc = CAT_COLOR[exp.category] || "#f0f0f5";
    const ec = exp.currency || incomeCurrency;
    const er = exp.customRate ? { ...rates, [exp.customRateCur || ec]: exp.customRate } : rates;
    const cv = convert(parseFloat(exp.amount) || 0, ec, incomeCurrency, er);
    const showCV = ec !== incomeCurrency;
    return (
      <div onClick={onEdit} style={{ ...S.card, marginBottom:10, display:"flex", alignItems:"center", gap:12, cursor:"pointer", transition:"background 0.15s" }}
        onMouseEnter={e=>e.currentTarget.style.background="rgba(255,255,255,0.07)"}
        onMouseLeave={e=>e.currentTarget.style.background="rgba(255,255,255,0.04)"}>
        <div style={{ width:42, height:42, borderRadius:12, background:`rgba(${rgb(cc)},0.15)`, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>
          <Icon d={activeType==="recurring" ? IC.repeat : IC.receipt} size={18} stroke={cc}/>
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          <p style={{ fontWeight:700, fontSize:14, marginBottom:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{exp.name}</p>
          <div style={{ display:"flex", gap:5, alignItems:"center", flexWrap:"wrap" }}>
            <span style={{ fontSize:11, padding:"2px 7px", borderRadius:99, background:`rgba(${rgb(cc)},0.15)`, color:cc, fontWeight:600 }}>{exp.subcat || exp.category}</span>
            {exp.date && <span style={{ fontSize:11, color:"rgba(255,255,255,0.25)" }}>{exp.date}</span>}
            {exp.customRate && <span style={{ fontSize:10, color:"#f5a623" }}>custom rate</span>}
          </div>
        </div>
        <div style={{ textAlign:"right", flexShrink:0 }}>
          <p style={{ fontWeight:800, fontSize:14 }}>{fmt(parseFloat(exp.amount), ec)}</p>
          {showCV && <p style={{ fontSize:11, color:"rgba(255,255,255,0.3)" }}>≈ {fmt(cv, incomeCurrency)}</p>}
        </div>
        <button onClick={e=>{e.stopPropagation(); onRemove();}} style={{ background:"none", border:"none", color:"rgba(255,255,255,0.2)", cursor:"pointer", padding:4, flexShrink:0 }}>
          <Icon d={IC.trash} size={15}/>
        </button>
      </div>
    );
  }

  const monthLabel = new Date().toLocaleString("en-US", { month: "long", year: "numeric" });

  return (
    <div style={{ padding:"0 0 20px" }}>
      {/* Header */}
      <div style={{ padding:"52px 24px 16px", background:"linear-gradient(160deg,#13131f 0%,#0a0a0f 100%)", marginBottom:16 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <BudgieLogo size={44}/>
            <div>
              <p style={{ fontSize:26, fontWeight:900, letterSpacing:"0.5px", lineHeight:1.2, background:"linear-gradient(90deg,#4ade9e,#0fbcf9)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", paddingRight:"4px", paddingBottom:"2px", display:"inline-block" }}>Budgie</p>
              <p style={{ fontSize:11, color:"rgba(255,255,255,0.3)", fontWeight:600, letterSpacing:"1px", textTransform:"uppercase", marginTop:5 }}>Expenses</p>
            </div>
          </div>
          <button style={S.btn("#e94560")} onClick={() => onOpenAdd(activeType)}>
            <Icon d={IC.plus} size={16} stroke="#fff"/>
          </button>
        </div>
      </div>

      <div style={{ padding:"0 16px" }}>
        {/* Tabs */}
        <div style={{ display:"flex", gap:8, marginBottom:12 }}>
          <button style={S.pill(activeType==="recurring")} onClick={() => setActiveType("recurring")}>Recurring</button>
          <button style={S.pill(activeType==="daily", "#f5a623")} onClick={() => setActiveType("daily")}>Daily</button>
        </div>

        {/* Info strip */}
        {activeType === "recurring" && (
          <div style={{ fontSize:12, color:"rgba(255,255,255,0.35)", marginBottom:14, padding:"8px 12px", background:"rgba(255,255,255,0.03)", borderRadius:10, lineHeight:1.5 }}>
            🔄 Fixed expenses are always counted in your budget, every period.
          </div>
        )}
        {activeType === "daily" && (
          <div style={{ fontSize:12, color:"rgba(255,255,255,0.35)", marginBottom:14, padding:"8px 12px", background:"rgba(255,255,255,0.03)", borderRadius:10, lineHeight:1.5 }}>
            📅 <strong style={{ color:"rgba(255,255,255,0.5)" }}>{monthLabel}</strong> — variable expenses reset when your next salary arrives.
          </div>
        )}

        {/* List */}
        {list.length === 0 ? (
          <div style={{ ...S.card, textAlign:"center", padding:"36px 20px" }}>
            <div style={{ fontSize:36, marginBottom:10 }}>{activeType==="recurring" ? "🔄" : "📝"}</div>
            <p style={{ fontWeight:700 }}>No {activeType} expenses yet</p>
            <p style={{ fontSize:13, color:"rgba(255,255,255,0.4)", marginTop:6 }}>
              {activeType === "recurring"
                ? "Add fixed costs like rent, subscriptions, utilities"
                : "Add today's purchases or scan a receipt"}
            </p>
          </div>
        ) : list.map(exp => (
          <ExpenseRow key={exp.id} exp={exp} onRemove={() => remove(exp.id)} onEdit={() => onOpenEdit(exp, activeType)}/>
        ))}

        <button style={{ ...S.card, width:"100%", border:"2px dashed rgba(255,255,255,0.1)", background:"none", color:"rgba(255,255,255,0.3)", cursor:"pointer", textAlign:"center", marginTop:8, padding:14, display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}
          onClick={() => onOpenAdd(activeType)}>
          <Icon d={IC.plus} size={16}/> Add {activeType} expense
        </button>
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// BudgetApp — only state & orchestration live here
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// HistoryTab
// ─────────────────────────────────────────────────────────────────────────────
function HistoryTab({ data }) {
  const history = data.history || [];

  function periodLabel(p) {
    if (!p) return "";
    const [y, m] = p.split("-");
    return new Date(parseInt(y), parseInt(m)-1, 1).toLocaleString("en-US", { month:"long", year:"numeric" });
  }

  function Bar({ value, max, color }) {
    const pct = max > 0 ? Math.min((value/max)*100, 100) : 0;
    return (
      <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:4 }}>
        <div style={{ width:"100%", height:80, background:"rgba(255,255,255,0.05)", borderRadius:8, overflow:"hidden", display:"flex", alignItems:"flex-end" }}>
          <div style={{ width:"100%", height:`${pct}%`, background:color, borderRadius:8, transition:"height 0.5s cubic-bezier(0.34,1.56,0.64,1)", minHeight: value > 0 ? 4 : 0 }}/>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding:"0 0 20px" }}>
      {/* Header */}
      <div style={{ padding:"52px 24px 16px", background:"linear-gradient(160deg,#13131f 0%,#0a0a0f 100%)", marginBottom:16 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <BudgieLogo size={44}/>
          <div>
            <p style={{ fontSize:26, fontWeight:900, letterSpacing:"0.5px", lineHeight:1.2, background:"linear-gradient(90deg,#4ade9e,#0fbcf9)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent", paddingRight:"4px", paddingBottom:"2px", display:"inline-block" }}>Budgie</p>
            <p style={{ fontSize:11, color:"rgba(255,255,255,0.3)", fontWeight:600, letterSpacing:"1px", textTransform:"uppercase", marginTop:5 }}>History</p>
          </div>
        </div>
      </div>

      <div style={{ padding:"0 16px" }}>
        {history.length === 0 ? (
          <div style={{ ...S.card, textAlign:"center", padding:"48px 24px" }}>
            <div style={{ fontSize:44, marginBottom:12 }}>📊</div>
            <p style={{ fontWeight:700, fontSize:16, marginBottom:8 }}>No history yet</p>
            <p style={{ fontSize:13, color:"rgba(255,255,255,0.4)", lineHeight:1.6 }}>
              Your spending breakdown will be saved here at the end of each budget period.
            </p>
          </div>
        ) : (
          <>
            {/* Overview chart — last 6 periods */}
            {history.length > 1 && (
              <div style={{ ...S.card, marginBottom:16, padding:16 }}>
                <p style={{ fontSize:11, fontWeight:700, color:"rgba(255,255,255,0.4)", textTransform:"uppercase", letterSpacing:"0.8px", marginBottom:16 }}>Last {Math.min(history.length, 6)} periods</p>
                <div style={{ display:"flex", gap:6, alignItems:"flex-end" }}>
                  {history.slice(0, 6).reverse().map((h, i) => {
                    const maxVal = Math.max(...history.slice(0,6).map(x => x.income || 1));
                    return (
                      <div key={i} style={{ flex:1, display:"flex", flexDirection:"column", gap:3 }}>
                        <Bar value={h.needs}   max={maxVal} color="#e94560"/>
                        <Bar value={h.wants}   max={maxVal} color="#f5a623"/>
                        <Bar value={h.savings} max={maxVal} color="#0fbcf9"/>
                        <p style={{ fontSize:9, color:"rgba(255,255,255,0.3)", textAlign:"center", marginTop:2 }}>
                          {h.period?.slice(2).replace("-","/")}
                        </p>
                      </div>
                    );
                  })}
                </div>
                <div style={{ display:"flex", gap:12, marginTop:12, justifyContent:"center" }}>
                  {[["Needs","#e94560"],["Wants","#f5a623"],["Savings","#0fbcf9"]].map(([l,c])=>(
                    <div key={l} style={{ display:"flex", alignItems:"center", gap:4 }}>
                      <div style={{ width:8, height:8, borderRadius:2, background:c }}/>
                      <span style={{ fontSize:11, color:"rgba(255,255,255,0.4)" }}>{l}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Per-period cards */}
            {history.map((h, i) => {
              const income  = h.income || 0;
              const savedPct = income > 0 ? Math.max(0, ((income - h.total) / income * 100)).toFixed(0) : 0;
              const overBudget = h.total > income && income > 0;
              return (
                <div key={i} style={{ ...S.card, marginBottom:12, padding:16 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
                    <p style={{ fontWeight:800, fontSize:15 }}>{periodLabel(h.period)}</p>
                    <span style={{ fontSize:11, padding:"3px 10px", borderRadius:99,
                      background: overBudget ? "rgba(233,69,96,0.15)" : "rgba(74,222,158,0.12)",
                      color: overBudget ? "#e94560" : "#4ade9e", fontWeight:700 }}>
                      {overBudget ? "Over budget" : `${savedPct}% saved`}
                    </span>
                  </div>

                  {/* Stacked bar */}
                  {income > 0 && (
                    <div style={{ height:8, borderRadius:99, overflow:"hidden", background:"rgba(255,255,255,0.06)", display:"flex", marginBottom:12 }}>
                      {[["needs","#e94560"],["wants","#f5a623"],["savings","#0fbcf9"]].map(([k,c])=>(
                        <div key={k} style={{ width:`${Math.min((h[k]/income)*100, 100)}%`, background:c, transition:"width 0.5s" }}/>
                      ))}
                    </div>
                  )}

                  {/* Stats row */}
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:8 }}>
                    {[
                      { label:"Income",  value:fmt(income, h.currency),  color:"rgba(255,255,255,0.7)" },
                      { label:"Needs",   value:fmt(h.needs, h.currency),  color:"#e94560" },
                      { label:"Wants",   value:fmt(h.wants, h.currency),  color:"#f5a623" },
                      { label:"Savings", value:fmt(h.savings, h.currency),color:"#0fbcf9" },
                    ].map(item=>(
                      <div key={item.label} style={{ textAlign:"center" }}>
                        <p style={{ fontSize:10, color:"rgba(255,255,255,0.3)", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.4px", marginBottom:3 }}>{item.label}</p>
                        <p style={{ fontSize:12, fontWeight:800, color:item.color }}>{item.value}</p>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

export default function BudgetApp() {
  const [data, setData]             = useState(loadData);
  const [tab,  setTab]              = useState("home");
  const [modal, setModal]           = useState(null);
  const [form,  setForm]            = useState({ name:"", amount:"", currency:"RON", category:"wants", subcat:"", customRate:"" });
  const [scanState,   setScanState] = useState("idle");
  const [scanResult,  setScanResult]= useState(null);
  const [scanError,   setScanError] = useState(null);
  const [showRates,   setShowRates] = useState(false);
  const [showPaydayReset, setShowPaydayReset] = useState(false);
  const [editingExpense, setEditingExpense] = useState(null);
  const [liveRates, setLiveRates] = useState(null);       // { EUR, USD, date } from API
  const [ratesLoading, setRatesLoading] = useState(false);

  useEffect(() => { saveData(data); }, [data]);

  // ── Fetch live rates on mount ───────────────────────────────────────────────
  useEffect(() => {
    setRatesLoading(true);
    fetchLiveRates().then(result => {
      if (result) {
        setLiveRates(result);
        // Auto-update stored rates if user hasn't manually overridden them
        // (i.e. if stored rates are still the defaults)
        setData(d => {
          const stored = d.rates || {};
          const isDefaultEUR = !stored.EUR || Math.abs(stored.EUR - DEFAULT_RATES.EUR) < 0.01;
          const isDefaultUSD = !stored.USD || Math.abs(stored.USD - DEFAULT_RATES.USD) < 0.01;
          if (isDefaultEUR && isDefaultUSD) {
            return { ...d, rates: { EUR: result.EUR, USD: result.USD } };
          }
          return d;
        });
      }
      setRatesLoading(false);
    });
  }, []);

  // ── Payday reset check ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!data.onboardingDone || !data.payday) return;
    const periodKey = getPeriodKey(data.payday);
    if (data.currentMonth && data.currentMonth !== periodKey) {
      // Archive current period's spending breakdown before reset
      const allExp = [...(data.recurringExpenses||[]), ...(data.dailyExpenses||[])];
      const spent  = { needs:0, wants:0, savings:0 };
      const r      = { RON:1, ...DEFAULT_RATES, ...(data.rates||{}) };
      const ic     = data.incomeCurrency || "RON";
      allExp.forEach(e => {
        const t  = e.category || classify(e.name);
        const er = e.customRate ? { ...r, [e.customRateCur||e.currency]: e.customRate } : r;
        spent[t] = (spent[t]||0) + convert(parseFloat(e.amount)||0, e.currency||ic, ic, er);
      });
      const snapshot = {
        period:   data.currentMonth,
        income:   parseFloat(data.monthlyIncome) || 0,
        currency: ic,
        needs:    spent.needs,
        wants:    spent.wants,
        savings:  spent.savings,
        total:    spent.needs + spent.wants + spent.savings,
      };
      const prevHistory = data.history || [];
      // Avoid duplicate snapshots for same period
      const alreadyArchived = prevHistory.some(h => h.period === data.currentMonth);
      setData(d => ({
        ...d,
        dailyExpenses: [],
        currentMonth: periodKey,
        history: alreadyArchived ? prevHistory : [snapshot, ...prevHistory].slice(0, 24),
      }));
      setShowPaydayReset(true);
    } else if (!data.currentMonth) {
      setData(d => ({ ...d, currentMonth: periodKey }));
    }
  }, []);

  const updateData = useCallback((patch) => setData(d => ({ ...d, ...patch })), []);

  const rates          = { RON:1, ...DEFAULT_RATES, ...(data.rates||{}) };
  const incomeCurrency = data.incomeCurrency||"RON";
  const allExpenses    = [...(data.recurringExpenses||[]), ...data.dailyExpenses]; // recurring always counted

  const spentByType = { needs:0, wants:0, savings:0 };
  allExpenses.forEach(e => {
    const t  = e.category||classify(e.name);
    const er = e.customRate ? { ...rates, [e.customRateCur||e.currency]:e.customRate } : rates;
    spentByType[t] = (spentByType[t]||0) + convert(parseFloat(e.amount)||0, e.currency||incomeCurrency, incomeCurrency, er);
  });
  const totalSpent = spentByType.needs + spentByType.wants + spentByType.savings;

  function openAdd(type) {
    setEditingExpense(null);
    setForm({ name:"", amount:"", currency:incomeCurrency, category:"wants", subcat:"", customRate:"" });
    setScanState("idle"); setScanResult(null); setScanError(null);
    setModal(type);
  }

  function openEdit(exp, type) {
    setEditingExpense({ id: exp.id, type });
    setForm({
      name:       exp.name,
      amount:     exp.amount.toString(),
      currency:   exp.currency || incomeCurrency,
      category:   exp.category,
      subcat:     exp.subcat || "",
      customRate: exp.customRate ? exp.customRate.toString() : "",
    });
    setScanState("idle"); setScanResult(null); setScanError(null);
    setModal(type);
  }

  function addExpense(type) {
    if (!form.name||!form.amount) return;
    const fc = form.currency !== "RON" ? form.currency : incomeCurrency;
    const cr = form.customRate ? parseFloat(form.customRate)||null : null;

    if (editingExpense) {
      // Edit mode — update existing entry in place
      const updatedEntry = (e) => e.id === editingExpense.id
        ? { ...e, name:form.name, amount:parseFloat(form.amount), currency:form.currency||incomeCurrency, customRateCur:fc, customRate:cr, category:form.category, subcat:form.subcat }
        : e;
      if (editingExpense.type === "recurring")
        updateData({ recurringExpenses: (data.recurringExpenses||[]).map(updatedEntry) });
      else
        updateData({ dailyExpenses: data.dailyExpenses.map(updatedEntry) });
      setEditingExpense(null);
    } else {
      // Add mode — insert new entry
      const entry = { id:Date.now(), name:form.name, amount:parseFloat(form.amount), currency:form.currency||incomeCurrency, customRateCur:fc, customRate:cr, category:form.category, subcat:form.subcat, date:new Date().toISOString().split("T")[0] };
      if (type==="recurring") updateData({ recurringExpenses:[...(data.recurringExpenses||[]), entry] });
      else                    updateData({ dailyExpenses:[...data.dailyExpenses, entry] });
    }
    setModal(null);
  }

  async function handleScanFile(file) {
    if (!file) return;
    setScanState("scanning"); setScanError(null);
    try {
      const result = await scanReceipt(file);
      if (result.error) { setScanError(result.error); setScanState("error"); return; }
      const dc = CURRENCIES.includes(result.currency) ? result.currency : incomeCurrency;
      setScanResult(result);
      setForm({ name:result.name||"", amount:result.amount?.toString()||"", currency:dc, category:classify(result.category||result.name||""), subcat:result.category||"", customRate:"" });
      setScanState("result");
    } catch(err) { setScanError(err.message||"Unknown error"); setScanState("error"); }
  }

  function confirmScan(type) { addExpense(type); setScanState("idle"); setScanResult(null); setModal(null); }
  function cancelScan()  { setScanState("idle"); setScanResult(null); }
  function retryScan()   { setScanState("idle"); setScanError(null); }

  const globalStyles = `* { margin:0; padding:0; box-sizing:border-box; } body { background:#0a0a0f; } input[type=number]::-webkit-inner-spin-button { -webkit-appearance:none; } input::placeholder { color:rgba(255,255,255,0.2); } select option { background:#13131f; } ::-webkit-scrollbar { width:0; }`;

  // ── Show onboarding if not done yet ───────────────────────────────────────
  if (!data.onboardingDone) {
    return (
      <div style={S.app}>
        <style>{globalStyles}</style>
        <Onboarding onComplete={(setup) => {
          updateData(setup);
        }}/>
      </div>
    );
  }

  return (
    <div style={S.app}>
      <style>{globalStyles}</style>

      {tab==="home"     && <HomeTab data={data} updateData={updateData} spentByType={spentByType} totalSpent={totalSpent} allExpenses={allExpenses} incomeCurrency={incomeCurrency} rates={rates} onOpenRates={()=>setShowRates(true)}/>}
      {tab==="expenses" && <ExpensesTab data={data} updateData={updateData} incomeCurrency={incomeCurrency} rates={rates} onOpenAdd={openAdd} onOpenEdit={openEdit}/>}
      {tab==="history"  && <HistoryTab data={data}/>}

      <nav style={S.navBar}>
        {[{id:"home",label:"Overview",icon:IC.home},{id:"expenses",label:"Expenses",icon:IC.receipt},{id:"history",label:"History",icon:IC.history}].map(item=>(
          <button key={item.id} style={S.navBtn(tab===item.id)} onClick={()=>setTab(item.id)}>
            <Icon d={item.icon} size={20} stroke="currentColor"/>{item.label}
          </button>
        ))}
      </nav>

      <ExpenseModal
        modal={modal} onClose={()=>{ setModal(null); setEditingExpense(null); }}
        form={form} setForm={setForm}
        onAdd={addExpense}
        isEditing={!!editingExpense}
        scanState={scanState} scanResult={scanResult} scanError={scanError}
        onScanFile={handleScanFile} onConfirmScan={confirmScan} onCancelScan={cancelScan} onRetryScan={retryScan}
        rates={rates} incomeCurrency={incomeCurrency}
      />

      <RatesModal
        show={showRates} onClose={()=>setShowRates(false)}
        rates={rates}
        liveRates={liveRates}
        ratesLoading={ratesLoading}
        onSave={(cur,val)=>updateData({ rates:{ ...data.rates, [cur]:val } })}
        onResetToLive={(cur)=>updateData({ rates:{ ...data.rates, [cur]: liveRates[cur] } })}
      />

      <PaydayResetModal
        show={showPaydayReset}
        userName={data.name || ""}
        income={data.monthlyIncome}
        currency={incomeCurrency}
        onKeep={() => setShowPaydayReset(false)}
        onUpdate={(newIncome, newCurrency) => {
          const ronVal = newCurrency === "RON"
            ? newIncome
            : (parseFloat(newIncome) * (rates[newCurrency] || DEFAULT_RATES[newCurrency] || 1)).toString();
          updateData({ monthlyIncome: newIncome, incomeCurrency: newCurrency, monthlyIncomeRON: ronVal });
          setShowPaydayReset(false);
        }}
      />
    </div>
  );
}


ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(BudgetApp));
