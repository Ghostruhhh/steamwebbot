const path = require('path');
const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');

const repoOrExeRoot = () =>
  app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..');

function ensureWorkingDirectory() {
  try {
    process.chdir(repoOrExeRoot());
  } catch (_) {
    /* ignore */
  }
}

function loadEnv() {
  const dotenv = require('dotenv');
  const p = path.join(process.cwd(), '.env');
  dotenv.config({ path: p });
}

const { computeGalaxyHwid } = require(path.join(__dirname, 'lib', 'galaxyHwid'));
const {
  normalizeKeyArg,
  postLoaderHub,
  loaderEndpointFromEnv,
  hubOrigin,
  DEFAULT_ACTIVATE_SUFFIX,
} = require(path.join(__dirname, 'lib', 'loaderHubActivate'));

function buildActivateSummary(out, hwid) {
  const hubMode = out.mode;
  const body = out.body || {};
  let headline = 'ok';
  let headlineDetail = '';

  if (body.first_activation === true || body.bound === true) {
    headline = 'first_pc';
    headlineDetail = 'First time on this PC — license locked here.';
  } else if (hubMode === 'activate' && body.activated === true) {
    headline = 'no_installer_yet';
    headlineDetail = 'License paired — this hub has no installer file yet.';
  } else if (body.valid === true || (hubMode === 'activate' && body.ok === true)) {
    headline = 'still_ok';
    headlineDetail = 'Still authorized on this PC.';
  } else if (body.ok === true) {
    headline = 'ok';
    headlineDetail = 'OK.';
  }

  const prod =
    typeof body.product_name === 'string' && body.product_name
      ? body.product_name
      : typeof body.product_id === 'string'
        ? body.product_id
        : null;

  const exp = body.license_expires_at ?? body.expires_at;
  const expires = typeof exp === 'string' ? exp : null;

  let hint = null;
  if (
    hubMode === 'activate' &&
    typeof body.download_url !== 'string' &&
    body.activated !== true
  ) {
    hint =
      'Seller has not wired an installer file yet — key pairing still worked.';
  }

  return {
    headline,
    headlineDetail,
    product: prod,
    hwid,
    expires,
    downloaded: out.downloaded || null,
    downloadError:
      typeof body._download_error === 'string' ? body._download_error : null,
    hint,
  };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 440,
    height: 620,
    minWidth: 360,
    minHeight: 520,
    show: false,
    backgroundColor: '#060606',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  return win;
}

app.whenReady().then(() => {
  ensureWorkingDirectory();
  loadEnv();
  ipcMain.handle('clipboardText', () =>
    typeof clipboard.readText === 'function' ? clipboard.readText() : '',
  );

  ipcMain.handle('branding', () => {
    ensureWorkingDirectory();
    loadEnv();
    const titleRaw = process.env.LOADER_GUI_TITLE?.trim();
    return {
      title: titleRaw || 'Galaxy Products',
    };
  });

  ipcMain.handle('hubInfo', () => {
    const ep = loaderEndpointFromEnv();
    return {
      mode: ep.mode,
      activateUrl: ep.url,
      defaultHint: `${hubOrigin()}${DEFAULT_ACTIVATE_SUFFIX}`,
    };
  });

  ipcMain.handle('activate', async (_evt, keyRaw, opts) => {
    try {
      ensureWorkingDirectory();
      loadEnv();

      const key = normalizeKeyArg(String(keyRaw || ''));
      if (!key) {
        return { ok: false, error: 'Enter a valid GP‑XXXX‑XXXX‑XXXX‑XXXX license key.' };
      }

      const hwid = await computeGalaxyHwid();
      const out = await postLoaderHub(key, hwid, {
        skipDownload: !!(opts && opts.skipDownload === true),
      });

      if (!out.ok) {
        const b = out.body || {};
        const msg = typeof b.error === 'string' ? b.error : 'Request failed.';
        return { ok: false, error: msg };
      }

      const body = out.body;
      const hubMode = out.mode;

      const unexpected =
        !(
          body.first_activation === true ||
          body.bound === true ||
          (hubMode === 'activate' && body.activated === true) ||
          body.valid === true ||
          (hubMode === 'activate' && body.ok === true) ||
          body.ok === true
        );

      if (unexpected) {
        return {
          ok: false,
          error: `Unexpected response: ${JSON.stringify(body)}`,
        };
      }

      return {
        ok: true,
        ...buildActivateSummary(out, hwid),
      };
    } catch (e) {
      return {
        ok: false,
        error: e && e.message ? String(e.message) : String(e),
      };
    }
  });

  ipcMain.handle('getHwid', async () => {
    ensureWorkingDirectory();
    loadEnv();
    try {
      const hwid = await computeGalaxyHwid();
      return { ok: true, hwid };
    } catch (e) {
      return {
        ok: false,
        error: e && e.message ? String(e.message) : String(e),
      };
    }
  });

  ipcMain.handle('openPath', async (_evt, fp) => {
    if (!fp || typeof fp !== 'string') return false;
    const err = await shell.openPath(fp);
    return err === '';
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
