# Amanah Budget

A zero-based budgeting app with Zakat & Sadaqah tracking. It runs entirely on your own devices: no accounts, no cloud, no fees, no external libraries. Your data is stored in your browser's IndexedDB and never leaves the device.

## What's inside

```
amanah-budget/
├── index.html        App shell
├── manifest.json     Lets you install it to your home screen
├── sw.js             Service worker (offline cache)
├── serve.py          Local server (Python standard library only)
├── css/styles.css    Light & dark theme, mobile-first
├── js/app.js         All screens: Budget, Transactions, Zakat, Goals, Reports, Settings
├── js/db.js          IndexedDB storage
├── js/csv.js         Bank CSV parser + CommBank/NAB/ANZ/Westpac detection
├── js/charts.js      SVG charts (no libraries)
├── js/utils.js       Money, dates, Hijri conversion
└── icons/            App icons
```

---

## 1. Run it on your computer

You need Python 3 (macOS and most Linux systems already have it; on Windows get it from python.org and tick "Add to PATH").

```bash
cd amanah-budget
python serve.py          # Windows: py serve.py
```

Open **http://localhost:8080**. On `localhost`, offline mode and "Install app" (the ⊕ icon in Chrome or Edge's address bar) work straight away.

> No Python? `npx serve -l 8080 .` (Node.js) or `python -m http.server 8080` also work.
> Please don't open `index.html` by double-clicking it: browsers block service workers and modules on `file://` addresses.

## 2. Open it on your phone (same Wi-Fi)

1. Leave `serve.py` running. It prints a line like `On your phone: http://192.168.1.23:8080`.
2. Type that address into your phone's browser (Safari on iPhone, Chrome on Android).
3. If it doesn't load, allow Python through your computer's firewall:
   - **Windows:** accept the "Allow access" prompt for *Private networks*.
   - **macOS:** System Settings → Network → Firewall → Options → allow Python.

The app works fully at this address **while your computer is on**. But browsers only allow offline caching and proper installation over **HTTPS** (or on `localhost`). For an app that works when your computer is off, do step 4. It takes about 10 minutes, once.

## 3. Important: each device has its own data

The phone and the computer each keep **separate** copies of your data. Pick one device as your main budget (most people use the phone). To move data between devices: **Settings → Export full backup (JSON)**, send the file over, then **Restore from backup** on the other device.

Your data is also tied to the exact address you open, e.g. `https://192.168.1.23:8443`. If your computer's IP address changes, the app will look empty. Your data isn't lost: go back to the old address, or restore a backup. To prevent this, give your computer a fixed IP with a *DHCP reservation* in your router's settings.

## 4. Full offline install on your phone (HTTPS)

You'll use **mkcert**, a free tool that makes a certificate your devices trust.

**a. Install mkcert on your computer**
- macOS: `brew install mkcert`
- Windows: `winget install FiloSottile.mkcert` (or `choco install mkcert`)
- Linux: your package manager, or the binary from github.com/FiloSottile/mkcert/releases

**b. Create a certificate** (use the IP that `serve.py` printed):
```bash
cd amanah-budget
mkcert -install
mkcert -cert-file cert.pem -key-file key.pem 192.168.1.23 localhost 127.0.0.1
```

**c. Make your phone trust it.** Run `mkcert -CAROOT` to find the folder that holds `rootCA.pem`.
- **iPhone:** AirDrop or email `rootCA.pem` to yourself and open it. Then Settings → *Profile Downloaded* → Install. Then Settings → General → About → **Certificate Trust Settings** → switch on full trust for the mkcert root.
- **Android:** copy `rootCA.pem` to the phone. Settings → Security → Encryption & credentials → Install a certificate → **CA certificate**. Menu names vary by brand; search Settings for "certificate".

**d. Start the HTTPS server**
```bash
python serve.py --https --port 8443
```
Open `https://192.168.1.23:8443` on your phone. You shouldn't see a security warning.

**e. Install it**
- **iPhone (Safari):** Share button → **Add to Home Screen**.
- **Android (Chrome):** ⋮ menu → **Install app** (or *Add to Home screen*).

Once it's installed, open it once while connected so it can cache everything. After that it works with the computer off, in flight mode, anywhere. Settings shows a ✓ when your browser has marked the storage as persistent.

> Keep the `rootCA-key.pem` file in mkcert's CAROOT folder private. Never share that key file.

## 5. Back up regularly

Browsers can delete stored data if you clear site data, uninstall the app, or (on iPhone) leave a *non-installed* site unused for a long time. Installed home-screen apps are protected. Still, use **Settings → Export full backup** every month or so, and keep the file somewhere safe (cloud drive, email to yourself).

## 6. Updating the app

If you change any file, bump `CACHE` at the top of `sw.js` (e.g. `amanah-v1.0.1`). Then open the app twice on each device: once to download the new version, and once to use it.

---

## Quick tour

**Budget:** Pick Monthly, Fortnightly or Weekly. Type a *Planned* amount for each category, and the **Left to Budget** banner updates live. When it reaches $0.00, every dollar has a job. **Copy previous** brings forward last period's plan. Tap a category name to rename it, move it, delete it, or turn on:
- **Sinking fund / rollover:** unspent money carries into the next period. Set a *starting balance* for money you'd already saved before using the app.
- **Zakatable asset:** counts the fund's balance in your Zakat calculation.

**Transactions:** Use **+** to add one, and *Split across categories* to divide one receipt (e.g. Groceries + Household). Search and filter by text, category, type and dates. **Import CSV** reads statements from CommBank, NAB, ANZ and Westpac (or any bank, if you map the columns yourself). It recognises re-imported rows and skips them, flags *possible* duplicates of things you entered by hand, and remembers merchant → category rules.

**Zakat:**
1. Enter today's gold or silver price per gram, or type the Nisab directly, and choose the basis.
2. Tag zakatable funds, and add assets and liabilities (cash, gold, halal shares; short-term debts to deduct).
3. Set the date your wealth first reached the Nisab. The app counts down 354 days and shows Gregorian and Hijri dates.
4. **Fund Zakat** plans annual Zakat ÷ 12, 26 or 52 into your Zakat Sinking Fund for the current period.
5. **Record Zakat paid** logs each payment and can also post it to your budget. When your Hawl completes, **lock** the due amount so the payments you make don't shrink the figure. Then start the next Hawl.

Sadaqah is logged separately from Zakat.

**Goals:** Set a target and date (e.g. a $60,000 house deposit) and link the goal to a sinking fund. The goal shows the amount needed per month, fortnight and week. The "If I save $X per month" calculator shows when you'd reach it.

**Reports:** Spending by category, planned vs actual by group, Zakat paid vs remaining, and net worth, savings and zakatable wealth over time. The app saves one snapshot per day.

*The Zakat module does the arithmetic: 2.5% of net zakatable wealth held above the Nisab for one lunar year. Scholars differ on how to treat superannuation, shares, debts and jewellery. Check with a scholar or your local Zakat organisation for your own situation.*
