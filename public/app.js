/* SteamScope client */
const $ = (id) => document.getElementById(id);

const form = $('search-form');
const input = $('q');
const button = form.querySelector('button[type="submit"]');
const resultEl = $('result');
const emptyEl = $('empty-state');
const nav = $('nav');
const toastStack = $('toast-stack');
const recentRow = $('recent-row');
const recentChips = $('recent-chips');

const PERSONA_STATES = {
  0: { label: 'Offline', cls: 'offline' },
  1: { label: 'Online', cls: 'online' },
  2: { label: 'Busy', cls: 'online' },
  3: { label: 'Away', cls: 'online' },
  4: { label: 'Snoozing', cls: 'online' },
  5: { label: 'Looking to trade', cls: 'online' },
  6: { label: 'Looking to play', cls: 'online' },
};

const RECENTS_KEY = 'steamscope.recents';
const HISTORY_KEY = 'steamscope.history';
const SNAPSHOTS_KEY = 'steamscope.snapshots';
const ME_KEY = 'steamscope.me';
const BM_MANUAL_KEY = 'steamscope.bm_manual_player';
const THEME_KEY = 'steamscope.theme';
const ACCENT_KEY = 'steamscope.accent';
/** Tracked games for the Game updates tab: [{ appid, label? }] */
const WATCH_GAMES_KEY = 'steamscope.watch_games';
/** Per-app Unix time of the latest dev/news post we showed last visit (for “new update” badge). */
const UPDATES_LAST_SEEN_KEY = 'steamscope.updates_last_seen';
/** Parent Galaxy hub listens for appearance updates while this app runs in an iframe. */
const HUB_THEME_MSG = 'steamscope-sync-theme';
const MAX_RECENTS = 6;
const MAX_HISTORY = 30;

let lastGames = [];
let lastData = null;
let lastQuery = null;
let currentSort = 'hours';
let myProfile = null;

/* ============ Toasts ============ */
const TOAST_ICONS = {
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
};

function toast(message, kind = 'info', timeout = 3500) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `<div class="toast-ic">${TOAST_ICONS[kind] || TOAST_ICONS.info}</div><div class="toast-msg">${escapeHtml(message)}</div>`;
  toastStack.appendChild(el);
  setTimeout(() => {
    el.classList.add('removing');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, timeout);
}

/* ============ Formatting helpers ============ */
function fmtNumber(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString();
}

function fmtHours(h) {
  if (h == null) return '—';
  if (h === 0) return 'Never';
  const minutes = h * 60;
  if (minutes < 1) return '<1 min';
  if (h < 1) return `${Math.round(minutes)} min`;
  if (h >= 10000) return `${(h / 1000).toFixed(1)}k h`;
  if (h < 10) return `${h.toFixed(1)} h`;
  return `${Math.round(h).toLocaleString()} h`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Locale date + time for update timestamps */
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtAccountAge(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const years = (now - d) / (1000 * 60 * 60 * 24 * 365.25);
  if (years < 1) {
    const months = Math.floor(years * 12);
    return `${months}mo`;
  }
  return `${years.toFixed(1)}y`;
}

function countryFlag(code) {
  if (!code || code.length !== 2) return '';
  const A = 0x1f1e6;
  return String.fromCodePoint(A + code.toUpperCase().charCodeAt(0) - 65)
       + String.fromCodePoint(A + code.toUpperCase().charCodeAt(1) - 65);
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ============ Animated counter ============ */
function animateCount(el, target, opts = {}) {
  const { duration = 900, decimals = 0, suffix = '', prefix = '' } = opts;
  if (target == null || isNaN(target)) {
    el.textContent = '—';
    return;
  }
  const startVal = 0;
  const startTime = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  function step(now) {
    const t = Math.min(1, (now - startTime) / duration);
    const v = startVal + (target - startVal) * ease(t);
    el.textContent = prefix + v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix;
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = prefix + target.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix;
  }
  requestAnimationFrame(step);
}

/* ============ Recent searches ============ */
function loadRecents() {
  try { return JSON.parse(localStorage.getItem(RECENTS_KEY)) || []; }
  catch { return []; }
}

function saveRecents(list) {
  localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, MAX_RECENTS)));
}

function pushRecent(entry) {
  const list = loadRecents().filter(r => r.q !== entry.q);
  list.unshift(entry);
  saveRecents(list);
  renderRecents();
}

function renderRecents() {
  const list = loadRecents();
  if (list.length === 0) {
    recentRow.classList.add('hidden');
    return;
  }
  recentRow.classList.remove('hidden');
  recentChips.innerHTML = '';
  for (const r of list) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.dataset.q = r.q;
    btn.title = r.q;
    btn.textContent = r.label || r.q;
    recentChips.appendChild(btn);
  }
}

function loadBmManualId() {
  try {
    const digits = String(localStorage.getItem(BM_MANUAL_KEY) ?? '').replace(/\D/g, '');
    return /^\d+$/.test(digits) ? digits : '';
  } catch {
    return '';
  }
}

/** Appends manual BM profile id when set in Settings (server uses `bm_player`). */
function bmQuerySuffix() {
  const id = loadBmManualId();
  return id ? `&bm_player=${encodeURIComponent(id)}` : '';
}

function initBmManualPlayerUi() {
  const inp = $('bm-player-input');
  const form = $('bm-player-form');
  const clearBtn = $('bm-player-clear');
  if (inp) inp.value = loadBmManualId();

  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = inp?.value.trim().replace(/\D/g, '') ?? '';
    if (!raw) {
      toast('Enter a Battlemetrics profile id (digits from the players URL on battlemetrics.com)', 'error');
      return;
    }
    localStorage.setItem(BM_MANUAL_KEY, raw);
    if (inp) inp.value = raw;
    toast('Saved BM profile id', 'success');
    if (lastQuery) lookup(lastQuery, { skipPushState: true, silent: true });
  });

  clearBtn?.addEventListener('click', () => {
    localStorage.removeItem(BM_MANUAL_KEY);
    if (inp) inp.value = '';
    toast('Cleared BM id', 'info', 2500);
    if (lastQuery) lookup(lastQuery, { skipPushState: true, silent: true });
  });
}

/* ============ Lookup ============ */
async function lookup(q, opts = {}) {
  const { skipPushState = false, silent = false } = opts;
  resultEl.classList.add('hidden');
  emptyEl.classList.add('hidden');
  button.disabled = true;
  button.querySelector('span').textContent = 'Looking up…';
  if (!silent) toast('Fetching profile…', 'info', 1500);

  try {
    const res = await fetch(`/api/lookup?q=${encodeURIComponent(q)}${bmQuerySuffix()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    lastData = data;
    lastQuery = q;
    render(data);
    pushRecent({ q, label: data.profile?.persona_name || q });
    pushHistory(data, q);
    showSnapshotDiff(data);
    fetchProfileExtras(data.steamid).catch(() => {});
    if (!skipPushState) {
      const url = new URL(window.location.href);
      url.searchParams.set('q', q);
      history.pushState({ q }, '', url.toString());
    }
    if (!silent) toast(`Loaded ${data.profile?.persona_name || 'profile'}`, 'success');
    $('save-snapshot').disabled = false;
    setTimeout(() => {
      resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  } catch (e) {
    emptyEl.classList.remove('hidden');
    toast(e.message || 'Lookup failed', 'error', 5000);
  } finally {
    button.disabled = false;
    button.querySelector('span').textContent = 'Look up';
  }
}

async function fetchProfileExtras(steamid) {
  try {
    const res = await fetch(`/api/profile-extras?steamid=${steamid}`);
    if (!res.ok) return;
    const x = await res.json();
    if (x.profile_background) {
      const bg = $('banner-bg');
      bg.style.backgroundImage = `url("${x.profile_background}")`;
      bg.style.filter = 'blur(0) saturate(110%)';
      bg.style.opacity = '0.6';
    }
  } catch {}
}

/* ============ Render ============ */
function render(d) {
  resultEl.classList.remove('hidden');
  emptyEl.classList.add('hidden');

  const p = d.profile;
  const isPrivate = p && p.visibility !== 3;

  /* Profile banner */
  $('avatar').src = p?.avatar || '';
  $('avatar').alt = p?.persona_name || 'Avatar';
  if (p?.avatar) {
    $('banner-bg').style.backgroundImage = `url("${p.avatar}")`;
  } else {
    $('banner-bg').style.backgroundImage = '';
  }
  $('persona-name').textContent = p?.persona_name || '(unknown)';
  $('real-name').textContent = p?.real_name || '';
  $('profile-link').href = d.profile_url;
  $('steamid-display').textContent = d.steamid;

  /* Status pill + dot */
  const pill = $('status-pill');
  const dot = $('status-dot');
  pill.className = 'pill';
  dot.className = 'status-dot';

  if (isPrivate) {
    pill.textContent = 'Private profile';
    pill.classList.add('private');
    dot.classList.add('private');
  } else if (p?.currently_playing) {
    pill.innerHTML = `<span style="width:6px;height:6px;border-radius:50%;background:currentColor;"></span> In game · ${escapeHtml(p.currently_playing)}`;
    pill.classList.add('in-game');
    dot.classList.add('in-game');
  } else if (p) {
    const ps = PERSONA_STATES[p.persona_state] || { label: 'Unknown', cls: 'offline' };
    pill.innerHTML = `<span style="width:6px;height:6px;border-radius:50%;background:currentColor;"></span> ${ps.label}`;
    pill.classList.add(ps.cls);
    dot.classList.add(ps.cls);
  } else {
    pill.textContent = 'No profile data';
    pill.classList.add('offline');
    dot.classList.add('offline');
  }

  const playing = $('playing-now');
  if (p?.currently_playing) {
    playing.textContent = `▶ Currently playing ${p.currently_playing}`;
    playing.classList.remove('hidden');
  } else {
    playing.classList.add('hidden');
  }

  /* Stats with animated counters */
  if (d.level.level != null) animateCount($('stat-level'), d.level.level);
  else $('stat-level').textContent = '—';

  const xpEl = $('stat-xp');
  const xpProg = $('xp-progress');
  if (d.level.xp != null) {
    animateCount(xpEl, d.level.xp);
    const cur = d.level.xp_current_level ?? 0;
    const need = d.level.xp_to_next ?? 0;
    if (need > 0) {
      const into = d.level.xp - cur;
      const pct = Math.max(0, Math.min(100, (into / (need + into)) * 100));
      xpProg.classList.remove('hidden');
      requestAnimationFrame(() => {
        xpProg.querySelector('span').style.width = pct + '%';
      });
    } else {
      xpProg.classList.add('hidden');
    }
  } else {
    xpEl.textContent = '—';
    xpProg.classList.add('hidden');
  }

  if (d.totals.games_owned > 0) {
    animateCount($('stat-games'), d.totals.games_owned);
  } else {
    $('stat-games').textContent = isPrivate ? 'Private' : '0';
  }

  if (d.totals.total_hours > 0) {
    animateCount($('stat-hours'), d.totals.total_hours, { decimals: 0, suffix: ' h' });
  } else {
    $('stat-hours').textContent = isPrivate ? 'Private' : '—';
  }

  if (d.friends.private) $('stat-friends').textContent = 'Private';
  else if (d.friends.count != null) animateCount($('stat-friends'), d.friends.count);
  else $('stat-friends').textContent = '—';

  $('stat-created').textContent = p?.account_created ? `${fmtAccountAge(p.account_created)} (${fmtDate(p.account_created)})` : '—';

  const flag = countryFlag(p?.country);
  $('stat-country').textContent = p?.country ? `${flag ? flag + ' ' : ''}${p.country}` : '—';

  /* Bans summary */
  const banStat = $('ban-stat');
  const banVal = $('stat-bans');
  banStat.classList.remove('bad');
  if (!d.bans) {
    banVal.textContent = '—';
  } else {
    const parts = [];
    if (d.bans.vac_banned) parts.push(`${d.bans.vac_bans} VAC`);
    if (d.bans.game_bans > 0) parts.push(`${d.bans.game_bans} game`);
    if (d.bans.community_banned) parts.push('Community');
    if (d.bans.economy_ban && d.bans.economy_ban !== 'none') parts.push(`Trade: ${d.bans.economy_ban}`);
    if (parts.length === 0) {
      banVal.textContent = 'Clean';
    } else {
      banVal.textContent = parts.join(', ');
      banStat.classList.add('bad');
    }
  }

  /* Rust: Steam vs Battlemetrics */
  renderRustAggregate(d);

  /* Podium - top 3 played games */
  renderPodium(d.games);

  /* Recent games tab */
  const recentList = $('recent-list');
  recentList.innerHTML = '';
  if (!d.recent || d.recent.length === 0) {
    recentList.innerHTML = `<div class="muted" style="padding:20px;text-align:center;grid-column:1/-1;">No recent activity${isPrivate ? ' (or private)' : ' in the last 2 weeks'}.</div>`;
  } else {
    for (const g of d.recent) {
      recentList.appendChild(makeGameCard(g, true));
    }
  }
  $('recent-count').textContent = d.recent?.length || 0;

  /* Library tab */
  lastGames = d.games || [];
  $('games-count').textContent = lastGames.length;
  currentSort = 'hours';
  document.querySelectorAll('.sort-opt').forEach(b => b.classList.toggle('active', b.dataset.sort === 'hours'));
  $('game-filter').value = '';
  renderGames();

  /* Bans detail tab */
  renderBansDetail(d);

  /* Raw JSON */
  $('raw-json').textContent = JSON.stringify(d, null, 2);

  /* Compare-to-me deltas */
  renderDeltas(d);
}

function renderRustAggregate(d) {
  const wrap = $('rust-panel');
  const steamLn = $('rust-steam-line');
  const bmLn = $('rust-bm-line');
  const srvBlock = $('rust-bm-servers');
  const foot = $('rust-panel-footnote');

  steamLn.innerHTML = '';
  bmLn.innerHTML = '';
  srvBlock.innerHTML = '';
  foot.textContent = '';

  const agg = d.rust_aggregate;
  if (!wrap || !agg) {
    wrap?.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');

  if (agg.steam_rust_hours_unavailable) {
    steamLn.innerHTML = `
      <div class="rust-row">
        <div class="label">Steam Rust</div>
        <div class="value-muted">${escapeHtml(agg.steam_rust_hours_unavailable_hint || 'Hidden')}</div>
      </div>`;
  } else if (agg.owns_on_steam) {
    steamLn.innerHTML = `
      <div class="rust-row">
        <div class="label">Steam Rust</div>
        <div class="value">${fmtHours(agg.steam_hours)}</div>
      </div>`;
  } else {
    steamLn.innerHTML = `
      <div class="rust-row">
        <div class="label">Steam Rust</div>
        <div class="value-muted">Rust not listed in publicly visible owned games.</div>
      </div>`;
  }

  const bm = agg.battlemetrics || {};

  if (!bm.configured) {
    bmLn.innerHTML = `
      <div class="rust-row">
        <div class="label">Battlemetrics</div>
        <div class="value-muted">Set <span class="mono">BATTLEMETRICS_TOKEN</span> in <span class="mono">.env</span>, restart the server.</div>
      </div>`;
  } else if (bm.error) {
    const msg = escapeHtml(String(bm.error).slice(0, 420));
    bmLn.innerHTML = `
      <div class="rust-row rust-row-err">
        <div class="label">Battlemetrics</div>
        <div class="value-muted">${msg}</div>
      </div>`;
  } else if (bm.found === false) {
    const hint = bm.identifier_private
      ? 'This Steam ID is flagged as private on BM (no search results).'
      : 'Battlemetrics hasn’t paired this Steam account with a BM player profile.';
    bmLn.innerHTML = `
      <div class="rust-row">
        <div class="label">Battlemetrics</div>
        <div class="value-muted">${escapeHtml(hint)}</div>
      </div>`;
    if (bm.explain) {
      bmLn.innerHTML += `<p class="muted rust-explain" style="margin-top:10px;line-height:1.5;font-size:13px">${escapeHtml(bm.explain)}</p>`;
    }
    const bmActs = [];
    if (bm.pairing_help_url) {
      bmActs.push(`<a class="btn btn-ghost" href="${escapeAttr(bm.pairing_help_url)}" target="_blank" rel="noopener">Why pairing fails (BM docs)</a>`);
    }
    if (bm.bm_profile_search_url) {
      bmActs.push(`<a class="btn btn-ghost" href="${escapeAttr(bm.bm_profile_search_url)}" target="_blank" rel="noopener">Search on Battlemetrics</a>`);
    }
    if (bmActs.length) {
      bmLn.innerHTML += `<div class="rust-bm-actions">${bmActs.join('')}</div>`;
    }
  } else {
    const nServers = bm.rust_server_count_with_time_on_bm ?? 0;
    const totalHours = bm.tracked_hours_total;
    bmLn.innerHTML = `
      <div class="rust-row">
        <div class="label">Tracked Rust servers</div>
        <div class="value">${totalHours != null ? fmtHours(Number(totalHours)) : '—'} <span class="muted mono" style="font-size:12px;font-weight:500">${nServers}&nbsp;srv sampled</span></div>
      </div>`;
    if (bm.bm_profile_url) {
      bmLn.innerHTML += `
      <div class="rust-bm-actions">
        <a class="btn btn-ghost" href="${escapeAttr(bm.bm_profile_url)}" target="_blank" rel="noopener">Open Battlemetrics profile</a>
      </div>`;
    }
    if (bm.paired_via === 'manual') {
      bmLn.innerHTML += `<p class="muted" style="margin-top:10px;font-size:13px">Linked using your saved BM profile ID (Settings).</p>`;
    }

    const tops = bm.top_rust_servers || [];
    if (tops.length) {
      const rows = tops.map((r) => {
        const id = encodeURIComponent(String(r.server_id || '').replace(/\D/g, ''));
        return `
        <a class="rust-srv-row" href="https://www.battlemetrics.com/servers/rust/${id}" target="_blank" rel="noopener">
          <span class="srv-name" title="${escapeAttr(r.name || '')}">${escapeHtml(r.name || 'Server')}</span>
          <span class="srv-hours">${fmtHours(Number(r.hours || 0))}</span>
        </a>`;
      }).join('');
      srvBlock.innerHTML = `
        <div class="rust-srv-caption">Most sampled time on BM-indexed Rust servers</div>
        <div class="rust-srv-list">${rows}</div>`;
    }
  }

  const caveats = [];
  if (bm.caveat) caveats.push(bm.caveat);
  if (bm.bm_server_refs_likely_capped_at_100) {
    caveats.push('Battlemetrics returns at most ~100 server relationships per profile, so totals can omit long-tail playtime.');
  }
  foot.textContent = caveats.join(' ');
}

function escapeAttr(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

/* ============ Podium ============ */
function renderPodium(games) {
  const podium = $('podium');
  const panel = $('podium-panel');
  const top = (games || []).filter(g => g.hours > 0).slice(0, 3);
  if (top.length === 0) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  podium.innerHTML = '';
  const tiers = ['gold', 'silver', 'bronze'];
  const medals = ['1', '2', '3'];
  top.forEach((g, i) => {
    const a = document.createElement('div');
    a.className = `podium-card ${tiers[i]}`;
    a.dataset.appid = g.appid;
    a.dataset.gameInfo = JSON.stringify({
      name: g.name,
      header: g.header,
      hours: g.hours,
      last_played: g.last_played || null,
    });
    a.style.cursor = 'pointer';
    const metaParts = [];
    if (g.hours_2weeks > 0) metaParts.push(`+${fmtHours(g.hours_2weeks)} past 2w`);
    if (g.last_played) metaParts.push(`last played ${fmtDate(g.last_played)}`);
    a.innerHTML = `
      <span class="medal">${medals[i]}</span>
      <img class="header-img" src="${g.header}" alt="" loading="lazy" onerror="this.style.display='none'" />
      <div class="pc-body">
        <div class="pc-name">${escapeHtml(g.name || '(unknown)')}</div>
        <div class="pc-hours">${fmtHours(g.hours)}</div>
        <div class="pc-meta">${metaParts.join(' · ') || '\u00A0'}</div>
      </div>
    `;
    podium.appendChild(a);
  });
}

/* ============ Game card ============ */
function makeGameCard(g, showRecent) {
  const a = document.createElement('div');
  a.className = 'game-card';
  a.dataset.appid = g.appid;
  a.dataset.gameInfo = JSON.stringify({
    name: g.name,
    header: g.header,
    hours: g.hours_total ?? g.hours ?? 0,
    last_played: g.last_played || null,
  });
  a.style.cursor = 'pointer';
  const totalHours = g.hours_total ?? g.hours;
  const meta = showRecent
    ? `<span class="accent">${fmtHours(g.hours_2weeks)}</span> past 2w${totalHours > 0 ? ` · ${fmtHours(totalHours)} total` : ''}`
    : `<span class="accent">${fmtHours(g.hours)}</span>${g.hours_2weeks > 0 ? ` · +${fmtHours(g.hours_2weeks)} 2w` : ''}`;
  a.innerHTML = `
    <img class="header-img" src="${g.header}" alt="" loading="lazy" onerror="this.style.display='none'" />
    <div class="body">
      <div class="name">${escapeHtml(g.name || '(unknown)')}</div>
      <div class="meta">${meta}</div>
    </div>
  `;
  return a;
}

/* ============ Library list ============ */
function renderGames() {
  const container = $('games-list');
  const summary = $('library-summary');
  container.innerHTML = '';
  const filter = $('game-filter').value.trim().toLowerCase();
  const playedOnly = $('played-only').checked;
  let list = lastGames.slice();
  const total = list.length;
  const playedTotal = list.filter(g => g.hours > 0).length;

  if (playedOnly) list = list.filter(g => g.hours > 0);
  if (filter) list = list.filter(g => g.name && g.name.toLowerCase().includes(filter));

  if (currentSort === 'name') {
    list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  } else if (currentSort === 'recent') {
    list.sort((a, b) => {
      const ta = a.last_played ? new Date(a.last_played).getTime() : 0;
      const tb = b.last_played ? new Date(b.last_played).getTime() : 0;
      return tb - ta;
    });
  } else {
    list.sort((a, b) => b.hours - a.hours);
  }

  if (total > 0) {
    const shown = list.length;
    summary.innerHTML = `Showing <span class="accent">${fmtNumber(shown)}</span> of ${fmtNumber(total)} games · <span class="accent">${fmtNumber(playedTotal)}</span> played, ${fmtNumber(total - playedTotal)} unplayed`;
  } else {
    summary.textContent = '';
  }

  if (list.length === 0) {
    const isPrivate = lastData?.profile && lastData.profile.visibility !== 3;
    let msg;
    if (isPrivate && total === 0) msg = 'Library is private — owner has hidden their games.';
    else if (filter) msg = `No games match "${escapeHtml(filter)}".`;
    else if (playedOnly && playedTotal === 0) msg = 'No games have been played yet. Uncheck "Played only" to see the full library.';
    else msg = 'No games to show.';
    container.innerHTML = `<div class="muted" style="padding:20px;text-align:center;">${msg}</div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  for (const g of list) {
    const row = document.createElement('div');
    row.className = 'game-row' + (g.hours === 0 ? ' unplayed' : '');
    row.dataset.appid = g.appid;
    row.dataset.gameInfo = JSON.stringify({
      name: g.name,
      header: g.header,
      hours: g.hours,
      last_played: g.last_played || null,
    });
    row.style.cursor = 'pointer';
    const hoursHtml = g.hours === 0
      ? `<span class="muted">Never played</span>`
      : `${fmtHours(g.hours)}${g.hours_2weeks > 0 ? ` <small>+${fmtHours(g.hours_2weeks)} 2w</small>` : ''}`;
    row.innerHTML = `
      <img class="icon" src="${g.icon || ''}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />
      <div class="name">${escapeHtml(g.name || '(unknown)')}</div>
      <div class="hours">${hoursHtml}</div>
    `;
    frag.appendChild(row);
  }
  container.appendChild(frag);
}

/* ============ Bans detail ============ */
function renderBansDetail(d) {
  const root = $('bans-detail');
  root.innerHTML = '';
  if (!d.bans) {
    root.innerHTML = '<div class="muted" style="padding:20px;text-align:center;">No ban data available.</div>';
    return;
  }
  const rows = [
    {
      title: 'VAC Ban',
      desc: 'Detected by Valve Anti-Cheat',
      bad: d.bans.vac_banned,
      status: d.bans.vac_banned ? `${d.bans.vac_bans} ban${d.bans.vac_bans === 1 ? '' : 's'}` : 'Clean',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-12V5l-8-3-8 3v5c0 8 8 12 8 12z"/></svg>',
    },
    {
      title: 'Game Bans',
      desc: 'Bans issued by individual game devs',
      bad: d.bans.game_bans > 0,
      status: d.bans.game_bans > 0 ? `${d.bans.game_bans}` : 'None',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>',
    },
    {
      title: 'Community Ban',
      desc: 'Banned from Steam Community features',
      bad: d.bans.community_banned,
      status: d.bans.community_banned ? 'Banned' : 'Clean',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>',
    },
    {
      title: 'Trade / Economy',
      desc: 'Restrictions on trading and market',
      bad: d.bans.economy_ban && d.bans.economy_ban !== 'none',
      status: d.bans.economy_ban && d.bans.economy_ban !== 'none' ? d.bans.economy_ban : 'None',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
    },
  ];
  if (d.bans.days_since_last_ban > 0) {
    rows.push({
      title: 'Days Since Last Ban',
      desc: 'How long ago the most recent ban was issued',
      bad: false,
      status: `${d.bans.days_since_last_ban}d`,
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    });
  }

  for (const r of rows) {
    const div = document.createElement('div');
    div.className = `ban-row ${r.bad ? 'bad' : 'ok'}`;
    div.innerHTML = `
      <div class="ban-icon">${r.icon}</div>
      <div class="ban-info">
        <h4>${escapeHtml(r.title)}</h4>
        <p>${escapeHtml(r.desc)}</p>
      </div>
      <div class="ban-status">${escapeHtml(r.status)}</div>
    `;
    root.appendChild(div);
  }
}

/* ============ Tabs ============ */
function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === target));
      if (target === 'updates') refreshGameUpdates();
    });
  });
}

/* ============ Sort toggle ============ */
function setupSort() {
  document.querySelectorAll('.sort-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      currentSort = btn.dataset.sort;
      document.querySelectorAll('.sort-opt').forEach(b => b.classList.toggle('active', b === btn));
      renderGames();
    });
  });
}

/* ============ History (lookup log with avatars) ============ */
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
  catch { return []; }
}

function saveHistory(list) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, MAX_HISTORY)));
}

function pushHistory(data, q) {
  const list = loadHistory().filter(h => h.steamid !== data.steamid);
  list.unshift({
    steamid: data.steamid,
    q,
    name: data.profile?.persona_name || q,
    avatar: data.profile?.avatar || null,
    games: data.totals?.games_owned || 0,
    hours: data.totals?.total_hours || 0,
    level: data.level?.level || null,
    ts: Date.now(),
  });
  saveHistory(list);
  renderHistory();
}

function renderHistory() {
  const root = $('history-list');
  const list = loadHistory();
  if (list.length === 0) {
    root.innerHTML = '<div class="muted" style="padding:24px;text-align:center;">No lookups yet.</div>';
    return;
  }
  root.innerHTML = '';
  for (const h of list) {
    const div = document.createElement('div');
    div.className = 'history-item';
    div.dataset.q = h.q;
    div.innerHTML = `
      <img src="${h.avatar || ''}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />
      <div class="meta">
        <strong>${escapeHtml(h.name)}</strong>
        <small>Lv ${h.level ?? '—'} · ${fmtNumber(h.games)} games · ${fmtHours(h.hours)}</small>
      </div>
      <span class="ts">${fmtRelative(h.ts)}</span>
    `;
    root.appendChild(div);
  }
}

function fmtRelative(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/* ============ Game updates (Steam news + SteamDB link) ============ */
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

/** Plain-English age for “last update” lines. */
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

/** Big yes/no-style summary — primary row uses newest Steam news item (any feed). */
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

/* ============ Snapshots ============ */
function loadSnapshots() {
  try { return JSON.parse(localStorage.getItem(SNAPSHOTS_KEY)) || []; }
  catch { return []; }
}
function saveSnapshots(list) {
  localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(list));
}

function snapshotOf(data) {
  return {
    id: 'snap-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    steamid: data.steamid,
    name: data.profile?.persona_name || data.steamid,
    avatar: data.profile?.avatar || null,
    ts: Date.now(),
    stats: {
      level: data.level?.level ?? null,
      xp: data.level?.xp ?? null,
      games: data.totals?.games_owned ?? 0,
      hours: data.totals?.total_hours ?? 0,
      friends: data.friends?.count ?? null,
      vac: data.bans?.vac_bans ?? 0,
      gameBans: data.bans?.game_bans ?? 0,
    },
  };
}

function saveSnapshot() {
  if (!lastData) return;
  const snaps = loadSnapshots();
  snaps.unshift(snapshotOf(lastData));
  saveSnapshots(snaps);
  renderSnapshots();
  toast(`Snapshot saved for ${lastData.profile?.persona_name || 'profile'}`, 'success');
}

function deleteSnapshot(id) {
  saveSnapshots(loadSnapshots().filter(s => s.id !== id));
  renderSnapshots();
}

function renderSnapshots() {
  const root = $('snapshot-list');
  const snaps = loadSnapshots();
  if (snaps.length === 0) {
    root.innerHTML = '<div class="muted" style="padding:14px 0;font-size:12px;">No snapshots yet.</div>';
    return;
  }
  root.innerHTML = '';
  for (const s of snaps) {
    const div = document.createElement('div');
    div.className = 'snapshot-item';
    div.innerHTML = `
      <div class="sn-meta">
        <div class="sn-name">${escapeHtml(s.name)}</div>
        <div class="sn-time">Lv ${s.stats.level ?? '—'} · ${fmtNumber(s.stats.games)} games · ${fmtHours(s.stats.hours)} · ${new Date(s.ts).toLocaleString()}</div>
      </div>
      <div class="sn-actions">
        <button data-load="${s.steamid}" title="Look up profile again">Refresh</button>
        <button class="danger" data-del="${s.id}" title="Delete snapshot">×</button>
      </div>
    `;
    root.appendChild(div);
  }
}

function showSnapshotDiff(data) {
  const banner = $('snapshot-diff');
  const snaps = loadSnapshots().filter(s => s.steamid === data.steamid);
  if (snaps.length === 0) {
    banner.classList.add('hidden');
    return;
  }
  const last = snaps[0];
  const cur = snapshotOf(data).stats;
  const diffs = [];
  const fmtDelta = (cur, prev, label, fmt = fmtNumber) => {
    if (cur == null || prev == null) return null;
    const d = cur - prev;
    if (d === 0) return null;
    const cls = d > 0 ? 'delta-up' : 'delta-down';
    const sign = d > 0 ? '+' : '';
    return `<span class="${cls}">${sign}${fmt(d)} ${label}</span>`;
  };
  const dLevel = fmtDelta(cur.level, last.stats.level, 'level');
  const dGames = fmtDelta(cur.games, last.stats.games, 'games');
  const dHours = fmtDelta(cur.hours, last.stats.hours, 'hours played', (n) => fmtHours(n).replace('Never', '0'));
  const dFriends = fmtDelta(cur.friends, last.stats.friends, 'friends');
  const dVac = fmtDelta(cur.vac, last.stats.vac, 'VAC bans');
  const dGameBans = fmtDelta(cur.gameBans, last.stats.gameBans, 'game bans');
  [dLevel, dGames, dHours, dFriends, dVac, dGameBans].forEach(d => d && diffs.push(d));

  if (diffs.length === 0) {
    banner.classList.add('hidden');
    return;
  }
  const days = Math.floor((Date.now() - last.ts) / 86400000);
  const ago = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  banner.classList.remove('hidden');
  banner.innerHTML = `
    <div class="sd-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>
    </div>
    <div class="sd-content">
      <div class="sd-title">Changes since snapshot ${ago}</div>
      <div class="sd-list">${diffs.join(' · ')}</div>
    </div>
  `;
}

/* ============ Compare to me ============ */
function loadMe() {
  try { return JSON.parse(localStorage.getItem(ME_KEY)); }
  catch { return null; }
}
function saveMe(p) {
  if (p) localStorage.setItem(ME_KEY, JSON.stringify(p));
  else localStorage.removeItem(ME_KEY);
  myProfile = p;
}

async function setMe(q) {
  try {
    const res = await fetch(`/api/lookup?q=${encodeURIComponent(q)}${bmQuerySuffix()}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    const me = {
      steamid: data.steamid,
      name: data.profile?.persona_name || data.steamid,
      avatar: data.profile?.avatar || null,
      level: data.level?.level ?? null,
      games: data.totals?.games_owned ?? 0,
      hours: data.totals?.total_hours ?? 0,
      friends: data.friends?.count ?? null,
    };
    saveMe(me);
    renderMyProfile();
    if (lastData) renderDeltas(lastData);
    toast(`Set "${me.name}" as your profile`, 'success');
  } catch (e) {
    toast(`Could not save: ${e.message}`, 'error');
  }
}

function renderMyProfile() {
  const display = $('my-id-display');
  const form = $('my-id-form');
  if (!myProfile) {
    display.classList.add('hidden');
    form.classList.remove('hidden');
    return;
  }
  display.classList.remove('hidden');
  form.classList.add('hidden');
  $('my-id-avatar').src = myProfile.avatar || '';
  $('my-id-name').textContent = myProfile.name;
  $('my-id-stats').textContent = `Lv ${myProfile.level ?? '—'} · ${fmtNumber(myProfile.games)} games · ${fmtHours(myProfile.hours)}`;
}

function renderDeltas(data) {
  const targets = [
    { id: 'delta-level', cur: data.level?.level, mine: myProfile?.level, fmt: (n) => n },
    { id: 'delta-games', cur: data.totals?.games_owned, mine: myProfile?.games, fmt: fmtNumber },
    { id: 'delta-hours', cur: data.totals?.total_hours, mine: myProfile?.hours, fmt: (n) => fmtHours(n) },
    { id: 'delta-friends', cur: data.friends?.private ? null : data.friends?.count, mine: myProfile?.friends, fmt: fmtNumber },
  ];
  for (const t of targets) {
    const el = $(t.id);
    if (!el) continue;
    if (!myProfile || data.steamid === myProfile.steamid || t.cur == null || t.mine == null) {
      el.innerHTML = '';
      continue;
    }
    const d = t.cur - t.mine;
    if (d === 0) {
      el.innerHTML = `<span class="delta-eq">= you</span>`;
    } else if (d > 0) {
      el.innerHTML = `<span class="delta-up">+${t.fmt(Math.abs(d))} vs you</span>`;
    } else {
      el.innerHTML = `<span class="delta-down">−${t.fmt(Math.abs(d))} vs you</span>`;
    }
  }
}

/* ============ Theme ============ */
function applyTheme(mode, accent) {
  if (mode) document.documentElement.dataset.theme = mode;
  if (accent) document.documentElement.dataset.accent = accent;
  document.querySelectorAll('.theme-mode').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  document.querySelectorAll('.accent-swatch').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.accent === accent)));
}

function loadTheme() {
  const mode = localStorage.getItem(THEME_KEY) || 'dark';
  const accent = localStorage.getItem(ACCENT_KEY) || 'blue';
  applyTheme(mode, accent);
}

function notifyParentTheme() {
  if (window.parent === window) return;
  try {
    window.parent.postMessage(
      {
        type: HUB_THEME_MSG,
        theme: document.documentElement.dataset.theme || 'dark',
        accent: document.documentElement.dataset.accent || 'blue',
      },
      window.location.origin,
    );
  } catch (_) { /* ignore */ }
}

window.addEventListener('message', (e) => {
  if (e.origin !== window.location.origin) return;
  const d = e.data;
  if (!d || d.type !== HUB_THEME_MSG) return;
  const mode = typeof d.theme === 'string' ? d.theme : null;
  const accent = typeof d.accent === 'string' ? d.accent : null;
  if (!mode && !accent) return;
  const nextMode = mode || document.documentElement.dataset.theme || 'dark';
  const nextAccent = accent || document.documentElement.dataset.accent || 'blue';
  if (mode) {
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch (_) { /* ignore */ }
  }
  if (accent) {
    try {
      localStorage.setItem(ACCENT_KEY, accent);
    } catch (_) { /* ignore */ }
  }
  applyTheme(nextMode, nextAccent);
});

/* ============ Modal: game detail ============ */
async function openGameModal(appid, gameInfo) {
  if (!lastData?.steamid) return;
  const modal = $('modal');
  const header = $('modal-header');
  const body = $('modal-body');

  const headerImg = gameInfo?.header || `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/header.jpg`;
  header.style.backgroundImage = `linear-gradient(180deg, transparent 0%, rgba(0, 0, 0, 0.85) 100%), url("${headerImg}")`;
  header.innerHTML = `
    <div class="mh-title">
      <h2>${escapeHtml(gameInfo?.name || 'Loading…')}</h2>
      <div class="mh-meta">
        ${gameInfo?.hours ? `<span>⏱ <strong>${fmtHours(gameInfo.hours)}</strong> played</span>` : ''}
        ${gameInfo?.last_played ? `<span>last ${fmtDate(gameInfo.last_played)}</span>` : ''}
        <a href="https://store.steampowered.com/app/${appid}" target="_blank" rel="noopener" style="color:#fff;text-decoration:underline;">View on Steam ↗</a>
      </div>
    </div>
  `;
  body.innerHTML = `<div class="modal-empty"><svg width="40" height="40" viewBox="0 0 50 50" fill="none" stroke="currentColor" stroke-width="3" style="opacity:0.5;animation:spin 1s linear infinite;"><circle cx="25" cy="25" r="20" stroke-dasharray="80" stroke-dashoffset="40"/></svg><p>Loading achievements…</p></div>`;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');

  try {
    const res = await fetch(`/api/game/${appid}?steamid=${lastData.steamid}`);
    const game = await res.json();
    renderGameModal(game, gameInfo);
  } catch (e) {
    body.innerHTML = `<div class="modal-empty"><p>Failed to load: ${escapeHtml(e.message)}</p></div>`;
  }
}

function renderGameModal(game, gameInfo) {
  const body = $('modal-body');
  if (!game.has_achievements || !game.achievements?.length) {
    body.innerHTML = `<div class="modal-empty"><p>No achievement data available for this game.</p>${gameInfo?.hours ? `<p class="muted">You've played <strong>${fmtHours(gameInfo.hours)}</strong>.</p>` : ''}</div>`;
    return;
  }
  const achieved = game.achievements.filter(a => a.achieved);
  const locked = game.achievements.filter(a => !a.achieved);

  let html = `
    <div class="completion-bar">
      <span class="cb-label">Completion</span>
      <div class="cb-track"><div class="cb-fill" style="width:${game.completion_pct || 0}%"></div></div>
      <span class="cb-num">${game.achieved}/${game.total} <span class="muted" style="font-weight:500;">(${game.completion_pct ?? 0}%)</span></span>
    </div>
  `;

  if (achieved.length) {
    html += `<div class="ach-section-title">Unlocked · ${achieved.length}</div><div class="ach-grid">`;
    for (const a of achieved) {
      html += achievementRow(a, true);
    }
    html += `</div>`;
  }
  if (locked.length) {
    html += `<div class="ach-section-title">Locked · ${locked.length} · sorted by easiest first</div><div class="ach-grid">`;
    for (const a of locked.slice(0, 60)) {
      html += achievementRow(a, false);
    }
    html += `</div>`;
    if (locked.length > 60) {
      html += `<div class="muted" style="text-align:center;padding:14px;font-size:12px;">+${locked.length - 60} more locked achievements</div>`;
    }
  }
  body.innerHTML = html;
}

function achievementRow(a, achieved) {
  const icon = achieved ? a.icon : a.icon_gray;
  const pct = a.global_percent != null ? `${a.global_percent.toFixed(1)}%` : '';
  const when = achieved && a.unlock_time ? `Unlocked ${fmtDate(a.unlock_time)}` : '';
  return `
    <div class="ach-row ${achieved ? '' : 'locked'}">
      <img src="${icon || ''}" alt="" loading="lazy" onerror="this.style.visibility='hidden'" />
      <div class="ach-info">
        <div class="ach-name">${escapeHtml(a.display_name)}</div>
        <div class="ach-desc">${escapeHtml(a.description) || (a.hidden ? '<em>(hidden achievement)</em>' : '')}</div>
        ${when ? `<div class="ach-time">${when}</div>` : ''}
      </div>
      ${pct ? `<div class="ach-pct">${pct}</div>` : ''}
    </div>
  `;
}

function closeModal() {
  const modal = $('modal');
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

/* ============ Drawer ============ */
function openDrawer(id) {
  document.querySelectorAll('.drawer').forEach(d => d.classList.toggle('open', d.id === id));
  $('drawer-backdrop').classList.add('open');
}
function closeDrawer() {
  document.querySelectorAll('.drawer').forEach(d => d.classList.remove('open'));
  $('drawer-backdrop').classList.remove('open');
}

/* ============ Wire up ============ */
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (q) lookup(q);
});

document.body.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip[data-q]');
  if (chip) {
    input.value = chip.dataset.q;
    lookup(chip.dataset.q);
    return;
  }
  const histItem = e.target.closest('.history-item[data-q]');
  if (histItem) {
    input.value = histItem.dataset.q;
    closeDrawer();
    lookup(histItem.dataset.q);
    return;
  }
  const card = e.target.closest('[data-appid]');
  if (card) {
    e.preventDefault();
    const appid = card.dataset.appid;
    const gameInfo = JSON.parse(card.dataset.gameInfo || '{}');
    openGameModal(appid, gameInfo);
    return;
  }
  if (e.target.closest('[data-close="1"]')) {
    closeModal();
    return;
  }
});

$('clear-recent').addEventListener('click', () => {
  saveRecents([]);
  renderRecents();
  toast('Cleared recent searches', 'info', 1500);
});

$('game-filter').addEventListener('input', renderGames);
$('played-only').addEventListener('change', renderGames);

$('copy-id').addEventListener('click', () => {
  if (!lastData) return;
  navigator.clipboard.writeText(lastData.steamid).then(() => {
    toast('SteamID64 copied to clipboard', 'success', 1800);
  }).catch(() => {
    toast('Could not copy to clipboard', 'error');
  });
});

$('share-link').addEventListener('click', () => {
  if (!lastQuery) return;
  const url = new URL(window.location.href);
  url.searchParams.set('q', lastQuery);
  navigator.clipboard.writeText(url.toString()).then(() => {
    toast('Shareable link copied', 'success', 1800);
  }).catch(() => {
    toast('Could not copy', 'error');
  });
});

$('open-history').addEventListener('click', () => { renderHistory(); openDrawer('drawer-history'); });
$('close-history').addEventListener('click', closeDrawer);
$('open-settings').addEventListener('click', () => { renderSnapshots(); renderMyProfile(); openDrawer('drawer-settings'); });
$('close-settings').addEventListener('click', closeDrawer);
$('drawer-backdrop').addEventListener('click', closeDrawer);

$('clear-history').addEventListener('click', () => {
  saveHistory([]);
  renderHistory();
  toast('History cleared', 'info', 1500);
});

document.querySelectorAll('.theme-mode').forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.mode;
    localStorage.setItem(THEME_KEY, mode);
    applyTheme(mode, document.documentElement.dataset.accent || 'blue');
    notifyParentTheme();
  });
});

document.querySelectorAll('.accent-swatch').forEach(btn => {
  btn.addEventListener('click', () => {
    const accent = btn.dataset.accent;
    localStorage.setItem(ACCENT_KEY, accent);
    applyTheme(document.documentElement.dataset.theme || 'dark', accent);
    notifyParentTheme();
  });
});

$('my-id-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('my-id-input').value.trim();
  if (v) {
    setMe(v);
    $('my-id-input').value = '';
  }
});

$('my-id-clear').addEventListener('click', () => {
  saveMe(null);
  renderMyProfile();
  if (lastData) renderDeltas(lastData);
  toast('Removed your profile', 'info', 1500);
});

$('save-snapshot').addEventListener('click', saveSnapshot);

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

$('snapshot-list').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    deleteSnapshot(del.dataset.del);
    return;
  }
  const load = e.target.closest('[data-load]');
  if (load) {
    closeDrawer();
    lookup(load.dataset.load);
  }
});

$('modal-close').addEventListener('click', closeModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeModal();
    closeDrawer();
  }
});

window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 8);
}, { passive: true });

window.addEventListener('popstate', () => {
  const q = new URL(window.location.href).searchParams.get('q');
  if (q) {
    input.value = q;
    lookup(q, { skipPushState: true, silent: true });
  } else {
    resultEl.classList.add('hidden');
    emptyEl.classList.remove('hidden');
  }
});

/* ============ Init ============ */
loadTheme();
myProfile = loadMe();
setupTabs();
setupSort();
renderRecents();
renderHistory();
renderSnapshots();
renderMyProfile();
initBmManualPlayerUi();

const initialQ = new URL(window.location.href).searchParams.get('q');
if (initialQ) {
  input.value = initialQ;
  lookup(initialQ, { skipPushState: true });
} else {
  input.focus();
}
