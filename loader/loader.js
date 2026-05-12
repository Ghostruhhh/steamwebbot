#!/usr/bin/env node
/**
 * License loader (file / terminal): reads this PC fingerprint, talks to hub, optionally saves installer.
 *
 * Usage:
 *   npm run loader
 *   node loader/loader.js --show-hwid
 *   GalaxyLoader.exe --clipboard                       (exe in dist: copy key first)
 *
 * Env:
 *   LOADER_HUB_ORIGIN  Full hub base URL, e.g. https://example.com (no trailing slash)
 *   LOADER_HUB_HOST    Host when using PORT (default 127.0.0.1)
 *   PORT               Hub port read from ../.env (default 3000)
 *   LOADER_BIND_URL       Full URL override; /keys/bind → bind-only (no exe download unless you pointed at activate).
 *   LICENSE_BIND_SECRET   Optional; sends X-License-Bind-Secret (remote hub bind).
 *   LOADER_CLI_NO_DOWNLOAD Set to 1 to skip saving the exe after activate.
 *   LOADER_CLI_DOWNLOAD_DIR Folder for installer (default ./downloads next to cwd).
 *   NO_COLOR          Disable ANSI (hub-matched Galaxy palette when colors are on)
 */

const path = require('path');
const readline = require('readline');

/** Packaged exe (via pkg): working directory often System32 — lock to exe folder and load .env there. */
if (typeof process.pkg !== 'undefined') {
  try {
    process.chdir(path.dirname(process.execPath));
  } catch (_) {
    /* keep cwd */
  }
}
const envPath =
  typeof process.pkg !== 'undefined'
    ? path.join(process.cwd(), '.env')
    : path.join(__dirname, '..', '.env');
require('dotenv').config({ path: envPath });

const { computeGalaxyHwid } = require('../lib/galaxyHwid');
const {
  DEFAULT_ACTIVATE_SUFFIX,
  hubOrigin,
  loaderEndpointFromEnv,
  normalizeKeyArg,
  postLoaderHub,
} = require('../lib/loaderHubActivate');

/** Clipboard text (primarily Windows / dist\\GalaxyLoader.exe where console Ctrl+V is clunky). */
function readClipboardRawSync() {
  const fs = require('fs');
  const { spawnSync, execFileSync } = require('child_process');

  try {
    if (process.platform === 'win32') {
      let psExe = path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      );
      if (!fs.existsSync(psExe)) psExe = 'powershell.exe';
      const r = spawnSync(
        psExe,
        ['-NoProfile', '-STA', '-NonInteractive', '-Command', 'Get-Clipboard -Raw'],
        {
          encoding: 'utf8',
          windowsHide: true,
          maxBuffer: 65536,
        },
      );
      if (r.signal || typeof r.stdout !== 'string') return '';
      const out = r.stdout.replace(/^\uFEFF/, '').replace(/\r?\n+$/, '');
      if (!out.trim()) return '';
      return out;
    }
    if (process.platform === 'darwin') {
      return String(
        execFileSync('pbpaste', { encoding: 'utf8', maxBuffer: 65536 }),
      ).replace(/\r?\n+$/, '');
    }
    try {
      return String(
        execFileSync('xclip', ['-selection', 'clipboard', '-o'], {
          encoding: 'utf8',
          maxBuffer: 65536,
        }),
      ).replace(/\r?\n+$/, '');
    } catch (_) {
      return String(
        execFileSync('xsel', ['--clipboard', '--output'], {
          encoding: 'utf8',
          maxBuffer: 65536,
        }),
      ).replace(/\r?\n+$/, '');
    }
  } catch {
    return '';
  }
}

/** Matches hub dark theme (--accent / --purple / --green / --red / --muted). */
function theme() {
  if (process.env.NO_COLOR || process.env.TERM === 'dumb') {
    return {
      reset: '',
      bold: '',
      dim: '',
      line: '',
      acc: '',
      pur: '',
      ok: '',
      err: '',
      mut: '',
    };
  }
  if (process.env.FORCE_COLOR || process.stdout.isTTY || process.stderr.isTTY) {
    return {
      reset: '\x1b[0m',
      bold: '\x1b[1m',
      dim: '\x1b[2m',
      line: '\x1b[38;2;31;39;53m',
      acc: '\x1b[38;2;102;192;244m',
      pur: '\x1b[38;2;180;129;255m',
      ok: '\x1b[38;2;94;226;122m',
      err: '\x1b[38;2;255;107;107m',
      mut: '\x1b[38;2;125;138;155m',
    };
  }
  return {
    reset: '',
    bold: '',
    dim: '',
    line: '',
    acc: '',
    pur: '',
    ok: '',
    err: '',
    mut: '',
  };
}

/** @param {ReturnType<typeof theme>} T */
function bannerLines(T) {
  const edge = `${T.line}╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌${T.reset}`;
  return [
    '',
    edge,
    `  ${T.bold}${T.pur}★${T.reset} ${T.bold}${T.acc}Galaxy Products${T.reset}  ${T.dim}· license loader${T.reset}`,
    edge,
    '',
  ];
}

/** @param {ReturnType<typeof theme>} T */
function printGalaxyBanner(T) {
  process.stderr.write(bannerLines(T).join('\n'));
}

/** @param {ReturnType<typeof theme>} T */
function promptKey(T) {
  process.stderr.write(
    `\n${T.dim}${T.acc}⌨${T.dim} Paste note: Classic Command Prompt (${T.acc}cmd.exe${T.dim}) ignores ${T.acc}Ctrl+V${T.dim} for programs like this.`,
  );
  process.stderr.write(
    `\n${T.dim}    • Easiest:${T.reset} copy your GP key → leave the prompt ${T.acc}empty${T.dim} → ${T.acc}Enter${T.dim} (${T.acc}clipboard${T.dim})`,
  );
  process.stderr.write(
    `\n${T.dim}    • Or:${T.reset} enable ${T.dim}Terminal / PowerShell${T.reset} (${T.acc}Ctrl+Shift+V${T.dim}), or cmd ${T.dim}Quick Edit Mode → ${T.acc}right-click${T.dim} paste`,
  );
  process.stderr.write(
    `\n${T.dim}    • Or:${T.reset} ${T.acc}GalaxyLoader.exe --clipboard${T.dim} / ${T.acc}GalaxyLoader-clipboard.cmd${T.reset}\n\n`,
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const q =
    `${T.mut}${T.dim}>${T.reset} ${T.acc}GP key${T.dim} (blank Enter = clipboard)${T.reset}${T.bold}:${T.reset} `;
  return new Promise((resolve) => {
    rl.question(q, (line) => {
      rl.close();
      const trimmed = typeof line === 'string' ? line.trim() : '';
      const raw = trimmed === '' ? readClipboardRawSync() : line;
      resolve(normalizeKeyArg(raw));
    });
  });
}

/** @param {ReturnType<typeof theme>} T */
function printUsage(T) {
  printGalaxyBanner(T);
  const g = (s) => `${T.dim}${s}${T.reset}`;
  const def = `${hubOrigin()}${DEFAULT_ACTIVATE_SUFFIX}`;
  process.stderr.write(
    [
      `  ${g('npm run loader')}`,
      `  ${T.mut}Hub${T.reset}        ${T.dim}${def}${T.reset} ${g('(pins key + saves installer)')}`,
      `  ${T.mut}LOADER_BIND_URL${T.reset}  ${g('Custom URL — legacy /keys/bind has no auto-download')}`,
      '',
      `  ${T.pur}${T.bold}Flags${T.reset}`,
      `    ${T.acc}--help${T.reset}         Help`,
      `    ${T.acc}--show-hwid${T.reset}   Device hash only`,
      `    ${T.acc}--no-download${T.reset}  Skip saving the .exe`,
      `    ${T.acc}--clipboard${T.reset} Use GP key on clipboard (same as typing nothing + Enter when prompted)`,
      '',
    ].join('\n'),
  );
}

async function main() {
  const T = theme();
  const argv = process.argv.slice(2);
  const clipFlag = argv.includes('--clipboard');
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage(T);
    process.exit(0);
  }

  if (argv.includes('--show-hwid')) {
    try {
      const hwid = await computeGalaxyHwid();
      const piped = !process.stdout.isTTY;
      if (!piped) printGalaxyBanner(T);
      if (piped) {
        process.stdout.write(`${hwid}\n`);
      } else {
        process.stderr.write(
          `${T.dim}Hardware fingerprint (${T.acc}Galaxy HWID${T.dim})${T.reset}\n`,
        );
        process.stdout.write(`${T.bold}${T.acc}${hwid}${T.reset}\n`);
      }
      process.exit(0);
    } catch (e) {
      printGalaxyBanner(T);
      process.stderr.write(`${T.err}✖${T.reset} ${T.err}HWID failed:${T.reset} ${e.message}\n`);
      process.exit(1);
    }
  }

  printGalaxyBanner(T);

  /** @type {string|null} */
  let keyNorm = null;
  for (const a of argv) {
    if (a.startsWith('-')) continue;
    keyNorm = normalizeKeyArg(a);
    if (keyNorm) break;
  }
  if (!keyNorm && clipFlag) {
    process.stderr.write(
      `${T.dim}⋯${T.reset} ${T.dim}Taking license key from clipboard…${T.reset}\n`,
    );
    keyNorm = normalizeKeyArg(readClipboardRawSync());
    if (!keyNorm) {
      process.stderr.write(
        `${T.err}✖${T.reset} Clipboard had no usable GP-… key. Copy the full key, then try again.`,
      );
      if (typeof process.pkg !== 'undefined') {
        process.stderr.write(
          ` ${T.dim}(${T.acc}GalaxyLoader.exe --clipboard${T.dim})${T.reset}\n`,
        );
      } else {
        process.stderr.write('\n');
      }
      process.exit(1);
    }
  }
  if (!keyNorm) {
    keyNorm = await promptKey(T);
  }
  if (!keyNorm) {
    process.stderr.write(`${T.err}✖${T.reset} ${T.mut}Invalid or empty key.${T.reset} `);
    process.stderr.write(`Expected ${T.acc}GP-XXXX-XXXX-XXXX-XXXX${T.reset}.\n`);
    process.exit(1);
  }

  process.stderr.write(
    `${T.acc}⋯${T.reset} ${T.dim}Reading hardware fingerprint…${T.reset}\n`,
  );
  let hwid;
  try {
    hwid = await computeGalaxyHwid();
  } catch (e) {
    process.stderr.write(`${T.err}✖${T.reset} ${T.err}HWID failed:${T.reset} ${e.message}\n`);
    process.exit(1);
  }

  const endpoint = loaderEndpointFromEnv();
  process.stderr.write(
    `${T.pur}⋯${T.reset} ${T.dim}Hub${T.reset} ${T.mut}${endpoint.url}${T.dim} (${endpoint.mode})${T.reset}\n`,
  );

  const out = await postLoaderHub(keyNorm, hwid);
  const hubMode = out.mode;

  if (!out.ok) {
    const b = out.body || {};
    const msg = typeof b.error === 'string' ? b.error : 'Request failed.';
    process.stderr.write(
      `${T.err}✖${T.reset} ${T.err}Failed${T.reset}: ${msg}\n`,
    );
    process.exit(1);
  }

  const body = out.body;
  process.stdout.write('\n');

  if (body.first_activation === true || body.bound === true) {
    process.stdout.write(
      `  ${T.ok}${T.bold}✓ First time on this PC${T.reset} ${T.dim}(license locked here)${T.reset}\n`,
    );
  } else if (hubMode === 'activate' && body.activated === true) {
    process.stdout.write(
      `  ${T.ok}${T.bold}✓ License paired with this PC${T.reset} ${T.dim}(hub has no installer file yet)${T.reset}\n`,
    );
  } else if (body.valid === true || (hubMode === 'activate' && body.ok === true)) {
    process.stdout.write(
      `  ${T.ok}${T.bold}✓ Still authorized${T.reset} ${T.dim}on this PC${T.reset}\n`,
    );
  } else if (body.ok === true) {
    process.stdout.write(`  ${T.ok}${T.bold}✓ OK${T.reset}\n`);
  } else {
    process.stderr.write(`${T.err}Unexpected:${T.reset} ${JSON.stringify(body)}\n`);
    process.exit(1);
  }

  const prod =
    typeof body.product_name === 'string' && body.product_name
      ? body.product_name
      : typeof body.product_id === 'string'
        ? body.product_id
        : '?';
  process.stdout.write(`  ${T.mut}Product${T.reset}       ${T.bold}${prod}${T.reset}\n`);
  process.stdout.write(`  ${T.mut}This PC ID${T.reset} ${T.dim}${hwid}${T.reset}\n`);

  const exp = body.license_expires_at ?? body.expires_at;
  if (typeof exp === 'string') {
    process.stdout.write(`  ${T.mut}Good until${T.reset} ${T.acc}${exp}${T.reset}\n`);
  }

  if (out.downloaded) {
    process.stdout.write(
      `\n  ${T.ok}Installer:${T.reset} ${T.acc}${out.downloaded}${T.reset}\n`,
    );
  } else if (typeof body._download_error === 'string' && body._download_error) {
    process.stderr.write(
      `\n  ${T.err}Download:${T.reset} ${body._download_error}\n`,
    );
  } else if (
    hubMode === 'activate' &&
    typeof body.download_url !== 'string' &&
    body.activated !== true &&
    !(process.argv.includes('--no-download') || process.env.LOADER_CLI_NO_DOWNLOAD === '1')
  ) {
    process.stderr.write(
      `\n  ${T.mut}(Seller has not wired an installer file yet — key pairing still worked.)${T.reset}\n`,
    );
  }

  process.stdout.write('\n');
  process.exit(0);
}

main().catch((e) => {
  const T = theme();
  process.stderr.write(`${T.err}${e.stack || e.message}${T.reset}\n`);
  process.exit(1);
});
