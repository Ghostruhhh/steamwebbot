const dns = require('dns').promises;
const net = require('net');

const URL_CHECK_FETCH_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.URL_CHECK_TIMEOUT_MS) || 5000, 2000),
  15_000,
);

/** @type {Set<string>} */
const SHORTENER_HOSTS = new Set([
  'bit.ly',
  'tinyurl.com',
  't.co',
  'goo.gl',
  'ow.ly',
  'is.gd',
  'buff.ly',
  'rebrand.ly',
  'cutt.ly',
  'adf.ly',
  'tiny.cc',
]);

/** @type {Set<string>} */
const LOW_TRUST_TLDS = new Set([
  'tk',
  'ml',
  'ga',
  'gq',
  'cf',
  'xyz',
  'top',
  'click',
  'surf',
  'beauty',
  'cfd',
  'autos',
  'monster',
  'loan',
]);

function isPrivateIpv4Parts(parts) {
  const a = parts[0];
  const b = parts[1];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** @returns {boolean} — true means private loopback/link-local/etc. Do not HEAD-fetch. */
function isNonPublicAddress(addr, family) {
  if (!addr || typeof addr !== 'string') return true;
  if (family === 4 || net.isIPv4(addr)) {
    const p = addr.split('.').map((x) => parseInt(x, 10));
    if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
    return isPrivateIpv4Parts(p);
  }
  const v = addr.toLowerCase().replace(/^::ffff:/, '');
  if (net.isIPv4(v)) {
    const p = v.split('.').map((x) => parseInt(x, 10));
    return isPrivateIpv4Parts(p);
  }
  const x = v.replace(/^[\[{]+|[}\]]+$/g, '').toLowerCase();
  return (
    x === '::1' ||
    /^fe80:/i.test(x) ||
    /^fc/i.test(x) ||
    /^fd/i.test(x) ||
    /^::ffff:127\./i.test(x) ||
    /^::ffff:(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/i.test(x)
  );
}

async function dnsSafeForOutboundFetch(hostname) {
  if (!hostname || hostname.toLowerCase() === 'localhost') {
    return { ok: false, reason: 'Host is localhost or empty.' };
  }
  try {
    const r = await dns.lookup(hostname, { verbatim: true });
    const addr = r.address;
    const fam = typeof r.family === 'number' ? r.family : 4;
    if (isNonPublicAddress(addr, fam)) {
      return { ok: false, reason: `Resolved ${addr} is private or loopback (blocked to reduce SSRF).` };
    }
    return { ok: true, address: addr };
  } catch (e) {
    return { ok: false, reason: e?.message ? String(e.message) : 'DNS lookup failed' };
  }
}

async function headRedirectPeek(initialUrlObj) {
  /** @type {Array<Record<string, unknown>>} */
  const chain = [];
  /** @type {URL} */
  let cur = initialUrlObj;
  const maxHops = 8;

  for (let hop = 0; hop < maxHops; hop++) {
    const dnsr = await dnsSafeForOutboundFetch(cur.hostname);
    if (!dnsr.ok) {
      chain.push({
        hop: hop + 1,
        url: cur.href,
        aborted: true,
        reason: dnsr.reason ?? 'DNS rejected',
      });
      return {
        chain,
        fetch_ok: false,
        fetch_detail: dnsr.reason || 'Stopped before outbound request.',
      };
    }

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), URL_CHECK_FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(cur.href, {
        method: 'HEAD',
        redirect: 'manual',
        headers: {
          'User-Agent': 'GalaxyProducts-LinkChecker/1.1 (+localhost diagnostics)',
          Accept: '*/*',
        },
        signal: ctl.signal,
      });

      const locHdr = res.headers.get('location');
      chain.push({
        hop: hop + 1,
        url: cur.href,
        status: res.status,
        ...(locHdr ? { location: locHdr } : {}),
      });

      const code = res.status;
      if (code >= 301 && code <= 308 && locHdr) {
        cur = new URL(locHdr, cur);
        continue;
      }
      return { chain, fetch_ok: true, fetch_detail: `HTTP ${code} on last hop (HEAD).` };
    } catch (e) {
      const aborted = String(e?.name || '') === 'AbortError';
      chain.push({
        hop: hop + 1,
        url: cur.href,
        ...(aborted ? { timed_out: true } : {}),
        error: e?.message ? String(e.message) : String(e),
      });
      return {
        chain,
        fetch_ok: false,
        fetch_detail: aborted
          ? `Request timed out after ${URL_CHECK_FETCH_TIMEOUT_MS}ms.`
          : e?.message
            ? String(e.message)
            : 'Network error',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    chain,
    fetch_ok: false,
    fetch_detail: `Stopped after ${maxHops} redirect hops.`,
  };
}

/**
 * @param {URL} u — caller guarantees http(s)
 */
function collectUrlSurfaceFindings(u) {
  /** @type {Array<{ tier: string; title: string; detail: string; code?: string }>} */
  const findings = [];
  const prot = String(u.protocol || '').toLowerCase();
  const hostLower = String(u.hostname || '').toLowerCase();

  if (u.username || u.password) {
    findings.push({
      tier: 'warning',
      code: 'userinfo',
      title: 'User info before hostname',
      detail:
        'The link embeds credentials (user:password@…). Attackers imitate trusted sites using this layout.',
    });
  }

  if (prot === 'http:') {
    findings.push({
      tier: 'notice',
      code: 'http',
      title: 'Uses HTTP, not HTTPS',
      detail:
        'Request and response bodies can be intercepted on untrusted networks; prefer sites that redirect to HTTPS.',
    });
  }

  if (/[\u0590-\u08FF\u0400-\u04FF]/u.test(u.hostname)) {
    findings.push({
      tier: 'notice',
      code: 'confusable_glyph',
      title: 'Unusual Unicode in hostname',
      detail:
        'Some phishing URLs swap letters for Cyrillic/Greek looks-alikes — compare spelling character by character.',
    });
  }

  if (/xn--/i.test(hostLower)) {
    findings.push({
      tier: 'notice',
      code: 'punycode',
      title: 'Punycode hostname (xn--)',
      detail:
        'Internationalized domains can hide spoofed names; expand the registrar “real” ASCII form before trusting.',
    });
  }

  if (SHORTENER_HOSTS.has(hostLower)) {
    findings.push({
      tier: 'notice',
      code: 'shortener',
      title: 'Link shortener',
      detail:
        'You only see an intermediary hop; the real destination arrives after redirection (inspect below).',
    });
  }

  const labelCount = u.hostname ? u.hostname.replace(/^\.|\.$/g, '').split('.').filter(Boolean).length : 0;
  if (labelCount > 6) {
    findings.push({
      tier: 'notice',
      code: 'long_subdomain_chain',
      title: 'Long subdomain chain',
      detail: `${labelCount} labels is uncommon for mainstream sites — pause before signing in.`,
    });
  }

  if (hostLower.length > 96) {
    findings.push({
      tier: 'notice',
      code: 'long_host',
      title: 'Unusually long hostname',
      detail: 'Very long hostnames are uncommon and sometimes used to hide spoofing.',
    });
  }

  const tldRaw = hostLower.includes('.') ? hostLower.split('.').pop() ?? '' : '';
  if (tldRaw && LOW_TRUST_TLDS.has(tldRaw)) {
    findings.push({
      tier: 'notice',
      code: `tld_${tldRaw}`,
      title: 'Low-cost TLD often abused in spam',
      detail: `.${tldRaw} is cheap and frequently used for throwaway malicious sites — not proof of harm, but higher risk.`,
    });
  }

  if (/(?:\d+\.){3}\d+/.test(u.hostname) || net.isIPv4(u.hostname.replace(/^\[|\]$/g, ''))) {
    findings.push({
      tier: 'notice',
      code: 'literal_ip',
      title: 'Hostname is a raw IP',
      detail: 'Most brands use DNS names; raw IPs are sometimes used to bypass simple host-based filters.',
    });
  }

  return findings;
}

function scoreFromFindings(findings) {
  const hasWarn = findings.some((f) => f.tier === 'warning');
  const notices = findings.filter((f) => f.tier === 'notice').length;
  if (hasWarn) return 'high';
  if (notices >= 3) return 'medium';
  if (notices >= 1) return 'elevated';
  return 'low';
}

async function runUrlThreatCheck(rawInput) {
  const trimmed = String(rawInput ?? '').trim();
  if (!trimmed) throw new Error('Paste a URL to analyze.');

  const sniff = trimmed.toLowerCase().replace(/^[\s\uFEFF]+/, '');
  /** Prefix block before URL parsing catches obfuscated whitespace tricks. */
  const blockedSniffPrefixes = ['javascript:', 'data:', 'vbscript:', 'file:', 'blob:'];
  for (const pref of blockedSniffPrefixes) {
    if (sniff.startsWith(pref)) {
      throw new Error(
        `Dangerous scheme (${pref.replace(/:$/, '')}) — don't open unsolicited links using this URI type.`,
      );
    }
  }

  /** @type {URL} */
  let u;
  try {
    u = trimmed.includes('://')
      ? new URL(trimmed)
      : trimmed.startsWith('//')
        ? new URL(`https:${trimmed}`)
        : new URL(`https://${trimmed}`);
  } catch {
    throw new Error("Couldn't parse this as a web address — check for typos or missing https://.");
  }

  if (!['http:', 'https:'].includes(String(u.protocol || '').toLowerCase())) {
    throw new Error(`Only http(s) links are analyzed (got ${u.protocol}).`);
  }

  let findings = collectUrlSurfaceFindings(u);

  const redirectProbe = await headRedirectPeek(u);

  const statusSteps = redirectProbe.chain.filter((step) => typeof step.status === 'number');
  if (statusSteps.length >= 5) {
    findings = findings.concat([
      {
        tier: 'notice',
        code: 'redirect_chain_long',
        title: 'Many HTTP redirects',
        detail: `${statusSteps.length} status responses in the chain — final URL may differ sharply from what you see in chat.`,
      },
    ]);
  }

  let risk_score = scoreFromFindings(findings);
  if (redirectProbe.fetch_ok === false && redirectProbe.fetch_detail && !String(redirectProbe.fetch_detail).includes('DNS')) {
    if (risk_score === 'low') risk_score = 'elevated';
  }

  return {
    ok: true,
    normalized_url: u.href,
    hostname: u.hostname,
    risk_score,
    findings,
    redirect_probe: redirectProbe,
    disclaimer:
      'Heuristic phishing / abuse hints only. Malware can live on “clean” domains; this does not download or scan page content.',
  };
}

module.exports = { runUrlThreatCheck };
