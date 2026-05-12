/* Standalone Game updates page (Galaxy hub iframe or direct). Shares localStorage keys with SteamScope app.js. */
(function () {
  const WATCH_GAMES_KEY = 'steamscope.watch_games';
  const UPDATES_LAST_SEEN_KEY = 'steamscope.updates_last_seen';
  const THEME_KEY = 'steamscope.theme';
  const ACCENT_KEY = 'steamscope.accent';
  const HUB_THEME_MSG = 'steamscope-sync-theme';

  const $ = (id) => document.getElementById(id);

  const TOAST_ICONS = {
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  };

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function toast(message, kind = 'info', timeout = 3500) {
    const stack = $('toast-stack');
    if (!stack) return;
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML = `<div class="toast-ic">${TOAST_ICONS[kind] || TOAST_ICONS.info}</div><div class="toast-msg">${escapeHtml(message)}</div>`;
    stack.appendChild(el);
    setTimeout(() => {
      el.classList.add('removing');
      el.addEventListener('animationend', () => el.remove(), { once: true });
    }, timeout);
  }

  function loadWatchGames() {
    try {
      const raw = localStorage.getItem(WATCH_GAMES_KEY);
      if (raw) {
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          return list
            .map((x) => ({
              appid: Number(x?.appid),
              label: typeof x?.label === 'string' ? x.label : undefined,
            }))
            .filter((x) => Number.isFinite(x.appid) && x.appid > 0);
        }
      }
    } catch {
      /* ignore */
    }
    return [{ appid: 252490, label: 'Rust' }];
  }

  function saveWatchGames(list) {
    localStorage.setItem(WATCH_GAMES_KEY, JSON.stringify(list));
  }

  function watchDisplayName(w, g) {
    if (w.label && String(w.label).trim()) return String(w.label).trim();
    if (g?.name) return g.name;
    return `App ${w.appid}`;
  }

  function loadUpdatesLastSeen() {
    try {
      const j = JSON.parse(localStorage.getItem(UPDATES_LAST_SEEN_KEY));
      return j && typeof j === 'object' ? j : {};
    } catch {
      return {};
    }
  }

  function saveUpdatesLastSeen(obj) {
    localStorage.setItem(UPDATES_LAST_SEEN_KEY, JSON.stringify(obj));
  }

  function humanAgeSincePost(tsMs) {
    const sec = Math.max(0, Math.floor((Date.now() - tsMs) / 1000));
    if (sec < 90) return 'just now';
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
    const d = Math.floor(h / 24);
    if (d < 14) return `${d} day${d === 1 ? '' : 's'} ago`;
    const w = Math.floor(d / 7);
    if (w < 9) return `${w} week${w === 1 ? '' : 's'} ago`;
    const mo = Math.max(1, Math.floor(d / 30));
    return `${mo} month${mo === 1 ? '' : 's'} ago`;
  }

  function updatesVerdict(latest, fromCommunity) {
    if (!latest?.date_unix) {
      return {
        cls: 'updates-verdict-none',
        head: 'No update info',
        sub: 'Could not load Steam news for this app. Try Refresh or open SteamDB.',
      };
    }
    const tsMs = latest.date_unix * 1000;
    const age = Date.now() - tsMs;
    const day = 86400000;
    const src = (latest.feedlabel || latest.feedname || 'news').replace(/</g, '');

    if (fromCommunity) {
      if (age < 3 * day) {
        return {
          cls: 'updates-verdict-recent',
          head: 'Yes — very recent developer post',
          sub: `Latest Steam news is a dev announcement (${humanAgeSincePost(tsMs)}). Strong signal of a client-facing patch or major news.`,
        };
      }
      if (age < 14 * day) {
        return {
          cls: 'updates-verdict-week',
          head: 'Developer post in the last ~2 weeks',
          sub: `Newest item is a dev announcement from ${humanAgeSincePost(tsMs)}. SteamDB “Last record update” can still differ slightly.`,
        };
      }
      return {
        cls: 'updates-verdict-stale',
        head: 'No fresh dev post in the last ~2 weeks',
        sub: `Latest dev headline is ${humanAgeSincePost(tsMs)} old. Silent depot fixes won’t always get a post — check SteamDB’s app page.`,
      };
    }

    if (age < 3 * day) {
      return {
        cls: 'updates-verdict-week',
        head: 'Fresh activity on Steam’s news feed',
        sub: `Newest item is “${src}” from ${humanAgeSincePost(tsMs)}. Often tracks coverage right after a build; open SteamDB for the exact catalog timestamp.`,
      };
    }
    if (age < 14 * day) {
      return {
        cls: 'updates-verdict-week',
        head: 'Recent Steam news activity',
        sub: `Newest headline (${src}) · ${humanAgeSincePost(tsMs)}. Compare with SteamDB “Last record update” on the app page.`,
      };
    }
    return {
      cls: 'updates-verdict-stale',
      head: 'Nothing recent in the Steam news feed we pull',
      sub: `Oldest visible item is ${humanAgeSincePost(tsMs)}. Use SteamDB for depot / changelist timing.`,
    };
  }

  async function refreshGameUpdates() {
    const list = loadWatchGames();
    const root = $('updates-list');
    const meta = $('updates-meta');
    if (!root || !meta) return;
    if (!list.length) {
      root.innerHTML = '<p class="muted">Add a Steam app ID above (e.g. 252490 for Rust).</p>';
      meta.textContent = '';
      return;
    }
    root.innerHTML = '<p class="muted">Loading…</p>';
    meta.textContent = '';
    const appids = list.map((x) => x.appid).join(',');
    try {
      const r = await fetch(`/api/game-updates?appids=${encodeURIComponent(appids)}`);
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

      const byId = new Map(data.games.map((g) => [g.appid, g]));
      meta.textContent = data.fetched_at ? `Last checked: ${fmtDateTime(data.fetched_at)}` : '';

      const lastSeen = loadUpdatesLastSeen();
      const nextSeen = { ...lastSeen };

      root.innerHTML = '';
      for (const w of list) {
        const g = byId.get(w.appid);
        if (!g) continue;
        const name = watchDisplayName(w, g);
        if (g.error) {
          const div = document.createElement('div');
          div.className = 'updates-card';
          const steamdbAppErr = escapeHtml(g.steamdb_app_url || `https://steamdb.info/app/${g.appid}/`);
          div.innerHTML = `
          <div class="updates-card-head">
            <strong>${escapeHtml(name)}</strong>
            <span class="muted small">${escapeHtml(String(g.error))}</span>
          </div>
          <div class="updates-card-actions">
            <a href="${steamdbAppErr}" target="_blank" rel="noopener">SteamDB app</a>
            <a href="${escapeHtml(g.steamdb_patchnotes_url)}" target="_blank" rel="noopener">SteamDB patch notes</a>
            <button type="button" class="linkish" data-remove-appid="${g.appid}">Remove</button>
          </div>`;
          root.appendChild(div);
          continue;
        }

        const latest = g.latest;
        const v = updatesVerdict(latest, g.from_community_announcements);
        const when = latest
          ? `${fmtDateTime(latest.date_iso)} · ${humanAgeSincePost(latest.date_unix * 1000)}`
          : 'No news returned';
        const feedPillLabel = latest ? String(latest.feedlabel || latest.feedname || 'News') : '';
        const pill = g.from_community_announcements
          ? '<span class="updates-pill">Newest: developer post</span>'
          : `<span class="updates-pill soft">Newest: ${escapeHtml(feedPillLabel)}</span>`;

        const appKey = String(g.appid);
        const prevUnix = lastSeen[appKey] != null ? Number(lastSeen[appKey]) : null;
        const curUnix = latest?.date_unix != null ? Number(latest.date_unix) : null;
        const showNewBadge =
          prevUnix != null && curUnix != null && Number.isFinite(prevUnix) && curUnix > prevUnix;
        if (curUnix != null && Number.isFinite(curUnix)) {
          nextSeen[appKey] = curUnix;
        }

        const div = document.createElement('div');
        div.className = 'updates-card';
        const newsLine = latest ? escapeHtml(latest.title) : '—';
        const steamLink = latest?.url
          ? `<a href="${escapeHtml(latest.url)}" target="_blank" rel="noopener">Open post</a>`
          : '';
        const newBadge = showNewBadge
          ? '<span class="updates-new-badge" title="Latest post is newer than the last time you opened this tab">New update since you last checked</span>'
          : '';
        const devPost = g.latest_dev_post;
        const devSecondary = devPost
          ? `<p class="news-title updates-dev-secondary"><span class="muted">Dev announcement (older):</span> ${escapeHtml(devPost.title)} · ${escapeHtml(fmtDateTime(devPost.date_iso))}${
              devPost.url
                ? ` · <a href="${escapeHtml(devPost.url)}" target="_blank" rel="noopener">Open</a>`
                : ''
            }</p>`
          : '';
        const steamdbApp = escapeHtml(g.steamdb_app_url || `https://steamdb.info/app/${g.appid}/`);
        div.innerHTML = `
        <div class="updates-verdict ${v.cls}">
          <div class="updates-verdict-head">${escapeHtml(v.head)}</div>
          <div class="updates-verdict-sub">${escapeHtml(v.sub)}</div>
        </div>
        <div class="updates-card-head">
          <strong>${escapeHtml(name)}</strong>
          ${newBadge}
          <span class="when">${escapeHtml(when)}</span>
          ${pill}
        </div>
        <p class="news-title"><span class="muted">Newest on Steam news:</span> ${newsLine}</p>
        ${devSecondary}
        <div class="updates-card-actions">
          ${steamLink}
          <a href="${steamdbApp}" target="_blank" rel="noopener">SteamDB app</a>
          <a href="${escapeHtml(g.steamdb_patchnotes_url)}" target="_blank" rel="noopener">SteamDB patch notes</a>
          <button type="button" class="linkish" data-remove-appid="${g.appid}">Remove</button>
        </div>`;
        root.appendChild(div);
      }

      saveUpdatesLastSeen(nextSeen);
    } catch (err) {
      root.innerHTML = `<p class="muted" style="color:var(--red, #ff6b6b)">${escapeHtml(err.message || 'Failed to load')}</p>`;
    }
  }

  function applyEmbeddedTheme(theme, accent) {
    const m = theme || 'dark';
    const a = accent || 'blue';
    document.documentElement.dataset.theme = m;
    document.documentElement.dataset.accent = a;
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.type !== HUB_THEME_MSG) return;
    const theme = typeof d.theme === 'string' ? d.theme : null;
    const accent = typeof d.accent === 'string' ? d.accent : null;
    if (!theme && !accent) return;
    const m = theme || document.documentElement.dataset.theme || 'dark';
    const a = accent || document.documentElement.dataset.accent || 'blue';
    applyEmbeddedTheme(m, a);
    try {
      if (theme) localStorage.setItem(THEME_KEY, m);
      if (accent) localStorage.setItem(ACCENT_KEY, a);
    } catch {
      /* ignore */
    }
  });

  $('updates-list')?.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove-appid]');
    if (!rm) return;
    const id = parseInt(rm.dataset.removeAppid, 10);
    if (!Number.isFinite(id)) return;
    saveWatchGames(loadWatchGames().filter((g) => Number(g.appid) !== id));
    toast('Removed from updates list', 'info', 1800);
    refreshGameUpdates();
  });

  $('updates-add-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const idRaw = $('updates-appid')?.value?.trim() ?? '';
    const labelRaw = $('updates-label')?.value?.trim() ?? '';
    if (!/^\d+$/.test(idRaw)) {
      toast('Enter a numeric Steam app ID (see store URL ?appid=…)', 'error');
      return;
    }
    const appid = parseInt(idRaw, 10);
    const list = loadWatchGames();
    if (list.some((g) => Number(g.appid) === appid)) {
      toast('That app is already in the list', 'info');
      return;
    }
    list.push({ appid, label: labelRaw || undefined });
    saveWatchGames(list);
    const inp = $('updates-appid');
    const lab = $('updates-label');
    if (inp) inp.value = '';
    if (lab) lab.value = '';
    toast(`Tracking updates for app ${appid}`, 'success');
    refreshGameUpdates();
  });

  $('updates-refresh')?.addEventListener('click', () => refreshGameUpdates());

  void refreshGameUpdates();
})();
