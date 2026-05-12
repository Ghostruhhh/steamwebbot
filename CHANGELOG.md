# Changelog

All notable changes to this project are documented in this file.

## [1.4.6] - 2026-05-10

- **Issued keys filters:** **Product** (all or one catalog item) and **Key plan** — **Lifetime** (no expiry), **Day** (1d), **Week** (6–8d), **Month** (28–31d), **Other timed**. Uses stored **`duration_days`** when present, otherwise infers from **created → expires** span. New **Plan** column per row; empty filter results show a dedicated message.

## [1.4.5] - 2026-05-10

- **License HWID lock:** `POST /api/license/keys/bind` with JSON **`{ "key", "hwid" }`** — first successful call stores **`hwid`** + **`hwid_bound_at`** on that key; later calls must send the same HWID or get **403**. Expired keys are rejected. **Localhost** bind always allowed; **remote** bind requires **`LICENSE_BIND_SECRET`** (≥8 chars) and header **`X-License-Bind-Secret`**. Hub shows an **HWID** column and **Clear HWID** (localhost **`DELETE /api/license/keys/:id/hwid`**).

## [1.4.4] - 2026-05-10

- **Products & keys:** responsive **two-column** layout (catalog + generator), shared **license-card** styling, clearer issued-keys panel head. **Issued keys** are grouped **by product** with headings **`Issued keys · {product name}`** (tables drop the redundant Product column). Sort modes apply to **group order** and **row order within each group**.

## [1.4.3] - 2026-05-10

- **Duration (days)** is a **text** field (`inputmode="numeric"`) so **`1` is in `.value` immediately** (no `type="number"` blur/stepper quirks). **Generate** blurs the field on pointer-down; status line shows **`expires …`** from the API response or warns if the running server didn’t save expiry. **`POST /api/license/keys/generate`** accepts **`duration`** as an alias for **`duration_days`** and trims string numbers.

## [1.4.2] - 2026-05-10

- **Issued keys:** **Sort keys** control (newest/oldest, product A–Z / Z–A). **Duration:** read reliably via `valueAsNumber` + parsing (fixes “Never” when **1 day** was set but the number field hadn’t committed); invalid non‑blank duration shows a clear status message. API/dashboard fills **`expires_at`** when only **`duration_days`** is present (including string values from hand‑edited JSON).

## [1.4.1] - 2026-05-10

- **License keys:** optional **`duration_days`** on **`POST /api/license/keys/generate`** — stores **`expires_at`** (and **`duration_days`** snapshot) per key; hub **Generate keys** adds **Duration (days)** (blank = no expiry). First-run **`data/license-store.json`** still bootstraps with **Product 1** when missing.

## [1.4.0] - 2026-05-11

- **Products & keys** hub tab + **`/api/license/*`** (localhost only): add products, generate **`GP-…`** keys (batch notes, counts up to 50), copy/delete keys, delete product (cascades keys). Persisted in **`data/license-store.json`** (folder gitignored).

## [1.3.0] - 2026-05-11

- Startup reports: API JSON includes `report_schema` + plaintext `report_log`; **Startup apps** tab adds **Download report file**. **Home** adds paste viewer (**Parse & show startups**) for saved JSON (embedded log in collapsible).

## [1.2.0] - 2026-05-10

- Added **Startup apps** hub tab: full WMI `Win32_StartupCommand` list (localhost only), filter field, and JSON export (`GET /api/startup-apps`).

## [1.1.0] - 2026-05-10

- Added **Changelog**: version and history from this file plus `package.json` (hub sidebar + `/api/meta`).
- Added **Suspicious link checker** (Security hints tab): heuristic URL/phishing signals and optional HTTP redirect peek (`POST /api/check-url`, localhost only).

## [1.0.0]

- Galaxy Products hub with SteamWeb Hour Checker embed, PC serial / WMI identifiers, malware/RAT heuristics, Defender quick scan, appearance settings in sidebar.
