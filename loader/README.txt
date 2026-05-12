Galaxy Products — file / desktop loader (no browser)
========================================

Recommended: Galaxy desktop app (full window — animated galaxy backdrop, paste key, Activate):

  npm install
  npm run build:galaxy-gui

Output: galaxy-desktop\release\GalaxyLoaderGUI.exe — keep a copy of your .env beside it
(LOADER_HUB_ORIGIN, PORT, …). Optional: LOADER_GUI_TITLE=YourBrand — sets the big centered title on the Electron loader window.

Alternatives:

  GalaxyLoader.hta — light Windows popup (needs Node installed on that PC).

  dist\GalaxyLoader.exe — from npm run build:loader-exe; console-only pkg blob (green Node icon).

  Clipboard: copy GP key → GalaxyLoader.exe --clipboard — or GalaxyLoader-clipboard.cmd —
  at the GP prompt in cmd.exe, Ctrl+V won't work — leave blank and press Enter, or PowerShell/right-click paste.

  GalaxyLoader.cmd — classic terminal.

Project folder (development / source tree):

  npm run loader

Runs the loader in this folder — paste your GP-… license key when prompted.

This talks to your hub's default loader activate URL (pins the key and can save the installer),

  POST /api/loader/activate

or the full URL set in LOADER_BIND_URL when you pointed at legacy bind endpoints.

Requirements:
• Node.js installed for dev (HTA, GalaxyLoader.cmd, npm run loader) — not needed for customers who only get GalaxyLoaderGUI.exe or GalaxyLoader.exe
• Dependencies installed once for HTA / CMD (runs npm install when needed)
• Hub reachable (LOADER_HUB_ORIGIN or PORT in .env — same file should sit beside GalaxyLoaderGUI.exe / GalaxyLoader.exe when shipped)

Optional env (see comments in loader/loader.js):

  LOADER_CLI_DOWNLOAD_DIR - folder for the saved .exe (default ./downloads)
  LOADER_CLI_NO_DOWNLOAD / flag --no-download - skip installer download
  LOADER_HUB_ORIGIN - HTTPS production hub base URL

Smaller standalone .exe (console window, pkg):

  npm install
  npm run build:loader-exe

Writes dist\GalaxyLoader.exe (+ optional GalaxyLoader-clipboard.cmd). Clipboard: copy GP key, then GalaxyLoader.exe --clipboard. Ship exe with .env (LOADER_HUB_ORIGIN,
PORT, LOADER_BIND_URL, etc.). Downloads next to exe (LOADER_CLI_DOWNLOAD_DIR). Rebuild whenever you change loader logic.

Antivirus scanners sometimes flag generic Node-in-exe blobs as suspicious; whitelist if needed.



Two-step hub delivery (recommended)
========================================
Give buyers the WEB link (http(s)…/loader/) first. Their browser activates with delivery:web and usually downloads GalaxyLoader.exe if you set:

  LOADER_BOOTSTRAP_EXE_PATH=dist\GalaxyLoader.exe   (or any copy of GalaxyLoader.exe)

Optional Save-as name: LOADER_CLIENT_DOWNLOAD_FILENAME=GalaxyLoader.exe

They run GalaxyLoader.exe, paste the SAME GP key → hub activates with native delivery and serves your product installer from:

  LOADER_ARTIFACT_PATH=artifacts\YourProductInstaller.exe

(Optional friendly name LOADER_DOWNLOAD_FILENAME=FriendlyInstaller.exe.) If bootstrap isn’t set, /loader/ falls back to direct product download (old behavior).

After activation — product .exe download (hub side)
========================================
Loaders don't create your product. The hub serves files off your PC paths above; see artifacts\README.txt and .env.example.

Print machine-only HWID hash (paste for debugging):

  npm run loader -- --show-hwid
