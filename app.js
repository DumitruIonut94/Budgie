const { useState, useEffect, useRef, useCallback } = React;

// ─────────────────────────────────────────────────────────────────────────────
// Supabase
// ─────────────────────────────────────────────────────────────────────────────
const SUPABASE_URL  = "https://arddqydzfxavwcrpmjof.supabase.co";
const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFyZGRxeWR6ZnhhdndjcnBtam9mIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ0MTk5MTUsImV4cCI6MjA4OTk5NTkxNX0.ghMsTw0wwdDIiz9QJJ-cNZzidR1CpBJJIzOGFEKZVuQ";

// Safe storage — falls back to sessionStorage and memory if localStorage is blocked
const _memStore = {};
const safeStorage = {
  get(key) {
    try { return localStorage.getItem(key); } catch {}
    try { return sessionStorage.getItem(key); } catch {}
    return _memStore[key] || null;
  },
  set(key, val) {
    try { localStorage.setItem(key, val); return; } catch {}
    try { sessionStorage.setItem(key, val); return; } catch {}
    _memStore[key] = val;
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch {}
    try { sessionStorage.removeItem(key); } catch {}
    delete _memStore[key];
  }
};

// Supabase client (lightweight, no npm needed)
const sb = (() => {
  const headers = { "apikey": SUPABASE_ANON, "Content-Type": "application/json" };
  const authHeaders = (token) => ({ ...headers, "Authorization": `Bearer ${token}` });

  async function signUp(email, password, name) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: "POST", headers,
      body: JSON.stringify({
        email, password,
        options: {
          data: { name },
          emailRedirectTo: window.location.origin,
        }
      })
    });
    const data = await r.json();
    // If signup succeeded and we got a session, use it directly (email confirm disabled)
    if (data.access_token) {
      safeStorage.set("sb_token", data.access_token);
    }
    return data;
  }
  async function signIn(email, password) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST", headers,
      body: JSON.stringify({ email, password })
    });
    return r.json();
  }
  async function signInWithOAuth(provider) {
    const redirectTo = window.location.origin;
    window.location.href = `${SUPABASE_URL}/auth/v1/authorize?provider=${provider}&redirect_to=${redirectTo}`;
  }
  async function signOut(token) {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: "POST", headers: authHeaders(token)
    });
  }
  async function getSession() {
    // Check URL hash for OAuth callback
    const hash = window.location.hash;
    if (hash.includes("access_token")) {
      const params = new URLSearchParams(hash.replace("#", ""));
      const token = params.get("access_token");
      const refresh = params.get("refresh_token");
      if (token) {
        safeStorage.set("sb_token", token);
        safeStorage.set("sb_refresh", refresh || "");
        window.history.replaceState({}, "", window.location.pathname);
        return { access_token: token };
      }
    }
    const token = safeStorage.get("sb_token");
    if (!token) return null;
    // Verify token is still valid
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: authHeaders(token)
    });
    if (!r.ok) { safeStorage.remove("sb_token"); return null; }
    return { access_token: token };
  }
  async function getUser(token) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: authHeaders(token)
    });
    return r.json();
  }
  async function resetPassword(email) {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
      method: "POST", headers,
      body: JSON.stringify({ email, redirect_to: window.location.origin })
    });
    return r.json();
  }

  // DB helpers
  async function from(table, token) {
    const base = `${SUPABASE_URL}/rest/v1/${table}`;
    const h = authHeaders(token);
    return {
      select: async (cols = "*", filters = "") => {
        const r = await fetch(`${base}?select=${cols}${filters ? "&" + filters : ""}`, { headers: { ...h, "Prefer": "return=representation" } });
        return r.json();
      },
      insert: async (data) => {
        const r = await fetch(base, { method: "POST", headers: { ...h, "Prefer": "return=representation" }, body: JSON.stringify(data) });
        return r.json();
      },
      update: async (data, filters) => {
        const r = await fetch(`${base}?${filters}`, { method: "PATCH", headers: { ...h, "Prefer": "return=representation" }, body: JSON.stringify(data) });
        return r.json();
      },
      delete: async (filters) => {
        const r = await fetch(`${base}?${filters}`, { method: "DELETE", headers: h });
        return r.ok;
      },
      upsert: async (data) => {
        const r = await fetch(base, { method: "POST", headers: { ...h, "Prefer": "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(data) });
        return r.json();
      }
    };
  }

  async function refreshToken() {
    const refresh = safeStorage.get("sb_refresh");
    if (!refresh) return null;
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST", headers,
      body: JSON.stringify({ refresh_token: refresh })
    });
    const data = await r.json();
    if (data.access_token) {
      safeStorage.set("sb_token", data.access_token);
      if (data.refresh_token) safeStorage.set("sb_refresh", data.refresh_token);
      return data.access_token;
    }
    return null;
  }

  async function callFunction(name, token, body) {
    // Try with current token first
    let r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    // If 401, try refreshing token once
    if (r.status === 401) {
      const newToken = await refreshToken();
      if (newToken) {
        r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
          method: "POST",
          headers: { ...authHeaders(newToken), "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
      } else {
        // Token can't be refreshed — return error
        return { error: "Session expired. Please sign out and sign in again." };
      }
    }
    return r.json();
  }

  return { signUp, signIn, signInWithOAuth, signOut, getSession, getUser, resetPassword, from, callFunction };
})();

// ─────────────────────────────────────────────────────────────────────────────
// Constants & helpers
// ─────────────────────────────────────────────────────────────────────────────
const CURRENCIES = ["RON", "EUR", "USD"];
const CUR_SYM    = { RON: "lei", EUR: "€", USD: "$" };
const CUR_COLOR  = { RON: "#e94560", EUR: "#0fbcf9", USD: "#f5a623" };
const DEFAULT_RATES = { RON: 1, EUR: 5.09, USD: 4.41 };

const PLAN_LIMITS = {
  free:   { budgets: 1, members: 1, history: false, export: false },
  pro:    { budgets: 99, members: 1, history: true,  export: true  },
  family: { budgets: 99, members: 5, history: true,  export: true  },
};

const CATEGORIES = {
  needs:   ["Rent/Mortgage","Utilities","Groceries","Transport","Insurance","Healthcare"],
  wants:   ["Dining Out","Entertainment","Shopping","Subscriptions","Travel","Hobbies"],
  savings: ["Emergency Fund","Investments","Retirement","Debt Repayment","Goals"],
};
const CAT_COLOR = { needs: "#e94560", wants: "#f5a623", savings: "#0fbcf9" };

async function fetchLiveRates() {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${today}/v1/currencies/eur.json`,
    "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/eur.json",
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const json = await res.json();
      const eurRON = json.eur?.ron, eurUSD = json.eur?.usd;
      if (eurRON && eurUSD) return { EUR: eurRON, USD: eurRON / eurUSD, date: json.date || today };
    } catch {}
  }
  return null;
}

function classify(name = "") {
  const n = name.toLowerCase();
  if (/(rent|mortgage|electric|gas|water|internet|grocer|supermarket|bus|metro|uber|taxi|insurance|doctor|hospital|medicine|fuel|chirie|curent|apa|mancare|transport)/.test(n)) return "needs";
  if (/(restaurant|cafe|coffee|pizza|netflix|spotify|amazon|cinema|movie|game|gym|bar|pub|shop|mall|cloth|travel|holiday)/.test(n)) return "wants";
  if (/(saving|invest|stock|fund|retirement|pension|loan|debt|credit|economii)/.test(n)) return "savings";
  return "wants";
}

function toRON(amount, cur, rates) { return cur === "RON" ? amount : amount * (rates[cur] || DEFAULT_RATES[cur] || 1); }
function fromRON(amount, cur, rates) { return cur === "RON" ? amount : amount / (rates[cur] || DEFAULT_RATES[cur] || 1); }
function convert(amount, from, to, rates) { return fromRON(toRON(amount, from, rates), to, rates); }
function fmt(amount, cur) {
  const n = Math.abs(amount).toLocaleString("ro-RO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return cur === "RON" ? `${n} lei` : `${CUR_SYM[cur]}${n}`;
}
function rgb(hex) {
  const r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return r ? `${parseInt(r[1],16)},${parseInt(r[2],16)},${parseInt(r[3],16)}` : "255,255,255";
}
function getPeriodKey(payday) {
  const now = new Date(), day = now.getDate(), year = now.getFullYear(), month = now.getMonth();
  if (day >= payday) return `${year}-${String(month+1).padStart(2,"0")}`;
  const d = new Date(year, month-1, 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
}

// AI receipt scanner
async function toJpeg(file) {
  const url = URL.createObjectURL(file);
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1600; let {width:w, height:h} = img;
      if (w > MAX || h > MAX) { const s = MAX/Math.max(w,h); w=Math.round(w*s); h=Math.round(h*s); }
      const c = document.createElement("canvas"); c.width=w; c.height=h;
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
    method:"POST",
    headers:{"Content-Type":"application/json","anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},
    body: JSON.stringify({
      model:"claude-sonnet-4-20250514", max_tokens:800,
      messages:[{role:"user",content:[
        {type:"image",source:{type:"base64",media_type:"image/jpeg",data:b64}},
        {type:"text",text:`Receipt (possibly Romanian: RON/lei, bon fiscal, TVA, total de plata).
Return ONLY JSON: {"name":"merchant","amount":42.50,"currency":"RON","category":"Groceries","date":"YYYY-MM-DD","items":["item"]}
- amount = total paid; currency = RON/EUR/USD; if unreadable: {"error":"unreadable"}`}
      ]}]
    })
  });
  const raw = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const d = JSON.parse(raw);
  if (d.error) throw new Error(`${d.error.type}: ${d.error.message}`);
  const txt = d.content?.[0]?.text || "";
  try { return JSON.parse(txt.replace(/```json|```/g,"").trim()); }
  catch { const m = txt.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); return {error:txt.slice(0,100)}; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Static styles
// ─────────────────────────────────────────────────────────────────────────────
const S = {
  app:     { fontFamily:"'DM Sans','Segoe UI',sans-serif", background:"#0a0a0f", color:"#f0f0f5", minHeight:"100vh", maxWidth:420, margin:"0 auto", position:"relative", paddingBottom:80, overflowX:"hidden" },
  header:  { padding:"52px 24px 20px", background:"linear-gradient(160deg,#13131f 0%,#0a0a0f 100%)" },
  card:    { background:"rgba(255,255,255,0.04)", borderRadius:20, padding:20, border:"1px solid rgba(255,255,255,0.07)" },
  input:   { width:"100%", background:"rgba(255,255,255,0.06)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:12, padding:"12px 14px", color:"#f0f0f5", fontSize:15, outline:"none", boxSizing:"border-box", fontFamily:"inherit" },
  btn:     (color="#e94560",full=false) => ({ background:color, color:"#fff", border:"none", borderRadius:14, padding:"14px 24px", fontSize:15, fontWeight:700, cursor:"pointer", width:full?"100%":"auto", fontFamily:"inherit" }),
  ghost:   { background:"rgba(255,255,255,0.06)", color:"rgba(255,255,255,0.6)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:14, padding:"14px 16px", fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:"inherit" },
  navBar:  { position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)", width:"100%", maxWidth:420, background:"rgba(10,10,15,0.95)", backdropFilter:"blur(20px)", borderTop:"1px solid rgba(255,255,255,0.07)", display:"flex", justifyContent:"space-around", padding:"10px 0 16px", zIndex:100 },
  navBtn:  (a) => ({ display:"flex", flexDirection:"column", alignItems:"center", gap:4, background:"none", border:"none", color:a?"#e94560":"rgba(255,255,255,0.35)", cursor:"pointer", fontSize:10, fontWeight:600, letterSpacing:"0.5px", textTransform:"uppercase" }),
  overlay: { position:"fixed", inset:0, background:"rgba(0,0,0,0.75)", zIndex:200, display:"flex", alignItems:"flex-end", backdropFilter:"blur(4px)" },
  sheet:   { background:"#13131f", borderRadius:"24px 24px 0 0", padding:"28px 24px 40px", width:"100%", maxWidth:420, margin:"0 auto", border:"1px solid rgba(255,255,255,0.08)", maxHeight:"90vh", overflowY:"auto" },
  label:   { fontSize:12, fontWeight:600, color:"rgba(255,255,255,0.4)", letterSpacing:"0.8px", textTransform:"uppercase", marginBottom:6, display:"block" },
  pill:    (a,color="#e94560") => ({ padding:"6px 14px", borderRadius:50, fontSize:13, fontWeight:600, background:a?color:"rgba(255,255,255,0.06)", color:a?"#fff":"rgba(255,255,255,0.5)", border:"none", cursor:"pointer", fontFamily:"inherit" }),
};

// ─────────────────────────────────────────────────────────────────────────────
// Icons & small components
// ─────────────────────────────────────────────────────────────────────────────
const Icon = ({d,size=18,stroke="currentColor"}) => (
  React.createElement("svg",{width:size,height:size,viewBox:"0 0 24 24",fill:"none",stroke,strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"},
    React.createElement("path",{d}))
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
  crown:   "M2 20h20 M5 20V9l7-7 7 7v11",
  logout:  "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4 M16 17l5-5-5-5 M21 12H9",
  users:   "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75",
  check:   "M20 6L9 17l-5-5",
  lock:    "M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2z M7 11V7a5 5 0 0 1 10 0v4",
};

function CircleProgress({pct,color,size=64,stroke=5}) {
  const r=(size-stroke)/2, circ=2*Math.PI*r, dash=Math.min(pct/100,1)*circ;
  return React.createElement("svg",{width:size,height:size,style:{transform:"rotate(-90deg)"}},
    React.createElement("circle",{cx:size/2,cy:size/2,r,fill:"none",stroke:"rgba(255,255,255,0.07)",strokeWidth:stroke}),
    React.createElement("circle",{cx:size/2,cy:size/2,r,fill:"none",stroke:color,strokeWidth:stroke,
      strokeDasharray:`${dash} ${circ}`,strokeLinecap:"round",
      style:{transition:"stroke-dasharray 0.6s cubic-bezier(0.34,1.56,0.64,1)"}})
  );
}

function CurPill({label,active,color,onClick}) {
  return React.createElement("button",{onClick,style:{padding:"5px 11px",borderRadius:50,fontSize:12,fontWeight:700,
    background:active?color:"rgba(255,255,255,0.06)",color:active?"#fff":"rgba(255,255,255,0.4)",
    border:`1px solid ${active?color:"rgba(255,255,255,0.08)"}`,cursor:"pointer"}},label);
}

function BudgieLogo({size=40}) {
  return React.createElement("svg",{width:size,height:size,viewBox:"0 0 64 64",fill:"none",xmlns:"http://www.w3.org/2000/svg"},
    React.createElement("defs",null,
      React.createElement("linearGradient",{id:"bodyGrad",x1:"10",y1:"10",x2:"54",y2:"54",gradientUnits:"userSpaceOnUse"},
        React.createElement("stop",{offset:"0%",stopColor:"#4ade9e"}),
        React.createElement("stop",{offset:"100%",stopColor:"#0fbcf9"}))),
    React.createElement("ellipse",{cx:"34",cy:"40",rx:"18",ry:"20",fill:"url(#bodyGrad)"}),
    React.createElement("ellipse",{cx:"35",cy:"46",rx:"10",ry:"12",fill:"#fffbe6",opacity:"0.9"}),
    React.createElement("ellipse",{cx:"20",cy:"38",rx:"10",ry:"16",fill:"#22d4a0",transform:"rotate(-15 20 38)"}),
    React.createElement("circle",{cx:"38",cy:"18",r:"13",fill:"url(#bodyGrad)"}),
    React.createElement("circle",{cx:"44",cy:"22",r:"4",fill:"#f97316",opacity:"0.8"}),
    React.createElement("circle",{cx:"40",cy:"15",r:"4",fill:"#fff"}),
    React.createElement("circle",{cx:"41",cy:"15",r:"2.2",fill:"#1e293b"}),
    React.createElement("circle",{cx:"42",cy:"14",r:"0.8",fill:"#fff"}),
    React.createElement("path",{d:"M33 20 L28 23 L33 25 Z",fill:"#f5a623"}),
    React.createElement("circle",{cx:"54",cy:"12",r:"7",fill:"#f5a623",opacity:"0.95"}),
    React.createElement("text",{x:"54",y:"16",textAnchor:"middle",fontSize:"8",fontWeight:"bold",fill:"#fff"},"$")
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth Screen
// ─────────────────────────────────────────────────────────────────────────────
function AuthScreen({onAuth}) {
  const [mode, setMode]       = useState("login"); // login | register | forgot
  const [email, setEmail]     = useState("");
  const [password, setPassword] = useState("");
  const [name, setName]       = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState("");
  const [success, setSuccess] = useState("");

  async function handleSubmit() {
    if (!email || (!password && mode !== "forgot")) {
      setError("Please fill in all fields.");
      return;
    }
    setError(""); setSuccess(""); setLoading(true);
    try {
      if (mode === "forgot") {
        const res = await sb.resetPassword(email);
        setSuccess("If that email exists, a reset link has been sent.");
      } else if (mode === "register") {
        const res = await sb.signUp(email, password, name);
        // Supabase returns error in res.error
        if (res.error) {
          setError(res.error.message || "Sign up failed. Please try again.");
          setLoading(false);
          return;
        }
        // Email confirmation disabled — we get access_token immediately
        if (res.access_token) {
          safeStorage.set("sb_token", res.access_token);
          setLoading(false);
          onAuth(res.access_token);
          return;
        }
        // Email confirmation enabled
        setSuccess("Account created! Please check your email to confirm.");
      } else {
        const res = await sb.signIn(email, password);
        if (res.error) {
          setError(res.error.message || "Invalid email or password.");
          setLoading(false);
          return;
        }
        if (!res.access_token) {
          setError("Sign in failed. Please try again.");
          setLoading(false);
          return;
        }
        safeStorage.set("sb_token", res.access_token);
        if (res.refresh_token) safeStorage.set("sb_refresh", res.refresh_token);
        setLoading(false);
        onAuth(res.access_token);
        return;
      }
    } catch(e) {
      setError(e.message || "Something went wrong. Please try again.");
    }
    setLoading(false);
  }

  return React.createElement("div",{style:{minHeight:"100vh",background:"#0a0a0f",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"24px"}},
    React.createElement("style",null,`@keyframes fadeUp { from { opacity:0; transform:translateY(20px); } to { opacity:1; transform:translateY(0); } }`),
    React.createElement("div",{style:{width:"100%",maxWidth:380,animation:"fadeUp 0.4s ease"}},
      // Logo
      React.createElement("div",{style:{textAlign:"center",marginBottom:32}},
        React.createElement(BudgieLogo,{size:60}),
        React.createElement("p",{style:{fontSize:28,fontWeight:900,marginTop:12,background:"linear-gradient(90deg,#4ade9e,#0fbcf9)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",display:"inline-block",paddingRight:4}},"Budgie"),
        React.createElement("p",{style:{fontSize:13,color:"rgba(255,255,255,0.35)",marginTop:2}},
          mode==="login"?"Welcome back!" : mode==="register"?"Create your account" : "Reset your password")
      ),

      // Social login
      mode !== "forgot" && React.createElement("div",{style:{display:"flex",flexDirection:"column",gap:8,marginBottom:20}},
        React.createElement("button",{
          style:{...S.ghost,display:"flex",alignItems:"center",justifyContent:"center",gap:10,width:"100%"},
          onClick:()=>sb.signInWithOAuth("google")},
          React.createElement("svg",{width:18,height:18,viewBox:"0 0 24 24"},
            React.createElement("path",{fill:"#4285F4",d:"M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"}),
            React.createElement("path",{fill:"#34A853",d:"M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"}),
            React.createElement("path",{fill:"#FBBC05",d:"M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"}),
            React.createElement("path",{fill:"#EA4335",d:"M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"})
          ),
          "Continue with Google"
        )
      ),

      // Divider
      mode !== "forgot" && React.createElement("div",{style:{display:"flex",alignItems:"center",gap:10,marginBottom:20}},
        React.createElement("div",{style:{flex:1,height:1,background:"rgba(255,255,255,0.07)"}}),
        React.createElement("span",{style:{fontSize:11,color:"rgba(255,255,255,0.25)",fontWeight:600}},"OR"),
        React.createElement("div",{style:{flex:1,height:1,background:"rgba(255,255,255,0.07)"}})
      ),

      // Form
      React.createElement("div",{style:{display:"flex",flexDirection:"column",gap:12}},
        mode==="register" && React.createElement("input",{style:S.input,placeholder:"Your name",value:name,onChange:e=>setName(e.target.value)}),
        React.createElement("input",{style:S.input,type:"email",placeholder:"Email",value:email,onChange:e=>setEmail(e.target.value)}),
        mode!=="forgot" && React.createElement("input",{style:S.input,type:"password",placeholder:"Password",value:password,
          onChange:e=>setPassword(e.target.value),
          onKeyDown:e=>{if(e.key==="Enter")handleSubmit();}}),

        error && React.createElement("p",{style:{fontSize:13,color:"#e94560",padding:"8px 12px",background:"rgba(233,69,96,0.1)",borderRadius:8}},error),
        success && React.createElement("p",{style:{fontSize:13,color:"#4ade9e",padding:"8px 12px",background:"rgba(74,222,158,0.1)",borderRadius:8}},success),

        React.createElement("button",{style:S.btn("#e94560",true),onClick:handleSubmit,disabled:loading},
          loading ? "Loading..." : mode==="login" ? "Sign In" : mode==="register" ? "Create Account" : "Send Reset Email"
        )
      ),

      // Switch mode links
      React.createElement("div",{style:{textAlign:"center",marginTop:20,display:"flex",flexDirection:"column",gap:8}},
        mode==="login" && React.createElement("p",{style:{fontSize:13,color:"rgba(255,255,255,0.4)"}},
          "Don't have an account? ",
          React.createElement("button",{style:{background:"none",border:"none",color:"#4ade9e",cursor:"pointer",fontWeight:700,fontSize:13},onClick:()=>{setMode("register");setError("")}},"Sign Up")
        ),
        mode==="register" && React.createElement("p",{style:{fontSize:13,color:"rgba(255,255,255,0.4)"}},
          "Already have an account? ",
          React.createElement("button",{style:{background:"none",border:"none",color:"#4ade9e",cursor:"pointer",fontWeight:700,fontSize:13},onClick:()=>{setMode("login");setError("")}},"Sign In")
        ),
        mode==="login" && React.createElement("button",{style:{background:"none",border:"none",color:"rgba(255,255,255,0.3)",cursor:"pointer",fontSize:12},
          onClick:()=>{setMode("forgot");setError("")}},"Forgot password?"),
        mode==="forgot" && React.createElement("button",{style:{background:"none",border:"none",color:"#4ade9e",cursor:"pointer",fontSize:13,fontWeight:700},
          onClick:()=>{setMode("login");setError("")}},"← Back to Sign In")
      )
    )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Upgrade Screen
// ─────────────────────────────────────────────────────────────────────────────
function UpgradeScreen({token, currentPlan, onClose}) {
  const [loading, setLoading] = useState(null);
  const [billingCycle, setBillingCycle] = useState("monthly");

  async function checkout(priceKey) {
    setLoading(priceKey);
    try {
      const res = await sb.callFunction("create-checkout", token, {
        priceKey,
        successUrl: window.location.origin + "?upgraded=1",
        cancelUrl:  window.location.origin,
      });
      if (res && res.url) {
        window.location.href = res.url;
        return;
      }
      // Show detailed error for debugging
      const errMsg = res?.error || res?.message || JSON.stringify(res) || "Failed to create checkout";
      alert("Checkout error: " + errMsg);
    } catch(e) {
      alert("Checkout error: " + (e.message || String(e)));
    }
    setLoading(null);
  }

  async function manageSubscription() {
    setLoading("portal");
    const res = await sb.callFunction("customer-portal", token, { returnUrl: window.location.origin });
    if (res.url) window.location.href = res.url;
    setLoading(null);
  }

  const plans = [
    {
      key: "pro", name: "Pro", color: "#0fbcf9",
      monthlyPrice: "€2.99", yearlyPrice: "€29.99",
      yearlyMonthly: "€2.50",
      features: ["Unlimited budgets","Full spending history","CSV & PDF export","Cloud backup & sync"],
      priceKey: billingCycle === "monthly" ? "pro_monthly" : "pro_yearly",
    },
    {
      key: "family", name: "Family", color: "#4ade9e",
      monthlyPrice: "€4.99", yearlyPrice: "€49.99",
      yearlyMonthly: "€4.17",
      features: ["Everything in Pro","2-5 members per budget","Shared budget view","Family spending insights"],
      priceKey: billingCycle === "monthly" ? "family_monthly" : "family_yearly",
    }
  ];

  return React.createElement("div",{style:{minHeight:"100vh",background:"#0a0a0f",overflowY:"auto",maxWidth:420,margin:"0 auto"}},
    // Header
    React.createElement("div",{style:{padding:"52px 24px 20px",background:"linear-gradient(160deg,#13131f 0%,#0a0a0f 100%)"}},
      React.createElement("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center"}},
        React.createElement("div",null,
          React.createElement("p",{style:{fontSize:22,fontWeight:900}},"Upgrade Budgie"),
          React.createElement("p",{style:{fontSize:13,color:"rgba(255,255,255,0.4)",marginTop:4}},"Unlock the full experience")
        ),
        onClose && React.createElement("button",{style:{background:"none",border:"none",color:"rgba(255,255,255,0.4)",cursor:"pointer"},onClick:onClose},
          React.createElement(Icon,{d:IC.x,size:22}))
      )
    ),

    React.createElement("div",{style:{padding:"0 16px 40px"}},
      // Billing toggle
      React.createElement("div",{style:{display:"flex",background:"rgba(255,255,255,0.04)",borderRadius:12,padding:4,marginBottom:24}},
        ["monthly","yearly"].map(cycle =>
          React.createElement("button",{key:cycle,
            style:{flex:1,padding:"8px",borderRadius:9,border:"none",cursor:"pointer",fontSize:13,fontWeight:700,
              background:billingCycle===cycle?"#e94560":"transparent",
              color:billingCycle===cycle?"#fff":"rgba(255,255,255,0.4)"},
            onClick:()=>setBillingCycle(cycle)},
            cycle==="monthly" ? "Monthly" : "Yearly (save 17%)"
          )
        )
      ),

      // Current plan
      currentPlan !== "free" && React.createElement("div",{style:{...S.card,marginBottom:16,padding:"12px 16px",display:"flex",justifyContent:"space-between",alignItems:"center"}},
        React.createElement("div",null,
          React.createElement("p",{style:{fontSize:13,fontWeight:700}},`Current plan: ${currentPlan.toUpperCase()}`),
          React.createElement("p",{style:{fontSize:12,color:"rgba(255,255,255,0.4)"}}, "Manage billing, cancel anytime")
        ),
        React.createElement("button",{style:{...S.ghost,padding:"8px 14px",fontSize:12},onClick:manageSubscription},
          loading==="portal" ? "..." : "Manage")
      ),

      // Plan cards
      plans.map(plan =>
        React.createElement("div",{key:plan.key,style:{...S.card,marginBottom:16,border:`1px solid rgba(${rgb(plan.color)},0.3)`,position:"relative",overflow:"hidden"}},
          plan.key==="family" && React.createElement("div",{style:{position:"absolute",top:12,right:12,fontSize:10,padding:"3px 10px",borderRadius:99,background:`rgba(${rgb(plan.color)},0.15)`,color:plan.color,fontWeight:700}},"MOST POPULAR"),

          React.createElement("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}},
            React.createElement("div",null,
              React.createElement("p",{style:{fontSize:18,fontWeight:900,color:plan.color}},"Budgie ",plan.name),
              React.createElement("p",{style:{fontSize:13,color:"rgba(255,255,255,0.4)"}},
                billingCycle==="monthly"
                  ? `${plan.monthlyPrice}/month`
                  : `${plan.yearlyPrice}/year (${plan.yearlyMonthly}/mo)`)
            )
          ),

          plan.features.map(f =>
            React.createElement("div",{key:f,style:{display:"flex",alignItems:"center",gap:8,marginBottom:8}},
              React.createElement(Icon,{d:IC.check,size:15,stroke:plan.color}),
              React.createElement("span",{style:{fontSize:13,color:"rgba(255,255,255,0.7)"}},f)
            )
          ),

          currentPlan === plan.key
            ? React.createElement("div",{style:{marginTop:16,padding:"10px",textAlign:"center",borderRadius:10,background:`rgba(${rgb(plan.color)},0.1)`,color:plan.color,fontSize:13,fontWeight:700}},"✓ Current Plan")
            : React.createElement("button",{
                style:{...S.btn(plan.color,true),marginTop:16},
                onClick:()=>checkout(plan.priceKey),
                disabled:!!loading},
                loading===plan.priceKey ? "Redirecting..." : `Upgrade to ${plan.name}`)
        )
      ),

      // Free plan note
      React.createElement("p",{style:{textAlign:"center",fontSize:12,color:"rgba(255,255,255,0.25)",marginTop:8}},
        "All plans include a 7-day free trial. Cancel anytime.")
    )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Onboarding Wizard
// ─────────────────────────────────────────────────────────────────────────────
function Onboarding({userName, onComplete}) {
  const [step, setStep]       = useState(0);
  const [income, setIncome]   = useState("");
  const [currency, setCurrency] = useState("RON");
  const [payday, setPayday]   = useState("");

  function finish() {
    onComplete({
      monthly_income: parseFloat(income) || 0,
      income_currency: currency,
      monthly_income_ron: currency==="RON" ? parseFloat(income)||0 : (parseFloat(income)||0) * (DEFAULT_RATES[currency]||1),
      payday: parseInt(payday)||1,
      current_period: getPeriodKey(parseInt(payday)||1),
      settings: { onboardingDone: true },
    });
  }

  const canProceed = step===0 ? true
    : step===1 ? (payday !== "" && parseInt(payday) >= 1 && parseInt(payday) <= 31)
    : step===2 ? (income !== "" && parseFloat(income) > 0)
    : true;

  function handleNext() {
    if (!canProceed) return;
    if (step === 3) { finish(); return; }
    setStep(function(s) { return s + 1; });
  }

  // Render current step content
  function renderStep() {
    if (step === 0) return React.createElement("div",{style:{textAlign:"center"}},
      React.createElement(BudgieLogo,{size:80}),
      React.createElement("h1",{style:{fontSize:28,fontWeight:900,marginTop:16,marginBottom:8,background:"linear-gradient(90deg,#4ade9e,#0fbcf9)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",display:"inline-block",paddingRight:4}},"Welcome, ",userName,"!"),
      React.createElement("p",{style:{fontSize:14,color:"rgba(255,255,255,0.4)",lineHeight:1.6}},"Let's set up your budget in a few quick steps.")
    );

    if (step === 1) return React.createElement("div",null,
      React.createElement("p",{style:{fontSize:13,fontWeight:700,color:"#4ade9e",letterSpacing:"1px",textTransform:"uppercase",marginBottom:12}},"Step 1 of 2"),
      React.createElement("h2",{style:{fontSize:24,fontWeight:900,marginBottom:8}},"When do you get paid?"),
      React.createElement("p",{style:{fontSize:14,color:"rgba(255,255,255,0.4)",marginBottom:24,lineHeight:1.6}},"Your budget resets on this day each month — expenses clear automatically when your next salary arrives."),
      React.createElement("input",{style:{...S.input,fontSize:24,fontWeight:800,padding:"16px",textAlign:"center"},
        type:"number",min:"1",max:"31",value:payday,onChange:e=>setPayday(e.target.value),
        placeholder:"e.g. 5",onKeyDown:e=>{if(e.key==="Enter")handleNext();}}),
      payday ? React.createElement("p",{style:{fontSize:13,color:"rgba(255,255,255,0.4)",marginTop:10,textAlign:"center"}},
        "Budget resets on the ",React.createElement("strong",{style:{color:"#4ade9e"}},payday,["st","nd","rd"][parseInt(payday)-1]||"th")," of each month"
      ) : null
    );

    if (step === 2) return React.createElement("div",null,
      React.createElement("p",{style:{fontSize:13,fontWeight:700,color:"#4ade9e",letterSpacing:"1px",textTransform:"uppercase",marginBottom:12}},"Step 2 of 2"),
      React.createElement("h2",{style:{fontSize:24,fontWeight:900,marginBottom:8}},"What's your monthly income?"),
      React.createElement("p",{style:{fontSize:14,color:"rgba(255,255,255,0.4)",marginBottom:20,lineHeight:1.6}},"We'll split it using the 50-30-20 rule."),
      React.createElement("div",{style:{marginBottom:14}},
        React.createElement("label",{style:S.label},"Currency"),
        React.createElement("div",{style:{display:"flex",gap:8}},
          CURRENCIES.map(c=>React.createElement(CurPill,{key:c,label:c,active:currency===c,color:CUR_COLOR[c],onClick:()=>setCurrency(c)}))
        )
      ),
      React.createElement("input",{style:{...S.input,fontSize:24,fontWeight:800,padding:"16px",textAlign:"center"},
        type:"number",value:income,onChange:e=>setIncome(e.target.value),placeholder:"0",
        onKeyDown:e=>{if(e.key==="Enter")handleNext();}}),
      (income && parseFloat(income)>0) ? React.createElement("div",{style:{marginTop:14,display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}},
        [["Needs","50%",parseFloat(income)*0.5,"#e94560"],["Wants","30%",parseFloat(income)*0.3,"#f5a623"],["Savings","20%",parseFloat(income)*0.2,"#0fbcf9"]].map(([l,p,v,c])=>
          React.createElement("div",{key:l,style:{background:`rgba(${rgb(c)},0.08)`,borderRadius:12,padding:"10px 8px",textAlign:"center",border:`1px solid rgba(${rgb(c)},0.2)`}},
            React.createElement("p",{style:{fontSize:10,color:"rgba(255,255,255,0.4)",fontWeight:700,textTransform:"uppercase"}},l),
            React.createElement("p",{style:{fontSize:15,fontWeight:800,color:c,marginTop:2}},p),
            React.createElement("p",{style:{fontSize:11,color:"rgba(255,255,255,0.5)",marginTop:1}},fmt(v,currency))
          )
        )
      ) : null
    );

    if (step === 3) return React.createElement("div",{style:{textAlign:"center"}},
      React.createElement("div",{style:{fontSize:64,marginBottom:16}},"🎉"),
      React.createElement("h2",{style:{fontSize:26,fontWeight:900,marginBottom:8}},"You're all set!"),
      React.createElement("p",{style:{fontSize:14,color:"rgba(255,255,255,0.4)",lineHeight:1.6}},
        "Your budget resets on the ",
        React.createElement("strong",{style:{color:"#4ade9e"}},payday,["st","nd","rd"][parseInt(payday)-1]||"th"),
        " of each month.")
    );

    return null;
  }

  return React.createElement("div",{style:{minHeight:"100vh",background:"#0a0a0f",display:"flex",flexDirection:"column",maxWidth:420,margin:"0 auto",padding:"0 24px"}},
    // Progress dots
    React.createElement("div",{style:{display:"flex",gap:6,justifyContent:"center",paddingTop:56,marginBottom:40}},
      [0,1,2,3].map(i=>React.createElement("div",{key:i,style:{width:i===step?20:7,height:7,borderRadius:99,background:i<=step?"#4ade9e":"rgba(255,255,255,0.1)",transition:"all 0.3s"}}))
    ),
    React.createElement("div",{style:{flex:1,display:"flex",flexDirection:"column",justifyContent:"center"}},
      renderStep()
    ),
    React.createElement("div",{style:{paddingBottom:40,paddingTop:24}},
      React.createElement("button",{
        style:{...S.btn("#4ade9e",true),color:"#0a0a0f",opacity:canProceed?1:0.4,fontSize:16},
        onClick:handleNext},
        step===0?"Get Started →":step===3?"Open Budgie →":"Continue →"
      )
    )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Payday Reset Modal
// ─────────────────────────────────────────────────────────────────────────────
function PaydayResetModal({show,userName,income,currency,rates,onKeep,onUpdate}) {
  const [changing, setChanging] = useState(false);
  const [newIncome, setNewIncome] = useState("");
  const [newCurrency, setNewCurrency] = useState(currency);
  if (!show) return null;

  return React.createElement("div",{style:{...S.overlay,zIndex:400,alignItems:"center"}},
    React.createElement("div",{style:{...S.sheet,borderRadius:24,margin:"0 24px",padding:"32px 24px"}},
      React.createElement("div",{style:{textAlign:"center",marginBottom:24}},
        React.createElement("div",{style:{fontSize:48,marginBottom:12}},"💰"),
        React.createElement("h3",{style:{fontWeight:900,fontSize:22,marginBottom:6}},"Payday",userName?`, ${userName}`:"","!"),
        React.createElement("p",{style:{fontSize:14,color:"rgba(255,255,255,0.4)",lineHeight:1.6}},"New budget period started. Variable expenses have been reset.")
      ),
      React.createElement("div",{style:{...S.card,marginBottom:20,padding:16,textAlign:"center"}},
        React.createElement("p",{style:{fontSize:12,color:"rgba(255,255,255,0.4)",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.8px",marginBottom:4}},"Current income"),
        React.createElement("p",{style:{fontSize:28,fontWeight:900,color:"#4ade9e"}},fmt(parseFloat(income)||0,currency))
      ),
      !changing ? React.createElement("div",null,
        React.createElement("p",{style:{fontSize:14,color:"rgba(255,255,255,0.5)",textAlign:"center",marginBottom:16}},"Has your income changed?"),
        React.createElement("div",{style:{display:"flex",gap:10}},
          React.createElement("button",{style:{...S.btn("#4ade9e",true),color:"#0a0a0f",flex:1},onClick:onKeep},"No, same income"),
          React.createElement("button",{style:{...S.ghost,flex:1},onClick:()=>setChanging(true)},"Yes, update it")
        )
      ) : React.createElement("div",null,
        React.createElement("div",{style:{marginBottom:14}},
          React.createElement("label",{style:S.label},"New income"),
          React.createElement("input",{style:{...S.input,fontSize:20,fontWeight:800,padding:"14px",textAlign:"center"},
            type:"number",value:newIncome,onChange:e=>setNewIncome(e.target.value),placeholder:income})
        ),
        React.createElement("div",{style:{marginBottom:20}},
          React.createElement("label",{style:S.label},"Currency"),
          React.createElement("div",{style:{display:"flex",gap:8}},
            CURRENCIES.map(c=>React.createElement(CurPill,{key:c,label:c,active:newCurrency===c,color:CUR_COLOR[c],onClick:()=>setNewCurrency(c)}))
          )
        ),
        React.createElement("div",{style:{display:"flex",gap:10}},
          React.createElement("button",{style:{...S.btn("#4ade9e",true),color:"#0a0a0f",flex:1},
            onClick:()=>onUpdate(newIncome||income,newCurrency)},"Save & Continue"),
          React.createElement("button",{style:S.ghost,onClick:()=>setChanging(false)},"Back")
        )
      )
    )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Rates Modal
// ─────────────────────────────────────────────────────────────────────────────
function RatesModal({show,onClose,rates,liveRates,ratesLoading,onSave,onResetToLive}) {
  const [edit, setEdit] = useState({EUR:"",USD:"",EUR_USD:"",USD_EUR:""});
  if (!show) return null;

  const eurRON = rates.EUR||DEFAULT_RATES.EUR, usdRON = rates.USD||DEFAULT_RATES.USD;
  const eurUSD = eurRON/usdRON, usdEUR = usdRON/eurRON;

  return React.createElement("div",{style:{...S.overlay,zIndex:300},onClick:e=>{if(e.target===e.currentTarget)onClose();}},
    React.createElement("div",{style:S.sheet},
      React.createElement("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}},
        React.createElement("h3",{style:{fontWeight:800,fontSize:18}},"Exchange Rates"),
        React.createElement("button",{style:{background:"none",border:"none",color:"rgba(255,255,255,0.4)",cursor:"pointer"},onClick:onClose},
          React.createElement(Icon,{d:IC.x,size:20}))
      ),
      // Live status
      React.createElement("div",{style:{display:"flex",alignItems:"center",gap:8,marginBottom:16,padding:"8px 12px",borderRadius:10,
        background:liveRates?"rgba(74,222,158,0.08)":"rgba(255,255,255,0.04)",
        border:`1px solid ${liveRates?"rgba(74,222,158,0.2)":"rgba(255,255,255,0.07)"}`}},
        React.createElement("div",{style:{width:7,height:7,borderRadius:99,flexShrink:0,background:ratesLoading?"#f5a623":liveRates?"#4ade9e":"rgba(255,255,255,0.2)",boxShadow:liveRates?"0 0 6px #4ade9e":"none"}}),
        React.createElement("p",{style:{fontSize:12,color:liveRates?"rgba(255,255,255,0.6)":"rgba(255,255,255,0.3)"}},
          ratesLoading?"Fetching live rates...":liveRates?`Live rates · ECB · ${liveRates.date}`:"Could not fetch live rates — using manual values")
      ),
      React.createElement("p",{style:{fontSize:13,color:"rgba(255,255,255,0.4)",marginBottom:16,lineHeight:1.5}},"Rates vs RON. Cross rates (EUR/USD) are derived automatically."),

      React.createElement("p",{style:{fontSize:11,fontWeight:700,color:"rgba(255,255,255,0.3)",letterSpacing:"0.8px",textTransform:"uppercase",marginBottom:10}},"vs RON"),
      [["EUR","🇪🇺","5.0951"],["USD","🇺🇸","4.4087"]].map(([cur,flag,ph])=>
        React.createElement("div",{key:cur,style:{...S.card,marginBottom:10,padding:14}},
          React.createElement("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}},
            React.createElement("div",{style:{display:"flex",alignItems:"center",gap:8}},
              React.createElement("span",{style:{fontSize:18}},flag),
              React.createElement("p",{style:{fontWeight:700,fontSize:14}},`1 ${cur} = ${(rates[cur]||DEFAULT_RATES[cur]).toFixed(4)} RON`)
            )
          ),
          React.createElement("div",{style:{display:"flex",gap:8}},
            React.createElement("input",{style:{...S.input,flex:1,fontSize:14,padding:"9px 12px"},
              type:"number",step:"0.0001",placeholder:`e.g. ${ph}`,value:edit[cur],
              onChange:e=>setEdit(v=>({...v,[cur]:e.target.value}))}),
            React.createElement("button",{style:S.btn("#0fbcf9"),onClick:()=>{
              const val=parseFloat(edit[cur]);
              if(!isNaN(val)&&val>0){onSave(cur,val);setEdit(v=>({...v,[cur]:""}))}
            }},"Set"),
            liveRates?.[cur] && React.createElement("button",{style:{...S.ghost,padding:"9px 12px"},
              onClick:()=>{onResetToLive(cur);setEdit(v=>({...v,[cur]:""}));}},"↺")
          )
        )
      ),

      React.createElement("p",{style:{fontSize:11,fontWeight:700,color:"rgba(255,255,255,0.3)",letterSpacing:"0.8px",textTransform:"uppercase",marginBottom:10,marginTop:16}},"Cross Rates (EUR / USD)"),
      [["EUR_USD","EUR","USD","🇪🇺→🇺🇸",eurUSD],["USD_EUR","USD","EUR","🇺🇸→🇪🇺",usdEUR]].map(([key,from,to,flag,derived])=>
        React.createElement("div",{key,style:{...S.card,marginBottom:10,padding:14}},
          React.createElement("div",{style:{display:"flex",alignItems:"center",gap:8,marginBottom:10}},
            React.createElement("span",{style:{fontSize:18}},flag),
            React.createElement("p",{style:{fontWeight:700,fontSize:14}},`1 ${from} = ${derived.toFixed(4)} ${to}`)
          ),
          React.createElement("div",{style:{display:"flex",gap:8}},
            React.createElement("input",{style:{...S.input,flex:1,fontSize:14,padding:"9px 12px"},
              type:"number",step:"0.0001",placeholder:derived.toFixed(4),value:edit[key],
              onChange:e=>setEdit(v=>({...v,[key]:e.target.value}))}),
            React.createElement("button",{style:S.btn("#f5a623"),onClick:()=>{
              const v=parseFloat(edit[key]);
              if(!isNaN(v)&&v>0){
                const fromRON=from==="RON"?1:(rates[from]||DEFAULT_RATES[from]);
                onSave(to,fromRON/v);
                setEdit(v=>({...v,[key]:""}));
              }
            }},"Set")
          )
        )
      ),
      React.createElement("button",{style:{...S.btn("#e94560",true),marginTop:12},onClick:onClose},"Done")
    )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Expense Modal
// ─────────────────────────────────────────────────────────────────────────────
function ExpenseModal({modal,onClose,form,setForm,onAdd,isEditing,scanState,scanResult,scanError,onScanFile,onConfirmScan,onCancelScan,onRetryScan,rates,incomeCurrency}) {
  const fileRef=useRef(), cameraRef=useRef();
  const type = modal;
  const needsRate = form.currency !== incomeCurrency;
  const rateFrom = incomeCurrency==="EUR" ? form.currency : incomeCurrency;
  const rateTo   = incomeCurrency==="EUR" ? incomeCurrency : form.currency;
  const getDefaultRate=(from,to,r)=>{if(from===to)return 1;const fR=from==="RON"?1:(r[from]||DEFAULT_RATES[from]||1);const tR=to==="RON"?1:(r[to]||DEFAULT_RATES[to]||1);return fR/tR;};
  const buildExpRates=(from,to,customVal,baseRates)=>{if(!customVal)return baseRates;const v=parseFloat(customVal);if(!v||isNaN(v))return baseRates;const r={...baseRates};if(from==="RON"&&to!=="RON")r[to]=1/v;else if(to==="RON"&&from!=="RON")r[from]=v;else if(from!=="RON"&&to!=="RON")r[to]=r[from]/v;return r;};
  const defaultDisplayRate=getDefaultRate(rateFrom,rateTo,rates);
  const expRates=form.customRate?buildExpRates(rateFrom,rateTo,form.customRate,rates):rates;
  const convertedPreview=(form.amount&&needsRate)?convert(parseFloat(form.amount)||0,form.currency,incomeCurrency,expRates):null;
  const rateLabel=`1 ${rateFrom} = ___ ${rateTo}`;
  const ratePlaceholder=defaultDisplayRate.toFixed(4);

  if (!modal) return null;

  const e = React.createElement;
  return e("div",{style:S.overlay,onClick:ev=>{if(ev.target===ev.currentTarget)onClose();}},
    e("div",{style:S.sheet},
      e("style",null,`@keyframes spin{to{transform:rotate(360deg);}}`),

      scanState==="result"&&scanResult ? e(React.Fragment,null,
        e("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}},
          e("h3",{style:{fontWeight:800,fontSize:18}},"Receipt Scanned ✓"),
          e("button",{style:{background:"none",border:"none",color:"rgba(255,255,255,0.4)",cursor:"pointer"},onClick:onCancelScan},e(Icon,{d:IC.x,size:20}))
        ),
        e("div",{style:{...S.card,marginBottom:20,background:"rgba(15,188,249,0.06)",border:"1px solid rgba(15,188,249,0.2)"}},
          [["Merchant",scanResult.name,"#f0f0f5"],["Amount",fmt(parseFloat(scanResult.amount)||0,form.currency),"#0fbcf9"],["Category",scanResult.category,"#f0f0f5"]].map(([k,v,c])=>
            e("div",{key:k,style:{display:"flex",justifyContent:"space-between",marginBottom:8}},
              e("span",{style:{fontSize:12,color:"rgba(255,255,255,0.4)",fontWeight:600,textTransform:"uppercase"}},k),
              e("span",{style:{fontWeight:700,color:c}},v)
            )
          ),
          convertedPreview!==null&&e("div",{style:{borderTop:"1px solid rgba(255,255,255,0.08)",paddingTop:8,marginTop:4,display:"flex",justifyContent:"space-between"}},
            e("span",{style:{fontSize:12,color:"rgba(255,255,255,0.4)",fontWeight:600,textTransform:"uppercase"}},"Converted"),
            e("span",{style:{fontWeight:700,color:"#f5a623"}},"≈ ",fmt(convertedPreview,incomeCurrency))
          )
        ),
        e("p",{style:{fontSize:13,color:"rgba(255,255,255,0.4)",marginBottom:14}},"Save as:"),
        e("div",{style:{display:"flex",gap:10}},
          e("button",{style:S.btn("#e94560"),onClick:()=>onConfirmScan("recurring")},"Fixed"),
          e("button",{style:S.btn("#f5a623"),onClick:()=>onConfirmScan("daily")},"Variable"),
          e("button",{style:S.ghost,onClick:onCancelScan},"Cancel")
        )
      ) : scanState==="scanning" ? e("div",{style:{textAlign:"center",padding:"40px 0"}},
        e("div",{style:{fontSize:48,marginBottom:16,display:"inline-block",animation:"spin 1s linear infinite"}},"🔍"),
        e("p",{style:{fontWeight:700,fontSize:17}},"Scanning receipt..."),
        e("p",{style:{fontSize:13,color:"rgba(255,255,255,0.4)",marginTop:6}},"AI is reading your receipt")
      ) : scanState==="error" ? e("div",{style:{textAlign:"center",padding:"40px 0"}},
        e("div",{style:{fontSize:48,marginBottom:16}},"❌"),
        e("p",{style:{fontWeight:700,fontSize:17}},"Couldn't read receipt"),
        scanError&&e("p",{style:{fontSize:11,color:"rgba(255,255,255,0.2)",marginBottom:20,padding:"8px 12px",background:"rgba(255,255,255,0.04)",borderRadius:8}},scanError),
        e("button",{style:S.btn("#e94560",true),onClick:onRetryScan},"Try Again")
      ) : e(React.Fragment,null,
        e("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:22}},
          e("h3",{style:{fontWeight:800,fontSize:18}},isEditing?"Edit Expense":`Add ${type==="recurring"?"Fixed":"Variable"} Expense`),
          e("button",{style:{background:"none",border:"none",color:"rgba(255,255,255,0.4)",cursor:"pointer"},onClick:onClose},e(Icon,{d:IC.x,size:20}))
        ),
        !isEditing&&e(React.Fragment,null,
          e("div",{style:{display:"flex",gap:8,marginBottom:18}},
            e("button",{style:{flex:1,...S.card,border:"1px solid rgba(15,188,249,0.3)",background:"rgba(15,188,249,0.06)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,padding:"11px 14px"},onClick:()=>fileRef.current?.click()},
              e(Icon,{d:IC.receipt,size:15,stroke:"#0fbcf9"}),e("span",{style:{fontSize:13,fontWeight:600,color:"#0fbcf9"}},"Upload Receipt")),
            e("button",{style:{flex:1,...S.card,border:"1px solid rgba(245,166,35,0.3)",background:"rgba(245,166,35,0.06)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,padding:"11px 14px"},onClick:()=>cameraRef.current?.click()},
              e(Icon,{d:IC.camera,size:15,stroke:"#f5a623"}),e("span",{style:{fontSize:13,fontWeight:600,color:"#f5a623"}},"Camera"))
          ),
          e("input",{ref:fileRef,type:"file",accept:"image/*",style:{display:"none"},onChange:ev=>onScanFile(ev.target.files[0])}),
          e("input",{ref:cameraRef,type:"file",accept:"image/*",capture:"environment",style:{display:"none"},onChange:ev=>onScanFile(ev.target.files[0])}),
          e("div",{style:{display:"flex",alignItems:"center",gap:10,marginBottom:18}},
            e("div",{style:{flex:1,height:1,background:"rgba(255,255,255,0.07)"}}),
            e("span",{style:{fontSize:11,color:"rgba(255,255,255,0.2)",fontWeight:600}},"OR MANUALLY"),
            e("div",{style:{flex:1,height:1,background:"rgba(255,255,255,0.07)"}})
          )
        ),
        e("div",{style:{marginBottom:14}},
          e("label",{style:S.label},"Name"),
          e("input",{style:S.input,value:form.name,onChange:ev=>setForm(f=>({...f,name:ev.target.value})),placeholder:"e.g. Netflix, Kaufland..."})
        ),
        e("div",{style:{marginBottom:6}},
          e("label",{style:S.label},"Amount & Currency"),
          e("div",{style:{display:"flex",gap:8,alignItems:"center"}},
            e("input",{style:{...S.input,flex:1},type:"number",value:form.amount,onChange:ev=>setForm(f=>({...f,amount:ev.target.value})),placeholder:"0.00"}),
            e("div",{style:{display:"flex",gap:4}},
              CURRENCIES.map(c=>e(CurPill,{key:c,label:c,active:form.currency===c,color:CUR_COLOR[c],onClick:()=>setForm(f=>({...f,currency:c,customRate:""}))}))
            )
          )
        ),
        needsRate&&e("div",{style:{...S.card,padding:"12px 14px",marginBottom:14,background:"rgba(255,255,255,0.025)",marginTop:8}},
          e("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}},
            e("label",{style:{...S.label,marginBottom:0}},"Rate: ",rateLabel),
            e("span",{style:{fontSize:11,color:"rgba(255,255,255,0.25)"}},"blank = default")
          ),
          e("input",{style:{...S.input,fontSize:14,padding:"9px 12px"},type:"number",step:"0.0001",
            placeholder:`default: ${ratePlaceholder}`,value:form.customRate,
            onChange:ev=>setForm(f=>({...f,customRate:ev.target.value}))}),
          convertedPreview!==null&&form.amount&&e("p",{style:{fontSize:12,color:"#0fbcf9",marginTop:7}},
            "≈ ",fmt(convertedPreview,incomeCurrency)," ",
            form.customRate?e("span",{style:{color:"#f5a623"}},"· custom rate"):e("span",{style:{color:"rgba(255,255,255,0.3)"}},"· default rate")
          )
        ),
        e("div",{style:{marginBottom:14}},
          e("label",{style:S.label},"Category"),
          e("div",{style:{display:"flex",gap:8}},
            ["needs","wants","savings"].map(c=>e("button",{key:c,style:S.pill(form.category===c,CAT_COLOR[c]),onClick:()=>setForm(f=>({...f,category:c}))},c.charAt(0).toUpperCase()+c.slice(1)))
          )
        ),
        e("div",{style:{marginBottom:22}},
          e("label",{style:S.label},"Subcategory"),
          e("select",{style:S.input,value:form.subcat,onChange:ev=>setForm(f=>({...f,subcat:ev.target.value}))},
            e("option",{value:""},"Select..."),
            (CATEGORIES[form.category]||[]).map(c=>e("option",{key:c,value:c},c))
          )
        ),
        e("button",{style:S.btn("#e94560",true),onClick:()=>onAdd(type)},isEditing?"Save Changes":"Add Expense")
      )
    )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Home Tab
// ─────────────────────────────────────────────────────────────────────────────
function HomeTab({budget,expenses,updateBudget,incomeCurrency,rates,spentByType,totalSpent,allExpenses,onOpenRates,plan,onUpgrade,userName}) {
  const [editingIncome,setEditingIncome]=useState(false);
  const [incomeInput,setIncomeInput]=useState("");
  const income=parseFloat(budget?.monthly_income)||0;
  const sym=CUR_SYM[incomeCurrency];

  return React.createElement("div",null,
    React.createElement("div",{style:S.header},
      React.createElement("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}},
        React.createElement("div",{style:{display:"flex",alignItems:"center",gap:10}},
          React.createElement(BudgieLogo,{size:44}),
          React.createElement("div",null,
            React.createElement("p",{style:{fontSize:26,fontWeight:900,letterSpacing:"0.5px",lineHeight:1.2,background:"linear-gradient(90deg,#4ade9e,#0fbcf9)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",paddingRight:"4px",paddingBottom:"2px",display:"inline-block"}},"Budgie"),
            React.createElement("p",{style:{fontSize:11,color:"rgba(255,255,255,0.3)",fontWeight:600,letterSpacing:"1px",textTransform:"uppercase",marginTop:3}},userName ? `${userName}'s Budget` : "Budget Tracker")
          )
        ),
        React.createElement("div",{style:{display:"flex",gap:8,alignItems:"center"}},
          plan!=="free"&&React.createElement("span",{style:{fontSize:10,padding:"3px 8px",borderRadius:99,background:"rgba(74,222,158,0.15)",color:"#4ade9e",fontWeight:700}},plan.toUpperCase()),
          React.createElement("button",{style:{background:"none",border:"none",cursor:"pointer",color:"rgba(255,255,255,0.3)",display:"flex",alignItems:"center",gap:5,fontSize:11,fontWeight:600},onClick:onOpenRates},
            React.createElement(Icon,{d:IC.cog,size:13})," Rates")
        )
      ),
      editingIncome ? React.createElement("input",{type:"number",value:incomeInput,
        onChange:e=>setIncomeInput(e.target.value),
        style:{...S.input,fontSize:34,fontWeight:800,padding:"4px 0",background:"none",border:"none",borderBottom:"2px solid #e94560",borderRadius:0,marginBottom:12},
        onBlur:()=>{
          const val=parseFloat(incomeInput)||0;
          const ronVal=val>0?toRON(val,incomeCurrency,rates):0;
          updateBudget({monthly_income:val,monthly_income_ron:ronVal});
          setEditingIncome(false);
        },
        onKeyDown:e=>{if(e.key==="Enter"){const val=parseFloat(incomeInput)||0;const ronVal=val>0?toRON(val,incomeCurrency,rates):0;updateBudget({monthly_income:val,monthly_income_ron:ronVal});setEditingIncome(false);}}
      }) : React.createElement("div",{style:{display:"flex",alignItems:"baseline",gap:8,cursor:"pointer",marginBottom:12},onClick:()=>{setIncomeInput(budget?.monthly_income||"");setEditingIncome(true);}},
        React.createElement("span",{style:{fontSize:38,fontWeight:800,letterSpacing:"-1px"}}),
        income>0?income.toLocaleString("ro-RO"):"—",
        React.createElement("span",{style:{fontSize:18,fontWeight:600,color:"rgba(255,255,255,0.5)"}},sym),
        React.createElement(Icon,{d:IC.edit,size:14,stroke:"rgba(255,255,255,0.25)"})
      ),
      React.createElement("div",{style:{display:"flex",alignItems:"center",gap:8}},
        React.createElement("span",{style:{fontSize:12,color:"rgba(255,255,255,0.35)",fontWeight:600}},"Currency:"),
        React.createElement("div",{style:{display:"flex",gap:5}},
          CURRENCIES.map(c=>React.createElement(CurPill,{key:c,label:c,active:incomeCurrency===c,color:CUR_COLOR[c],
            onClick:()=>{
              if(c===incomeCurrency)return;
              const baseRON=parseFloat(budget?.monthly_income_ron)||parseFloat(budget?.monthly_income)||0;
              const converted=baseRON>0?(c==="RON"?baseRON:fromRON(baseRON,c,rates)):0;
              updateBudget({income_currency:c,monthly_income:parseFloat(converted.toFixed(2))});
            }
          }))
        )
      )
    ),

    React.createElement("div",{style:{padding:"0 16px"}},
      income>0 ? React.createElement(React.Fragment,null,
        // 50-30-20 cards
        React.createElement("div",{style:{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:20}},
          [{key:"needs",label:"Needs",pct:50,budget:income*0.5,color:"#e94560"},
           {key:"wants",label:"Wants",pct:30,budget:income*0.3,color:"#f5a623"},
           {key:"savings",label:"Savings",pct:20,budget:income*0.2,color:"#0fbcf9"}].map(item=>{
            const spent=spentByType[item.key]||0, rem=item.budget-spent;
            return React.createElement("div",{key:item.key,style:{...S.card,padding:"14px 10px",textAlign:"center"}},
              React.createElement("div",{style:{position:"relative",display:"inline-block",marginBottom:8}},
                React.createElement(CircleProgress,{pct:item.budget>0?(spent/item.budget)*100:0,color:item.color,size:62,stroke:5}),
                React.createElement("div",{style:{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center"}},
                  React.createElement("span",{style:{fontSize:13,fontWeight:800,color:item.color}},item.pct,"%"))
              ),
              React.createElement("p",{style:{fontSize:11,fontWeight:700,color:"rgba(255,255,255,0.45)",textTransform:"uppercase",letterSpacing:"0.5px",marginBottom:2}},item.label),
              React.createElement("p",{style:{fontSize:12,fontWeight:800,color:item.color}},fmt(item.budget,incomeCurrency)),
              React.createElement("p",{style:{fontSize:10,color:rem<0?"#e94560":"rgba(255,255,255,0.3)"}},rem<0?`over ${fmt(Math.abs(rem),incomeCurrency)}`:`${fmt(rem,incomeCurrency)} left`)
            );
          })
        ),

        // Breakdown bars
        React.createElement("div",{style:{...S.card,marginBottom:20}},
          React.createElement("p",{style:{fontSize:11,fontWeight:700,marginBottom:16,color:"rgba(255,255,255,0.5)",textTransform:"uppercase",letterSpacing:"0.8px"}},"Spending Breakdown"),
          [{label:"Needs (50%)",budget:income*0.5,spent:spentByType.needs||0,color:"#e94560",icon:IC.wallet},
           {label:"Wants (30%)",budget:income*0.3,spent:spentByType.wants||0,color:"#f5a623",icon:IC.sparkle},
           {label:"Savings (20%)",budget:income*0.2,spent:spentByType.savings||0,color:"#0fbcf9",icon:IC.wallet}].map(({label,budget,spent,color,icon})=>{
            const pct=budget>0?Math.min((spent/budget)*100,100):0, over=spent>budget;
            return React.createElement("div",{key:label,style:{marginBottom:16}},
              React.createElement("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}},
                React.createElement("div",{style:{display:"flex",alignItems:"center",gap:8}},
                  React.createElement("div",{style:{width:26,height:26,borderRadius:7,background:`rgba(${rgb(color)},0.15)`,display:"flex",alignItems:"center",justifyContent:"center"}},
                    React.createElement(Icon,{d:icon,size:13,stroke:color})),
                  React.createElement("span",{style:{fontSize:13,fontWeight:600}},label)
                ),
                React.createElement("div",{style:{textAlign:"right"}},
                  React.createElement("span",{style:{fontSize:13,fontWeight:700,color:over?"#e94560":color}},fmt(spent,incomeCurrency)),
                  React.createElement("span",{style:{fontSize:11,color:"rgba(255,255,255,0.3)"}}," / ",fmt(budget,incomeCurrency))
                )
              ),
              React.createElement("div",{style:{height:6,background:"rgba(255,255,255,0.07)",borderRadius:99,overflow:"hidden"}},
                React.createElement("div",{style:{height:"100%",width:`${pct}%`,background:over?"#e94560":color,borderRadius:99,transition:"width 0.6s cubic-bezier(0.34,1.56,0.64,1)"}})),
              over&&React.createElement("p",{style:{fontSize:11,color:"#e94560",marginTop:3}},"⚠ Over by ",fmt(spent-budget,incomeCurrency))
            );
          })
        ),

        // Summary
        React.createElement("div",{style:{...S.card,marginBottom:20,display:"flex"}},
          [{label:"Total Spent",value:fmt(totalSpent,incomeCurrency),color:totalSpent>income?"#e94560":"#f0f0f5"},
           {label:"Remaining",value:fmt(Math.abs(income-totalSpent),incomeCurrency),color:income-totalSpent<0?"#e94560":"#0fbcf9"},
           {label:"Expenses",value:String(allExpenses.length),color:"#f0f0f5"}].map((item,i)=>
            React.createElement("div",{key:i,style:{flex:1,textAlign:"center",borderRight:i<2?"1px solid rgba(255,255,255,0.07)":"none"}},
              React.createElement("p",{style:{fontSize:10,color:"rgba(255,255,255,0.35)",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.4px",marginBottom:4}},item.label),
              React.createElement("p",{style:{fontSize:15,fontWeight:800,color:item.color}},item.value)
            )
          )
        ),

        // Upgrade banner for free users
        plan==="free"&&React.createElement("div",{style:{...S.card,marginBottom:20,background:"rgba(74,222,158,0.06)",border:"1px solid rgba(74,222,158,0.2)",cursor:"pointer"},onClick:onUpgrade},
          React.createElement("div",{style:{display:"flex",alignItems:"center",gap:12}},
            React.createElement(Icon,{d:IC.crown,size:20,stroke:"#4ade9e"}),
            React.createElement("div",{style:{flex:1}},
              React.createElement("p",{style:{fontWeight:700,fontSize:14,color:"#4ade9e"}},"Upgrade to Pro"),
              React.createElement("p",{style:{fontSize:12,color:"rgba(255,255,255,0.4)",marginTop:2}},"Unlock history, export & more — from €2.99/mo")
            ),
            React.createElement(Icon,{d:IC.history,size:16,stroke:"rgba(255,255,255,0.3)"})
          )
        )
      ) : React.createElement("div",{style:{...S.card,textAlign:"center",padding:"40px 24px"}},
        React.createElement("div",{style:{fontSize:48,marginBottom:12}},"💰"),
        React.createElement("p",{style:{fontWeight:700,fontSize:17,marginBottom:8}},"Set your monthly income"),
        React.createElement("p",{style:{fontSize:14,color:"rgba(255,255,255,0.4)",marginBottom:20}},"Tap the amount above to get started"),
        React.createElement("div",{style:{background:"rgba(255,255,255,0.04)",borderRadius:14,padding:16,textAlign:"left"}},
          [["🔴","50%","Needs","Rent, food, bills"],["🟡","30%","Wants","Dining, shopping, fun"],["🔵","20%","Savings","Emergency fund, investments"]].map(([e,p,l,d])=>
            React.createElement("div",{key:l,style:{display:"flex",gap:10,marginBottom:10}},
              React.createElement("span",null,e),
              React.createElement("div",null,
                React.createElement("span",{style:{fontWeight:700,fontSize:13}},p," ",l),
                React.createElement("p",{style:{fontSize:12,color:"rgba(255,255,255,0.35)",margin:0}},d)
              )
            )
          )
        )
      )
    )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Expenses Tab
// ─────────────────────────────────────────────────────────────────────────────
function ExpensesTab({expenses,updateBudget,incomeCurrency,rates,onOpenAdd,onOpenEdit,budget,userName}) {
  const [activeType,setActiveType]=useState("recurring");
  const monthLabel=new Date().toLocaleString("en-US",{month:"long",year:"numeric"});
  const list=expenses.filter(e=>e.type===activeType);

  function remove(id,type) {
    // Mark as deleted (will be removed from DB in parent)
    onOpenEdit({id,_delete:true,type});
  }

  function ExpenseRow({exp}) {
    const cc=CAT_COLOR[exp.category]||"#f0f0f5";
    const ec=exp.currency||incomeCurrency;
    const er=exp.custom_rate?{...rates,[exp.custom_rate_cur||ec]:exp.custom_rate}:rates;
    const cv=convert(parseFloat(exp.amount)||0,ec,incomeCurrency,er);
    const showCV=ec!==incomeCurrency;
    return React.createElement("div",{
      onClick:()=>onOpenEdit(exp),
      style:{...S.card,marginBottom:10,display:"flex",alignItems:"center",gap:12,cursor:"pointer",transition:"background 0.15s"},
      onMouseEnter:e=>e.currentTarget.style.background="rgba(255,255,255,0.07)",
      onMouseLeave:e=>e.currentTarget.style.background="rgba(255,255,255,0.04)"},
      React.createElement("div",{style:{width:42,height:42,borderRadius:12,background:`rgba(${rgb(cc)},0.15)`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}},
        React.createElement(Icon,{d:activeType==="recurring"?IC.repeat:IC.receipt,size:18,stroke:cc})),
      React.createElement("div",{style:{flex:1,minWidth:0}},
        React.createElement("p",{style:{fontWeight:700,fontSize:14,marginBottom:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}},exp.name),
        React.createElement("div",{style:{display:"flex",gap:5,alignItems:"center",flexWrap:"wrap"}},
          React.createElement("span",{style:{fontSize:11,padding:"2px 7px",borderRadius:99,background:`rgba(${rgb(cc)},0.15)`,color:cc,fontWeight:600}},exp.subcat||exp.category),
          exp.expense_date&&React.createElement("span",{style:{fontSize:11,color:"rgba(255,255,255,0.25)"}},exp.expense_date),
          exp.custom_rate&&React.createElement("span",{style:{fontSize:10,color:"#f5a623"}},"custom rate")
        )
      ),
      React.createElement("div",{style:{textAlign:"right",flexShrink:0}},
        React.createElement("p",{style:{fontWeight:800,fontSize:14}},fmt(parseFloat(exp.amount),ec)),
        showCV&&React.createElement("p",{style:{fontSize:11,color:"rgba(255,255,255,0.3)"}},"≈ ",fmt(cv,incomeCurrency))
      ),
      React.createElement("button",{
        onClick:e=>{e.stopPropagation();remove(exp.id,exp.type);},
        style:{background:"none",border:"none",color:"rgba(255,255,255,0.2)",cursor:"pointer",padding:4,flexShrink:0}},
        React.createElement(Icon,{d:IC.trash,size:15}))
    );
  }

  return React.createElement("div",{style:{padding:"0 0 20px"}},
    React.createElement("div",{style:{padding:"52px 24px 16px",background:"linear-gradient(160deg,#13131f 0%,#0a0a0f 100%)",marginBottom:16}},
      React.createElement("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center"}},
        React.createElement("div",{style:{display:"flex",alignItems:"center",gap:10}},
          React.createElement(BudgieLogo,{size:44}),
          React.createElement("div",null,
            React.createElement("p",{style:{fontSize:26,fontWeight:900,letterSpacing:"0.5px",lineHeight:1.2,background:"linear-gradient(90deg,#4ade9e,#0fbcf9)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",paddingRight:"4px",paddingBottom:"2px",display:"inline-block"}},"Budgie"),
            React.createElement("p",{style:{fontSize:11,color:"rgba(255,255,255,0.3)",fontWeight:600,letterSpacing:"1px",textTransform:"uppercase",marginTop:5}},userName ? `${userName}'s Expenses` : "Expenses")
          )
        ),
        React.createElement("button",{style:S.btn("#e94560"),onClick:()=>onOpenAdd(activeType)},
          React.createElement(Icon,{d:IC.plus,size:16,stroke:"#fff"}))
      )
    ),
    React.createElement("div",{style:{padding:"0 16px"}},
      React.createElement("div",{style:{display:"flex",gap:8,marginBottom:12}},
        React.createElement("button",{style:S.pill(activeType==="recurring"),onClick:()=>setActiveType("recurring")},"Fixed"),
        React.createElement("button",{style:S.pill(activeType==="daily","#f5a623"),onClick:()=>setActiveType("daily")},"Variable")
      ),
      activeType==="recurring"&&React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.35)",marginBottom:14,padding:"8px 12px",background:"rgba(255,255,255,0.03)",borderRadius:10,lineHeight:1.5}},
        "🔄 Fixed expenses are always counted in your budget, every period."),
      activeType==="daily"&&React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.35)",marginBottom:14,padding:"8px 12px",background:"rgba(255,255,255,0.03)",borderRadius:10,lineHeight:1.5}},
        "📅 ",React.createElement("strong",{style:{color:"rgba(255,255,255,0.5)"}},monthLabel)," — variable expenses reset when your next salary arrives."),
      list.length===0?React.createElement("div",{style:{...S.card,textAlign:"center",padding:"36px 20px"}},
        React.createElement("div",{style:{fontSize:36,marginBottom:10}},activeType==="recurring"?"🔄":"📝"),
        React.createElement("p",{style:{fontWeight:700}},`No ${activeType==="recurring"?"fixed":"variable"} expenses yet`),
        React.createElement("p",{style:{fontSize:13,color:"rgba(255,255,255,0.4)",marginTop:6}},
          activeType==="recurring"?"Add fixed costs like rent, subscriptions, utilities":"Add today's purchases or scan a receipt")
      ):list.map(exp=>React.createElement(ExpenseRow,{key:exp.id,exp})),
      React.createElement("button",{style:{...S.card,width:"100%",border:"2px dashed rgba(255,255,255,0.1)",background:"none",color:"rgba(255,255,255,0.3)",cursor:"pointer",textAlign:"center",marginTop:8,padding:14,display:"flex",alignItems:"center",justifyContent:"center",gap:8},
        onClick:()=>onOpenAdd(activeType)},
        React.createElement(Icon,{d:IC.plus,size:16})," Add ",activeType==="recurring"?"fixed":"variable"," expense")
    )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// History Tab (Pro/Family only)
// ─────────────────────────────────────────────────────────────────────────────
function HistoryTab({history,plan,onUpgrade,userName}) {
  function periodLabel(p) {
    if(!p)return"";
    const [y,m]=p.split("-");
    return new Date(parseInt(y),parseInt(m)-1,1).toLocaleString("en-US",{month:"long",year:"numeric"});
  }

  if (plan==="free") return React.createElement("div",{style:{padding:"52px 16px 20px"}},
    React.createElement("div",{style:{...S.card,textAlign:"center",padding:"48px 24px",background:"rgba(74,222,158,0.05)",border:"1px solid rgba(74,222,158,0.2)"}},
      React.createElement(Icon,{d:IC.lock,size:40,stroke:"#4ade9e"}),
      React.createElement("p",{style:{fontWeight:800,fontSize:18,marginTop:16,marginBottom:8}},"History is a Pro feature"),
      React.createElement("p",{style:{fontSize:14,color:"rgba(255,255,255,0.4)",marginBottom:24,lineHeight:1.6}},"Upgrade to Pro to see your full spending history and track trends over time."),
      React.createElement("button",{style:S.btn("#4ade9e",true),onClick:onUpgrade},"Upgrade to Pro — €2.99/mo")
    )
  );

  return React.createElement("div",{style:{padding:"0 0 20px"}},
    React.createElement("div",{style:{padding:"52px 24px 16px",background:"linear-gradient(160deg,#13131f 0%,#0a0a0f 100%)",marginBottom:16}},
      React.createElement("div",{style:{display:"flex",alignItems:"center",gap:10}},
        React.createElement(BudgieLogo,{size:44}),
        React.createElement("div",null,
          React.createElement("p",{style:{fontSize:26,fontWeight:900,letterSpacing:"0.5px",lineHeight:1.2,background:"linear-gradient(90deg,#4ade9e,#0fbcf9)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",paddingRight:"4px",paddingBottom:"2px",display:"inline-block"}},"Budgie"),
          React.createElement("p",{style:{fontSize:11,color:"rgba(255,255,255,0.3)",fontWeight:600,letterSpacing:"1px",textTransform:"uppercase",marginTop:5}},userName ? `${userName}'s History` : "History")
        )
      )
    ),
    React.createElement("div",{style:{padding:"0 16px"}},
      history.length===0?React.createElement("div",{style:{...S.card,textAlign:"center",padding:"48px 24px"}},
        React.createElement("div",{style:{fontSize:44,marginBottom:12}},"📊"),
        React.createElement("p",{style:{fontWeight:700,fontSize:16,marginBottom:8}},"No history yet"),
        React.createElement("p",{style:{fontSize:13,color:"rgba(255,255,255,0.4)",lineHeight:1.6}},"Your spending breakdown will be saved here at the end of each budget period.")
      ) : React.createElement(React.Fragment,null,
        history.length>1&&React.createElement("div",{style:{...S.card,marginBottom:16,padding:16}},
          React.createElement("p",{style:{fontSize:11,fontWeight:700,color:"rgba(255,255,255,0.4)",textTransform:"uppercase",letterSpacing:"0.8px",marginBottom:16}},"Last ",Math.min(history.length,6)," periods"),
          React.createElement("div",{style:{display:"flex",gap:6,alignItems:"flex-end"}},
            history.slice(0,6).reverse().map((h,i)=>{
              const maxVal=Math.max(...history.slice(0,6).map(x=>x.income||1));
              return React.createElement("div",{key:i,style:{flex:1,display:"flex",flexDirection:"column",gap:3}},
                [["needs","#e94560"],["wants","#f5a623"],["savings","#0fbcf9"]].map(([k,c])=>{
                  const pct=maxVal>0?Math.min((h[k]/maxVal)*100,100):0;
                  return React.createElement("div",{key:k,style:{width:"100%",height:80,background:"rgba(255,255,255,0.05)",borderRadius:8,overflow:"hidden",display:"flex",alignItems:"flex-end"}},
                    React.createElement("div",{style:{width:"100%",height:`${pct}%`,background:c,borderRadius:8,minHeight:h[k]>0?4:0}}));
                }),
                React.createElement("p",{style:{fontSize:9,color:"rgba(255,255,255,0.3)",textAlign:"center",marginTop:2}},h.period?.slice(2).replace("-","/"))
              );
            })
          ),
          React.createElement("div",{style:{display:"flex",gap:12,marginTop:12,justifyContent:"center"}},
            [["Needs","#e94560"],["Wants","#f5a623"],["Savings","#0fbcf9"]].map(([l,c])=>
              React.createElement("div",{key:l,style:{display:"flex",alignItems:"center",gap:4}},
                React.createElement("div",{style:{width:8,height:8,borderRadius:2,background:c}}),
                React.createElement("span",{style:{fontSize:11,color:"rgba(255,255,255,0.4)"}},l)
              )
            )
          )
        ),
        history.map((h,i)=>{
          const income=h.income||0;
          const savedPct=income>0?Math.max(0,((income-h.total)/income*100)).toFixed(0):0;
          const over=h.total>income&&income>0;
          return React.createElement("div",{key:i,style:{...S.card,marginBottom:12,padding:16}},
            React.createElement("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}},
              React.createElement("p",{style:{fontWeight:800,fontSize:15}},periodLabel(h.period)),
              React.createElement("span",{style:{fontSize:11,padding:"3px 10px",borderRadius:99,background:over?"rgba(233,69,96,0.15)":"rgba(74,222,158,0.12)",color:over?"#e94560":"#4ade9e",fontWeight:700}},over?"Over budget":`${savedPct}% saved`)
            ),
            income>0&&React.createElement("div",{style:{height:8,borderRadius:99,overflow:"hidden",background:"rgba(255,255,255,0.06)",display:"flex",marginBottom:12}},
              [["needs","#e94560"],["wants","#f5a623"],["savings","#0fbcf9"]].map(([k,c])=>
                React.createElement("div",{key:k,style:{width:`${Math.min((h[k]/income)*100,100)}%`,background:c}})
              )
            ),
            React.createElement("div",{style:{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:8}},
              [{label:"Income",value:fmt(income,h.currency),color:"rgba(255,255,255,0.7)"},
               {label:"Needs",value:fmt(h.needs,h.currency),color:"#e94560"},
               {label:"Wants",value:fmt(h.wants,h.currency),color:"#f5a623"},
               {label:"Savings",value:fmt(h.savings,h.currency),color:"#0fbcf9"}].map(item=>
                React.createElement("div",{key:item.label,style:{textAlign:"center"}},
                  React.createElement("p",{style:{fontSize:10,color:"rgba(255,255,255,0.3)",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.4px",marginBottom:3}},item.label),
                  React.createElement("p",{style:{fontSize:12,fontWeight:800,color:item.color}},item.value)
                )
              )
            )
          );
        })
      )
    )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Account Tab
// ─────────────────────────────────────────────────────────────────────────────
function AccountTab({user,profile,token,onSignOut,onUpgrade}) {
  async function handlePortal() {
    const res = await sb.callFunction("customer-portal", token, { returnUrl: window.location.origin });
    if (res.url) window.location.href = res.url;
  }

  const planColor = profile?.plan==="family"?"#4ade9e":profile?.plan==="pro"?"#0fbcf9":"rgba(255,255,255,0.4)";

  return React.createElement("div",{style:{padding:"52px 16px 20px"}},
    // Profile card
    React.createElement("div",{style:{...S.card,marginBottom:16,padding:20}},
      React.createElement("div",{style:{display:"flex",alignItems:"center",gap:12,marginBottom:16}},
        React.createElement("div",{style:{width:52,height:52,borderRadius:99,background:"linear-gradient(135deg,#4ade9e,#0fbcf9)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,fontWeight:800,color:"#0a0a0f"}},
          (profile?.name||user?.email||"?")[0].toUpperCase()),
        React.createElement("div",null,
          React.createElement("p",{style:{fontWeight:800,fontSize:16}},profile?.name||"User"),
          React.createElement("p",{style:{fontSize:12,color:"rgba(255,255,255,0.4)"}},user?.email)
        )
      ),
      React.createElement("div",{style:{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",borderRadius:10,background:`rgba(${rgb(planColor==="rgba(255,255,255,0.4)"?"255,255,255":"74,222,158")},0.08)`}},
        React.createElement(Icon,{d:IC.crown,size:16,stroke:planColor}),
        React.createElement("span",{style:{fontSize:13,fontWeight:700,color:planColor}},
          profile?.plan==="pro"?"Budgie Pro":profile?.plan==="family"?"Budgie Family":"Free Plan"),
        profile?.plan!=="free"&&profile?.plan_expires_at&&React.createElement("span",{style:{fontSize:11,color:"rgba(255,255,255,0.3)",marginLeft:"auto"}},
          "Renews ",new Date(profile.plan_expires_at).toLocaleDateString())
      )
    ),

    // Actions
    React.createElement("div",{style:{display:"flex",flexDirection:"column",gap:10}},
      profile?.plan==="free"&&React.createElement("button",{style:{...S.btn("#4ade9e",true),color:"#0a0a0f"},onClick:onUpgrade},
        "⭐ Upgrade to Pro — €2.99/mo"),
      profile?.plan!=="free"&&React.createElement("button",{style:{...S.ghost,width:"100%",textAlign:"left"},onClick:handlePortal},
        "Manage Subscription & Billing"),
      React.createElement("button",{style:{...S.ghost,width:"100%",textAlign:"left",color:"#e94560",borderColor:"rgba(233,69,96,0.2)"},onClick:onSignOut},
        "Sign Out")
    )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main App
// ─────────────────────────────────────────────────────────────────────────────
function BudgetApp() {
  const [authToken, setAuthToken]   = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [user, setUser]             = useState(null);
  const [profile, setProfile]       = useState(null);
  const [budget, setBudget]         = useState(null);
  const [expenses, setExpenses]     = useState([]);
  const [history, setHistory]       = useState([]);
  const [tab, setTab]               = useState("home");
  const [modal, setModal]           = useState(null);
  const [form, setForm]             = useState({name:"",amount:"",currency:"RON",category:"wants",subcat:"",customRate:""});
  const [scanState, setScanState]   = useState("idle");
  const [scanResult, setScanResult] = useState(null);
  const [scanError, setScanError]   = useState(null);
  const [showRates, setShowRates]   = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [showPaydayReset, setShowPaydayReset] = useState(false);
  const [liveRates, setLiveRates]   = useState(null);
  const [ratesLoading, setRatesLoading] = useState(false);
  const [editingExpense, setEditingExpense] = useState(null);
  const [dataLoading, setDataLoading] = useState(false);

  // ── Auth check on mount ──────────────────────────────────────────────────
  useEffect(()=>{
    sb.getSession().then(async session=>{
      if(session?.access_token){
        setAuthToken(session.access_token);
        await loadUserData(session.access_token);
      }
      setAuthLoading(false);
    });
  },[]);

  // ── Fetch live rates ─────────────────────────────────────────────────────
  useEffect(()=>{
    setRatesLoading(true);
    fetchLiveRates().then(result=>{
      if(result) setLiveRates(result);
      setRatesLoading(false);
    });
  },[]);

  async function loadUserData(token) {
    setDataLoading(true);
    try {
      // Step 1: get user
      const userData = await sb.getUser(token);
      if (!userData || userData.error || !userData.id) {
        console.error("getUser failed:", userData);
        // Token invalid — clear and go back to login
        safeStorage.remove("sb_token");
        setAuthToken(null);
        setDataLoading(false);
        return;
      }
      setUser(userData);

      // Step 2: get profile (created automatically by DB trigger on signup)
      let prof = null;
      try {
        const db = await sb.from("profiles", token);
        const profiles = await db.select("*", `id=eq.${userData.id}`);
        prof = Array.isArray(profiles) && profiles.length > 0 ? profiles[0] : null;
      } catch(e) { console.error("profile load error:", e); }
      setProfile(prof);

      // Step 3: get budget
      let bud = null;
      try {
        const budgetDb = await sb.from("budgets", token);
        const budgets = await budgetDb.select("*", `owner_id=eq.${userData.id}&order=created_at.asc`);
        bud = Array.isArray(budgets) && budgets.length > 0 ? budgets[0] : null;
      } catch(e) { console.error("budget load error:", e); }

      if (!bud) {
        setBudget(null); // → shows Onboarding
      } else {
        setBudget(bud);
        // Payday reset check
        if (bud.payday) {
          const periodKey = getPeriodKey(bud.payday);
          if (bud.current_period && bud.current_period !== periodKey) {
            try {
              await archivePeriod(token, bud, bud.current_period);
              const expDb = await sb.from("expenses", token);
              await expDb.delete(`budget_id=eq.${bud.id}&type=eq.daily`);
              const budgetDb2 = await sb.from("budgets", token);
              await budgetDb2.update({current_period: periodKey}, `id=eq.${bud.id}`);
              setBudget({...bud, current_period: periodKey});
              setShowPaydayReset(true);
            } catch(e) { console.error("payday reset error:", e); }
          }
        }
        // Load expenses
        try { await loadExpenses(token, bud.id); } catch(e) { console.error("expenses load error:", e); }
        // Load history (Pro/Family)
        if (prof?.plan && prof.plan !== "free") {
          try { await loadHistory(token, bud.id); } catch(e) { console.error("history load error:", e); }
        }
      }
    } catch(e) {
      console.error("loadUserData critical error:", e);
    }
    setDataLoading(false);
  }

  async function archivePeriod(token, bud, period) {
    try {
      const expDb = await sb.from("expenses", token);
      const allExp = await expDb.select("*", `budget_id=eq.${bud.id}`);
      if(!Array.isArray(allExp)||allExp.length===0) return;
      const rates = {RON:1,...DEFAULT_RATES,...(bud.rates||{})};
      const ic = bud.income_currency||"RON";
      const spent={needs:0,wants:0,savings:0};
      allExp.forEach(e=>{
        const t=e.category||classify(e.name);
        const er=e.custom_rate?{...rates,[e.custom_rate_cur||e.currency]:e.custom_rate}:rates;
        spent[t]=(spent[t]||0)+convert(parseFloat(e.amount)||0,e.currency||ic,ic,er);
      });
      const histDb = await sb.from("history_snapshots", token);
      await histDb.upsert({budget_id:bud.id,period,income:parseFloat(bud.monthly_income)||0,currency:ic,needs:spent.needs,wants:spent.wants,savings:spent.savings,total:spent.needs+spent.wants+spent.savings});
    } catch(e){ console.error("archivePeriod error:",e); }
  }

  async function loadExpenses(token, budgetId) {
    const expDb = await sb.from("expenses", token);
    const exps = await expDb.select("*", `budget_id=eq.${budgetId}&order=created_at.desc`);
    setExpenses(Array.isArray(exps)?exps:[]);
  }

  async function loadHistory(token, budgetId) {
    const histDb = await sb.from("history_snapshots", token);
    const hist = await histDb.select("*", `budget_id=eq.${budgetId}&order=period.desc`);
    setHistory(Array.isArray(hist)?hist:[]);
  }

  async function handleAuth(token) {
    setAuthToken(token);
    await loadUserData(token);
  }

  async function handleSignOut() {
    await sb.signOut(authToken);
    safeStorage.remove("sb_token");
    safeStorage.remove("sb_refresh");
    setAuthToken(null); setUser(null); setProfile(null); setBudget(null); setExpenses([]); setHistory([]);
  }

  async function handleOnboardingComplete(data) {
    setDataLoading(true);
    try {
      const budgetDb = await sb.from("budgets", authToken);
      const insertData = {
        owner_id: user.id,
        name: "My Budget",
        monthly_income: data.monthly_income,
        income_currency: data.income_currency,
        monthly_income_ron: data.monthly_income_ron,
        payday: data.payday,
        current_period: data.current_period,
        settings: data.settings,  // jsonb — no stringify needed
      };
      const result = await budgetDb.insert(insertData);
      const newBudget = Array.isArray(result) ? result[0] : null;
      if (newBudget) {
        setBudget(newBudget);
      } else {
        // Fetch the budget we just created
        const fetched = await budgetDb.select("*", `owner_id=eq.${user.id}&order=created_at.desc&limit=1`);
        if (Array.isArray(fetched) && fetched[0]) setBudget(fetched[0]);
      }
    } catch(e) {
      console.error("handleOnboardingComplete error:", e);
    }
    setDataLoading(false);
  }

  const rates = {RON:1,...DEFAULT_RATES,...(liveRates?{EUR:liveRates.EUR,USD:liveRates.USD}:{}),...(budget?.rates||{})};
  const incomeCurrency = budget?.income_currency||"RON";
  const plan = (profile?.plan && ["free","pro","family"].includes(profile.plan)) ? profile.plan : "free";

  const spentByType={needs:0,wants:0,savings:0};
  expenses.forEach(e=>{
    const t=e.category||classify(e.name);
    const er=e.custom_rate?{...rates,[e.custom_rate_cur||e.currency]:e.custom_rate}:rates;
    spentByType[t]=(spentByType[t]||0)+convert(parseFloat(e.amount)||0,e.currency||incomeCurrency,incomeCurrency,er);
  });
  const totalSpent=spentByType.needs+spentByType.wants+spentByType.savings;

  async function updateBudget(patch) {
    if(!budget) return;
    const db = await sb.from("budgets", authToken);
    await db.update(patch, `id=eq.${budget.id}`);
    setBudget(b=>({...b,...patch}));
  }

  function openAdd(type) {
    setEditingExpense(null);
    setForm({name:"",amount:"",currency:incomeCurrency,category:"wants",subcat:"",customRate:""});
    setScanState("idle"); setScanResult(null); setScanError(null);
    setModal(type);
  }

  function openEdit(exp) {
    if(exp._delete) { deleteExpense(exp.id, exp.type); return; }
    setEditingExpense(exp);
    setForm({name:exp.name,amount:exp.amount.toString(),currency:exp.currency||incomeCurrency,category:exp.category,subcat:exp.subcat||"",customRate:exp.custom_rate?exp.custom_rate.toString():""});
    setScanState("idle"); setScanResult(null); setScanError(null);
    setModal(exp.type);
  }

  async function deleteExpense(id, type) {
    const db = await sb.from("expenses", authToken);
    await db.delete(`id=eq.${id}`);
    setExpenses(ex=>ex.filter(e=>e.id!==id));
  }

  async function addExpense(type) {
    if(!form.name||!form.amount||!budget) return;
    const fc=form.currency!=="RON"?form.currency:incomeCurrency;
    const cr=form.customRate?parseFloat(form.customRate)||null:null;
    const entry={budget_id:budget.id,added_by:user.id,type,name:form.name,amount:parseFloat(form.amount),currency:form.currency||incomeCurrency,custom_rate_cur:fc,custom_rate:cr,category:form.category,subcat:form.subcat,expense_date:new Date().toISOString().split("T")[0]};

    if(editingExpense) {
      const db = await sb.from("expenses", authToken);
      const updated = await db.update({name:form.name,amount:parseFloat(form.amount),currency:form.currency||incomeCurrency,custom_rate_cur:fc,custom_rate:cr,category:form.category,subcat:form.subcat}, `id=eq.${editingExpense.id}`);
      setExpenses(ex=>ex.map(e=>e.id===editingExpense.id?{...e,...(Array.isArray(updated)?updated[0]:{})}:e));
      setEditingExpense(null);
    } else {
      const db = await sb.from("expenses", authToken);
      const result = await db.insert(entry);
      if(Array.isArray(result)&&result[0]) setExpenses(ex=>[result[0],...ex]);
    }
    setModal(null);
  }

  async function handleScanFile(file) {
    setScanState("scanning"); setScanError(null);
    try {
      const result = await scanReceipt(file);
      if(result.error){setScanError(result.error);setScanState("error");return;}
      const dc=CURRENCIES.includes(result.currency)?result.currency:incomeCurrency;
      setScanResult(result);
      setForm({name:result.name||"",amount:result.amount?.toString()||"",currency:dc,category:classify(result.category||result.name||""),subcat:result.category||"",customRate:""});
      setScanState("result");
    } catch(err){setScanError(err.message||"Unknown error");setScanState("error");}
  }

  function confirmScan(type){addExpense(type);setScanState("idle");setScanResult(null);setModal(null);}
  function cancelScan(){setScanState("idle");setScanResult(null);}
  function retryScan(){setScanState("idle");setScanError(null);}

  const globalStyles=`*{margin:0;padding:0;box-sizing:border-box;}body{background:#0a0a0f;}input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;}input::placeholder{color:rgba(255,255,255,0.2);}select option{background:#13131f;}::-webkit-scrollbar{width:0;}`;

  // ── Loading ────────────────────────────────────────────────────────────────
  if(authLoading) return React.createElement("div",{style:{minHeight:"100vh",background:"#0a0a0f",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16}},
    React.createElement("style",null,globalStyles),
    React.createElement(BudgieLogo,{size:60}),
    React.createElement("p",{style:{color:"rgba(255,255,255,0.3)",fontSize:14}},"Loading...")
  );

  // ── Auth screen ────────────────────────────────────────────────────────────
  if(!authToken) return React.createElement("div",{style:S.app},
    React.createElement("style",null,globalStyles),
    React.createElement(AuthScreen,{onAuth:handleAuth})
  );

  // ── Upgrade screen ─────────────────────────────────────────────────────────
  if(showUpgrade) return React.createElement("div",{style:S.app},
    React.createElement("style",null,globalStyles),
    React.createElement(UpgradeScreen,{token:authToken,currentPlan:plan,onClose:()=>setShowUpgrade(false)})
  );

  // ── Loading data ───────────────────────────────────────────────────────────
  if(dataLoading) return React.createElement("div",{style:{minHeight:"100vh",background:"#0a0a0f",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:16}},
    React.createElement("style",null,globalStyles),
    React.createElement(BudgieLogo,{size:60}),
    React.createElement("p",{style:{color:"rgba(255,255,255,0.3)",fontSize:14}},"Setting up your budget...")
  );

  // ── Onboarding ─────────────────────────────────────────────────────────────
  if(!budget) return React.createElement("div",{style:S.app},
    React.createElement("style",null,globalStyles),
    React.createElement(Onboarding,{userName:profile?.name||user?.email?.split("@")[0]||"",onComplete:handleOnboardingComplete})
  );

  // ── Main app ───────────────────────────────────────────────────────────────
  return React.createElement("div",{style:S.app},
    React.createElement("style",null,globalStyles),

    tab==="home"&&React.createElement(HomeTab,{budget,expenses,updateBudget,incomeCurrency,rates,spentByType,totalSpent,allExpenses:expenses,onOpenRates:()=>setShowRates(true),plan,onUpgrade:()=>setShowUpgrade(true),userName:profile?.name||user?.email?.split("@")[0]||""}),
    tab==="expenses"&&React.createElement(ExpensesTab,{expenses,updateBudget,incomeCurrency,rates,onOpenAdd:openAdd,onOpenEdit:openEdit,budget,userName:profile?.name||user?.email?.split("@")[0]||""}),
    tab==="history"&&React.createElement(HistoryTab,{history,plan,onUpgrade:()=>setShowUpgrade(true),userName:profile?.name||user?.email?.split("@")[0]||""}),
    tab==="account"&&React.createElement(AccountTab,{user,profile,token:authToken,onSignOut:handleSignOut,onUpgrade:()=>setShowUpgrade(true)}),

    React.createElement("nav",{style:S.navBar},
      [{id:"home",label:"Overview",icon:IC.home},{id:"expenses",label:"Expenses",icon:IC.receipt},{id:"history",label:"History",icon:IC.history},{id:"account",label:"Account",icon:IC.users}].map(item=>
        React.createElement("button",{key:item.id,style:S.navBtn(tab===item.id),onClick:()=>setTab(item.id)},
          React.createElement(Icon,{d:item.icon,size:20,stroke:"currentColor"}),item.label)
      )
    ),

    React.createElement(ExpenseModal,{modal,onClose:()=>{setModal(null);setEditingExpense(null);},form,setForm,onAdd:addExpense,isEditing:!!editingExpense,scanState,scanResult,scanError,onScanFile:handleScanFile,onConfirmScan:confirmScan,onCancelScan:cancelScan,onRetryScan:retryScan,rates,incomeCurrency}),
    React.createElement(RatesModal,{show:showRates,onClose:()=>setShowRates(false),rates,liveRates,ratesLoading,onSave:(cur,val)=>updateBudget({rates:{...(budget?.rates||{}),[cur]:val}}),onResetToLive:(cur)=>updateBudget({rates:{...(budget?.rates||{}),  [cur]:liveRates[cur]}})}),
    React.createElement(PaydayResetModal,{show:showPaydayReset,userName:profile?.name,income:budget?.monthly_income,currency:incomeCurrency,rates,
      onKeep:()=>setShowPaydayReset(false),
      onUpdate:(newIncome,newCurrency)=>{
        const ronVal=newCurrency==="RON"?newIncome:(parseFloat(newIncome)*(rates[newCurrency]||DEFAULT_RATES[newCurrency]||1)).toString();
        updateBudget({monthly_income:parseFloat(newIncome),income_currency:newCurrency,monthly_income_ron:parseFloat(ronVal)});
        setShowPaydayReset(false);
      }
    })
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(BudgetApp));
