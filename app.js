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
      window.history.replaceState({}, "", window.location.pathname);
      if (token) {
        // Exchange OAuth token for a Supabase session token via refresh
        if (refresh) {
          try {
            const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
              method: "POST", headers,
              body: JSON.stringify({ refresh_token: refresh })
            });
            const data = await r.json();
            if (data.access_token) {
              safeStorage.set("sb_token", data.access_token);
              safeStorage.set("sb_refresh", data.refresh_token || refresh);
              return { access_token: data.access_token };
            }
          } catch(e) { console.error("token exchange error:", e); }
        }
        // Fallback: use token directly
        safeStorage.set("sb_token", token);
        safeStorage.set("sb_refresh", refresh || "");
        return { access_token: token };
      }
    }
    const token = safeStorage.get("sb_token");
    if (!token) return null;
    // Verify token is still valid
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: authHeaders(token)
    });
    if (!r.ok) {
      // Try refresh
      const refresh = safeStorage.get("sb_refresh");
      if (refresh) {
        try {
          const rr = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
            method: "POST", headers,
            body: JSON.stringify({ refresh_token: refresh })
          });
          const data = await rr.json();
          if (data.access_token) {
            safeStorage.set("sb_token", data.access_token);
            if (data.refresh_token) safeStorage.set("sb_refresh", data.refresh_token);
            return { access_token: data.access_token };
          }
        } catch(e) {}
      }
      safeStorage.remove("sb_token");
      return null;
    }
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
const CUR_COLOR  = { RON: "#e94560", EUR: "#43A047", USD: "#1E88E5" };
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
const CAT_COLOR = { needs: "#f97316", wants: "#1E88E5", savings: "#43A047" };

// ─────────────────────────────────────────────────────────────────────────────
// Push Notifications
// ─────────────────────────────────────────────────────────────────────────────
const VAPID_PUBLIC_KEY = "BNeh1VhFBrr5kuWUx4rcJ7BPde3BE1XF8Us728enJ74M6TIpnQOMS4WHtEUuBgUJfRrWW_-oqLpC06wHMOBPDj0";

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function requestPushPermission(token, userId) {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      alert("Push notifications not supported in this browser.");
      return false;
    }

    // Request permission if not already granted
    let permission = Notification.permission;
    if (permission === "default") {
      permission = await Notification.requestPermission();
    }
    if (permission !== "granted") {
      alert("Please enable notifications in your browser settings.");
      return false;
    }

    const reg = await navigator.serviceWorker.ready;

    // Check if already subscribed
    let sub = await reg.pushManager.getSubscription();
    if (sub) {
      // Already subscribed — just save to DB in case it wasn't saved
      console.log("Already subscribed, saving to DB...");
    } else {
      // Create new subscription
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
    }

    // Save subscription to Supabase (upsert)
    const db = await sb.from("push_subscriptions", token);
    await db.upsert({ user_id: userId, subscription: sub.toJSON() });
    console.log("Push subscription saved:", sub.endpoint.slice(0, 50));
    return true;
  } catch(e) {
    console.error("Push permission error:", e.message);
    alert("Error enabling notifications: " + e.message);
    return false;
  }
}

async function sendLocalNotification(title, body, url="/") {
  if (Notification.permission !== "granted") return;
  const reg = await navigator.serviceWorker.ready;
  reg.showNotification(title, {
    body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url },
  });
}

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

// Image to base64 helper
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

// PDF to base64 image — renders first page using pdf.js
async function pdfToJpeg(file) {
  // Load pdf.js from CDN if not already loaded
  if (!window.pdfjsLib) {
    await new Promise((res, rej) => {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      script.onload = res;
      script.onerror = rej;
      document.head.appendChild(script);
    });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const page = await pdf.getPage(1); // first page only

  const scale = 2.0; // higher = better quality
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;

  return canvas.toDataURL("image/jpeg", 0.92).split(",")[1];
}

// Convert any file (image or PDF) to base64 jpeg
async function fileToBase64(file) {
  if (file.type === "application/pdf" || file.name?.toLowerCase().endsWith(".pdf")) {
    return pdfToJpeg(file);
  }
  return toJpeg(file);
}

// ─────────────────────────────────────────────────────────────────────────────
// Static styles
// ─────────────────────────────────────────────────────────────────────────────
const S = {
  app:     { fontFamily:"'DM Sans','Segoe UI',sans-serif", background:"#0a0a0f", color:"#f0f0f5", minHeight:"100vh", maxWidth:480, width:"100%", margin:"0 auto", position:"relative", paddingBottom:80, overflowX:"hidden" },
  header:  { padding:"max(env(safe-area-inset-top, 16px), 44px) 20px 16px", background:"linear-gradient(160deg,#13131f 0%,#0a0a0f 100%)" },
  card:    { background:"rgba(255,255,255,0.04)", borderRadius:16, padding:16, border:"1px solid rgba(255,255,255,0.07)" },
  input:   { width:"100%", background:"rgba(255,255,255,0.06)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:12, padding:"12px 14px", color:"#f0f0f5", fontSize:15, outline:"none", boxSizing:"border-box", fontFamily:"inherit" },
  btn:     (color="#e94560",full=false) => ({ background:color, color:"#fff", border:"none", borderRadius:14, padding:"14px 24px", fontSize:15, fontWeight:700, cursor:"pointer", width:full?"100%":"auto", fontFamily:"inherit" }),
  ghost:   { background:"rgba(255,255,255,0.06)", color:"rgba(255,255,255,0.6)", border:"1px solid rgba(255,255,255,0.1)", borderRadius:14, padding:"14px 16px", fontSize:14, fontWeight:600, cursor:"pointer", fontFamily:"inherit" },
  navBar:  { position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)", width:"100%", maxWidth:480, background:"rgba(10,10,15,0.95)", backdropFilter:"blur(20px)", borderTop:"1px solid rgba(255,255,255,0.07)", display:"flex", justifyContent:"space-around", padding:"10px 0 16px", zIndex:100 },
  navBtn:  (a) => ({ display:"flex", flexDirection:"column", alignItems:"center", gap:4, background:"none", border:"none", color:a?"#e94560":"rgba(255,255,255,0.35)", cursor:"pointer", fontSize:10, fontWeight:600, letterSpacing:"0.5px", textTransform:"uppercase" }),
  overlay: { position:"fixed", inset:0, background:"rgba(0,0,0,0.75)", zIndex:200, display:"flex", alignItems:"flex-end", backdropFilter:"blur(4px)" },
  sheet:   { background:"#13131f", borderRadius:"20px 20px 0 0", padding:"24px 20px max(env(safe-area-inset-bottom, 20px), 32px)", width:"100%", maxWidth:480, margin:"0 auto", border:"1px solid rgba(255,255,255,0.08)", maxHeight:"92vh", overflowY:"auto" },
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
  pin:     "M12 2a7 7 0 0 1 7 7c0 5-7 13-7 13S5 14 5 9a7 7 0 0 1 7-7z M12 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  trending:"M22 7l-8.5 8.5-5-5L2 17 M16 7h6v6",
  shield:  "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
  bell:    "M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 0 1-3.46 0",
  bot:     "M12 8V4H8 M8 8h8a4 4 0 0 1 4 4v4a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-4a4 4 0 0 1 4-4z M9 13h.01 M15 13h.01",
  zap:     "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
  thumbsup:"M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3",
  calendar:"M3 4h18v18H3z M16 2v4 M8 2v4 M3 10h18",
  clock:   "M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2z M12 6v6l4 2",
  bulb:    "M9 18h6 M10 22h4 M12 2a7 7 0 0 1 7 7 7 7 0 0 1-7 7 7 7 0 0 1-7-7 7 7 0 0 1 7-7z",
  star:    "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z",
  family:  "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75 M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8z",
  download:"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4 M7 10l5 5 5-5 M12 15V3",
  alert:   "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z M12 9v4 M12 17h.01",
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
        React.createElement("stop",{offset:"100%",stopColor:"#43A047"}))),
    React.createElement("ellipse",{cx:"34",cy:"40",rx:"18",ry:"20",fill:"url(#bodyGrad)"}),
    React.createElement("ellipse",{cx:"35",cy:"46",rx:"10",ry:"12",fill:"#fffbe6",opacity:"0.9"}),
    React.createElement("ellipse",{cx:"20",cy:"38",rx:"10",ry:"16",fill:"#22d4a0",transform:"rotate(-15 20 38)"}),
    React.createElement("circle",{cx:"38",cy:"18",r:"13",fill:"url(#bodyGrad)"}),
    React.createElement("circle",{cx:"44",cy:"22",r:"4",fill:"#f97316",opacity:"0.8"}),
    React.createElement("circle",{cx:"40",cy:"15",r:"4",fill:"#fff"}),
    React.createElement("circle",{cx:"41",cy:"15",r:"2.2",fill:"#1e293b"}),
    React.createElement("circle",{cx:"42",cy:"14",r:"0.8",fill:"#fff"}),
    React.createElement("path",{d:"M33 20 L28 23 L33 25 Z",fill:"#1E88E5"}),
    React.createElement("circle",{cx:"54",cy:"12",r:"7",fill:"#1E88E5",opacity:"0.95"}),
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
        React.createElement("p",{style:{fontSize:28,fontWeight:900,marginTop:12,background:"linear-gradient(90deg,#4ade9e,#43A047)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",display:"inline-block",paddingRight:4}},"Budgie"),
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

  // Stripe Payment Links — direct redirect, no server needed
  const PAYMENT_LINKS = {
    pro_monthly:    "https://buy.stripe.com/test_fZu14n7ht2aI76ycdWbsc00",
    pro_yearly:     "https://buy.stripe.com/test_dRm5kD6dpbLi1Meb9Sbsc01",
    family_monthly: "https://buy.stripe.com/test_9B6eVd6dp8z64Yqem4bsc02",
    family_yearly:  "https://buy.stripe.com/test_00w6oH0T57v2duW4Lubsc03",
  };

  async function checkout(priceKey) {
    setLoading(priceKey);
    const link = PAYMENT_LINKS[priceKey];
    if (link) {
      window.location.href = link;
      return;
    }
    alert("Payment link not found for: " + priceKey);
    setLoading(null);
  }

  function manageSubscription() {
    window.location.href = "https://billing.stripe.com/p/login/test_fZu14n7ht2aI76ycdWbsc00";
  }

  const plans = [
    {
      key: "free", name: "Free", color: "rgba(255,255,255,0.4)",
      monthlyPrice: "€0", yearlyPrice: "€0",
      yearlyMonthly: "€0",
      features: [
        "1 budget",
        "Fixed & variable expenses",
        "50-30-20 overview",
        "Multi-currency support",
        "3 AI scan credits",
      ],
      priceKey: null,
    },
    {
      key: "pro", name: "Pro", color: "#43A047",
      monthlyPrice: "€2.99", yearlyPrice: "€29.99",
      yearlyMonthly: "€2.50",
      features: [
        "Unlimited budgets",
        "Full spending history",
        "CSV & PDF export",
        "Cloud backup & sync",
        "10 AI scan credits/month",
      ],
      priceKey: billingCycle === "monthly" ? "pro_monthly" : "pro_yearly",
    },
    {
      key: "family", name: "Family", color: "#4ade9e",
      monthlyPrice: "€4.99", yearlyPrice: "€49.99",
      yearlyMonthly: "€4.17",
      features: [
        "Everything in Pro",
        "2–5 members per budget",
        "Shared budget & expenses",
        "Family spending insights",
        "20 AI scan credits/month",
      ],
      priceKey: billingCycle === "monthly" ? "family_monthly" : "family_yearly",
    }
  ];

  return React.createElement("div",{style:{minHeight:"100vh",background:"#0a0a0f",overflowY:"auto",maxWidth:420,margin:"0 auto"}},
    // Header
    React.createElement("div",{style:{padding:"44px 20px 16px",background:"linear-gradient(160deg,#13131f 0%,#0a0a0f 100%)"}},
      React.createElement("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center"}},
        React.createElement("div",null,
          React.createElement("p",{style:{fontSize:22,fontWeight:900}},"Upgrade Budgie"),
          React.createElement("p",{style:{fontSize:13,color:"rgba(255,255,255,0.4)",marginTop:4}},
          currentPlan === "free" ? "Unlock the full experience" : "Change your plan")
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
        React.createElement("div",{key:plan.key,style:{...S.card,marginBottom:16,border:`1px solid rgba(${rgb(plan.color==="rgba(255,255,255,0.4)"?"255,255,255":rgb(plan.color))},${plan.key==="free"?"0.1":"0.3"})`,position:"relative",overflow:"hidden",
          opacity:plan.key==="free"&&currentPlan!=="free"?0.5:1}},
          plan.key==="family" && React.createElement("div",{style:{position:"absolute",top:12,right:12,fontSize:10,padding:"3px 10px",borderRadius:99,background:`rgba(${rgb(plan.color)},0.15)`,color:plan.color,fontWeight:700}},"MOST POPULAR"),

          React.createElement("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16}},
            React.createElement("div",null,
              React.createElement("p",{style:{fontSize:18,fontWeight:900,color:plan.key==="free"?"rgba(255,255,255,0.5)":plan.color}},"Budgie ",plan.name),
              React.createElement("p",{style:{fontSize:13,color:"rgba(255,255,255,0.4)"}},
                plan.key==="free" ? "Free forever" :
                billingCycle==="monthly"
                  ? `${plan.monthlyPrice}/month`
                  : `${plan.yearlyPrice}/year (${plan.yearlyMonthly}/mo)`)
            )
          ),

          plan.features.map(f =>
            React.createElement("div",{key:f,style:{display:"flex",alignItems:"center",gap:8,marginBottom:8}},
              React.createElement(Icon,{d:IC.check,size:15,stroke:plan.key==="free"?"rgba(255,255,255,0.3)":plan.color}),
              React.createElement("span",{style:{fontSize:13,color:plan.key==="free"?"rgba(255,255,255,0.4)":"rgba(255,255,255,0.7)"}},f)
            )
          ),

          currentPlan === plan.key
            ? React.createElement("div",{style:{marginTop:16,padding:"10px",textAlign:"center",borderRadius:10,background:`rgba(${plan.key==="free"?"255,255,255":rgb(plan.color)},0.1)`,color:plan.key==="free"?"rgba(255,255,255,0.4)":plan.color,fontSize:13,fontWeight:700}},"✓ Current Plan")
            : plan.key==="free" ? null
            : React.createElement("button",{
                style:{...S.btn(plan.color,true),marginTop:16},
                onClick:()=>checkout(plan.priceKey),
                disabled:!!loading},
                loading===plan.priceKey ? "Redirecting..."
                  : currentPlan !== "free" ? `Switch to ${plan.name}`
                  : `Upgrade to ${plan.name} — ${plan.monthlyPrice}/mo`)
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
      React.createElement("h1",{style:{fontSize:28,fontWeight:900,marginTop:16,marginBottom:8,background:"linear-gradient(90deg,#4ade9e,#43A047)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",display:"inline-block",paddingRight:4}},"Welcome, ",userName,"!"),
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
        [["Needs","50%",parseFloat(income)*0.5,"#e94560"],["Wants","30%",parseFloat(income)*0.3,"#1E88E5"],["Savings","20%",parseFloat(income)*0.2,"#43A047"]].map(([l,p,v,c])=>
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
        React.createElement("div",{style:{width:7,height:7,borderRadius:99,flexShrink:0,background:ratesLoading?"#1E88E5":liveRates?"#4ade9e":"rgba(255,255,255,0.2)",boxShadow:liveRates?"0 0 6px #4ade9e":"none"}}),
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
            React.createElement("button",{style:S.btn("#43A047"),onClick:()=>{
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
            React.createElement("button",{style:S.btn("#1E88E5"),onClick:()=>{
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

// ─────────────────────────────────────────────────────────────────────────────
// LineItemsSelector — editable checklist for detailed scan results
// ─────────────────────────────────────────────────────────────────────────────
function LineItemsSelector({scanResult, form, fmt, classify, onConfirmItems, onCancelScan}) {
  const [items, setItems] = useState(() =>
    (scanResult.items || []).map((item, i) => ({
      ...item,
      id: i,
      selected: true,
      type: "daily",  // default: variable
      editName: item.name || "",
      editAmount: (item.total || item.unit_price || 0).toString(),
      editCategory: classify(item.category || item.name || ""),
      editSubcat: item.category || "",
      editing: false,
    }))
  );

  function toggleItem(id) {
    setItems(its => its.map(it => it.id===id ? {...it, selected:!it.selected} : it));
  }

  function toggleEdit(id) {
    setItems(its => its.map(it => it.id===id ? {...it, editing:!it.editing} : it));
  }

  function updateItem(id, field, val) {
    setItems(its => its.map(it => it.id===id ? {...it, [field]:val} : it));
  }

  const selectedCount = items.filter(i => i.selected).length;
  const selectedTotal = items.filter(i => i.selected).reduce((sum, i) => sum + (parseFloat(i.editAmount)||0), 0);

  return React.createElement("div",null,
    // Header
    React.createElement("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}},
      React.createElement("div",null,
        React.createElement("p",{style:{fontWeight:800,fontSize:16}},scanResult.name||"Receipt"),
        React.createElement("p",{style:{fontSize:11,color:"rgba(255,255,255,0.35)"}},
          scanResult.date||"", scanResult.date?" · ":"",
          `${items.length} items found`)
      ),
      React.createElement("p",{style:{fontSize:18,fontWeight:900,color:"#43A047"}},
        fmt(scanResult.total||0, form.currency))
    ),

    // Select all / none
    React.createElement("div",{style:{display:"flex",gap:8,marginBottom:10}},
      React.createElement("button",{style:{...S.ghost,fontSize:12,padding:"6px 12px"},
        onClick:()=>setItems(its=>its.map(it=>({...it,selected:true})))},"Select all"),
      React.createElement("button",{style:{...S.ghost,fontSize:12,padding:"6px 12px"},
        onClick:()=>setItems(its=>its.map(it=>({...it,selected:false})))},"Clear all")
    ),

    // Items list
    React.createElement("div",{style:{maxHeight:340,overflowY:"auto",marginBottom:12}},
      items.map(item =>
        React.createElement("div",{key:item.id,style:{
          ...S.card, marginBottom:8, padding:"10px 12px",
          border: item.selected ? "1px solid rgba(15,188,249,0.3)" : "1px solid rgba(255,255,255,0.06)",
          opacity: item.selected ? 1 : 0.5,
        }},
          // Row: checkbox + name + amount + edit button
          React.createElement("div",{style:{display:"flex",alignItems:"center",gap:10}},
            // Checkbox
            React.createElement("button",{
              style:{width:22,height:22,borderRadius:6,border:`2px solid ${item.selected?"#43A047":"rgba(255,255,255,0.2)"}`,
                background:item.selected?"#43A047":"transparent",flexShrink:0,cursor:"pointer",
                display:"flex",alignItems:"center",justifyContent:"center"},
              onClick:()=>toggleItem(item.id)},
              item.selected && React.createElement(Icon,{d:IC.check,size:12,stroke:"#fff"})
            ),
            // Name & details
            React.createElement("div",{style:{flex:1,minWidth:0},onClick:()=>toggleItem(item.id),style:{flex:1,minWidth:0,cursor:"pointer"}},
              React.createElement("p",{style:{fontWeight:600,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}},
                item.editName),
              React.createElement("p",{style:{fontSize:11,color:"rgba(255,255,255,0.35)"}},
                item.qty&&item.qty>1?`${item.qty}x · `:"", item.editSubcat||item.editCategory)
            ),
            // Amount
            React.createElement("p",{style:{fontWeight:800,fontSize:14,color:"#43A047",flexShrink:0}},
              fmt(parseFloat(item.editAmount)||0, form.currency)),
            // Type toggle
            React.createElement("button",{
              style:{fontSize:10,fontWeight:700,padding:"3px 8px",borderRadius:99,border:"none",cursor:"pointer",
                background:item.type==="recurring"?"rgba(233,69,96,0.15)":"rgba(245,166,35,0.15)",
                color:item.type==="recurring"?"#e94560":"#1E88E5"},
              onClick:()=>updateItem(item.id,"type",item.type==="recurring"?"daily":"recurring")},
              item.type==="recurring"?"Fixed":"Var."
            ),
            // Edit toggle
            React.createElement("button",{
              style:{background:"none",border:"none",color:"rgba(255,255,255,0.3)",cursor:"pointer",padding:4},
              onClick:()=>toggleEdit(item.id)},
              React.createElement(Icon,{d:IC.edit,size:14}))
          ),

          // Inline edit form
          item.editing && React.createElement("div",{style:{marginTop:10,paddingTop:10,borderTop:"1px solid rgba(255,255,255,0.07)"}},
            React.createElement("div",{style:{display:"flex",flexDirection:"column",gap:8}},
              React.createElement("div",null,
                React.createElement("label",{style:S.label},"Name"),
                React.createElement("input",{style:{...S.input,fontSize:13},value:item.editName,
                  onChange:e=>updateItem(item.id,"editName",e.target.value)})
              ),
              React.createElement("div",{style:{display:"flex",gap:8}},
                React.createElement("div",{style:{flex:1}},
                  React.createElement("label",{style:S.label},"Amount (",form.currency,")"),
                  React.createElement("input",{style:{...S.input,fontSize:13},type:"number",value:item.editAmount,
                    onChange:e=>updateItem(item.id,"editAmount",e.target.value)})
                ),
                React.createElement("div",{style:{flex:1}},
                  React.createElement("label",{style:S.label},"Category"),
                  React.createElement("select",{style:{...S.input,fontSize:13},value:item.editCategory,
                    onChange:e=>updateItem(item.id,"editCategory",e.target.value)},
                    ["needs","wants","savings"].map(c=>
                      React.createElement("option",{key:c,value:c},c.charAt(0).toUpperCase()+c.slice(1))
                    )
                  )
                )
              ),
              React.createElement("button",{style:{...S.ghost,fontSize:12,padding:"6px"},
                onClick:()=>toggleEdit(item.id)},"Done editing")
            )
          )
        )
      )
    ),

    // Summary + Add button
    React.createElement("div",{style:{...S.card,marginBottom:12,padding:"10px 14px",display:"flex",justifyContent:"space-between",alignItems:"center"}},
      React.createElement("p",{style:{fontSize:13,color:"rgba(255,255,255,0.5)"}},
        `${selectedCount} item${selectedCount!==1?"s":""} selected`),
      React.createElement("p",{style:{fontWeight:800,color:"#43A047"}},
        fmt(selectedTotal, form.currency))
    ),

    React.createElement("p",{style:{fontSize:11,color:"rgba(255,255,255,0.35)",marginBottom:8,textAlign:"center"}},
      "Tap ",React.createElement("span",{style:{color:"#e94560",fontWeight:700}},"Fixed"),
      " / ",React.createElement("span",{style:{color:"#1E88E5",fontWeight:700}},"Var."),
      " on each item to set type individually"),
    React.createElement("div",{style:{display:"flex",gap:8}},
      React.createElement("button",{
        style:{...S.btn("#4ade9e",true),flex:1,color:"#0a0a0f",opacity:selectedCount>0?1:0.4},
        disabled:selectedCount===0,
        onClick:()=>onConfirmItems(items.filter(i=>i.selected))},
        `Add ${selectedCount} selected`),
      React.createElement("button",{style:{...S.ghost,padding:"14px"},onClick:onCancelScan},
        React.createElement(Icon,{d:IC.x,size:16}))
    )
  );
}

function ExpenseModal({modal,onClose,form,setForm,onAdd,isEditing,scanState,scanResult,scanError,onScanFile,onConfirmScan,onCancelScan,onRetryScan,onConfirmItems,rates,incomeCurrency,budgets,activeBudgetId,aiCredits,onBuyCredits}) {
  const fileRef=useRef(), cameraRef=useRef();
  const [scanMode, setScanMode] = useState("simple");
  const [scanModeInfo, setScanModeInfo] = useState(false);
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
          e("h3",{style:{fontWeight:800,fontSize:18}},scanResult.mode==="detailed"?"Receipt Scanned — Line Items ✓":"Receipt Scanned ✓"),
          e("button",{style:{background:"none",border:"none",color:"rgba(255,255,255,0.4)",cursor:"pointer"},onClick:onCancelScan},e(Icon,{d:IC.x,size:20}))
        ),

        // Simple mode result
        scanResult.mode!=="detailed"&&e(React.Fragment,null,
          e("div",{style:{...S.card,marginBottom:20,background:"rgba(15,188,249,0.06)",border:"1px solid rgba(15,188,249,0.2)"}},
            [["Merchant",scanResult.name,"#f0f0f5"],["Amount",fmt(parseFloat(scanResult.amount)||0,form.currency),"#43A047"],["Category",scanResult.category,"#f0f0f5"]].map(([k,v,c])=>
              e("div",{key:k,style:{display:"flex",justifyContent:"space-between",marginBottom:8}},
                e("span",{style:{fontSize:12,color:"rgba(255,255,255,0.4)",fontWeight:600,textTransform:"uppercase"}},k),
                e("span",{style:{fontWeight:700,color:c}},v)
              )
            ),
            convertedPreview!==null&&e("div",{style:{borderTop:"1px solid rgba(255,255,255,0.08)",paddingTop:8,marginTop:4,display:"flex",justifyContent:"space-between"}},
              e("span",{style:{fontSize:12,color:"rgba(255,255,255,0.4)",fontWeight:600,textTransform:"uppercase"}},"Converted"),
              e("span",{style:{fontWeight:700,color:"#1E88E5"}},"≈ ",fmt(convertedPreview,incomeCurrency))
            )
          ),
          e("p",{style:{fontSize:13,color:"rgba(255,255,255,0.4)",marginBottom:14}},"Save as:"),
          e("div",{style:{display:"flex",gap:10}},
            e("button",{style:S.btn("#e94560"),onClick:()=>onConfirmScan("recurring")},"Fixed"),
            e("button",{style:S.btn("#1E88E5"),onClick:()=>onConfirmScan("daily")},"Variable"),
            e("button",{style:S.ghost,onClick:onCancelScan},"Cancel")
          )
        ),

        // Detailed mode — line items with checkboxes and inline edit
        scanResult.mode==="detailed"&&e(LineItemsSelector,{
          scanResult, form, fmt, classify, onConfirmItems, onCancelScan
        })
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
        !isEditing&&e("input",{ref:fileRef,type:"file",accept:"image/*,application/pdf",style:{display:"none"},onChange:ev=>onScanFile(ev.target.files[0],scanMode)}),
        !isEditing&&e("input",{ref:cameraRef,type:"file",accept:"image/*",capture:"environment",style:{display:"none"},onChange:ev=>onScanFile(ev.target.files[0],scanMode)}),
        // Budget selector — only show if user has multiple budgets
        budgets && budgets.length > 1 && !isEditing && e("div",{style:{marginBottom:14}},
          e("label",{style:S.label},"Add to budget"),
          e("select",{style:S.input,value:form.targetBudgetId||activeBudgetId,
            onChange:ev=>setForm(f=>({...f,targetBudgetId:ev.target.value}))},
            budgets.map(b=>e("option",{key:b.id,value:b.id},b.name))
          )
        ),

        // 1. Name
        e("div",{style:{marginBottom:14}},
          e("label",{style:S.label},"Name"),
          e("input",{style:S.input,value:form.name,onChange:ev=>setForm(f=>({...f,name:ev.target.value})),placeholder:"e.g. Netflix, Kaufland..."})
        ),
        // 2. Category
        e("div",{style:{marginBottom:14}},
          e("label",{style:S.label},"Category"),
          e("div",{style:{display:"flex",gap:8}},
            ["needs","wants","savings"].map(c=>e("button",{key:c,style:S.pill(form.category===c,CAT_COLOR[c]),onClick:()=>setForm(f=>({...f,category:c}))},c.charAt(0).toUpperCase()+c.slice(1)))
          )
        ),
        // 3. Amount & Currency
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
          convertedPreview!==null&&form.amount&&e("p",{style:{fontSize:12,color:"#43A047",marginTop:7}},
            "≈ ",fmt(convertedPreview,incomeCurrency)," ",
            form.customRate?e("span",{style:{color:"#1E88E5"}},"· custom rate"):e("span",{style:{color:"rgba(255,255,255,0.3)"}},"· default rate")
          )
        ),
        // 4. Comments
        e("div",{style:{marginBottom:20}},
          e("label",{style:S.label},"Comments"),
          e("input",{style:S.input,value:form.subcat,onChange:ev=>setForm(f=>({...f,subcat:ev.target.value})),placeholder:"Optional note..."})
        ),
        e("button",{style:S.btn("#e94560",true),onClick:()=>onAdd(type)},isEditing?"Save Changes":"Add Expense"),

        // ── OR using the AI ─────────────────────────────────────────────────
        !isEditing&&e(React.Fragment,null,
          e("div",{style:{display:"flex",alignItems:"center",gap:10,margin:"20px 0 16px"}},
            e("div",{style:{flex:1,height:1,background:"rgba(255,255,255,0.07)"}}),
            e("span",{style:{fontSize:11,color:"rgba(255,255,255,0.3)",fontWeight:600,letterSpacing:"0.5px"}},"OR USING THE AI"),
            e("div",{style:{flex:1,height:1,background:"rgba(255,255,255,0.07)"}})
          ),
          // Credits indicator
          aiCredits !== undefined && e("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,padding:"8px 12px",borderRadius:10,
            background:aiCredits>5?"rgba(74,222,158,0.06)":aiCredits>0?"rgba(245,166,35,0.06)":"rgba(233,69,96,0.06)",
            border:`1px solid ${aiCredits>5?"rgba(74,222,158,0.2)":aiCredits>0?"rgba(245,166,35,0.2)":"rgba(233,69,96,0.2)"}`}},
            e("div",{style:{display:"flex",alignItems:"center",gap:6}},
              e(Icon,{d:IC.bot,size:14,stroke:aiCredits>0?"rgba(255,255,255,0.5)":"#e94560"}),
              e("span",{style:{fontSize:12,color:"rgba(255,255,255,0.5)"}},
                aiCredits>0?`${aiCredits} scan credit${aiCredits===1?"":"s"} remaining`:"No scan credits remaining")
            ),
            aiCredits<=0&&e("button",{style:{fontSize:11,color:"#4ade9e",background:"none",border:"none",cursor:"pointer",fontWeight:700},
              onClick:onBuyCredits},"Buy credits →")
          ),
          // Scan mode selector
          aiCredits>0&&e("div",{style:{marginBottom:12}},
            e("div",{style:{display:"flex",alignItems:"center",gap:6,marginBottom:8}},
              e("label",{style:{...S.label,marginBottom:0}},"Scan mode"),
              e("button",{
                style:{background:"none",border:"none",cursor:"pointer",padding:2,display:"flex"},
                onClick:()=>setScanModeInfo(!scanModeInfo)},
                e(Icon,{d:"M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 16v-4 M12 8h.01",size:15,stroke:"rgba(255,255,255,0.4)"})
              )
            ),
            scanModeInfo&&e("div",{style:{...S.card,marginBottom:10,padding:14,background:"rgba(255,255,255,0.03)"}},
              e("div",{style:{marginBottom:10}},
                e("div",{style:{display:"flex",alignItems:"center",gap:6,marginBottom:4}},
                  e("div",{style:{width:8,height:8,borderRadius:99,background:"#43A047",flexShrink:0}}),
                  e("p",{style:{fontWeight:700,fontSize:13,color:"#43A047"}},"Simple — Total only")
                ),
                e("p",{style:{fontSize:12,color:"rgba(255,255,255,0.5)",lineHeight:1.5,paddingLeft:14}},
                  "Extracts the merchant name, total amount, currency and date. Best for quick everyday expense logging.")
              ),
              e("div",null,
                e("div",{style:{display:"flex",alignItems:"center",gap:6,marginBottom:4}},
                  e("div",{style:{width:8,height:8,borderRadius:99,background:"#1E88E5",flexShrink:0}}),
                  e("p",{style:{fontWeight:700,fontSize:13,color:"#1E88E5"}},"Detailed — Line items")
                ),
                e("p",{style:{fontSize:12,color:"rgba(255,255,255,0.5)",lineHeight:1.5,paddingLeft:14}},
                  "Extracts every individual item from the receipt or invoice — name, quantity and price. Perfect for business expenses, invoices or splitting a bill.")
              ),
              e("button",{style:{...S.ghost,width:"100%",marginTop:10,fontSize:12,padding:"8px"},
                onClick:()=>setScanModeInfo(false)},"Got it")
            ),
            e("div",{style:{display:"flex",gap:8,marginBottom:12}},
              e("button",{style:S.pill(scanMode==="simple","#43A047"),onClick:()=>setScanMode("simple")},"Simple (total only)"),
              e("button",{style:S.pill(scanMode==="detailed","#1E88E5"),onClick:()=>setScanMode("detailed")},"Detailed (line items)")
            )
          ),
          // Upload / Camera buttons
          e("div",{style:{display:"flex",gap:8,opacity:aiCredits>0?1:0.4,pointerEvents:aiCredits>0?"auto":"none"}},
            e("button",{style:{flex:1,...S.card,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,padding:"11px 14px"},onClick:()=>fileRef.current?.click()},
              e(Icon,{d:IC.receipt,size:15,stroke:"rgba(255,255,255,0.5)"}),
              e("span",{style:{fontSize:13,fontWeight:600,color:"rgba(255,255,255,0.7)"}},"Upload / PDF")),
            e("button",{style:{flex:1,...S.card,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,padding:"11px 14px"},onClick:()=>cameraRef.current?.click()},
              e(Icon,{d:IC.camera,size:15,stroke:"rgba(255,255,255,0.5)"}),
              e("span",{style:{fontSize:13,fontWeight:600,color:"rgba(255,255,255,0.7)"}},"Camera"))
          )
        )
      )
    )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Home Tab
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// BudgetMethodCard — shown once after first login
// ─────────────────────────────────────────────────────────────────────────────
function BudgetMethodCard({onDismiss}) {
  return React.createElement("div",{style:{
    position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",zIndex:500,
    display:"flex",alignItems:"flex-end",backdropFilter:"blur(4px)"}},
    React.createElement("div",{style:{
      background:"#13131f",borderRadius:"24px 24px 0 0",padding:"28px 20px 40px",
      width:"100%",maxWidth:480,margin:"0 auto",
      border:"1px solid rgba(255,255,255,0.08)"}},
      React.createElement("div",{style:{textAlign:"center",marginBottom:20}},
        React.createElement("div",{style:{
          width:56,height:56,borderRadius:99,
          background:"linear-gradient(135deg,#f97316,#1E88E5,#43A047)",
          display:"flex",alignItems:"center",justifyContent:"center",
          margin:"0 auto 12px"}},
          React.createElement(Icon,{d:IC.wallet,size:24,stroke:"#fff"})
        ),
        React.createElement("h3",{style:{fontWeight:900,fontSize:20,marginBottom:6}},
          "The 50-30-20 Rule"),
        React.createElement("p",{style:{fontSize:13,color:"rgba(255,255,255,0.5)",lineHeight:1.6}},
          "A simple way to balance your budget every month")
      ),
      [
        {color:"#f97316",pct:"50%",name:"Needs",icon:IC.home,
          desc:"Essential expenses you can't avoid",
          examples:"Rent, utilities, groceries, transport, insurance, healthcare"},
        {color:"#1E88E5",pct:"30%",name:"Wants",icon:IC.sparkle,
          desc:"Things you enjoy but don't strictly need",
          examples:"Dining out, Netflix, shopping, travel, hobbies"},
        {color:"#43A047",pct:"20%",name:"Savings",icon:IC.wallet,
          desc:"Money you put aside for the future",
          examples:"Emergency fund, investments, debt repayment, goals"},
      ].map(item=>
        React.createElement("div",{key:item.name,style:{
          display:"flex",gap:12,marginBottom:14,padding:"12px 14px",
          borderRadius:14,background:`rgba(${rgb(item.color)},0.06)`,
          border:`1px solid rgba(${rgb(item.color)},0.15)`}},
          React.createElement("div",{style:{
            width:38,height:38,borderRadius:10,flexShrink:0,
            background:`rgba(${rgb(item.color)},0.12)`,
            display:"flex",alignItems:"center",justifyContent:"center"}},
            React.createElement(Icon,{d:item.icon,size:18,stroke:item.color})
          ),
          React.createElement("div",null,
            React.createElement("div",{style:{display:"flex",alignItems:"center",gap:6,marginBottom:2}},
              React.createElement("span",{style:{fontWeight:800,fontSize:15,color:item.color}},item.pct),
              React.createElement("span",{style:{fontWeight:700,fontSize:15}}," ",item.name)
            ),
            React.createElement("p",{style:{fontSize:12,color:"rgba(255,255,255,0.5)",marginBottom:3}},item.desc),
            React.createElement("p",{style:{fontSize:11,color:"rgba(255,255,255,0.3)",fontStyle:"italic"}},item.examples)
          )
        )
      ),
      React.createElement("button",{
        style:{...S.btn("#4ade9e",true),color:"#0a0a0f",marginTop:8,fontSize:15},
        onClick:onDismiss},"Got it! Let's start budgeting →")
    )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CategoryTooltip — shown on tap on a circle
// ─────────────────────────────────────────────────────────────────────────────
const CATEGORY_INFO = {
  needs: {
    color:"#f97316", pct:"50%", name:"Needs", icon:IC.home,
    desc:"Essential expenses you can't avoid — things you need to live and work.",
    examples:["Rent / Mortgage","Utilities & bills","Groceries","Transport","Insurance","Healthcare"],
  },
  wants: {
    color:"#1E88E5", pct:"30%", name:"Wants", icon:IC.sparkle,
    desc:"Lifestyle expenses that improve your life but aren't strictly necessary.",
    examples:["Dining out","Entertainment","Shopping","Subscriptions","Travel","Hobbies"],
  },
  savings: {
    color:"#43A047", pct:"20%", name:"Savings", icon:IC.wallet,
    desc:"Money you set aside to build security and reach future goals.",
    examples:["Emergency fund","Investments","Retirement","Debt repayment","Goals"],
  },
};

function CategoryTooltip({cat, onClose}) {
  if (!cat) return null;
  const info = CATEGORY_INFO[cat];
  if (!info) return null;
  return React.createElement("div",{
    style:{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:400,
      display:"flex",alignItems:"center",justifyContent:"center",padding:"24px",
      backdropFilter:"blur(4px)"},
    onClick:onClose},
    React.createElement("div",{
      style:{background:"#13131f",borderRadius:20,padding:"24px 20px",
        width:"100%",maxWidth:340,border:`1px solid rgba(${rgb(info.color)},0.3)`},
      onClick:e=>e.stopPropagation()},
      React.createElement("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}},
        React.createElement("div",{style:{display:"flex",alignItems:"center",gap:10}},
          React.createElement("div",{style:{width:40,height:40,borderRadius:12,
            background:`rgba(${rgb(info.color)},0.12)`,
            display:"flex",alignItems:"center",justifyContent:"center"}},
            React.createElement(Icon,{d:info.icon,size:20,stroke:info.color})
          ),
          React.createElement("div",null,
            React.createElement("p",{style:{fontWeight:900,fontSize:18,color:info.color}},info.name),
            React.createElement("p",{style:{fontSize:12,color:"rgba(255,255,255,0.4)"}},"Budget: ",info.pct," of income")
          )
        ),
        React.createElement("button",{style:{background:"none",border:"none",color:"rgba(255,255,255,0.4)",cursor:"pointer"},onClick:onClose},
          React.createElement(Icon,{d:IC.x,size:20}))
      ),
      React.createElement("p",{style:{fontSize:13,color:"rgba(255,255,255,0.6)",marginBottom:14,lineHeight:1.6}},info.desc),
      React.createElement("p",{style:{fontSize:11,fontWeight:700,color:"rgba(255,255,255,0.3)",textTransform:"uppercase",letterSpacing:"0.8px",marginBottom:8}},"Examples"),
      React.createElement("div",{style:{display:"flex",flexWrap:"wrap",gap:6}},
        info.examples.map(ex=>
          React.createElement("span",{key:ex,style:{
            fontSize:11,padding:"4px 10px",borderRadius:99,
            background:`rgba(${rgb(info.color)},0.1)`,
            color:info.color,fontWeight:600}},ex)
        )
      ),
      React.createElement("button",{style:{...S.ghost,width:"100%",marginTop:16,fontSize:13},onClick:onClose},"Got it")
    )
  );
}

function HomeTab({budget,expenses,updateBudget,incomeCurrency,rates,spentByType,totalSpent,allExpenses,onOpenRates,plan,onUpgrade,userName,onOpenBudgetPicker,budgetsCount,budgetName,onSwitchTab,onCatInfo}) {
  const [editingIncome,setEditingIncome]=useState(false);
  const [incomeInput,setIncomeInput]=useState("");
  const income=parseFloat(budget?.monthly_income)||0;
  const sym=CUR_SYM[incomeCurrency];

  return React.createElement("div",null,
    React.createElement("div",{style:S.header},
      React.createElement("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}},
        React.createElement("div",{style:{display:"flex",alignItems:"center",gap:10},onClick:onOpenBudgetPicker,style:{display:"flex",alignItems:"center",gap:10,cursor:budgetsCount>1||(plan!=="free")?"pointer":"default"}},
          React.createElement(BudgieLogo,{size:44}),
          React.createElement("div",null,
            React.createElement("p",{style:{fontSize:26,fontWeight:900,letterSpacing:"0.5px",lineHeight:1.2,background:"linear-gradient(90deg,#4ade9e,#43A047)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",paddingRight:"4px",paddingBottom:"2px",display:"inline-block"}},"Budgie"),
            React.createElement("div",{style:{display:"flex",alignItems:"center",gap:4}},
              React.createElement("p",{style:{fontSize:11,color:"rgba(255,255,255,0.3)",fontWeight:600,letterSpacing:"1px",textTransform:"uppercase",marginTop:3}},
                budgetName || (userName ? `${userName}'s Budget` : "Budget Tracker")),
              (plan!=="free"||budgetsCount>1) && React.createElement("span",{style:{fontSize:10,color:"rgba(255,255,255,0.2)",marginTop:3}},"▼")
            )
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
          [{key:"needs",label:"Needs",pct:50,budget:income*0.5,color:"#f97316"},
           {key:"wants",label:"Wants",pct:30,budget:income*0.3,color:"#1E88E5"},
           {key:"savings",label:"Savings",pct:20,budget:income*0.2,color:"#43A047"}].map(item=>{
            const spent=spentByType[item.key]||0, rem=item.budget-spent;
            return React.createElement("div",{key:item.key,
              style:{...S.card,padding:"14px 10px",textAlign:"center",cursor:"pointer"},
              onClick:()=>onCatInfo&&onCatInfo(item.key)},
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

        // Insights card
        React.createElement("div",{style:{...S.card,marginBottom:16}},
          React.createElement("p",{style:{fontSize:11,fontWeight:700,marginBottom:12,color:"rgba(255,255,255,0.5)",textTransform:"uppercase",letterSpacing:"0.8px"}},React.createElement(React.Fragment,null,React.createElement(Icon,{d:IC.bulb,size:12,stroke:"rgba(255,255,255,0.5)"}), " Insights")),
          (()=>{
            const insights = [];
            const daysInPeriod = 30;
            const today = new Date();
            const payday = budget?.payday || 1;
            const dayOfMonth = today.getDate();
            const daysLeft = dayOfMonth >= payday
              ? daysInPeriod - (dayOfMonth - payday)
              : payday - dayOfMonth;
            const daysElapsed = daysInPeriod - daysLeft;
            const expectedSpendPct = daysElapsed / daysInPeriod;

            // Per category insights
            [["needs","#f97316",0.5],["wants","#1E88E5",0.3],["savings","#43A047",0.2]].forEach(([cat,color,pct])=>{
              const catBudget = income * pct;
              const catSpent  = spentByType[cat] || 0;
              const spentPct  = catBudget > 0 ? catSpent / catBudget : 0;

              if (cat === "savings") {
                // For savings, more = better — encourage saving
                if (catSpent === 0 && daysElapsed > 3) {
                  insights.push({emoji:"save",msg:`No savings yet this period — set aside ${fmt(catBudget,incomeCurrency)} by payday!`,color:"#43A047"});
                } else if (spentPct >= 1.0) {
                  insights.push({emoji:"check",msg:`Excellent! You've hit your savings goal of ${fmt(catBudget,incomeCurrency)} 🎯`,color:"#4ade9e"});
                } else if (spentPct >= 0.5) {
                  insights.push({emoji:"save",msg:`Good progress — ${fmt(catSpent,incomeCurrency)} saved, ${fmt(catBudget-catSpent,incomeCurrency)} to go!`,color:"#43A047"});
                } else if (daysElapsed > 10) {
                  insights.push({emoji:"save",msg:`Try to save ${fmt(catBudget,incomeCurrency)} this period — you're at ${Math.round(spentPct*100)}%`,color:"#1E88E5"});
                }
                return;
              }

              const label = cat.charAt(0).toUpperCase()+cat.slice(1);
              if (spentPct >= 1.0) {
                insights.push({emoji:"alert",msg:`${label} is over budget by ${fmt(catSpent-catBudget,incomeCurrency)}`,color:"#e94560"});
              } else if (spentPct >= 0.8) {
                insights.push({emoji:"warn",msg:`${label} is at ${Math.round(spentPct*100)}% — ${fmt(catBudget-catSpent,incomeCurrency)} left`,color:"#1E88E5"});
              } else if (spentPct < expectedSpendPct * 0.6 && daysElapsed > 5) {
                insights.push({emoji:"check",msg:`${label} is on track — ${Math.round(spentPct*100)}% used`,color:color});
              }
            });

            // Spending velocity
            if (daysElapsed > 3 && income > 0) {
              const dailyRate = totalSpent / daysElapsed;
              const projected = dailyRate * daysInPeriod;
              if (projected > income * 1.1) {
                insights.push({emoji:"trend",msg:`At this rate you'll spend ${fmt(projected,incomeCurrency)} this period`,color:"#1E88E5"});
              } else if (projected < income * 0.7) {
                insights.push({emoji:"save",msg:`Great pace! Projected to save ${fmt(income-projected,incomeCurrency)}`,color:"#4ade9e"});
              }
            }

            // Days left
            if (daysLeft <= 5 && daysLeft > 0) {
              insights.push({emoji:"cal",msg:`${daysLeft} day${daysLeft===1?"":"s"} left in this period`,color:"rgba(255,255,255,0.5)"});
            }

            if (insights.length === 0) {
              insights.push({emoji:"good",msg:"Everything looks good this period!", color:"#4ade9e"});
            }

            return insights.slice(0,3).map((ins,i) =>
              React.createElement("div",{key:i,style:{display:"flex",alignItems:"center",gap:10,marginBottom:i<insights.slice(0,3).length-1?10:0,padding:"8px 10px",borderRadius:10,background:`rgba(${rgb(ins.color)},0.06)`}},
                React.createElement("div",{style:{width:24,height:24,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}},
                ins.emoji==="alert"?React.createElement(Icon,{d:IC.alert,size:16,stroke:"#e94560"}):
                ins.emoji==="warn"?React.createElement(Icon,{d:IC.alert,size:16,stroke:"#1E88E5"}):
                ins.emoji==="check"?React.createElement(Icon,{d:IC.check,size:16,stroke:"#4ade9e"}):
                ins.emoji==="trend"?React.createElement(Icon,{d:IC.trending,size:16,stroke:"#1E88E5"}):
                ins.emoji==="save"?React.createElement(Icon,{d:IC.thumbsup,size:16,stroke:"#4ade9e"}):
                ins.emoji==="cal"?React.createElement(Icon,{d:IC.calendar,size:16,stroke:"rgba(255,255,255,0.5)"}):
                React.createElement(Icon,{d:IC.check,size:16,stroke:"#4ade9e"})
              ),
                React.createElement("p",{style:{fontSize:13,color:"rgba(255,255,255,0.7)",lineHeight:1.4}},ins.msg)
              )
            );
          })()
        ),

        // Recent Expenses
        allExpenses.length > 0 && React.createElement("div",{style:{...S.card,marginBottom:16}},
          React.createElement("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}},
            React.createElement("p",{style:{fontSize:11,fontWeight:700,color:"rgba(255,255,255,0.5)",textTransform:"uppercase",letterSpacing:"0.8px"}},React.createElement(React.Fragment,null,React.createElement(Icon,{d:IC.clock,size:12,stroke:"rgba(255,255,255,0.5)"}), " Recent")),
            React.createElement("button",{style:{background:"none",border:"none",color:"rgba(255,255,255,0.3)",fontSize:11,cursor:"pointer"},
              onClick:()=>onSwitchTab("expenses")},"See all →")
          ),
          allExpenses.slice(0,4).map((exp,i) => {
            const cc = CAT_COLOR[exp.category] || "#f0f0f5";
            const ec = exp.currency || incomeCurrency;
            return React.createElement("div",{key:exp.id||i,style:{display:"flex",alignItems:"center",gap:10,marginBottom:i<3?10:0}},
              React.createElement("div",{style:{width:34,height:34,borderRadius:10,background:`rgba(${rgb(cc)},0.12)`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}},
                React.createElement(Icon,{d:exp.type==="recurring"?IC.pin:IC.receipt,size:15,stroke:cc})
              ),
              React.createElement("div",{style:{flex:1,minWidth:0}},
                React.createElement("p",{style:{fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}},exp.name),
                React.createElement("p",{style:{fontSize:11,color:"rgba(255,255,255,0.3)"}},exp.expense_date||"")
              ),
              React.createElement("p",{style:{fontSize:13,fontWeight:800,color:cc,flexShrink:0}},fmt(parseFloat(exp.amount),ec))
            );
          })
        ),

        // Summary
        React.createElement("div",{style:{...S.card,marginBottom:20,display:"flex"}},
          [{label:"Total Spent",value:fmt(totalSpent,incomeCurrency),color:totalSpent>income?"#e94560":"#f0f0f5"},
           {label:"Remaining",value:fmt(Math.abs(income-totalSpent),incomeCurrency),color:income-totalSpent<0?"#e94560":"#43A047"},
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
          [["🟠","50%","Needs","Rent, food, bills"],["🟡","30%","Wants","Dining, shopping, fun"],["🔵","20%","Savings","Emergency fund, investments"]].map(([e,p,l,d])=>
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
  const [search, setSearch]       = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [filterCat, setFilterCat] = useState("");
  const [sortBy, setSortBy]       = useState("date");
  const monthLabel=new Date().toLocaleString("en-US",{month:"long",year:"numeric"});

  const list = expenses
    .filter(e => e.type === activeType)
    .filter(e => !search || (e.name||"").toLowerCase().includes(search.toLowerCase()))
    .filter(e => !filterCat || e.category === filterCat)
    .sort((a,b) => {
      if (sortBy === "amount_desc") return (parseFloat(b.amount)||0) - (parseFloat(a.amount)||0);
      if (sortBy === "amount_asc")  return (parseFloat(a.amount)||0) - (parseFloat(b.amount)||0);
      return (b.expense_date||"").localeCompare(a.expense_date||"");
    });

  const hasActiveFilters = !!filterCat || sortBy !== "date";

  function remove(id,type,name) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    onOpenEdit({id,_delete:true,type});
  }

  function groupByDate(exps) {
    const today     = new Date(); today.setHours(0,0,0,0);
    const yesterday = new Date(today); yesterday.setDate(today.getDate()-1);
    const lastWeek  = new Date(today); lastWeek.setDate(today.getDate()-7);
    const lastMonth = new Date(today); lastMonth.setDate(today.getDate()-30);
    const groups = {};
    exps.forEach(exp => {
      const d = exp.expense_date ? new Date(exp.expense_date+"T00:00:00") : null;
      let label;
      if (!d)              label = "Unknown date";
      else if (d >= today) label = "Today";
      else if (d >= yesterday) label = "Yesterday";
      else if (d >= lastWeek)  label = "This week";
      else if (d >= lastMonth) label = "This month";
      else                     label = "Older";
      if (!groups[label]) groups[label] = [];
      groups[label].push(exp);
    });
    const order = ["Today","Yesterday","This week","This month","Older","Unknown date"];
    return order.filter(l => groups[l]).map(l => ({ label: l, items: groups[l] }));
  }

  const useGrouping = activeType === "daily" && !search && !filterCat && sortBy === "date";
  const grouped = useGrouping ? groupByDate(list) : null;

  function ExpenseRow({exp}) {
    const cc=CAT_COLOR[exp.category]||"#f0f0f5";
    const ec=exp.currency||incomeCurrency;
    const er=exp.custom_rate?{...rates,[exp.custom_rate_cur||ec]:exp.custom_rate}:rates;
    const cv=convert(parseFloat(exp.amount)||0,ec,incomeCurrency,er);
    const showCV=ec!==incomeCurrency;
    return React.createElement("div",{
      onClick:()=>onOpenEdit(exp),
      style:{...S.card,marginBottom:8,display:"flex",alignItems:"center",gap:12,cursor:"pointer",transition:"background 0.15s"},
      onMouseEnter:e=>e.currentTarget.style.background="rgba(255,255,255,0.07)",
      onMouseLeave:e=>e.currentTarget.style.background="rgba(255,255,255,0.04)"},
      React.createElement("div",{style:{width:42,height:42,borderRadius:12,background:`rgba(${rgb(cc)},0.15)`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}},
        React.createElement(Icon,{d:activeType==="recurring"?IC.pin:IC.receipt,size:18,stroke:cc})),
      React.createElement("div",{style:{flex:1,minWidth:0}},
        React.createElement("p",{style:{fontWeight:700,fontSize:14,marginBottom:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}},exp.name),
        React.createElement("div",{style:{display:"flex",gap:5,alignItems:"center",flexWrap:"wrap"}},
          React.createElement("span",{style:{fontSize:11,padding:"2px 7px",borderRadius:99,background:`rgba(${rgb(cc)},0.15)`,color:cc,fontWeight:600}},exp.subcat||exp.category),
          exp.expense_date&&activeType==="recurring"&&React.createElement("span",{style:{fontSize:11,color:"rgba(255,255,255,0.25)"}},exp.expense_date),
          exp.custom_rate&&React.createElement("span",{style:{fontSize:10,color:"#1E88E5"}},"custom rate")
        )
      ),
      React.createElement("div",{style:{textAlign:"right",flexShrink:0}},
        React.createElement("p",{style:{fontWeight:800,fontSize:14}},fmt(parseFloat(exp.amount),ec)),
        showCV&&React.createElement("p",{style:{fontSize:11,color:"rgba(255,255,255,0.3)"}},"≈ ",fmt(cv,incomeCurrency))
      ),
      React.createElement("button",{
        onClick:e=>{e.stopPropagation();remove(exp.id,exp.type,exp.name);},
        style:{background:"none",border:"none",color:"rgba(255,255,255,0.2)",cursor:"pointer",padding:4,flexShrink:0}},
        React.createElement(Icon,{d:IC.trash,size:15}))
    );
  }

  return React.createElement("div",{style:{padding:"0 0 20px"}},
    React.createElement("div",{style:{padding:"44px 20px 14px",background:"linear-gradient(160deg,#13131f 0%,#0a0a0f 100%)",marginBottom:16}},
      React.createElement("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center"}},
        React.createElement("div",{style:{display:"flex",alignItems:"center",gap:10}},
          React.createElement(BudgieLogo,{size:44}),
          React.createElement("div",null,
            React.createElement("p",{style:{fontSize:26,fontWeight:900,letterSpacing:"0.5px",lineHeight:1.2,background:"linear-gradient(90deg,#4ade9e,#43A047)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",paddingRight:"4px",paddingBottom:"2px",display:"inline-block"}},"Budgie"),
            React.createElement("p",{style:{fontSize:11,color:"rgba(255,255,255,0.3)",fontWeight:600,letterSpacing:"1px",textTransform:"uppercase",marginTop:5}},userName ? `${userName}'s Expenses` : "Expenses")
          )
        ),
        React.createElement("button",{style:S.btn("#e94560"),onClick:()=>onOpenAdd(activeType)},
          React.createElement(Icon,{d:IC.plus,size:16,stroke:"#fff"}))
      )
    ),
    React.createElement("div",{style:{padding:"0 16px"}},
      React.createElement("div",{style:{display:"flex",gap:8,marginBottom:12}},
        React.createElement("button",{style:S.pill(activeType==="recurring"),onClick:()=>{setActiveType("recurring");setSearch("");setFilterCat("");setSortBy("date");}},"Fixed"),
        React.createElement("button",{style:S.pill(activeType==="daily","#1E88E5"),onClick:()=>{setActiveType("daily");setSearch("");setFilterCat("");setSortBy("date");}},"Variable")
      ),
      React.createElement("div",{style:{display:"flex",gap:8,marginBottom:12}},
        React.createElement("div",{style:{flex:1,position:"relative",display:"flex",alignItems:"center"}},
          React.createElement("div",{style:{position:"absolute",left:10,pointerEvents:"none"}},
            React.createElement(Icon,{d:"M11 3a8 8 0 1 0 0 16A8 8 0 0 0 11 3z M21 21l-4.35-4.35",size:15,stroke:"rgba(255,255,255,0.3)"})
          ),
          React.createElement("input",{style:{...S.input,paddingLeft:34,fontSize:13},placeholder:"Search expenses...",value:search,onChange:e=>setSearch(e.target.value)})
        ),
        React.createElement("button",{
          style:{...S.card,padding:"0 12px",display:"flex",alignItems:"center",gap:4,cursor:"pointer",flexShrink:0,minHeight:44,
            border:hasActiveFilters?"1px solid rgba(74,222,158,0.4)":"1px solid rgba(255,255,255,0.07)",
            background:hasActiveFilters?"rgba(74,222,158,0.08)":"rgba(255,255,255,0.04)"},
          onClick:()=>setShowFilters(!showFilters)},
          React.createElement(Icon,{d:"M4 6h16 M8 12h8 M11 18h2",size:16,stroke:hasActiveFilters?"#4ade9e":"rgba(255,255,255,0.5)"}),
          hasActiveFilters&&React.createElement("div",{style:{width:6,height:6,borderRadius:99,background:"#4ade9e",position:"absolute",marginTop:-16,marginLeft:8}})
        )
      ),
      showFilters&&React.createElement("div",{style:{...S.card,marginBottom:12,padding:14}},
        React.createElement("p",{style:{...S.label,marginBottom:8}},"Category"),
        React.createElement("div",{style:{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap"}},
          React.createElement("button",{style:S.pill(!filterCat,"#4ade9e"),onClick:()=>setFilterCat("")},"All"),
          ["needs","wants","savings"].map(c=>
            React.createElement("button",{key:c,style:S.pill(filterCat===c,CAT_COLOR[c]),onClick:()=>setFilterCat(filterCat===c?"":c)},
              c.charAt(0).toUpperCase()+c.slice(1))
          )
        ),
        React.createElement("p",{style:{...S.label,marginBottom:8}},"Sort by"),
        React.createElement("div",{style:{display:"flex",gap:6,flexWrap:"wrap"}},
          [["date","Date ↓"],["amount_desc","Amount ↓"],["amount_asc","Amount ↑"]].map(([val,label])=>
            React.createElement("button",{key:val,style:S.pill(sortBy===val,"#1E88E5"),onClick:()=>setSortBy(val)},label)
          )
        ),
        hasActiveFilters&&React.createElement("button",{
          style:{...S.ghost,width:"100%",marginTop:12,fontSize:12,padding:"8px",color:"rgba(255,255,255,0.4)"},
          onClick:()=>{setFilterCat("");setSortBy("date");}},
          "Reset filters")
      ),
      activeType==="recurring"&&React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.35)",marginBottom:14,padding:"8px 12px",background:"rgba(255,255,255,0.03)",borderRadius:10,lineHeight:1.5}},
        React.createElement(React.Fragment,null,React.createElement(Icon,{d:IC.pin,size:12,stroke:"rgba(255,255,255,0.35)"}), " Fixed expenses are always counted in your budget, every period.")),
      activeType==="daily"&&React.createElement("div",{style:{fontSize:12,color:"rgba(255,255,255,0.35)",marginBottom:14,padding:"8px 12px",background:"rgba(255,255,255,0.03)",borderRadius:10,lineHeight:1.5}},
        React.createElement(React.Fragment,null,React.createElement(Icon,{d:IC.calendar,size:12,stroke:"rgba(255,255,255,0.35)"}), " "),React.createElement("strong",{style:{color:"rgba(255,255,255,0.5)"}},monthLabel)," — variable expenses reset when your next salary arrives."),
      (search||filterCat)&&React.createElement("p",{style:{fontSize:12,color:"rgba(255,255,255,0.35)",marginBottom:10}},`${list.length} result${list.length!==1?"s":""}`),
      list.length===0 ? React.createElement("div",{style:{...S.card,textAlign:"center",padding:"36px 20px"}},
        React.createElement("p",{style:{fontWeight:700}},search||filterCat?"No expenses match your search":`No ${activeType==="recurring"?"fixed":"variable"} expenses yet`),
        React.createElement("p",{style:{fontSize:13,color:"rgba(255,255,255,0.4)",marginTop:6}},
          search||filterCat?"Try different search terms or filters":activeType==="recurring"?"Add fixed costs like rent, subscriptions, utilities":"Add today's purchases or scan a receipt")
      ) : useGrouping ?
        grouped.map(group=>
          React.createElement(React.Fragment,{key:group.label},
            React.createElement("div",{style:{display:"flex",alignItems:"center",gap:8,marginBottom:8,marginTop:4}},
              React.createElement("p",{style:{fontSize:11,fontWeight:700,color:"rgba(255,255,255,0.35)",textTransform:"uppercase",letterSpacing:"0.8px",whiteSpace:"nowrap"}},group.label),
              React.createElement("div",{style:{flex:1,height:1,background:"rgba(255,255,255,0.06)"}})
            ),
            group.items.map(exp=>React.createElement(ExpenseRow,{key:exp.id,exp})),
            React.createElement("div",{style:{marginBottom:8}})
          )
        )
      : list.map(exp=>React.createElement(ExpenseRow,{key:exp.id,exp}))
    )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// History Tab (Pro/Family only)
// ─────────────────────────────────────────────────────────────────────────────
function HistoryTab({history,plan,onUpgrade,userName,budget,expenses,token}) {
  const [fromPeriod, setFromPeriod] = useState("");
  const [toPeriod, setToPeriod]     = useState("");
  const [exporting, setExporting]   = useState(false);
  const [histExpenses, setHistExpenses] = useState([]);
  const [histLoading, setHistLoading]   = useState(false);
  const [expSearch, setExpSearch]       = useState("");
  const [expFilterCat, setExpFilterCat] = useState("");
  const [expSortBy, setExpSortBy]       = useState("date");
  const [showExpFilters, setShowExpFilters] = useState(false);
  const [expFromDate, setExpFromDate]   = useState("");
  const [expToDate, setExpToDate]       = useState("");
  const [showExportModal, setShowExportModal] = useState(false);
  const [expandedPeriod, setExpandedPeriod] = useState(null);
  const [exportPeriod, setExportPeriod]     = useState(null); // period key for inline export

  function periodLabel(p) {
    if(!p)return"";
    const [y,m]=p.split("-");
    return new Date(parseInt(y),parseInt(m)-1,1).toLocaleString("en-US",{month:"long",year:"numeric"});
  }

  // Fetch all expenses for a date range from Supabase
  async function fetchExpensesForRange(fromP, toP) {
    if (!budget?.id || !token) return [];
    try {
      // Calculate date range from period strings
      const fromDate = fromP ? `${fromP}-01` : "2000-01-01";
      // Last day of toPeriod month
      let toDate = "2099-12-31";
      if (toP) {
        const [y,m] = toP.split("-").map(Number);
        const lastDay = new Date(y, m, 0).getDate();
        toDate = `${toP}-${String(lastDay).padStart(2,"0")}`;
      }
      const db = await sb.from("expenses", token);
      const rows = await db.select("*", 
        `budget_id=eq.${budget.id}&expense_date=gte.${fromDate}&expense_date=lte.${toDate}&order=expense_date.asc`
      );
      return Array.isArray(rows) ? rows : [];
    } catch(e) { 
      console.error("fetchExpensesForRange error:", e);
      return []; 
    }
  }

  // All available periods from history
  const periods = history.map(h=>h.period).sort();
  const oldest  = periods[0] || "";
  const newest  = periods[periods.length-1] || "";

  // Filter history by range
  const filtered = history.filter(h => {
    if (fromPeriod && h.period < fromPeriod) return false;
    if (toPeriod   && h.period > toPeriod)   return false;
    return true;
  });

  // Load expenses when periods change
  const { useState: _us, useEffect: _ue } = React;
  useEffect(()=>{
    if (!budget?.id || !token || history.length===0) return;
    setHistLoading(true);
    fetchExpensesForRange(fromPeriod||oldest, toPeriod||newest)
      .then(rows => { setHistExpenses(rows); setHistLoading(false); })
      .catch(()=>setHistLoading(false));
  }, [fromPeriod, toPeriod, budget?.id, oldest, newest]);

  // Filter/sort hist expenses
  const filteredExpenses = histExpenses
    .filter(e => !expSearch || (e.name||"").toLowerCase().includes(expSearch.toLowerCase()))
    .filter(e => !expFilterCat || e.category===expFilterCat)
    .filter(e => !expFromDate || (e.expense_date||"") >= expFromDate)
    .filter(e => !expToDate   || (e.expense_date||"") <= expToDate)
    .sort((a,b)=>{
      if (expSortBy==="amount_desc") return (parseFloat(b.amount)||0)-(parseFloat(a.amount)||0);
      if (expSortBy==="amount_asc")  return (parseFloat(a.amount)||0)-(parseFloat(b.amount)||0);
      return (b.expense_date||"").localeCompare(a.expense_date||"");
    });

  const hasExpFilters = !!expFilterCat || expSortBy!=="date" || !!expFromDate || !!expToDate;

  // Export a single period to CSV
  function exportPeriodCSV(h, exps) {
    try {
      const income = h.income||0;
      const used = (h.needs||0)+(h.wants||0)+(h.savings||0);
      const unused = Math.max(0, income-used);
      const rows = [
        ["SUMMARY"],
        ["Period","Income","Currency","Needs","Wants","Savings","Unused","Total"],
        [periodLabel(h.period),(income).toFixed(2),h.currency||"RON",
          (h.needs||0).toFixed(2),(h.wants||0).toFixed(2),(h.savings||0).toFixed(2),
          unused.toFixed(2),(h.total||0).toFixed(2)],
        [],
        ["EXPENSES"],
        ["Date","Name","Type","Category","Comments","Amount","Currency"],
        ...exps.map(e=>[
          e.expense_date||"", e.name||"",
          e.type==="recurring"?"Fixed":"Variable",
          e.category||"", e.subcat||"",
          (parseFloat(e.amount)||0).toFixed(2), e.currency||"RON"
        ])
      ];
      const csv = rows.map(r=>r.map(v=>'"'+String(v||"").replace(/"/g,'""')+'"').join(",")).join("\n");
      const blob = new Blob(["﻿"+csv],{type:"text/csv;charset=utf-8;"});
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href = url; a.download = `budgie-${h.period}.csv`; a.click();
      URL.revokeObjectURL(url);
    } catch(e) { alert("Export failed: "+e.message); }
  }

  // Export a single period to PDF
  async function exportPeriodPDF(h, exps) {
    setExporting(true);
    try {
      if (!window.jspdf) {
        await new Promise((res,rej)=>{
          const s=document.createElement("script");
          s.src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
          s.onload=res; s.onerror=rej; document.head.appendChild(s);
        });
      }
      const {jsPDF} = window.jspdf;
      const doc = new jsPDF({orientation:"portrait",unit:"mm",format:"a4"});
      const W=210, margin=16;
      let y=20;

      // Header
      doc.setFillColor(10,10,15); doc.rect(0,0,W,30,"F");
      doc.setTextColor(74,222,158); doc.setFontSize(22); doc.setFont("helvetica","bold");
      doc.text("Budgie", margin, 15);
      doc.setTextColor(255,255,255); doc.setFontSize(11); doc.setFont("helvetica","normal");
      doc.text(`${periodLabel(h.period)} Report`, margin, 22);
      y=38;

      const income=h.income||0;
      const used=(h.needs||0)+(h.wants||0)+(h.savings||0);
      const unused=Math.max(0,income-used);
      const fmt2=n=>n.toLocaleString("ro-RO",{minimumFractionDigits:2,maximumFractionDigits:2})+" "+(h.currency||"RON");

      // Summary box
      doc.setFillColor(20,20,32); doc.roundedRect(margin,y,W-margin*2,32,3,3,"F");
      doc.setFontSize(10); doc.setFont("helvetica","bold"); doc.setTextColor(255,255,255);
      doc.text("Summary", margin+4, y+8);
      doc.setFont("helvetica","normal"); doc.setFontSize(9); doc.setTextColor(200,200,220);
      [[`Income: ${fmt2(income)}`,margin+4],[`Needs: ${fmt2(h.needs||0)}`,margin+50],
       [`Wants: ${fmt2(h.wants||0)}`,margin+96],[`Savings: ${fmt2(h.savings||0)}`,margin+142]].forEach(([t,x])=>doc.text(t,x,y+18));
      [[`Spent: ${fmt2(used)}`,margin+4],[`Unused: ${fmt2(unused)}`,margin+60]].forEach(([t,x])=>doc.text(t,x,y+26));
      y+=40;

      // Expenses
      if (exps.length>0) {
        doc.setFontSize(7); doc.setTextColor(120,120,140); doc.setFont("helvetica","bold");
        doc.text("Date",margin+2,y+4); doc.text("Name",margin+18,y+4);
        doc.text("Type",margin+100,y+4); doc.text("Category",margin+128,y+4); doc.text("Amount",margin+162,y+4);
        y+=7;
        exps.forEach(e=>{
          if(y>275){doc.addPage();y=20;}
          doc.setFont("helvetica","normal"); doc.setFontSize(8); doc.setTextColor(200,200,210);
          doc.text(e.expense_date||"",margin+2,y+4);
          doc.text((e.name||"").slice(0,38),margin+18,y+4);
          doc.setTextColor(e.type==="recurring"?233:245,e.type==="recurring"?69:166,e.type==="recurring"?96:35);
          doc.text(e.type==="recurring"?"Fixed":"Var.",margin+100,y+4);
          doc.setTextColor(160,160,180); doc.text((e.category||"").slice(0,14),margin+128,y+4);
          doc.setTextColor(15,188,249); doc.text(`${(parseFloat(e.amount)||0).toFixed(2)} ${e.currency||"RON"}`,margin+162,y+4);
          y+=6;
        });
      }

      doc.setFontSize(8); doc.setTextColor(100,100,120);
      doc.text(`Generated by Budgie · ${new Date().toLocaleDateString()}`,margin,290);
      doc.save(`budgie-${h.period}.pdf`);
    } catch(e) { alert("PDF export failed: "+e.message); console.error(e); }
    setExporting(false);
  }

  // Export CSV — includes summary + individual expenses
  async function exportCSV() {
    setExporting(true);
    try {
      // Fetch all expenses for the selected range
      const allExpenses = await fetchExpensesForRange(fromPeriod||oldest, toPeriod||newest);

      // Part 1: Summary rows
      const rows = [["SUMMARY"],["Period","Income","Currency","Needs","Wants","Savings","Total","Saved"]];
      filtered.forEach(h => {
        const saved = (h.income||0) - (h.total||0);
        rows.push([
          periodLabel(h.period),
          (h.income||0).toFixed(2),
          h.currency||"RON",
          (h.needs||0).toFixed(2),
          (h.wants||0).toFixed(2),
          (h.savings||0).toFixed(2),
          (h.total||0).toFixed(2),
          saved.toFixed(2),
        ]);
      });

      // Part 2: Individual expenses
      rows.push([]);
      rows.push(["EXPENSES"]);
      rows.push(["Date","Name","Type","Category","Subcategory","Amount","Currency"]);
      allExpenses.forEach(e => {
        rows.push([
          e.expense_date||"",
          e.name||"",
          e.type==="recurring"?"Fixed":"Variable",
          e.category||"",
          e.subcat||"",
          (parseFloat(e.amount)||0).toFixed(2),
          e.currency||"RON",
        ]);
      });

      const csv = rows.map(r => r.map(v => '"' + String(v||"").replace(/"/g, '""') + '"').join(",")).join("\n");
      const blob = new Blob(["\uFEFF"+csv], {type:"text/csv;charset=utf-8;"});
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `budgie-export-${fromPeriod||oldest}-${toPeriod||newest}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch(e) { alert("Export failed: "+e.message); }
    setExporting(false);
  }

  // Export PDF
  async function exportPDF() {
    setExporting(true);
    try {
      // Load jsPDF from CDN
      if (!window.jspdf) {
        await new Promise((res,rej) => {
          const s = document.createElement("script");
          s.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
          s.onload = res; s.onerror = rej;
          document.head.appendChild(s);
        });
      }
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation:"portrait", unit:"mm", format:"a4" });
      const W = 210, margin = 16;
      let y = 20;

      // Header
      doc.setFillColor(10,10,15);
      doc.rect(0,0,W,30,"F");
      doc.setTextColor(74,222,158);
      doc.setFontSize(22); doc.setFont("helvetica","bold");
      doc.text("Budgie", margin, 15);
      doc.setTextColor(255,255,255);
      doc.setFontSize(11); doc.setFont("helvetica","normal");
      doc.text(`${userName ? userName+"'s " : ""}Budget Report`, margin, 22);
      doc.setFontSize(9); doc.setTextColor(150,150,170);
      doc.text(`${periodLabel(fromPeriod||oldest)} — ${periodLabel(toPeriod||newest)}`, W-margin, 22, {align:"right"});
      y = 38;

      // Summary totals
      const totalIncome  = filtered.reduce((s,h)=>s+(h.income||0),0);
      const totalNeeds   = filtered.reduce((s,h)=>s+(h.needs||0),0);
      const totalWants   = filtered.reduce((s,h)=>s+(h.wants||0),0);
      const totalSavings = filtered.reduce((s,h)=>s+(h.savings||0),0);
      const totalSpent   = filtered.reduce((s,h)=>s+(h.total||0),0);
      const currency     = filtered[0]?.currency || "RON";

      const fmt2 = (n) => n.toLocaleString("ro-RO",{minimumFractionDigits:2,maximumFractionDigits:2})+" "+currency;

      doc.setFillColor(20,20,32);
      doc.roundedRect(margin,y,W-margin*2,32,3,3,"F");
      doc.setTextColor(255,255,255); doc.setFontSize(10); doc.setFont("helvetica","bold");
      doc.text("Summary", margin+4, y+8);
      doc.setFont("helvetica","normal"); doc.setFontSize(9);
      const cols = [[`Income: ${fmt2(totalIncome)}`,margin+4],[`Needs: ${fmt2(totalNeeds)}`,margin+50],[`Wants: ${fmt2(totalWants)}`,margin+96],[`Saved: ${fmt2(totalIncome-totalSpent)}`,margin+142]];
      cols.forEach(([txt,x])=>{ doc.setTextColor(200,200,220); doc.text(txt,x,y+18); });
      y += 40;

      // Period rows
      // Fetch expenses for range
      const allExpenses = await fetchExpensesForRange(fromPeriod||oldest, toPeriod||newest);

      // Group expenses by period
      const expByPeriod = {};
      allExpenses.forEach(e => {
        const p = (e.expense_date||"").slice(0,7); // "YYYY-MM"
        if (!expByPeriod[p]) expByPeriod[p] = [];
        expByPeriod[p].push(e);
      });

      filtered.forEach((h,i) => {
        if (y > 240) { doc.addPage(); y = 20; }
        const income = h.income||0;
        const over = (h.total||0) > income && income > 0;
        const savedPct = income>0?Math.max(0,((income-(h.total||0))/income*100)).toFixed(0):"—";

        // Period header
        doc.setFillColor(i%2===0?18:22, i%2===0?18:22, i%2===0?28:32);
        doc.rect(margin,y,W-margin*2,28,"F");
        doc.setTextColor(255,255,255); doc.setFontSize(10); doc.setFont("helvetica","bold");
        doc.text(periodLabel(h.period), margin+4, y+8);
        doc.setFillColor(over?233:74, over?69:222, over?96:158, 0.3);
        doc.setTextColor(over?233:74, over?69:222, over?96:158);
        doc.setFontSize(8);
        doc.text(over?"Over budget":`${savedPct}% saved`, margin+4, y+16);
        doc.setFont("helvetica","normal"); doc.setFontSize(8);
        // Row 1: Income + Needs
        doc.setTextColor(180,180,200);
        doc.text(`Income: ${fmt2(income)}`, margin+48, y+10);
        doc.text(`Needs: ${fmt2(h.needs||0)}`, margin+112, y+10);
        // Row 2: Wants + Savings
        doc.text(`Wants: ${fmt2(h.wants||0)}`, margin+48, y+20);
        doc.text(`Savings: ${fmt2(h.savings||0)}`, margin+112, y+20);
        y += 32;

        // Expenses for this period
        const periodExps = expByPeriod[h.period] || [];
        if (periodExps.length > 0) {
          // Column headers
          if (y > 270) { doc.addPage(); y = 20; }
          doc.setFontSize(7); doc.setTextColor(120,120,140); doc.setFont("helvetica","bold");
          doc.text("Date", margin+2, y+4);
          doc.text("Name", margin+18, y+4);
          doc.text("Type", margin+100, y+4);
          doc.text("Category", margin+128, y+4);
          doc.text("Amount", margin+162, y+4);
          y += 7;

          periodExps.forEach(e => {
            if (y > 275) { doc.addPage(); y = 20; }
            doc.setFont("helvetica","normal"); doc.setFontSize(8);
            doc.setTextColor(200,200,210);
            const name = (e.name||"").slice(0,38);
            doc.text(e.expense_date||"", margin+2, y+4);
            doc.text(name, margin+18, y+4);
            doc.setTextColor(e.type==="recurring"?233:245, e.type==="recurring"?69:166, e.type==="recurring"?96:35);
            doc.text(e.type==="recurring"?"Fixed":"Var.", margin+100, y+4);
            doc.setTextColor(160,160,180);
            doc.text((e.category||"").slice(0,14), margin+128, y+4);
            doc.setTextColor(15,188,249);
            doc.text(`${(parseFloat(e.amount)||0).toFixed(2)} ${e.currency||"RON"}`, margin+162, y+4);
            y += 6;
          });
          y += 4;
        }
      });

      // Footer
      doc.setFontSize(8); doc.setTextColor(100,100,120);
      doc.text(`Generated by Budgie · ${new Date().toLocaleDateString()}`, margin, 290);

      doc.save(`budgie-report-${fromPeriod||oldest}-${toPeriod||newest}.pdf`);
    } catch(e) { alert("PDF export failed: "+e.message); console.error(e); }
    setExporting(false);
  }

  if (plan==="free") return React.createElement("div",{style:{padding:"44px 16px 16px"}},
    React.createElement("div",{style:{...S.card,textAlign:"center",padding:"48px 24px",background:"rgba(74,222,158,0.05)",border:"1px solid rgba(74,222,158,0.2)"}},
      React.createElement(Icon,{d:IC.lock,size:40,stroke:"#4ade9e"}),
      React.createElement("p",{style:{fontWeight:800,fontSize:18,marginTop:16,marginBottom:8}},"History is a Pro feature"),
      React.createElement("p",{style:{fontSize:14,color:"rgba(255,255,255,0.4)",marginBottom:24,lineHeight:1.6}},"Upgrade to Pro to see your full spending history and track trends over time."),
      React.createElement("button",{style:S.btn("#4ade9e",true),onClick:onUpgrade},"Upgrade to Pro — €2.99/mo")
    )
  );

  return React.createElement("div",{style:{padding:"0 0 20px"}},
    // Export Modal
    showExportModal && React.createElement("div",{style:{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center",padding:"24px",backdropFilter:"blur(4px)"},
      onClick:e=>{if(e.target===e.currentTarget)setShowExportModal(false);}},
      React.createElement("div",{style:{background:"#13131f",borderRadius:20,padding:"24px 20px 28px",width:"100%",maxWidth:420,border:"1px solid rgba(255,255,255,0.08)"}},
        React.createElement("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}},
          React.createElement("p",{style:{fontWeight:800,fontSize:17}},"Export"),
          React.createElement("button",{style:{background:"none",border:"none",color:"rgba(255,255,255,0.4)",cursor:"pointer"},onClick:()=>setShowExportModal(false)},
            React.createElement(Icon,{d:IC.x,size:20}))
        ),
        React.createElement("p",{style:{...S.label,marginBottom:8}},"Date range"),
        React.createElement("div",{style:{display:"flex",gap:8,marginBottom:20}},
          React.createElement("div",{style:{flex:1}},
            React.createElement("label",{style:{fontSize:11,color:"rgba(255,255,255,0.3)",marginBottom:4,display:"block"}},"From"),
            React.createElement("select",{style:{...S.input,fontSize:13,padding:"8px 10px"},value:fromPeriod,onChange:e=>setFromPeriod(e.target.value)},
              React.createElement("option",{value:""},"Oldest"),
              periods.map(p=>React.createElement("option",{key:p,value:p},periodLabel(p)))
            )
          ),
          React.createElement("div",{style:{flex:1}},
            React.createElement("label",{style:{fontSize:11,color:"rgba(255,255,255,0.3)",marginBottom:4,display:"block"}},"To"),
            React.createElement("select",{style:{...S.input,fontSize:13,padding:"8px 10px"},value:toPeriod,onChange:e=>setToPeriod(e.target.value)},
              React.createElement("option",{value:""},"Latest"),
              periods.map(p=>React.createElement("option",{key:p,value:p},periodLabel(p)))
            )
          )
        ),
        React.createElement("p",{style:{fontSize:12,color:"rgba(255,255,255,0.35)",marginBottom:14}},
          `${filtered.length} period${filtered.length!==1?"s":""} selected`),
        React.createElement("div",{style:{display:"flex",gap:8}},
          React.createElement("button",{
            style:{...S.ghost,flex:1,fontSize:14,padding:"12px",display:"flex",alignItems:"center",justifyContent:"center",gap:8},
            onClick:()=>{exportCSV();setShowExportModal(false);},disabled:exporting||filtered.length===0},
            React.createElement(Icon,{d:IC.download,size:16,stroke:"rgba(255,255,255,0.6)"}), " Export CSV"),
          React.createElement("button",{
            style:{...S.ghost,flex:1,fontSize:14,padding:"12px",display:"flex",alignItems:"center",justifyContent:"center",gap:8},
            onClick:()=>{exportPDF();setShowExportModal(false);},disabled:exporting||filtered.length===0},
            React.createElement(Icon,{d:IC.download,size:16,stroke:"rgba(255,255,255,0.6)"}), " Export PDF")
        )
      )
    ),
    React.createElement("div",{style:{padding:"44px 20px 14px",background:"linear-gradient(160deg,#13131f 0%,#0a0a0f 100%)",marginBottom:16}},
      React.createElement("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center"}},
        React.createElement("div",{style:{display:"flex",alignItems:"center",gap:10}},
          React.createElement(BudgieLogo,{size:44}),
          React.createElement("div",null,
            React.createElement("p",{style:{fontSize:26,fontWeight:900,letterSpacing:"0.5px",lineHeight:1.2,background:"linear-gradient(90deg,#4ade9e,#43A047)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent",paddingRight:"4px",paddingBottom:"2px",display:"inline-block"}},"Budgie"),
            React.createElement("p",{style:{fontSize:11,color:"rgba(255,255,255,0.3)",fontWeight:600,letterSpacing:"1px",textTransform:"uppercase",marginTop:5}},userName ? `${userName}'s History` : "History")
          )
        ),
        history.length>0 && React.createElement("button",{
          style:{...S.ghost,padding:"8px 14px",display:"flex",alignItems:"center",gap:6,fontSize:13},
          onClick:()=>setShowExportModal(true)},
          React.createElement(Icon,{d:IC.download,size:15,stroke:"rgba(255,255,255,0.6)"}),
          "Export")
      )
    ),
    React.createElement("div",{style:{padding:"0 16px"}},
      history.length===0 ? React.createElement("div",{style:{...S.card,textAlign:"center",padding:"48px 24px"}},
        React.createElement("p",{style:{fontWeight:700,fontSize:16,marginBottom:8}},"No history yet"),
        React.createElement("p",{style:{fontSize:13,color:"rgba(255,255,255,0.4)",lineHeight:1.6}},"Your spending breakdown will be saved here at the end of each budget period.")
      ) : React.createElement(React.Fragment,null,

        // ── 1. Last 2 periods ────────────────────────────────────────────────
        history.length>0&&React.createElement("div",{style:{...S.card,marginBottom:16,padding:16}},
          React.createElement("p",{style:{fontSize:11,fontWeight:700,color:"rgba(255,255,255,0.4)",textTransform:"uppercase",letterSpacing:"0.8px",marginBottom:14}},"Last 2 periods"),
          history.slice(0,2).map((h,i)=>{
            const income=h.income||0;
            const used=(h.needs||0)+(h.wants||0)+(h.savings||0);
            const unused=Math.max(0,income-used);
            const savedAmt=Math.max(0,income-used);
            const savedPct=income>0?Math.max(0,((income-h.total)/income*100)).toFixed(0):0;
            const over=h.total>income&&income>0;
            const isExpanded=expandedPeriod===h.period;
            return React.createElement("div",{key:i,style:{marginBottom:i===0&&history.length>1?16:0}},
              // Header row
              React.createElement("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}},
                React.createElement("div",{style:{display:"flex",alignItems:"center",gap:8}},
                  React.createElement("p",{style:{fontWeight:700,fontSize:13}},periodLabel(h.period)),
                  React.createElement("button",{
                    style:{background:"none",border:"none",cursor:"pointer",padding:4,color:"rgba(255,255,255,0.3)",display:"flex",alignItems:"center"},
                    onClick:()=>setExportPeriod(exportPeriod===h.period?null:h.period)},
                    React.createElement(Icon,{d:IC.download,size:14,stroke:exportPeriod===h.period?"#4ade9e":"rgba(255,255,255,0.4)"})
                  ),
                  exportPeriod===h.period&&React.createElement("div",{style:{display:"flex",gap:6,background:"rgba(255,255,255,0.06)",borderRadius:8,padding:"3px 6px"}},
                    React.createElement("button",{
                      style:{fontSize:11,fontWeight:700,color:"#4ade9e",background:"none",border:"none",cursor:"pointer",padding:"2px 6px"},
                      onClick:async()=>{
                        setExportPeriod(null);
                        const exps = await fetchExpensesForRange(h.period, h.period);
                        exportPeriodCSV(h, exps);
                      }},"CSV"),
                    React.createElement("span",{style:{color:"rgba(255,255,255,0.2)",lineHeight:"20px"}},"|"),
                    React.createElement("button",{
                      style:{fontSize:11,fontWeight:700,color:"#1E88E5",background:"none",border:"none",cursor:"pointer",padding:"2px 6px"},
                      onClick:async()=>{
                        setExportPeriod(null);
                        const exps = await fetchExpensesForRange(h.period, h.period);
                        exportPeriodPDF(h, exps);
                      }},"PDF")
                  )
                ),
                React.createElement("span",{style:{fontSize:11,padding:"2px 8px",borderRadius:99,
                  background:over?"rgba(233,69,96,0.15)":"rgba(74,222,158,0.12)",
                  color:over?"#e94560":"#4ade9e",fontWeight:700}},
                  over?"Over budget":`${fmt(savedAmt,h.currency)} (${savedPct}%) saved`)
              ),
              // Color bar
              income>0&&React.createElement("div",{style:{height:10,borderRadius:99,overflow:"hidden",background:"rgba(255,255,255,0.06)",display:"flex",marginBottom:10}},
                (()=>{
                  const unusedPct=Math.max(0,((income-used)/income)*100);
                  return [
                    ...["needs","wants","savings"].map(k=>
                      React.createElement("div",{key:k,style:{width:`${Math.min((h[k]||0)/income*100,100)}%`,background:CAT_COLOR[k]}})
                    ),
                    unusedPct>0&&React.createElement("div",{key:"unused",style:{width:`${unusedPct}%`,background:"rgba(255,255,255,0.15)",borderRadius:"0 99px 99px 0"}})
                  ];
                })()
              ),
              // Simplified stats: Spent + Unused + info icon
              React.createElement("div",{style:{display:"flex",alignItems:"center",gap:8}},
                React.createElement("div",{style:{flex:1,textAlign:"center",background:"rgba(255,255,255,0.04)",borderRadius:10,padding:"8px 4px"}},
                  React.createElement("p",{style:{fontSize:10,color:"rgba(255,255,255,0.3)",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.4px",marginBottom:3}},"Spent"),
                  React.createElement("p",{style:{fontSize:13,fontWeight:800,color:"rgba(255,255,255,0.8)"}},fmt(used,h.currency))
                ),
                React.createElement("div",{style:{flex:1,textAlign:"center",background:"rgba(255,255,255,0.04)",borderRadius:10,padding:"8px 4px"}},
                  React.createElement("p",{style:{fontSize:10,color:"rgba(255,255,255,0.3)",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.4px",marginBottom:3}},"Unused"),
                  React.createElement("p",{style:{fontSize:13,fontWeight:800,color:"rgba(255,255,255,0.3)"}},fmt(unused,h.currency))
                ),
                // Info icon
                React.createElement("button",{
                  style:{background:"none",border:"none",cursor:"pointer",padding:6,flexShrink:0,color:isExpanded?"#4ade9e":"rgba(255,255,255,0.3)"},
                  onClick:()=>setExpandedPeriod(isExpanded?null:h.period)},
                  React.createElement(Icon,{d:"M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 16v-4 M12 8h.01",size:18,stroke:isExpanded?"#4ade9e":"rgba(255,255,255,0.4)"})
                )
              ),
              // Breakdown (expandable)
              isExpanded&&React.createElement("div",{style:{marginTop:10,padding:"12px 14px",borderRadius:12,background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.07)"}},
                [{label:"Needs",val:h.needs||0,color:"#f97316"},
                 {label:"Wants",val:h.wants||0,color:"#1E88E5"},
                 {label:"Savings",val:h.savings||0,color:"#43A047"},
                 {label:"Unused",val:unused,color:"rgba(255,255,255,0.3)"}
                ].map((item,j)=>
                  React.createElement("div",{key:item.label,style:{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",
                    borderBottom:j<3?"1px solid rgba(255,255,255,0.05)":"none"}},
                    React.createElement("div",{style:{display:"flex",alignItems:"center",gap:8}},
                      React.createElement("div",{style:{width:8,height:8,borderRadius:99,background:item.color,flexShrink:0}}),
                      React.createElement("span",{style:{fontSize:13,color:"rgba(255,255,255,0.6)"}}),item.label
                    ),
                    React.createElement("div",{style:{textAlign:"right"}},
                      React.createElement("span",{style:{fontWeight:700,fontSize:13,color:item.color}},fmt(item.val,h.currency)),
                      income>0&&React.createElement("span",{style:{fontSize:11,color:"rgba(255,255,255,0.3)",marginLeft:6}},
                        `${((item.val/income)*100).toFixed(0)}%`)
                    )
                  )
                )
              ),
              i===0&&history.length>1&&React.createElement("div",{style:{height:1,background:"rgba(255,255,255,0.06)",marginTop:14}})
            );
          }),
          // Legend
          React.createElement("div",{style:{display:"flex",gap:10,marginTop:12,justifyContent:"center"}},
            [["Needs","#f97316"],["Wants","#1E88E5"],["Savings","#43A047"],["Unused","rgba(255,255,255,0.3)"]].map(([l,c])=>
              React.createElement("div",{key:l,style:{display:"flex",alignItems:"center",gap:4}},
                React.createElement("div",{style:{width:8,height:8,borderRadius:2,background:c}}),
                React.createElement("span",{style:{fontSize:11,color:"rgba(255,255,255,0.4)"}},l)
              )
            )
          )
        ),

        // ── 2. Expenses ──────────────────────────────────────────────────────
React.createElement("div",{style:{...S.card,marginBottom:16,padding:16}},
          React.createElement("p",{style:{fontSize:11,fontWeight:700,color:"rgba(255,255,255,0.4)",textTransform:"uppercase",letterSpacing:"0.8px",marginBottom:12}},"Expenses"),
          React.createElement("div",{style:{display:"flex",gap:8,marginBottom:10}},
            React.createElement("div",{style:{flex:1,position:"relative",display:"flex",alignItems:"center"}},
              React.createElement("div",{style:{position:"absolute",left:10,pointerEvents:"none"}},
                React.createElement(Icon,{d:"M11 3a8 8 0 1 0 0 16A8 8 0 0 0 11 3z M21 21l-4.35-4.35",size:14,stroke:"rgba(255,255,255,0.3)"})
              ),
              React.createElement("input",{style:{...S.input,paddingLeft:32,fontSize:13},placeholder:"Search expenses...",value:expSearch,onChange:e=>setExpSearch(e.target.value)})
            ),
            React.createElement("button",{
              style:{...S.card,padding:"0 12px",display:"flex",alignItems:"center",cursor:"pointer",flexShrink:0,minHeight:44,
                border:hasExpFilters?"1px solid rgba(74,222,158,0.4)":"1px solid rgba(255,255,255,0.07)",
                background:hasExpFilters?"rgba(74,222,158,0.08)":"rgba(255,255,255,0.04)"},
              onClick:()=>setShowExpFilters(!showExpFilters)},
              React.createElement(Icon,{d:"M4 6h16 M8 12h8 M11 18h2",size:15,stroke:hasExpFilters?"#4ade9e":"rgba(255,255,255,0.5)"})
            )
          ),
          showExpFilters&&React.createElement("div",{style:{marginBottom:12,padding:12,borderRadius:12,background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.06)"}},
            // Date range
            React.createElement("p",{style:{...S.label,marginBottom:8}},"Date range"),
            React.createElement("div",{style:{display:"flex",gap:8,marginBottom:14}},
              React.createElement("div",{style:{flex:1}},
                React.createElement("label",{style:{fontSize:11,color:"rgba(255,255,255,0.3)",marginBottom:4,display:"block"}},"From"),
                React.createElement("input",{type:"date",style:{...S.input,fontSize:12,padding:"8px 10px"},
                  value:expFromDate,onChange:e=>setExpFromDate(e.target.value)})
              ),
              React.createElement("div",{style:{flex:1}},
                React.createElement("label",{style:{fontSize:11,color:"rgba(255,255,255,0.3)",marginBottom:4,display:"block"}},"To"),
                React.createElement("input",{type:"date",style:{...S.input,fontSize:12,padding:"8px 10px"},
                  value:expToDate,onChange:e=>setExpToDate(e.target.value)})
              )
            ),
            // Category
            React.createElement("p",{style:{...S.label,marginBottom:8}},"Category"),
            React.createElement("div",{style:{display:"flex",gap:6,marginBottom:12,flexWrap:"wrap"}},
              React.createElement("button",{style:S.pill(!expFilterCat,"#4ade9e"),onClick:()=>setExpFilterCat("")},"All"),
              ["needs","wants","savings"].map(c=>
                React.createElement("button",{key:c,style:S.pill(expFilterCat===c,CAT_COLOR[c]),onClick:()=>setExpFilterCat(expFilterCat===c?"":c)},
                  c.charAt(0).toUpperCase()+c.slice(1))
              )
            ),
            // Sort
            React.createElement("p",{style:{...S.label,marginBottom:8}},"Sort by"),
            React.createElement("div",{style:{display:"flex",gap:6,flexWrap:"wrap"}},
              [["date","Date ↓"],["amount_desc","Amount ↓"],["amount_asc","Amount ↑"]].map(([val,label])=>
                React.createElement("button",{key:val,style:S.pill(expSortBy===val,"#1E88E5"),onClick:()=>setExpSortBy(val)},label)
              )
            ),
            hasExpFilters&&React.createElement("button",{style:{...S.ghost,width:"100%",marginTop:10,fontSize:12,padding:"8px",color:"rgba(255,255,255,0.4)"},
              onClick:()=>{setExpFilterCat("");setExpSortBy("date");setExpFromDate("");setExpToDate("");}},
              "Reset all filters")
          ),
          (expSearch||expFilterCat)&&React.createElement("p",{style:{fontSize:12,color:"rgba(255,255,255,0.35)",marginBottom:8}},
            `${filteredExpenses.length} result${filteredExpenses.length!==1?"s":""}`),
          histLoading ? React.createElement("p",{style:{fontSize:13,color:"rgba(255,255,255,0.3)",textAlign:"center",padding:"16px 0"}},"Loading...") :
          filteredExpenses.length===0 ? React.createElement("p",{style:{fontSize:13,color:"rgba(255,255,255,0.3)",textAlign:"center",padding:"16px 0"}},
            expSearch||expFilterCat?"No expenses match your search":"No expenses for this period") :
          filteredExpenses.map((exp,i)=>{
            const cc=CAT_COLOR[exp.category]||"#f0f0f5";
            const ec=exp.currency||"RON";
            return React.createElement("div",{key:exp.id||i,style:{display:"flex",alignItems:"center",gap:10,padding:"10px 0",borderBottom:i<filteredExpenses.length-1?"1px solid rgba(255,255,255,0.05)":"none"}},
              React.createElement("div",{style:{width:34,height:34,borderRadius:10,background:`rgba(${rgb(cc)},0.12)`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}},
                React.createElement(Icon,{d:exp.type==="recurring"?IC.pin:IC.receipt,size:15,stroke:cc})
              ),
              React.createElement("div",{style:{flex:1,minWidth:0}},
                React.createElement("p",{style:{fontWeight:600,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}},exp.name),
                React.createElement("div",{style:{display:"flex",gap:5,alignItems:"center"}},
                  React.createElement("span",{style:{fontSize:11,padding:"1px 6px",borderRadius:99,background:`rgba(${rgb(cc)},0.12)`,color:cc,fontWeight:600}},exp.category),
                  React.createElement("span",{style:{fontSize:11,color:"rgba(255,255,255,0.25)"}},exp.expense_date)
                )
              ),
              React.createElement("p",{style:{fontWeight:800,fontSize:13,color:cc,flexShrink:0}},fmt(parseFloat(exp.amount),ec))
            );
          })
        ),


      )
    )
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Account Tab
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Family Members Manager
// ─────────────────────────────────────────────────────────────────────────────
function FamilyMembers({budget, token, plan}) {
  const [members, setMembers]   = useState([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [loading, setLoading]   = useState(false);
  const [msg, setMsg]           = useState("");

  useEffect(()=>{
    if (!budget?.id || !token) return;
    loadMembers();
  }, [budget?.id]);

  async function loadMembers() {
    try {
      const db = await sb.from("budget_members", token);
      const rows = await db.select("user_id,role", `budget_id=eq.${budget.id}`);
      if (Array.isArray(rows)) setMembers(rows);
    } catch(e) { console.error("loadMembers error:", e); }
  }

  async function sendInvite() {
    if (!inviteEmail) return;
    setLoading(true); setMsg("");
    try {
      // 1. Create invite record in DB
      const db = await sb.from("invites", token);
      const result = await db.insert({
        budget_id: budget.id,
        invited_by: budget.owner_id,
        email: inviteEmail,
      });
      const invite = Array.isArray(result) ? result[0] : null;
      if (!invite) { setMsg("Error creating invite. Try again."); setLoading(false); return; }

      // 2. Send email via Edge Function
      const emailRes = await sb.callFunction("send-invite", token, {
        inviteId: invite.id,
        budgetName: budget.name || "Budgie Budget",
        inviterName: budget.owner_name || "Your friend",
        appUrl: window.location.origin,
      });

      if (emailRes.success) {
        setMsg(`✓ Invitation sent to ${inviteEmail}!`);
        setInviteEmail("");
      } else {
        setMsg("Invite created but email failed: " + (emailRes.error || "unknown error"));
      }
    } catch(e) { setMsg("Error: " + e.message); }
    setLoading(false);
  }

  async function removeMember(userId) {
    try {
      const db = await sb.from("budget_members", token);
      await db.delete(`budget_id=eq.${budget.id}&user_id=eq.${userId}`);
      setMembers(m => m.filter(x => x.user_id !== userId));
    } catch(e) { console.error("removeMember error:", e); }
  }

  if (plan !== "family") return null;

  return React.createElement("div",{style:{...S.card,marginBottom:16,padding:16}},
    React.createElement("p",{style:{fontWeight:700,fontSize:14,marginBottom:12,display:"flex",alignItems:"center",gap:8}},
      React.createElement(Icon,{d:IC.users,size:16,stroke:"#4ade9e"}),
      " Family Members (",members.length,"/5)"
    ),

    // Members list
    members.length > 0 && React.createElement("div",{style:{marginBottom:14}},
      members.map((m,i) =>
        React.createElement("div",{key:i,style:{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid rgba(255,255,255,0.06)"}},
          React.createElement("div",{style:{display:"flex",alignItems:"center",gap:8}},
            React.createElement("div",{style:{width:28,height:28,borderRadius:99,background:"linear-gradient(135deg,#4ade9e,#43A047)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:800,color:"#0a0a0f"}},"👤"),
            React.createElement("span",{style:{fontSize:13,color:"rgba(255,255,255,0.7)"}},
              m.role === "owner" ? "You (owner)" : `Member`)
          ),
          m.role !== "owner" && React.createElement("button",{
            style:{background:"none",border:"none",color:"rgba(255,255,255,0.3)",cursor:"pointer",fontSize:11},
            onClick:()=>removeMember(m.user_id)},"Remove")
        )
      )
    ),

    // Invite form
    members.length < 5 && React.createElement("div",null,
      React.createElement("label",{style:S.label},"Invite by email"),
      React.createElement("div",{style:{display:"flex",gap:8}},
        React.createElement("input",{style:{...S.input,flex:1,fontSize:13,padding:"10px 12px"},
          type:"email",placeholder:"friend@example.com",value:inviteEmail,
          onChange:e=>setInviteEmail(e.target.value),
          onKeyDown:e=>{if(e.key==="Enter")sendInvite();}}),
        React.createElement("button",{style:S.btn("#4ade9e"),onClick:sendInvite,disabled:loading},
          loading?"...":"Invite")
      ),
      msg && React.createElement("p",{style:{fontSize:12,marginTop:8,color:msg.includes("Error")?"#e94560":"#4ade9e"}},msg)
    )
  );
}

function AccountTab({user,profile,token,budget,aiCredits,onSignOut,onUpgrade,onRequestPush,notifPrefs,onToggleNotif}) {
  function handlePortal() {
    window.location.href = "https://billing.stripe.com/p/login/test_fZu14n7ht2aI76ycdWbsc00";
  }

  const planColor = profile?.plan==="family"?"#4ade9e":profile?.plan==="pro"?"#43A047":"rgba(255,255,255,0.4)";

  return React.createElement("div",{style:{padding:"44px 16px 16px"}},
    // Profile card
    React.createElement("div",{style:{...S.card,marginBottom:16,padding:20}},
      React.createElement("div",{style:{display:"flex",alignItems:"center",gap:12,marginBottom:16}},
        React.createElement("div",{style:{width:52,height:52,borderRadius:99,background:"linear-gradient(135deg,#4ade9e,#43A047)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,fontWeight:800,color:"#0a0a0f"}},
          (profile?.name||user?.email||"?")[0].toUpperCase()),
        React.createElement("div",null,
          React.createElement("p",{style:{fontWeight:800,fontSize:16}},profile?.name||"User"),
          React.createElement("p",{style:{fontSize:12,color:"rgba(255,255,255,0.4)"}},user?.email)
        )
      ),
      React.createElement("div",{style:{display:"flex",alignItems:"center",gap:8,padding:"10px 14px",borderRadius:10,background:`rgba(${rgb(planColor==="rgba(255,255,255,0.4)"?"255,255,255":"74,222,158")},0.08)`,marginBottom:profile?.plan!=="family"?12:0}},
        React.createElement(Icon,{d:IC.crown,size:16,stroke:planColor}),
        React.createElement("span",{style:{fontSize:13,fontWeight:700,color:planColor}},
          profile?.plan==="pro"?"Budgie Pro":profile?.plan==="family"?"Budgie Family":"Free Plan"),
        profile?.plan!=="free"&&profile?.plan_expires_at&&React.createElement("span",{style:{fontSize:11,color:"rgba(255,255,255,0.3)",marginLeft:"auto"}},
          "Renews ",new Date(profile.plan_expires_at).toLocaleDateString())
      ),
      profile?.plan==="free"&&React.createElement("div",{style:{display:"flex",gap:8,marginTop:0}},
        React.createElement("button",{style:{...S.btn("#43A047",true),color:"#fff",flex:1,fontSize:12},onClick:onUpgrade},
          React.createElement(React.Fragment,null,React.createElement(Icon,{d:IC.zap,size:13,stroke:"#fff"}), " Pro €2.99/mo")),
        React.createElement("button",{style:{...S.btn("#4ade9e",true),color:"#0a0a0f",flex:1,fontSize:12},onClick:onUpgrade},
          React.createElement(React.Fragment,null,React.createElement(Icon,{d:IC.family,size:13,stroke:"#0a0a0f"}), " Family €4.99/mo"))
      ),
      profile?.plan==="pro"&&React.createElement("button",{style:{...S.btn("#4ade9e",true),color:"#0a0a0f",width:"100%"},onClick:onUpgrade},
        React.createElement(React.Fragment,null,React.createElement(Icon,{d:IC.family,size:14,stroke:"#0a0a0f"}), " Switch to Family Plan"))
    ),

    // Family members section
    profile?.plan==="family" && React.createElement(FamilyMembers,{budget,token,plan:profile?.plan}),

    // AI Credits display
    React.createElement("div",{style:{...S.card,marginBottom:16,padding:16}},
      React.createElement("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}},
        React.createElement("div",{style:{display:"flex",alignItems:"center",gap:8}},
          React.createElement("div",{style:{width:28,height:28,borderRadius:8,background:"rgba(74,222,158,0.12)",display:"flex",alignItems:"center",justifyContent:"center"}},React.createElement(Icon,{d:IC.bot,size:16,stroke:"#4ade9e"})),
          React.createElement("p",{style:{fontWeight:700,fontSize:14}},"AI Scanner Credits")
        ),
        React.createElement("span",{style:{fontSize:22,fontWeight:900,color:aiCredits>5?"#4ade9e":aiCredits>0?"#1E88E5":"#e94560"}},
          aiCredits ?? "...")
      ),
      React.createElement("p",{style:{fontSize:12,color:"rgba(255,255,255,0.4)",marginBottom:12}},
        profile?.plan==="free"  ? "3 free credits included · Buy more anytime" :
        profile?.plan==="pro"   ? "10 credits/month included · Buy more anytime" :
                                  "20 credits/month included · Buy more anytime"),
      React.createElement("div",{style:{display:"flex",gap:8,flexWrap:"wrap"}},
        [
          {label:"Starter · 30 credits", price:"€2.99", url:"https://buy.stripe.com/test_eVq7sL8lxbLi8aC6TCbsc04"},
          {label:"Business · 100 credits", price:"€7.99", url:"https://buy.stripe.com/test_aFacN5eJV7v24Yqdi0bsc05"},
          {label:"Enterprise · 200 credits", price:"€12.99", url:"https://buy.stripe.com/test_9B6aEX1X95mU0Iagucbsc06"},
        ].map(pkg =>
          React.createElement("button",{key:pkg.label,
            style:{...S.ghost,fontSize:12,padding:"8px 12px",flex:1,minWidth:"120px"},
            onClick:()=>window.location.href=pkg.url},
            pkg.label," · ",pkg.price)
        )
      )
    ),

    // Notification settings
    React.createElement("div",{style:{...S.card,marginBottom:16,padding:16}},
      React.createElement("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}},
        React.createElement("p",{style:{fontWeight:700,fontSize:14}},React.createElement(React.Fragment,null,React.createElement(Icon,{d:IC.bell,size:14,stroke:"currentColor"}), " Notifications")),
        React.createElement("button",{
          style:{fontSize:12,color:"#4ade9e",background:"none",border:"none",cursor:"pointer",fontWeight:700},
          onClick:()=>onRequestPush()},"Enable")
      ),
      [
        {key:"budget_alerts", label:"Budget alerts (80%)", icon:IC.alert},
        {key:"payday_reset",  label:"Payday reset", icon:IC.wallet},
        {key:"daily_reminder",label:"Daily reminder", icon:IC.clock},
        {key:"weekly_summary",label:"Weekly summary", icon:IC.history},
      ].map(item =>
        React.createElement("div",{key:item.key,style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}},
          React.createElement("div",{style:{display:"flex",alignItems:"center",gap:8}},
            item.icon && React.createElement(Icon,{d:item.icon,size:14,stroke:"rgba(255,255,255,0.5)"}),
            React.createElement("span",{style:{fontSize:13,color:"rgba(255,255,255,0.6)"}},item.label)
          ),
          React.createElement("div",{
            style:{width:40,height:22,borderRadius:99,cursor:"pointer",position:"relative",transition:"background 0.2s",
              background:notifPrefs?.[item.key]?"#4ade9e":"rgba(255,255,255,0.1)"},
            onClick:()=>onToggleNotif(item.key)},
            React.createElement("div",{style:{position:"absolute",top:2,width:18,height:18,borderRadius:99,background:"#fff",transition:"left 0.2s",
              left:notifPrefs?.[item.key]?"19px":"2px"}})
          )
        )
      )
    ),

    // Actions
    React.createElement("div",{style:{display:"flex",flexDirection:"column",gap:10}},
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
  const [budgets, setBudgets]       = useState([]);   // all budgets for this user
  const [showBudgetPicker, setShowBudgetPicker] = useState(false);
  const [showNewBudget, setShowNewBudget] = useState(false);
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
  const [aiCredits, setAiCredits]   = useState(null);
  const [showBuyCredits, setShowBuyCredits] = useState(false);
  const [notifPrefs, setNotifPrefs] = useState({
    budget_alerts: true, payday_reset: true,
    daily_reminder: true, weekly_summary: true,
  });
  const [showMethodCard, setShowMethodCard] = useState(false);
  const [activeCatTooltip, setActiveCatTooltip] = useState(null); // "needs"|"wants"|"savings"

  // ── Auth check on mount ──────────────────────────────────────────────────
  // Check for invite token in URL
  useEffect(()=>{
    const params = new URLSearchParams(window.location.search);
    const inviteToken = params.get("invite");
    if (inviteToken) {
      safeStorage.set("pending_invite", inviteToken);
      window.history.replaceState({}, "", window.location.pathname);
    }
    if (params.get("upgraded") === "1") {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  // Accept pending invite after login
  useEffect(()=>{
    if (!authToken || !user) return;
    const pendingInvite = safeStorage.get("pending_invite");
    if (!pendingInvite) return;
    safeStorage.remove("pending_invite");
    acceptInvite(pendingInvite);
  }, [authToken, user]);

  async function acceptInvite(token_str) {
    try {
      // Find invite by token
      const db = await sb.from("invites", authToken);
      const invites = await db.select("*", `token=eq.${token_str}&status=eq.pending`);
      const invite = Array.isArray(invites) ? invites[0] : null;
      if (!invite) { console.log("Invite not found or expired"); return; }

      // Check if already member
      const memberDb = await sb.from("budget_members", authToken);
      const existing = await memberDb.select("*", `budget_id=eq.${invite.budget_id}&user_id=eq.${user.id}`);
      if (Array.isArray(existing) && existing.length > 0) { console.log("Already a member"); return; }

      // Add to budget_members
      await memberDb.insert({ budget_id: invite.budget_id, user_id: user.id, role: "member" });

      // Mark invite accepted
      await db.update({ status: "accepted" }, `id=eq.${invite.id}`);

      // Reload data to show the shared budget
      await loadUserData(authToken);
      alert("✓ You joined the shared budget!");
    } catch(e) { console.error("acceptInvite error:", e); }
  }

  useEffect(()=>{
    async function checkAuth() {
      try {
        // First try to refresh the token
        const refresh = safeStorage.get("sb_refresh");
        if (refresh) {
          const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
            method: "POST",
            headers: { "apikey": SUPABASE_ANON, "Content-Type": "application/json" },
            body: JSON.stringify({ refresh_token: refresh })
          });
          const data = await r.json();
          if (data.access_token) {
            safeStorage.set("sb_token", data.access_token);
            if (data.refresh_token) safeStorage.set("sb_refresh", data.refresh_token);
            setAuthToken(data.access_token);
            await loadUserData(data.access_token);
            setAuthLoading(false);
            return;
          }
        }
        // No refresh token — try existing session
        const session = await sb.getSession();
        if (session?.access_token) {
          setAuthToken(session.access_token);
          await loadUserData(session.access_token);
        }
      } catch(e) {
        console.error("checkAuth error:", e);
      }
      setAuthLoading(false);
    }
    checkAuth();
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
        console.log("profiles response:", JSON.stringify(profiles));
        if (Array.isArray(profiles) && profiles.length > 0) {
          prof = profiles[0];
          // Sanitize plan value
          if (!prof.plan || !["free","pro","family"].includes(prof.plan)) {
            prof.plan = "free";
          }
        }
      } catch(e) { console.error("profile load error:", e); }
      console.log("final profile:", prof);
      setProfile(prof);

      // Load notification preferences
      try {
        const notifDb = await sb.from("notification_preferences", token);
        const notifRows = await notifDb.select("*", `user_id=eq.${userData.id}`);
        if (Array.isArray(notifRows) && notifRows[0]) {
          const p = notifRows[0];
          setNotifPrefs({
            budget_alerts:  p.budget_alerts  ?? true,
            payday_reset:   p.payday_reset   ?? true,
            daily_reminder: p.daily_reminder ?? true,
            weekly_summary: p.weekly_summary ?? true,
          });
        }
      } catch(e) { console.error("notif prefs load error:", e); }

      // Load AI credits
      try {
        const credDb = await sb.from("ai_credits", token);
        const credRows = await credDb.select("credits", `user_id=eq.${userData.id}`);
        const cred = Array.isArray(credRows) && credRows.length > 0 ? credRows[0] : null;
        setAiCredits(cred?.credits ?? 0);
      } catch(e) { setAiCredits(0); }

      // Step 3: get all budgets
      let bud = null;
      let allBudgets = [];
      try {
        const budgetDb = await sb.from("budgets", token);
        const budgetList = await budgetDb.select("*", `owner_id=eq.${userData.id}&order=created_at.asc`);
        allBudgets = Array.isArray(budgetList) ? budgetList : [];
        setBudgets(allBudgets);
        bud = allBudgets.length > 0 ? allBudgets[0] : null;
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
            sendLocalNotification(
              "💰 Payday Reset!",
              "Your variable expenses have been reset. New budget period started!",
              "/"
            );
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
    // Show 50-30-20 explanation card
    setShowMethodCard(true);
    // Request push permission after onboarding
    if (user?.id) {
      setTimeout(() => requestPushPermission(authToken, user.id), 4000);
    }
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
    setBudgets(bs => bs.map(b => b.id === budget.id ? {...b,...patch} : b));
  }

  async function switchBudget(bud) {
    setBudget(bud);
    setExpenses([]);
    setHistory([]);
    setShowBudgetPicker(false);
    try { await loadExpenses(authToken, bud.id); } catch(e) {}
    if (plan !== "free") try { await loadHistory(authToken, bud.id); } catch(e) {}
  }

  async function createBudget(name) {
    if (!name || !user) return;
    try {
      const db = await sb.from("budgets", authToken);
      const result = await db.insert({
        owner_id: user.id,
        name,
        monthly_income: 0,
        income_currency: budget?.income_currency || "RON",
        payday: budget?.payday || 1,
        current_period: getPeriodKey(budget?.payday || 1),
        settings: { onboardingDone: true },
      });
      const newBud = Array.isArray(result) ? result[0] : null;
      if (newBud) {
        setBudgets(bs => [...bs, newBud]);
        await switchBudget(newBud);
      }
    } catch(e) { console.error("createBudget error:", e); }
    setShowNewBudget(false);
  }

  async function deleteBudget(budId) {
    if (budgets.length <= 1) { alert("You need at least one budget."); return; }
    if (!confirm("Delete this budget? All expenses will be lost.")) return;
    try {
      const db = await sb.from("budgets", authToken);
      await db.delete(`id=eq.${budId}`);
      const remaining = budgets.filter(b => b.id !== budId);
      setBudgets(remaining);
      if (budget?.id === budId) await switchBudget(remaining[0]);
    } catch(e) { console.error("deleteBudget error:", e); }
  }

  function checkBudgetAlert(allExpenses, newExpense) {
    if (!budget) return;
    const income = parseFloat(budget.monthly_income) || 0;
    if (income <= 0) return;
    const cat = newExpense.category;
    const budgetPct = cat === "needs" ? 0.5 : cat === "wants" ? 0.3 : 0.2;
    const catBudget = income * budgetPct;
    const er = { RON:1, ...rates };
    const catSpent = allExpenses
      .filter(e => e.category === cat)
      .reduce((sum, e) => {
        const expRates = e.custom_rate ? {...er, [e.custom_rate_cur||e.currency]: e.custom_rate} : er;
        return sum + convert(parseFloat(e.amount)||0, e.currency||incomeCurrency, incomeCurrency, expRates);
      }, 0);
    const pct = catSpent / catBudget;
    if (pct >= 0.8 && pct < 1.0) {
      sendLocalNotification(
        "⚠️ Budget Alert",
        `You've used ${Math.round(pct*100)}% of your ${cat} budget this period.`,
        "/"
      );
    } else if (pct >= 1.0) {
      sendLocalNotification(
        "🚨 Over Budget!",
        `You've exceeded your ${cat} budget by ${fmt(catSpent - catBudget, incomeCurrency)}.`,
        "/"
      );
    }
  }

  async function handleRequestPush() {
    if (!user?.id) return;
    const granted = await requestPushPermission(authToken, user.id);
    if (granted) {
      sendLocalNotification("🦜 Budgie Notifications", "You'll now receive budget alerts and reminders!");
    } else {
      alert("Notifications blocked. Please enable them in your browser settings.");
    }
  }

  async function handleToggleNotif(key) {
    const updated = {...notifPrefs, [key]: !notifPrefs[key]};
    setNotifPrefs(updated);
    // Save to Supabase
    try {
      const db = await sb.from("notification_preferences", authToken);
      await db.upsert({user_id: user.id, ...updated});
    } catch(e) { console.error("notif pref save error:", e); }
  }

  function openAdd(type) {
    setEditingExpense(null);
    setForm({name:"",amount:"",currency:incomeCurrency,category:"wants",subcat:"",customRate:"",targetBudgetId:budget?.id});
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
    const targetBudId = form.targetBudgetId || budget.id;
    const entry={budget_id:targetBudId,added_by:user.id,type,name:form.name,amount:parseFloat(form.amount),currency:form.currency||incomeCurrency,custom_rate_cur:fc,custom_rate:cr,category:form.category,subcat:form.subcat,expense_date:new Date().toISOString().split("T")[0]};

    if(editingExpense) {
      const db = await sb.from("expenses", authToken);
      const updated = await db.update({name:form.name,amount:parseFloat(form.amount),currency:form.currency||incomeCurrency,custom_rate_cur:fc,custom_rate:cr,category:form.category,subcat:form.subcat}, `id=eq.${editingExpense.id}`);
      setExpenses(ex=>ex.map(e=>e.id===editingExpense.id?{...e,...(Array.isArray(updated)?updated[0]:{})}:e));
      setEditingExpense(null);
    } else {
      const db = await sb.from("expenses", authToken);
      const result = await db.insert(entry);
      // Only update local state if expense was added to current active budget
      if(Array.isArray(result)&&result[0]&&targetBudId===budget.id) {
        const newExpenses = [result[0], ...expenses];
        setExpenses(newExpenses);
        // Check 80% budget alert
        checkBudgetAlert(newExpenses, result[0]);
      }
    }
    setModal(null);
  }

  async function handleScanFile(file, mode="simple") {
    if (aiCredits !== null && aiCredits <= 0) {
      setShowBuyCredits(true);
      return;
    }
    setScanState("scanning"); setScanError(null);
    try {
      const b64 = await fileToBase64(file);
      const res = await sb.callFunction("scan-receipt", authToken, { imageBase64: b64, mode });
      if (res.error === "no_credits") {
        setShowBuyCredits(true);
        setScanState("idle");
        return;
      }
      if (res.error) { setScanError(res.error); setScanState("error"); return; }
      // Update credits count
      if (res.credits_remaining !== undefined) setAiCredits(res.credits_remaining);
      const dc = CURRENCIES.includes(res.currency) ? res.currency : incomeCurrency;
      setScanResult({ ...res, mode });
      if (mode === "simple") {
        setForm({name:res.name||"",amount:res.amount?.toString()||"",currency:dc,category:classify(res.category||res.name||""),subcat:res.category||"",customRate:"",targetBudgetId:budget?.id});
      }
      setScanState("result");
    } catch(err) { setScanError(err.message||"Unknown error"); setScanState("error"); }
  }

  function confirmScan(type){addExpense(type);setScanState("idle");setScanResult(null);setModal(null);}
  function cancelScan(){setScanState("idle");setScanResult(null);}
  function retryScan(){setScanState("idle");setScanError(null);}

  async function confirmItems(selectedItems) {
    if (!selectedItems.length || !budget) return;
    for (const item of selectedItems) {
      const entry = {
        budget_id: form.targetBudgetId || budget.id,
        added_by: user.id,
        type: item.type || "daily",  // each item has its own type
        name: item.editName || item.name,
        amount: parseFloat(item.editAmount) || 0,
        currency: form.currency || incomeCurrency,
        category: item.editCategory || classify(item.name),
        subcat: item.editSubcat || item.category || "",
        expense_date: scanResult?.date || new Date().toISOString().split("T")[0],
      };
      try {
        const db = await sb.from("expenses", authToken);
        const result = await db.insert(entry);
        if (Array.isArray(result) && result[0] && entry.budget_id === budget.id) {
          setExpenses(ex => [result[0], ...ex]);
        }
      } catch(e) { console.error("confirmItems insert error:", e); }
    }
    setScanState("idle");
    setScanResult(null);
    setModal(null);
  }

  const globalStyles=`*{margin:0;padding:0;box-sizing:border-box;}body{background:#0a0a0f;}input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;}input::placeholder{color:rgba(255,255,255,0.2);}select option{background:#13131f;}::-webkit-scrollbar{width:0;}`;

  // Budget Picker Modal
  function BudgetPicker() {
    const [newName, setNewName] = useState("");
    const canCreate = plan !== "free" || budgets.length === 0;
    return React.createElement("div",{style:{...S.overlay,zIndex:300},onClick:e=>{if(e.target===e.currentTarget)setShowBudgetPicker(false);}},
      React.createElement("div",{style:S.sheet},
        React.createElement("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}},
          React.createElement("h3",{style:{fontWeight:800,fontSize:18}},"Your Budgets"),
          React.createElement("button",{style:{background:"none",border:"none",color:"rgba(255,255,255,0.4)",cursor:"pointer"},onClick:()=>setShowBudgetPicker(false)},
            React.createElement(Icon,{d:IC.x,size:20}))
        ),
        // Budget list
        budgets.map(b =>
          React.createElement("div",{key:b.id,style:{...S.card,marginBottom:10,display:"flex",alignItems:"center",gap:12,cursor:"pointer",
            border:b.id===budget?.id?"1px solid rgba(74,222,158,0.4)":"1px solid rgba(255,255,255,0.07)"},
            onClick:()=>switchBudget(b)},
            React.createElement("div",{style:{width:36,height:36,borderRadius:10,background:b.id===budget?.id?"rgba(74,222,158,0.15)":"rgba(255,255,255,0.06)",display:"flex",alignItems:"center",justifyContent:"center"}},
              React.createElement(Icon,{d:IC.wallet,size:16,stroke:b.id===budget?.id?"#4ade9e":"rgba(255,255,255,0.4)"})),
            React.createElement("div",{style:{flex:1}},
              React.createElement("p",{style:{fontWeight:700,fontSize:14,color:b.id===budget?.id?"#4ade9e":"#f0f0f5"}},b.name),
              React.createElement("p",{style:{fontSize:11,color:"rgba(255,255,255,0.3)"}},
                b.income_currency||"RON"," · ",b.payday?"Payday "+b.payday:"No payday set")
            ),
            b.id===budget?.id && React.createElement(Icon,{d:IC.check,size:16,stroke:"#4ade9e"}),
            budgets.length > 1 && b.id !== budget?.id && React.createElement("button",{
              onClick:e=>{e.stopPropagation();deleteBudget(b.id);},
              style:{background:"none",border:"none",color:"rgba(255,255,255,0.2)",cursor:"pointer",padding:4}},
              React.createElement(Icon,{d:IC.trash,size:14}))
          )
        ),
        // New budget
        canCreate ? React.createElement("div",{style:{marginTop:16}},
          React.createElement("label",{style:S.label},"Create new budget"),
          React.createElement("div",{style:{display:"flex",gap:8}},
            React.createElement("input",{style:{...S.input,flex:1},placeholder:"e.g. Business, Vacation...",value:newName,
              onChange:e=>setNewName(e.target.value),
              onKeyDown:e=>{if(e.key==="Enter"&&newName)createBudget(newName);}}),
            React.createElement("button",{style:S.btn("#4ade9e"),onClick:()=>createBudget(newName),disabled:!newName},
              React.createElement(Icon,{d:IC.plus,size:16}))
          )
        ) : React.createElement("div",{style:{...S.card,marginTop:16,background:"rgba(74,222,158,0.05)",border:"1px solid rgba(74,222,158,0.15)",textAlign:"center",padding:16}},
          React.createElement("p",{style:{fontSize:13,color:"rgba(255,255,255,0.5)",marginBottom:8}},"Multiple budgets requires Pro or Family"),
          React.createElement("button",{style:{...S.btn("#4ade9e",true),color:"#0a0a0f"},onClick:()=>{setShowBudgetPicker(false);setShowUpgrade(true);}},
            "Upgrade to Pro")
        )
      )
    );
  }

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

    tab==="home"&&React.createElement(HomeTab,{budget,expenses,updateBudget,incomeCurrency,rates,spentByType,totalSpent,allExpenses:expenses,onOpenRates:()=>setShowRates(true),plan,onUpgrade:()=>setShowUpgrade(true),userName:profile?.name||user?.email?.split("@")[0]||"",onOpenBudgetPicker:()=>setShowBudgetPicker(true),budgetsCount:budgets.length,budgetName:budget?.name,onSwitchTab:setTab,onCatInfo:setActiveCatTooltip}),
    tab==="expenses"&&React.createElement(ExpensesTab,{expenses,updateBudget,incomeCurrency,rates,onOpenAdd:openAdd,onOpenEdit:openEdit,budget,userName:profile?.name||user?.email?.split("@")[0]||""}),
    tab==="history"&&React.createElement(HistoryTab,{history,plan,onUpgrade:()=>setShowUpgrade(true),userName:profile?.name||user?.email?.split("@")[0]||"",budget,expenses,token:authToken}),
    tab==="account"&&React.createElement(AccountTab,{user,profile,token:authToken,budget,aiCredits,onSignOut:handleSignOut,onUpgrade:()=>setShowUpgrade(true),onRequestPush:handleRequestPush,notifPrefs,onToggleNotif:handleToggleNotif}),

    React.createElement("nav",{style:S.navBar},
      [{id:"home",label:"Overview",icon:IC.home},{id:"expenses",label:"Expenses",icon:IC.receipt},{id:"history",label:"History",icon:IC.history},{id:"account",label:"Account",icon:IC.users}].map(item=>
        React.createElement("button",{key:item.id,style:S.navBtn(tab===item.id),onClick:()=>setTab(item.id)},
          React.createElement(Icon,{d:item.icon,size:20,stroke:"currentColor"}),item.label)
      )
    ),

    React.createElement(ExpenseModal,{modal,onClose:()=>{setModal(null);setEditingExpense(null);},form,setForm,onAdd:addExpense,isEditing:!!editingExpense,scanState,scanResult,scanError,onScanFile:handleScanFile,onConfirmScan:confirmScan,onCancelScan:cancelScan,onRetryScan:retryScan,onConfirmItems:confirmItems,rates,incomeCurrency,budgets,activeBudgetId:budget?.id,aiCredits,onBuyCredits:()=>setTab("account")}),
    showBudgetPicker && React.createElement(BudgetPicker,null),
    showMethodCard && React.createElement(BudgetMethodCard,{onDismiss:()=>setShowMethodCard(false)}),
    activeCatTooltip && React.createElement(CategoryTooltip,{cat:activeCatTooltip,onClose:()=>setActiveCatTooltip(null)}),
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
