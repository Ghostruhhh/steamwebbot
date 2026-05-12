(() => {
  const I18N = {
    en: {
      placeholder: 'Enter your key',
      activate: 'Activate Key',
      clearSession: 'Clear Session',
      hardwareId: 'Hardware ID',
      skipDl: 'Skip installer download (pair key only)',
      hub: 'Hub',
      openFolder: 'Open installer folder…',
      options: 'Options',
    },
    ru: {
      placeholder: 'Введите ключ',
      activate: 'Активировать ключ',
      clearSession: 'Сбросить сессию',
      hardwareId: 'ID железа',
      skipDl: 'Без установщика (только привязка)',
      hub: 'Хаб',
      openFolder: 'Папка с установщиком…',
      options: 'Параметры',
    },
  };

  const keyInput = document.getElementById('key-in');
  const btnGo = document.getElementById('btn-go');
  const btnHwid = document.getElementById('btn-hwid');
  const chkNodl = document.getElementById('chk-nodl');
  const statusEl = document.getElementById('status');
  const hubMeta = document.getElementById('hub-meta');
  const btnOpen = document.getElementById('btn-open');
  const btnClear = document.getElementById('clear-session');
  const langRu = document.getElementById('lang-ru');
  const langEn = document.getElementById('lang-en');

  const GP_KEY =
    /^GP-[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}$/;

  const KEY_MAX_LEN = 52;
  const LS_LANG = 'galaxy-loader-lang';

  let lang =
    localStorage.getItem(LS_LANG) === 'ru' ? 'ru' : 'en';

  function t(key) {
    return (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;
  }

  function applyI18n() {
    document.documentElement.lang = lang === 'ru' ? 'ru' : 'en';
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const k = el.getAttribute('data-i18n');
      if (k) el.textContent = t(k);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const k = el.getAttribute('data-i18n-placeholder');
      if (k) el.setAttribute('placeholder', t(k));
    });
    langRu.classList.toggle('is-active', lang === 'ru');
    langEn.classList.toggle('is-active', lang === 'en');
  }

  function scrubRawKey(raw) {
    let s = String(raw || '').toUpperCase();
    s = s.replace(/\uFEFF/g, '');
    s = s.replace(/\s+/g, '');
    s = s.replace(/[^A-Z0-9-]/g, '');
    return s.slice(0, KEY_MAX_LEN);
  }

  function applyKeyInput(rawFromClipboardOrPaste) {
    keyInput.value = scrubRawKey(rawFromClipboardOrPaste);
    syncBtn();
  }

  function normalizeKey(raw) {
    const s = String(raw || '')
      .trim()
      .toUpperCase()
      .replace(/\s+/g, '');
    return GP_KEY.test(s) ? s : null;
  }

  function syncBtn() {
    btnGo.disabled = normalizeKey(keyInput.value) === null;
  }

  function api() {
    return window.galaxy;
  }

  async function initBranding() {
    try {
      const b = await api().branding();
      const title =
        b && typeof b.title === 'string' && b.title.trim()
          ? b.title.trim()
          : 'Galaxy Products';
      const el = document.getElementById('brand-title');
      if (el) el.textContent = title;
      document.title = title;
    } catch {
      /* keep defaults */
    }
  }

  async function initHubLabel() {
    try {
      const inf = await api().hubInfo();
      hubMeta.textContent = `(${inf.mode}) ${inf.activateUrl}`;
    } catch {
      hubMeta.textContent =
        lang === 'ru'
          ? 'не удалось загрузить — проверьте .env рядом с приложением'
          : 'could not load — fix steamwebbot .env beside this app';
    }
  }

  function showStatus(ok, lines) {
    const text = lines.filter(Boolean).join('\n');
    statusEl.dataset.tier = ok ? 'ok' : 'err';
    statusEl.textContent = text;
    statusEl.dataset.empty = text ? '0' : '1';
  }

  function clearSession() {
    keyInput.value = '';
    btnOpen.classList.add('hidden');
    delete btnOpen.dataset.path;
    showStatus(true, []);
    syncBtn();
    keyInput.focus();
  }

  btnOpen.addEventListener('click', async () => {
    const fp = btnOpen.dataset.path;
    if (fp) await api().openPath(fp);
  });

  btnClear.addEventListener('click', () => clearSession());

  function setLang(next) {
    lang = next === 'ru' ? 'ru' : 'en';
    localStorage.setItem(LS_LANG, lang);
    applyI18n();
    initHubLabel();
  }

  langRu.addEventListener('click', () => setLang('ru'));
  langEn.addEventListener('click', () => setLang('en'));

  btnGo.addEventListener('click', async () => {
    const key = normalizeKey(keyInput.value);
    if (!key) return;

    btnGo.disabled = true;
    btnHwid.disabled = true;
    btnOpen.classList.add('hidden');
    showStatus(
      true,
      [
        lang === 'ru'
          ? 'Отпечаток и хаб…'
          : 'Reading fingerprint & contacting hub…',
      ],
    );

    try {
      const res = await api().activate(key, { skipDownload: chkNodl.checked });
      if (!res.ok) {
        showStatus(false, [res.error || 'unknown']);
      } else {
        const lines = [
          `✓ ${res.headlineDetail || 'Done.'}`,
          res.product ? `Product: ${res.product}` : null,
          res.hwid ? `This PC: ${res.hwid}` : null,
          res.expires ? `Good until: ${res.expires}` : null,
          res.downloaded ? `Installer saved:\n${res.downloaded}` : null,
          res.downloadError ? `Download issue: ${res.downloadError}` : null,
          res.hint ? res.hint : null,
        ];
        showStatus(true, lines);

        if (res.downloaded) {
          btnOpen.classList.remove('hidden');
          const sep = res.downloaded.replace(/\\/g, '/').lastIndexOf('/');
          const folder =
            sep >= 0 ? res.downloaded.slice(0, sep) : res.downloaded;
          btnOpen.dataset.path = folder;
        }
      }
    } catch (e) {
      showStatus(false, [String(e && e.message ? e.message : e)]);
    } finally {
      btnGo.disabled = normalizeKey(keyInput.value) === null;
      btnHwid.disabled = false;
    }
  });

  btnHwid.addEventListener('click', async () => {
    btnHwid.disabled = true;
    try {
      const r = await api().getHwid();
      if (r.ok)
        await navigator.clipboard.writeText(r.hwid).catch(() => {});
      showStatus(
        r.ok,
        r.ok
          ? [
              lang === 'ru'
                ? 'Отпечаток железа (как CLI):'
                : 'Hardware fingerprint (matches CLI `npm run loader -- --show-hwid`):',
              r.hwid,
              '',
              lang === 'ru'
                ? 'Скопировано в буфер, если разрешено.'
                : 'Copied to clipboard when possible.',
            ]
          : ['HWID failed:', r.error || 'unknown'],
      );
    } catch (e) {
      showStatus(false, [String(e && e.message ? e.message : e)]);
    } finally {
      btnHwid.disabled = false;
    }
  });

  keyInput.addEventListener('input', () => {
    keyInput.value = scrubRawKey(keyInput.value);
    syncBtn();
  });

  keyInput.addEventListener('paste', (e) => {
    const txt = e.clipboardData && e.clipboardData.getData('text/plain');
    if (txt == null) return;
    e.preventDefault();
    applyKeyInput(txt);
  });

  applyI18n();
  initBranding();
  initHubLabel();
  syncBtn();
})();
