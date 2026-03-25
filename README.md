# Budgie 🦜 — Budget Tracker PWA

## Instalare pe telefon (fără App Store)

### Opțiunea 1: GitHub Pages (recomandat, complet gratuit)

1. Creează un cont pe [github.com](https://github.com) dacă nu ai
2. Creează un repository nou numit `budgie`
3. Uploadează toate fișierele din acest folder
4. Mergi la **Settings → Pages → Source: main branch → Save**
5. Aplicația va fi disponibilă la `https://USERUL-TAU.github.io/budgie`
6. Deschide URL-ul pe telefon în Safari (iPhone) sau Chrome (Android)
7. **iPhone:** tap Share → "Add to Home Screen"
   **Android:** tap meniu (⋮) → "Add to Home Screen" sau "Install App"

### Opțiunea 2: Netlify Drop (cel mai simplu, 30 secunde)

1. Mergi la [app.netlify.com/drop](https://app.netlify.com/drop)
2. Trage folderul `budgie-pwa` direct în pagină
3. Netlify îți dă un URL instant (ex: `happy-bird-123.netlify.app`)
4. Deschide pe telefon și instalează ca mai sus

### Opțiunea 3: Vercel

1. Instalează Vercel CLI: `npm i -g vercel`
2. În folderul proiectului: `vercel --prod`
3. Urmează pașii din terminal

---

## Scanare bonuri (opțional)

Funcția de scanare bon folosește Anthropic API (~$0.001/scan).

1. Creează un cont pe [console.anthropic.com](https://console.anthropic.com)
2. Generează un API key
3. În fișierul `app.js`, caută `anthropic-dangerous-direct-browser-access` și adaugă cheia ta:
   ```
   "x-api-key": "sk-ant-..."
   ```

Fără API key, restul aplicației funcționează perfect.

---

## Structura proiectului

```
budgie-pwa/
  index.html          ← Entry point cu meta taguri PWA
  app.js              ← Aplicația React (JSX, transpilat de Babel)
  manifest.json       ← Configurare PWA (nume, culori, iconițe)
  sw.js               ← Service worker (offline, cache)
  icons/
    icon-192.png      ← Iconiță standard
    icon-512.png      ← Iconiță mare
    icon-maskable-192.png  ← Iconiță adaptivă Android
    icon-maskable-512.png
```

---

## Funcționalități

- 💰 Buget lunar cu metoda 50-30-20
- 🔄 Cheltuieli fixed (permanente) și variable (reset la salariu)
- 💱 Suport RON, EUR, USD cu cursuri live zilnice (BCE)
- 📸 Scanare bonuri fiscale cu AI
- 📊 Istoric spending breakdown pe perioade
- 📱 Instalabilă pe iPhone și Android ca aplicație nativă
- 🌐 Funcționează offline după prima deschidere
