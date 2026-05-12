(function () {
  const keyInput = document.getElementById('gp-key-input');
  const btn = document.getElementById('gp-activate-btn');
  const pill = document.getElementById('gp-hwid-pill');
  const statusEl = document.getElementById('gp-status');
  const pasteBtn = document.getElementById('gp-paste-btn');

  const GP_KEY_RE = /^GP-[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}$/;
  const KEY_MAX_LEN = 52;

  /** Loader cannot call APIs — keep Activate disabled until next reload fixes it */
  let hubConfigBlocked = false;

  /** @returns {Promise<string>} */
  async function sha256Hex(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    const bytes = Array.from(new Uint8Array(buf));
    return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** Browser-only binding (distinct from SMBIOS-backed CLI loader). */
  async function webBindingHwid() {
    let canvasFp = '';
    try {
      const c = document.createElement('canvas');
      const w = 220;
      const h = 40;
      c.width = w;
      c.height = h;
      const cx = c.getContext('2d');
      if (cx) {
        cx.textBaseline = 'top';
        cx.font = '16px monospace';
        cx.fillStyle = '#66c0f4';
        cx.fillRect(0, 0, w, h);
        cx.fillStyle = '#0b0f17';
        cx.fillText('GalaxyProducts', 4, 6);
        canvasFp = cx.getImageData(0, 0, w, h).data.slice(0, 4096).join(',');
      }
    } catch {
      /* ignore */
    }
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const parts = [
      'gp-web-v1',
      navigator.userAgent || '',
      navigator.language || '',
      tz,
      String(screen?.width ?? ''),
      String(screen?.height ?? ''),
      String(screen?.colorDepth ?? ''),
      String(navigator?.hardwareConcurrency ?? ''),
      navigator?.platform || '',
      canvasFp,
    ].join('|');
    return sha256Hex(parts);
  }

  /** Strip quotes/whitespace from copied keys (email snippets, Slack, etc.). */
  function scrubRawKey(raw) {
    let s = String(raw || '').toUpperCase();
    s = s.replace(/\uFEFF/g, '');
    s = s.replace(/\s+/g, '');
    s = s.replace(/[^A-Z0-9-]/g, '').slice(0, KEY_MAX_LEN);
    return s;
  }

  function normalizeKey(raw) {
    const s = scrubRawKey(raw);
    return GP_KEY_RE.test(s) ? s : null;
  }

  function setMsg(tier, text) {
    statusEl.dataset.tier = tier;
    statusEl.textContent = text || '';
  }

  function syncBtn() {
    btn.disabled =
      hubConfigBlocked || !normalizeKey(keyInput.value) || boundHwid == null;
  }

  /** @type {string|null} */
  let boundHwid = null;
  /** @type {'machine'|'web'} */
  let hwidMode = 'web';

  async function bootstrapHwid() {
    pill.hidden = false;
    pill.innerHTML =
      '<strong>Setup…</strong> On <strong>this same PC</strong> as your hub URL we fingerprint the hardware; elsewhere we fingerprint the browser instead.';
    setMsg('muted', 'Talking to seller’s server…');

    let configured = false;

    try {
      const metaRes = await fetch('/api/meta');
      const metaTxt = await metaRes.text();
      let fromSteamwebbotHub = false;
      try {
        const mj = JSON.parse(metaTxt);
        fromSteamwebbotHub =
          mj &&
          (mj.name === 'steamwebbot' ||
            (typeof mj.description === 'string' && mj.description.includes('Steam profile')));
      } catch {
        /* ignore */
      }

      const res = await fetch('/api/loader/config');
      const raw = await res.text();
      if (!res.ok) {
        hubConfigBlocked = true;
        if (
          res.status === 404 &&
          metaRes.ok &&
          fromSteamwebbotHub
        ) {
          setMsg(
            'err',
            'The server on this PC is out of date. Close Node (Ctrl+C in the hub window — or quit stray node.exe in Task Manager), run npm start or start‑server.bat from your steamwebbot folder until you see “Web product loader” in the console, refresh this tab.',
          );
          pill.innerHTML =
            '<strong>Old server running</strong> — restart Galaxy from the steamwebbot folder.';
        } else {
          const portHint =
            typeof location.port === 'string' && location.port
              ? location.port
              : location.protocol === 'https:'
                ? '443'
                : '80';
          setMsg(
            'err',
            `Something replied on port ${portHint}, but it isn’t the Galaxy hub loader. Close other programs using that port, start this project with npm start, hard‑refresh.`,
          );
          pill.innerHTML =
            '<strong>Wrong program on this port</strong> — restart the Galaxy hub only.';
        }
        syncBtn();
        return;
      }
      let cfg;
      try {
        cfg = JSON.parse(raw);
      } catch {
        hubConfigBlocked = true;
        setMsg(
          'err',
          'That address isn’t Galaxy’s backend. Always start the seller’s hub first (usually npm start in their steamwebbot folder — not a VS Code preview).',
        );
        pill.innerHTML =
          '<strong>Not Galaxy</strong> — open the link again after hub is started.';
        syncBtn();
        return;
      }
      if (
        !cfg ||
        typeof cfg.artifact_configured !== 'boolean' ||
        (cfg.bootstrap_configured !== undefined &&
          typeof cfg.bootstrap_configured !== 'boolean')
      ) {
        hubConfigBlocked = true;
        setMsg(
          'err',
          'Server answered with junk. Restart the Galaxy hub tab and reload this page.',
        );
        pill.innerHTML =
          '<strong>Confused reply</strong> — restart hub, refresh.';
        syncBtn();
        return;
      }
      const hasProduct = !!cfg.artifact_configured;
      const hasBootstrap = !!cfg.bootstrap_configured;
      configured = hasProduct || hasBootstrap;
      if (!configured) {
        setMsg(
          'muted',
          'Seller hasn’t set up download files yet — activation can still attach your key.',
        );
      } else if (hasBootstrap && hasProduct) {
        setMsg(
          'muted',
          typeof cfg.web_flow_hint === 'string' && cfg.web_flow_hint
            ? cfg.web_flow_hint
            : 'After your key: you’ll get GalaxyLoader.exe; run it and enter the key again for your product.',
        );
      } else if (hasBootstrap) {
        setMsg(
          'muted',
          typeof cfg.web_flow_hint === 'string' && cfg.web_flow_hint
            ? cfg.web_flow_hint
            : 'You’ll download GalaxyLoader.exe; your product arrives after the seller adds their installer path.',
        );
      } else {
        setMsg(
          'muted',
          `Download link expires about ${Math.floor(Number(cfg.download_ttl_sec) || 900)}s after activation — activate when ready.`,
        );
      }
    } catch {
      hubConfigBlocked = true;
      setMsg(
        'err',
        'Can’t reach Galaxy — is the seller’s hub running? (Their PC: npm start or start‑server.bat, then reopen this browser link. Don’t paste URLs into PowerShell.)',
      );
      pill.innerHTML =
        '<strong>Offline</strong> — seller must turn the hub on, then reload.';
      syncBtn();
      return;
    }

    try {
      const mh = await fetch('/api/loader/machine-hwid');
      if (mh.ok) {
        const j = await mh.json();
        if (j.hwid && typeof j.hwid === 'string') {
          boundHwid = j.hwid;
          hwidMode = 'machine';
          pill.innerHTML =
            '<strong>This PC fingerprint</strong> — matches the seller’s CLI check on the same machine.';
          if (!configured)
            setMsg(
              'muted',
              'Key can attach — seller still owes an installer.',
            );
          syncBtn();
          return;
        }
      }
    } catch {
      /* non-localhost */
    }

    try {
      boundHwid = await webBindingHwid();
      hwidMode = 'web';
      pill.innerHTML =
        '<strong>Browser fingerprint</strong> — best from the same PC/IP as seller; roaming browsers look “different”.';
      if (!configured) {
        setMsg(
          'muted',
          'Key can attach — seller still owes an installer file.',
        );
      } else setMsg('muted', 'Paste GP key → Activate & download.');
    } catch (e) {
      boundHwid = null;
      pill.innerHTML =
        '<strong>Couldn’t read device hints</strong> — try Chrome/Edge.';
      setMsg('err', String(e.message || e));
    }
    syncBtn();
  }

  keyInput.addEventListener('input', () => {
    keyInput.value = scrubRawKey(keyInput.value);
    syncBtn();
  });

  keyInput.addEventListener('paste', (ev) => {
    const txt = ev.clipboardData?.getData('text/plain');
    if (txt == null) return;
    ev.preventDefault();
    keyInput.value = scrubRawKey(txt);
    syncBtn();
  });

  pasteBtn?.addEventListener('click', async () => {
    let t = '';
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        t = scrubRawKey(await navigator.clipboard.readText());
      }
    } catch {
      /* permission */
    }
    keyInput.value = t;
    syncBtn();
    if (!normalizeKey(keyInput.value)) {
      setMsg(
        'muted',
        'Use Ctrl+V in the license field if Paste did not grab your key.',
      );
    }
  });

  keyInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !btn.disabled) btn.click();
  });

  btn.addEventListener('click', async () => {
    const k = normalizeKey(keyInput.value);
    if (!k || !boundHwid) return;
    btn.disabled = true;
    setMsg(
      'muted',
      hwidMode === 'machine' ? 'Linking license to this computer…' : 'Linking license to this browser…',
    );
    try {
      const res = await fetch('/api/loader/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: k, hwid: boundHwid, delivery: 'web' }),
      });
      const doc = await res.json().catch(() => ({}));
      if (res.status === 503 && doc.activated === true) {
        setMsg(
          'ok',
          `Registered (${doc.product_name || 'your product'}). Seller hasn’t wired files yet — ask them.`,
        );
        btn.disabled = false;
        syncBtn();
        return;
      }
      if (!res.ok) {
        const err =
          typeof doc.error === 'string'
            ? doc.error
            : `Request failed (${res.status})`;
        setMsg('err', err);
        btn.disabled = false;
        syncBtn();
        return;
      }
      const name = doc.product_name || 'Product';
      const clientUrl =
        typeof doc.loader_client_url === 'string' ? doc.loader_client_url : null;
      if (clientUrl) {
        setMsg(
          'ok',
          doc.first_activation
            ? `Key locked — starting download of Galaxy Loader for ${name}…`
            : `${name} — downloading Galaxy Loader (run it next for your product)…`,
        );
        window.location.assign(clientUrl);
        return;
      }
      setMsg(
        'ok',
        doc.first_activation ? `First time locked — grabbing ${name}…` : `${name} still good — grabbing file…`,
      );
      const url = typeof doc.download_url === 'string' ? doc.download_url : null;
      if (url) {
        window.location.assign(url);
      } else if (typeof doc.download_token === 'string') {
        window.location.assign(`/api/loader/download?token=${encodeURIComponent(doc.download_token)}`);
      } else {
        setMsg(
          'err',
          'License tied, but download link missing — reload and retry.',
        );
      }
      btn.disabled = false;
      syncBtn();
    } catch (e) {
      setMsg('err', String(e.message || e));
      btn.disabled = false;
      syncBtn();
    }
  });

  bootstrapHwid().then(syncBtn);
})();
