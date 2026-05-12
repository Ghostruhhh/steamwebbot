/**
 * Shared hub POST + optional installer fetch (CLI + packaged GUI).
 * Depends on global fetch / process.env — does not configure dotenv.
 */

const path = require('path');
const fs = require('fs');

const DEFAULT_ACTIVATE_SUFFIX = '/api/loader/activate';
const LEGACY_BIND_URL_ENV = () => process.env.LOADER_BIND_URL?.trim();

function hubOrigin() {
  let o =
    typeof process.env.LOADER_HUB_ORIGIN === 'string'
      ? process.env.LOADER_HUB_ORIGIN.trim().replace(/\/$/, '')
      : '';
  if (o) return o;

  const p = Number(process.env.PORT);
  const port = Number.isFinite(p) && p > 0 && p <= 65535 ? p : 3000;
  const host =
    typeof process.env.LOADER_HUB_HOST === 'string' && process.env.LOADER_HUB_HOST.trim()
      ? process.env.LOADER_HUB_HOST.trim()
      : '127.0.0.1';
  return `http://${host}:${port}`;
}

/** @returns {{ url: string; mode: 'activate'|'bind' }} */
function loaderEndpointFromEnv() {
  const legacy = LEGACY_BIND_URL_ENV();
  if (legacy)
    return { url: legacy, mode: legacy.includes('/activate') ? 'activate' : 'bind' };
  return { url: `${hubOrigin()}${DEFAULT_ACTIVATE_SUFFIX}`, mode: 'activate' };
}

function bindUrlFromEnv() {
  return loaderEndpointFromEnv().url;
}

function normalizeKeyArg(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.toUpperCase().replace(/\uFEFF/g, '');
  s = s.replace(/\s+/g, '').replace(/[^A-Z0-9-]/g, '');
  const re = /^GP-[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}$/;
  return re.test(s) ? s : null;
}

/** @typedef {{ argv?: readonly string[]; skipDownload?: boolean }} PostOpts */

/** @typedef {{ ok: boolean; body: Record<string, unknown>; downloaded?: string|null; mode: 'activate'|'bind' }} PostResult */

/**
 * @param {string} keyNorm
 * @param {string} hwid
 * @param {PostOpts} [runtime]
 * @returns {Promise<PostResult>}
 */
async function postLoaderHub(keyNorm, hwid, runtime = {}) {
  const argvForSkip = runtime.argv ?? process.argv;
  const { url: target, mode } = loaderEndpointFromEnv();
  const secret = process.env.LICENSE_BIND_SECRET?.trim();
  /** @type {Record<string,string>} */
  const headers = { 'Content-Type': 'application/json' };
  if (secret && secret.length >= 8) {
    headers['X-License-Bind-Secret'] = secret;
  }

  const skipDlDefault =
    process.env.LOADER_CLI_NO_DOWNLOAD === '1' || argvForSkip.includes('--no-download');
  const skipDl = runtime.skipDownload === true || skipDlDefault;

  const res = await fetch(target, {
    method: 'POST',
    headers,
    body: JSON.stringify({ key: keyNorm, hwid }),
  });

  let body = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }

  if (!res.ok) {
    const softOk =
      mode === 'activate' && res.status === 503 && body.activated === true;
    return {
      ok: softOk,
      body,
      downloaded: null,
      mode,
    };
  }

  if (mode === 'bind') {
    const good =
      body.ok === true || body.bound === true || body.valid === true;
    return {
      ok: !!good,
      body,
      downloaded: null,
      mode,
    };
  }

  const origin = hubOrigin();
  let saved = null;
  const dlRaw =
    typeof body.download_url === 'string' ? body.download_url.trim() : '';
  if (!skipDl && dlRaw) {
    const absDl = /^https?:\/\//i.test(dlRaw) ? dlRaw : new URL(dlRaw, origin).href;
    try {
      saved = await downloadInstallerToDisk(absDl, body);
    } catch (e) {
      body._download_error = e?.message ? String(e.message) : String(e);
    }
  }
  return {
    ok: true,
    body,
    downloaded: saved,
    mode,
  };
}

/**
 * @param {string} absUrl
 * @param {Record<string, unknown>} body
 */
async function downloadInstallerToDisk(absUrl, body) {
  const dirRaw = process.env.LOADER_CLI_DOWNLOAD_DIR?.trim();
  const baseDir =
    dirRaw !== undefined && dirRaw !== ''
      ? dirRaw
      : path.join(process.cwd(), 'downloads');

  let prefix = '';
  if (typeof body.product_name === 'string' && body.product_name) {
    const safe = body.product_name.replace(/[^\w.\-]+/g, '_').slice(0, 80);
    if (safe) prefix = `${safe}-installer`;
  }

  const res = await fetch(absUrl);
  if (!res.ok) {
    throw new Error(`Download failed (${res.status})`);
  }
  let baseName = `${prefix || 'GalaxyInstaller'}.exe`;
  const cd = res.headers.get('content-disposition');
  const m = cd && /filename\*?=(?:UTF-8''|")?([^\";]+)/i.exec(cd);
  if (m && m[1]) {
    try {
      baseName = decodeURIComponent(m[1].trim());
    } catch {
      baseName = m[1].trim();
    }
  }
  const fp = path.join(
    baseDir,
    path.basename(baseName) || `${prefix || 'GalaxyInstaller'}.exe`,
  );
  await fs.promises.mkdir(path.dirname(fp), { recursive: true });
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.promises.writeFile(fp, buf);
  return fp;
}

module.exports = {
  DEFAULT_ACTIVATE_SUFFIX,
  hubOrigin,
  loaderEndpointFromEnv,
  bindUrlFromEnv,
  normalizeKeyArg,
  postLoaderHub,
};
