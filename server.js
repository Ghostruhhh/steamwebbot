const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { promisify } = require('util');
const { execFile, spawn } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const si = require('systeminformation');
const { runUrlThreatCheck } = require('./lib/urlThreatCheck');
const { computeGalaxyHwid } = require('./lib/galaxyHwid');

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '48kb' }));
const API_KEY = process.env.STEAM_API_KEY;
const BM_TOKEN_RAW = process.env.BATTLEMETRICS_TOKEN?.trim();
const SERIAL_CHECKER_EXE = process.env.SERIAL_CHECKER_EXE?.trim();
const SERIAL_CHECKER_ARGS = process.env.SERIAL_CHECKER_ARGS?.trim();
const SERIAL_CHECKER_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.SERIAL_CHECKER_TIMEOUT_MS) || 90_000, 5_000),
  240_000,
);

/** Windows Defender CLI quick scan (localhost “Malware hints” tab). */
const DEFENDER_SCAN_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.DEFENDER_SCAN_TIMEOUT_MS) || 720_000, 60_000),
  3_600_000,
);

/** Steam app ID for Rust (Facepunch) */
const RUST_STEAM_APPID = 252490;
const BM_BASE = 'https://api.battlemetrics.com';

function bmHeaders() {
  if (!BM_TOKEN_RAW) return null;
  const auth = BM_TOKEN_RAW.toLowerCase().startsWith('bearer ')
    ? BM_TOKEN_RAW
    : `Bearer ${BM_TOKEN_RAW}`;
  return {
    Authorization: auth,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

const BM_PAIRING_HELP_URL = 'https://learn.battlemetrics.com/article/54-how-can-i-search-for-a-player-by-steam64id';

/** Best-effort client address (Express + raw socket — Windows often uses IPv4-mapped ::ffff:...) */
function getClientAddr(req) {
  const rip = typeof req.ip === 'string' ? req.ip : '';
  const sock =
    (req.socket && typeof req.socket.remoteAddress === 'string' && req.socket.remoteAddress) ||
    (req.connection && typeof req.connection.remoteAddress === 'string' && req.connection.remoteAddress) ||
    '';
  return rip || sock;
}

/** Loopback-only for host-only endpoints (WMI dumps / running bundled EXE). */
function isLoopbackReq(req) {
  const raw = getClientAddr(req);
  if (!raw) return false;
  const addr = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  return addr === '127.0.0.1' || addr === '::1';
}

/** Naive whitespace split — put paths with spaces in SERIAL_CHECKER_EXE short form, or extend later */
function exeArgsFromEnv(raw) {
  if (!raw) return [];
  return raw.split(/\s+/).filter(Boolean);
}

async function trySi(label, fn) {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err?.message ? String(err.message) : `${label}: failed`, label };
  }
}

async function execPowerShell(command) {
  const psExe = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  const r = await execFileAsync(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    encoding: 'utf8',
    timeout: 25_000,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return r.stdout;
}

/**
 * Runs arbitrary PowerShell as a UTF-8 temp .ps1 (avoids Windows ~8192-char command-line cap for -Command).
 * @param {string} scriptBody
 * @param {{ timeout?: number; maxBuffer?: number }} opts
 */
async function execPowerShellFromScriptFile(scriptBody, opts) {
  const psExe = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  const tmpPs1 = path.join(
    os.tmpdir(),
    `steamwebbot-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`,
  );
  await fs.promises.writeFile(tmpPs1, `\uFEFF${scriptBody}`, 'utf8');
  try {
    const r = await execFileAsync(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpPs1], {
      encoding: 'utf8',
      timeout: opts?.timeout ?? 60_000,
      windowsHide: true,
      maxBuffer: opts?.maxBuffer ?? 20 * 1024 * 1024,
    });
    return r.stdout;
  } finally {
    await fs.promises.unlink(tmpPs1).catch(() => {});
  }
}

async function execPowerShellThreatScan(scriptBody) {
  return execPowerShellFromScriptFile(scriptBody, { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
}

async function execPowerShellSerialExtras(scriptBody) {
  return execPowerShellFromScriptFile(scriptBody, { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 });
}

/**
 * WMI blobs for plaintext serial dump (PnP GPUs, NIC MAC sample, TPM, Secure Boot, DeviceGuard reg).
 */
const WINDOWS_SERIAL_REPORT_EXTRAS_PS = [
  '$ErrorActionPreference="SilentlyContinue";',
  '$root=[ordered]@{adapters=@();video=@();tpm=$null;secure_boot=$null;credential_guard=@{}};',
  '$ad=Get-CimInstance Win32_NetworkAdapter | Where-Object { $_.MACAddress -and ($_.MACAddress -ne "00:00:00:00:00:00") } | Select-Object Name,MACAddress,PhysicalAdapter,NetConnectionID;',
  '$root.adapters=@($ad);',
  '$vc=Get-CimInstance Win32_VideoController | Select-Object Name,PNPDeviceID,AdapterRAM,DriverVersion;',
  '$root.video=@($vc);',
  'try { $root.secure_boot = [bool](Confirm-SecureBootUEFI -ErrorAction Stop) } catch { $root.secure_boot = $null };',
  'try { $tp = Get-Tpm -ErrorAction Stop; $root.tpm = @{ present=[bool]$tp.TpmPresent; ready=[bool]$tp.TpmReady; enabled=[bool]$tp.TpmEnabled; activated=[bool]$tp.TpmActivated; owned=[bool]$tp.TpmOwned } } catch { $root.tpm = $null };',
  'try { $dg = Get-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\DeviceGuard" -ErrorAction Stop; $root.credential_guard.virtualization_based_security_enabled = if ($null -ne $dg.EnableVirtualizationBasedSecurity) { [int]$dg.EnableVirtualizationBasedSecurity } else { $null }; $root.credential_guard.lsa_cfg_flags = if ($null -ne $dg.LsaCfgFlags) { [string]$dg.LsaCfgFlags } else { $null }; $root.credential_guard.configured_cred_guard = if ($null -ne $dg.ConfiguredCredentialGuard) { [string]$dg.ConfiguredCredentialGuard } else { $null } } catch { $root.credential_guard = @{ registry_read_failed = $true } };',
  '[pscustomobject]$root | ConvertTo-Json -Depth 8 -Compress',
].join('\r\n');

function formatDumpTimestamp(isoStr) {
  const d = isoStr ? new Date(isoStr) : new Date();
  if (Number.isNaN(d.getTime())) return 'unknown-date';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}-${mi}-${ss}`;
}

/** @param {string} label @param {any} val */
function serialReportLine(label, val) {
  const L = String(label);
  const v = val == null || val === '' ? '—' : String(val).replace(/\r?\n/g, ' ');
  return `  ${L.padEnd(28)} : ${v}`;
}

function serialDashLine() {
  return `${'='.repeat(80)}`;
}

/**
 * ASCII report with section banners (plain hardware dump).
 */
function formatVerseStyleSerialDump(/** @type {any} */ doc, extras, arpText) {
  /** @type {string[]} */
  const sb = [];
  const dash = serialDashLine;
  sb.push(`SERIAL DUMP (${formatDumpTimestamp(doc.scanned_at)})`);
  sb.push('');
  sb.push('PC SERIAL REPORT');
  sb.push('');
  sb.push(`${dash()}`);
  sb.push('');
  sb.push('SYSTEM INFORMATION:');
  sb.push('');
  const m = doc.machine && !doc.machine.error ? doc.machine : {};
  sb.push(serialReportLine('MANUFACTURER', m.manufacturer));
  sb.push(serialReportLine('PRODUCT NAME', m.model));
  sb.push(serialReportLine('VERSION INDEX', m.version));
  sb.push(serialReportLine('SYSTEM SERIAL', m.serial));
  sb.push(serialReportLine('SYSTEM UUID', m.uuid));
  sb.push(serialReportLine('FAMILY SERIAL', '—'));
  sb.push(serialReportLine('SKU NUMBER', m.sku));
  sb.push('');
  sb.push(serialReportLine('VIRTUAL MACHINE (HEURISTIC)', m.virtual ?? '—'));

  if (doc.os && !doc.os.error) {
    sb.push('');
    sb.push('  ---------- HOST / OS -----------');
    sb.push(serialReportLine('HOSTNAME', doc.os.hostname));
    sb.push(serialReportLine('OPERATING SYSTEM', doc.os.distro));
    sb.push(serialReportLine('OS SERIAL NUMBER', doc.os.serial));
    sb.push(serialReportLine('OS BUILD', `${doc.os.release || ''}${doc.os.build ? ` (build ${doc.os.build})` : ''}`));
    sb.push(serialReportLine('DISPLAY VERSION', doc.os.codename));
    sb.push(serialReportLine('UEFI BOOT (si.osInfo)', doc.os.uefi));
    sb.push(serialReportLine('REMOTE SESSION', doc.os.remote_session));
  }

  sb.push('');
  sb.push(`${dash()}`);
  sb.push('');
  sb.push('BASEBOARD INFORMATION:');
  sb.push('');
  const mb = doc.motherboard && !doc.motherboard.error ? doc.motherboard : {};
  sb.push(serialReportLine('MANUFACTURER', mb.manufacturer));
  sb.push(serialReportLine('PRODUCT NAME', mb.model));
  sb.push(serialReportLine('VERSION INDEX', mb.version));
  sb.push(serialReportLine('SERIAL NUMBER', mb.serial));
  sb.push(serialReportLine('ASSET NUMBER', mb.asset_tag));
  sb.push(serialReportLine('(CS) LOCATION', 'Default string'));

  sb.push('');
  sb.push(`${dash()}`);
  sb.push('');
  sb.push('CHASSIS INFORMATION:');
  sb.push('');
  const ch = doc.chassis && !doc.chassis.error ? doc.chassis : {};
  sb.push(serialReportLine('MANUFACTURER', ch.manufacturer));
  sb.push(serialReportLine('PRODUCT NAME', ch.model));
  sb.push(serialReportLine('CHASSIS TYPE', ch.type));
  sb.push(serialReportLine('SERIAL NUMBER', ch.serial));
  sb.push(serialReportLine('ASSET NUMBER', 'Default string'));
  sb.push(serialReportLine('SKU NUMBER', ch.sku));

  /** @type {any} */
  const cg =
    extras && extras.credential_guard && typeof extras.credential_guard === 'object'
      ? extras.credential_guard
      : {};
  const vbsRaw = cg.virtualization_based_security_enabled;
  /** @type {string} */
  let coreLbl = '';
  if (vbsRaw === 1 || vbsRaw === true) coreLbl = 'Enabled';
  else if (vbsRaw === 2) coreLbl = 'Audit mode';
  else if (vbsRaw === 0 || vbsRaw === false) coreLbl = 'Disabled';
  else if (cg.registry_read_failed) coreLbl = 'Unknown (could not read DeviceGuard registry)';
  else coreLbl = 'Unknown';

  /** @type {string} */
  let virtLbl = '';
  const cpuVirt = doc.cpu && !doc.cpu.error ? doc.cpu.virtualization_reports_hypervisor : null;
  if (typeof cpuVirt === 'boolean')
    virtLbl = cpuVirt ? 'Hypervisor-present (guest / nested virt flag)' : 'Disabled / not flagged';
  else virtLbl = 'Unknown';

  /** @type {string} */
  let secureLbl = '';
  if (extras && Object.prototype.hasOwnProperty.call(extras, 'secure_boot')) {
    if (extras.secure_boot === true) secureLbl = 'Enabled';
    else if (extras.secure_boot === false) secureLbl = 'Disabled';
    else secureLbl = String(extras.secure_boot);
  } else secureLbl = 'Unknown (Confirm-SecureBootUEFI may need elevation / policy)';

  /** @type {string} */
  let tpmLbl = '';
  /** @type {any} */
  const tpmObj = extras && extras.tpm;
  if (!tpmObj || typeof tpmObj !== 'object') tpmLbl = 'Disabled or unavailable';
  else if (tpmObj.enabled === false || tpmObj.present === false) tpmLbl = 'Disabled';
  else if (tpmObj.enabled === true) tpmLbl = 'Enabled';
  else tpmLbl = 'Unknown';

  sb.push('');
  sb.push(`${dash()}`);
  sb.push('');
  sb.push('BIOS INFORMATION (plus security summaries):');
  sb.push('');
  const b = doc.bios && !doc.bios.error ? doc.bios : {};
  sb.push(serialReportLine('BIOS VENDOR', b.vendor));
  sb.push(serialReportLine('BIOS VERSION', b.version));
  sb.push(serialReportLine('RELEASE DATE', b.release_date));
  sb.push(serialReportLine('BIOS SERIAL', b.serial));
  sb.push('');
  sb.push(serialReportLine('CORE ISOLATION (VBS reg)', coreLbl));
  sb.push(serialReportLine('VIRTUALIZATION (heuristic)', virtLbl));
  sb.push(serialReportLine('SECURE BOOT', secureLbl));
  sb.push(serialReportLine('TPM STATUS', tpmLbl));

  sb.push('');
  sb.push(`${dash()}`);
  sb.push('');
  sb.push('PROCESSOR INFORMATION:');
  sb.push('');
  const cpu = doc.cpu && !doc.cpu.error ? doc.cpu : {};
  sb.push(serialReportLine('CPU MANUFACTURER', cpu.manufacturer));
  sb.push(serialReportLine('PROCESSOR TYPE', cpu.brand));
  sb.push(serialReportLine('BASE SPEED GHz', cpu.speed_ghz));
  sb.push(serialReportLine('MAX SPEED GHz', cpu.speed_max_ghz));
  sb.push(serialReportLine('PHYSICAL CORES', cpu.cores_physical));
  sb.push(serialReportLine('LOGICAL CPUs', cpu.cores_logical));
  sb.push(serialReportLine('SOCKET TYPE', cpu.socket));
  sb.push(serialReportLine('SERIAL NUMBER', 'SMBIOS field — often "To be filled by O.E.M."'));
  sb.push(serialReportLine('PART NUMBER', 'SMBIOS field — often "To be filled by O.E.M."'));
  sb.push(serialReportLine('ASSET NUMBER', 'SMBIOS field — often "To be filled by O.E.M."'));

  /** @type {any[]} */
  const pp = Array.isArray(doc.cpu_processor_wmi) ? doc.cpu_processor_wmi : [];
  if (pp.length) {
    for (let i = 0; i < pp.length; i++) {
      const p = pp[i];
      sb.push('');
      sb.push(serialReportLine(`SOCKET DESIGNATION ${i + 1}`, p.socket_designation));
      sb.push(serialReportLine(`WIN32 PROCESSOR ID ${i + 1}`, p.processor_id_hex || '—'));
    }
  } else sb.push(serialReportLine('WIN32 PROCESSOR ID', 'No WMI CPU rows'));
  sb.push('');
  sb.push(`${dash()}`);
  sb.push('');
  sb.push('DISK INFORMATION (WMI LAYOUT SAMPLE):');
  sb.push('');
  sb.push(serialReportLine(
    'STORAGE QUERY / SCSI NOTES',
    'Low-level STORAGE_QUERY_PROPERTY / ATA probe strings need a dedicated storage driver tool.',
  ));
  const disks = Array.isArray(doc.disks) ? doc.disks : [];
  if (!disks.length) sb.push(serialReportLine('ROWS', '—'));
  for (let i = 0; i < disks.length; i++) {
    const dk = disks[i];
    sb.push('');
    sb.push(`  --- LOGICAL / PHYS VOL ${i + 1} ---`);
    sb.push(serialReportLine('DISK STORAGE MODEL LINE', dk.vendor ? `${dk.vendor} ${dk.name || ''}`.trim() : dk.name));
    sb.push(serialReportLine('WMI SERIAL', dk.serial));
    sb.push(serialReportLine('FIRMWARE REVISION', dk.firmware_revision));
    sb.push(
      serialReportLine(
        'SIZE',
        dk.size_bytes && typeof dk.size_bytes === 'number'
          ? `${(dk.size_bytes / (1024 ** 3)).toFixed(2)} GB`
          : null,
      ),
    );
    sb.push(serialReportLine('NAME / TYPE', dk.name ? `${dk.name} (${dk.type || '—'})` : dk.type));
  }

  sb.push('');
  sb.push(`${dash()}`);
  sb.push('');
  sb.push('NETWORK INFORMATION:');
  sb.push('');
  let adap = extras && extras.adapters ? extras.adapters : [];
  if (!Array.isArray(adap)) adap = [adap];
  /** @type {Set<string>} */
  const macSeen = new Set();
  let idx = 0;
  if (!adap.length) sb.push(serialReportLine('ADAPTERS', 'No WMI rows (non-Windows or empty)'));
  for (const a of adap) {
    const mac = typeof a?.MACAddress === 'string' ? a.MACAddress.trim() : '';
    if (!mac) continue;
    const up = mac.toUpperCase();
    if (macSeen.has(up)) continue;
    macSeen.add(up);
    idx++;
    const tag = `[ADAPTER${idx}]`;
    sb.push(serialReportLine(`MAC ${tag}`, mac));
    if (a.PhysicalAdapter !== undefined)
      sb.push(serialReportLine(`  ${tag} PHYSICAL ADAPTER`, a.PhysicalAdapter));
    sb.push(serialReportLine(`  ${tag} INTERFACE`, `${a.NetConnectionID || ''} · ${a.Name || ''}`));
  }

  sb.push('');
  sb.push(`${dash()}`);
  sb.push('');
  sb.push('ARP INFORMATION:');
  sb.push('');
  if (arpText && String(arpText).trim()) {
    for (const line of String(arpText).replace(/\r\n/g, '\n').split('\n')) {
      sb.push(line.trim() === '' ? '' : `    ${line}`);
    }
  } else sb.push('    — arp.exe not available');

  sb.push('');
  sb.push(`${dash()}`);
  sb.push('');
  sb.push('MONITOR INFORMATION (EDID WMI):');
  sb.push('');
  /** @type {any[]} */
  const monList = Array.isArray(doc.monitor_edid) ? doc.monitor_edid : [];
  if (!monList.length) sb.push(serialReportLine('DISPLAYS', 'No WmiMonitorID rows'));
  for (const mo of monList) {
    sb.push('');
    sb.push(serialReportLine('MANUFACTURER', mo.manufacturer));
    sb.push(serialReportLine('MODEL NAME', mo.friendly_name));
    sb.push(serialReportLine('MONITOR SERIAL', mo.serial_edid));
    sb.push(serialReportLine('ID SERIAL NUMBER', mo.product_code_id));
  }

  sb.push('');
  sb.push(`${dash()}`);
  sb.push('');
  sb.push('GPU INFORMATION:');
  sb.push('');
  let vid = extras && extras.video ? extras.video : [];
  if (!Array.isArray(vid)) vid = [vid];
  if (!vid.length) {
    const gpuCtr = Array.isArray(doc.gpu_controllers) ? doc.gpu_controllers : [];
    for (let gi = 0; gi < gpuCtr.length; gi++) {
      const g = gpuCtr[gi];
      sb.push('');
      sb.push(serialReportLine(`PCI SUMMARY ${gi + 1}`, `PCI SUBSYS (hex fragment) ${g.pci_subsystem_id_hex || '—'}`));
      sb.push(serialReportLine('GPU NAME', `${g.vendor || ''} ${g.model || ''}`.trim()));
      sb.push(serialReportLine('VRAM MB', g.vram_mb));
    }
  } else {
    let gi = 0;
    for (const it of vid) {
      gi++;
      sb.push('');
      sb.push(`  --- gpu ${gi} ---`);
      sb.push(serialReportLine('PCI DEVICE', it.PNPDeviceID || '—'));
      sb.push(serialReportLine('GPU NAME', it.Name));
      sb.push(serialReportLine('GPU DRIVER VERSION', it.DriverVersion));
      if (typeof it.AdapterRAM === 'number' && it.AdapterRAM > 65536)
        sb.push(serialReportLine('ADAPTER RAM (bytes)', String(it.AdapterRAM)));
    }
  }
  sb.push('');
  sb.push(serialReportLine('GPU GUID SERIAL (DX STYLE)', 'Not queried via Node hub - use DxDiag / vendor tools'));

  sb.push('');
  sb.push(`${dash()}`);
  sb.push('');
  sb.push('TPM INFORMATION (WMI TPM ENNUMERATION):');
  sb.push('');
  if (!extras || extras.tpm == null || typeof extras.tpm !== 'object') {
    sb.push(serialReportLine('VENDOR STATUS', 'Disabled or Error'));
  } else if (extras.tpm.enabled !== true || extras.tpm.present !== true) {
    sb.push(serialReportLine('SUMMARY', 'TPM not fully enabled'));
  } else {
    sb.push(serialReportLine('PRESENT', extras.tpm.present));
    sb.push(serialReportLine('READY', extras.tpm.ready));
    sb.push(serialReportLine('ENABLED', extras.tpm.enabled));
    sb.push(serialReportLine('ACTIVATED', extras.tpm.activated));
    sb.push(serialReportLine('OWNED', extras.tpm.owned));
  }
  sb.push('');
  sb.push(`${dash()}`);
  sb.push('');
  sb.push('MEMORY MODULES (DIMM):');
  sb.push('');
  /** @type {any[]} */
  const memMods = Array.isArray(doc.memory_modules) ? doc.memory_modules : [];
  if (!memMods.length) sb.push(serialReportLine('MODULES', '—'));
  for (let mi = 0; mi < memMods.length; mi++) {
    const x = memMods[mi];
    sb.push('');
    sb.push(`  --- DIMM ${mi + 1} ---`);
    sb.push(serialReportLine('BANK LABEL', x.bank));
    sb.push(serialReportLine('TYPE', x.type));
    sb.push(serialReportLine('FORM FACTOR', x.form_factor));
    sb.push(
      serialReportLine(
        'SIZE',
        typeof x.size_bytes === 'number' ? `${(x.size_bytes / (1024 ** 3)).toFixed(2)} GB` : null,
      ),
    );
    sb.push(serialReportLine('SPEED MHz', x.speed_mhz));
    sb.push(serialReportLine('MANUFACTURER', x.manufacturer));
    sb.push(serialReportLine('PART NUMBER', x.part_number));
    sb.push(serialReportLine('SERIAL NUMBER', x.serial));
  }

  sb.push('');
  sb.push(`${dash()}`);
  sb.push('');
  sb.push('-- end SERIAL DUMP · Galaxy Products / steamwebbot ---');
  return sb.join('\n');
}

async function snapshotWindowsReportExtrasAndArp() {
  /** @returns {Promise<{ extras: any, arp_text: string|null, diagnostics: { source: string; detail: string }[]}>} */
  if (process.platform !== 'win32') {
    return {
      extras: null,
      arp_text: null,
      diagnostics: [{ source: 'serial_report_plain', detail: 'Windows WMI extras omitted on this platform.' }],
    };
  }

  /** @type {{ source: string; detail: string }[]} */
  const diagnostics = [];
  /** @type {any} */
  let extras = null;
  try {
    const raw = (await execPowerShellSerialExtras(WINDOWS_SERIAL_REPORT_EXTRAS_PS)).trim();
    if (raw.startsWith('{')) extras = JSON.parse(raw);
    else diagnostics.push({ source: 'serial_report_plain', detail: 'PowerShell did not emit JSON extras.' });
  } catch (e) {
    diagnostics.push({
      source: 'serial_report_plain',
      detail: e?.message ? String(e.message) : 'extras JSON parse failed',
    });
  }

  /** @returns {Promise<string|null>} */
  async function runArpA() {
    try {
      const arpExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'arp.exe');
      const r = await execFileAsync(arpExe, ['-a'], {
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
      });
      return r.stdout != null ? String(r.stdout) : '';
    } catch {
      return null;
    }
  }

  const arpText = await runArpA();
  return { extras, arp_text: arpText, diagnostics };
}

/**
 * One PowerShell payload: Defender status, filtered process “hints”, startup sample.
 * Output is a single JSON object (stdout only). Not a substitute for AV — rule-based only.
 */
const WINDOWS_THREAT_HINTS_PS = [
  '$ErrorActionPreference="SilentlyContinue";',
  '$diag=New-Object System.Collections.Generic.List[string];',
  '$hints=New-Object System.Collections.Generic.List[object];',
  '$def=$null;',
  'try{$mp=Get-MpComputerStatus -ErrorAction Stop;$def=@{realtime_on=[bool]$mp.RealTimeProtectionEnabled;antivirus_on=[bool]$mp.AntivirusEnabled;antispyware_on=[bool]$mp.AntispywareEnabled;am_service_on=[bool]$mp.AMServiceEnabled;nis_on=[bool]$mp.NISEnabled;signature_last_updated=if($mp.AntivirusSignatureLastUpdated){$mp.AntivirusSignatureLastUpdated.ToUniversalTime().ToString("o")}else{$null};quick_scan_last_start=if($mp.QuickScanStartTime){$mp.QuickScanStartTime.ToUniversalTime().ToString("o")}else{$null};full_scan_last_start=if($mp.FullScanStartTime){$mp.FullScanStartTime.ToUniversalTime().ToString("o")}else{$null};engine_version=[string]$mp.AMEngineVersion;signature_version=[string]$mp.AntiVirusSignatureVersion}}catch{$diag.Add("defender:"+$_.Exception.Message)};',
  '$rules=@(@{g="common_rat_or_stealer_keyword";t="warning";rx="(?i)(njrat|asyncrat|async.?rat|darkcomet|remcos|xworm|redline|agenttesla|formbook|lokibot|nanocore|quasar)"},@{g="memory_editor_game";t="hint";rx="(?i)cheatengine"},@{g="injector_or_mod_menu_style";t="hint";rx="(?i)(xenos|extreme.?injector|kiddions|modest.?menu|\\b2take1\\b|cherax|stand.?menu|nightfall|paragon.?menu)"},@{g="remote_access";t="notice";rx="(?i)(anydesk|teamviewer|rustdesk|parsec\\.exe|dwagent\\.exe|splashtop|ammyy|bomgar|beyondtrust|gotoassist|meshagent|tacticalrmm|connectwise|screenconnect|ultraviewer)"},@{g="advanced_process_or_network_tool";t="notice";rx="(?i)(process.?hacker|system.?informer|procexp|procmon|wireshark|fiddler|burpsuite)"});',
  'foreach($proc in Get-CimInstance Win32_Process){foreach($rule in $rules){$n=[string]$proc.Name;$p=if($proc.ExecutablePath){[string]$proc.ExecutablePath}else{""};if($n -match $rule.rx -or ($p -and $p -match $rule.rx)){$hints.Add([pscustomobject]@{group=$rule.g;tier=$rule.t;pid=$proc.ProcessId;name=$n;path=$p});break}}};',
  '$start=@();Get-CimInstance Win32_StartupCommand|Select-Object -First 120 Name,Command,Location,User|ForEach-Object{$start+=@{name=$_.Name;command=$_.Command;location=$_.Location;user=$_.User}};',
  '[pscustomobject]@{defender=$def;process_hints=@($hints);startup_sample=$start;diagnostics=@($diag);rule_set="steamwebbot-threat-hints-v1"}|ConvertTo-Json -Depth 10 -Compress',
].join('\r\n');

function findWindowsDefenderMpCmdRun() {
  const roots = [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    'C:\\Program Files',
  ].filter(Boolean);
  for (const root of roots) {
    const candidate = path.join(root, 'Windows Defender', 'MpCmdRun.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Read-only “hint” scan (rules + Defender status + startup sample). Windows only.
 */
async function snapshotPcThreatHints() {
  const notes =
    'Heuristic review only: many legitimate tools (remote support, debuggers, Cheat Engine for offline use) match these rules. Remote-access matches are common on clean PCs. Pair with Windows Update, a full Defender scan, and a reputable second-opinion scanner if you suspect malware.';

  if (process.platform !== 'win32') {
    return {
      scanned_at: new Date().toISOString(),
      platform: process.platform,
      notes,
      defender: null,
      process_hints: [],
      startup_sample: [],
      diagnostics: [{ source: 'platform', detail: 'Process / Defender heuristic scan runs on Windows hosts only.' }],
    };
  }

  /** @type {string[]} */
  const diagnostics = [];
  try {
    const raw = await execPowerShellThreatScan(WINDOWS_THREAT_HINTS_PS);
    const trimmed = raw.trim();
    /** @type {any} */
    const doc =
      trimmed && trimmed.startsWith('{')
        ? JSON.parse(trimmed)
        : trimmed.startsWith('[')
          ? JSON.parse(trimmed)
          : {};

    if (doc.diagnostics?.length)
      diagnostics.push(...doc.diagnostics.map((d) => ({ source: 'powershell', detail: String(d) })));

    const processHints = Array.isArray(doc.process_hints) ? doc.process_hints.slice(0, 256) : [];
    const startups = Array.isArray(doc.startup_sample) ? doc.startup_sample.slice(0, 120) : [];

    return {
      scanned_at: new Date().toISOString(),
      platform: 'win32',
      notes,
      rule_set: doc.rule_set || null,
      defender: doc.defender && typeof doc.defender === 'object' ? doc.defender : null,
      process_hints: processHints.map((h) => ({
        tier: h.tier || null,
        group: h.group || null,
        pid: h.pid ?? null,
        name: h.name || null,
        path: h.path || null,
      })),
      startup_sample: startups.map((s) => ({
        name: s.name || null,
        command: typeof s.command === 'string' && s.command.length > 800 ? `${s.command.slice(0, 797)}…` : s.command || null,
        location: s.location || null,
        user: s.user || null,
      })),
      summary: {
        hint_rows: processHints.filter((x) => x.tier === 'hint').length,
        notice_rows: processHints.filter((x) => x.tier === 'notice').length,
        warning_rows: processHints.filter((x) => x.tier === 'warning').length,
        defender_available: !!(doc.defender && typeof doc.defender === 'object'),
        startup_entries: startups.length,
      },
      defender_quick_scan_exe: findWindowsDefenderMpCmdRun(),
      diagnostics,
    };
  } catch (e) {
    diagnostics.push({
      source: 'threat_scan',
      detail: e?.message ? String(e.message) : 'Threat hint scan failed',
    });
    return {
      scanned_at: new Date().toISOString(),
      platform: 'win32',
      notes,
      error: e?.message ? String(e.message) : 'Failed',
      defender: null,
      process_hints: [],
      startup_sample: [],
      defender_quick_scan_exe: findWindowsDefenderMpCmdRun(),
      diagnostics,
    };
  }
}

/** WMI Win32_StartupCommand — registry Run / RunOnce / Startup folder entries (read-only). */
const WINDOWS_STARTUP_APPS_PS = [
  "$ErrorActionPreference='SilentlyContinue';",
  '$diag = New-Object System.Collections.ArrayList;',
  '$entries = New-Object System.Collections.ArrayList;',
  '$total = 0;',
  'try {',
  '  $rows = @(Get-CimInstance Win32_StartupCommand | Select-Object Name, Command, Location, User);',
  '  $total = $rows.Count;',
  '  foreach ($row in $rows) {',
  '    [void]$entries.Add(@{ name=[string]$row.Name; command=[string]$row.Command; location=[string]$row.Location; user=[string]$row.User });',
  '  }',
  '} catch { [void]$diag.Add("wmi:" + $_.Exception.Message) }',
  '$max = 600;',
  '$truncated = $total -gt $max;',
  '$take = if ($truncated) { $max } else { $total };',
  '$slice = @(for ($i = 0; $i -lt $take; $i++) { $entries[$i] });',
  '$body = @{ total=$total; truncated=$truncated; cap=$max; entries=@($slice); diagnostics=@($diag); source="Win32_StartupCommand" };',
  '$body | ConvertTo-Json -Depth 10 -Compress',
].join('\r\n');

/** Pick first present string field (PowerShell JSON often uses PascalCase). */
function startupPickStr(row, keys) {
  if (!row || typeof row !== 'object') return null;
  for (const k of keys) {
    const v = row[k];
    if (v != null && v !== '') return String(v);
  }
  return null;
}

/**
 * ConvertTo-Json sometimes emits arrays as objects with numeric keys; nested props may be PascalCase.
 * @param {any} doc parsed JSON from PowerShell
 * @returns {any[]}
 */
function coerceStartupEntriesArray(raw) {
  let entries = raw?.entries ?? raw?.Entries;
  if (typeof entries === 'string') {
    try {
      entries = JSON.parse(entries);
    } catch {
      return [];
    }
  }
  if (entries == null) return [];
  if (Array.isArray(entries)) return entries;
  if (typeof entries === 'object') {
    const keys = Object.keys(entries);
    if (keys.length && keys.every((k) => /^\d+$/.test(k))) {
      return keys.sort((a, b) => Number(a) - Number(b)).map((k) => entries[k]);
    }
    return [entries];
  }
  return [];
}

function parseStartupAppsPowerShellJson(rawStdout) {
  const trimmed = String(rawStdout ?? '')
    .replace(/^\uFEFF/, '')
    .trim();
  if (!trimmed) throw new Error('Empty PowerShell output');
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (firstErr) {
    const lo = trimmed.indexOf('{');
    const hi = trimmed.lastIndexOf('}');
    if (lo === -1 || hi <= lo) throw firstErr;
    parsed = JSON.parse(trimmed.slice(lo, hi + 1));
  }
  return parsed;
}

const STARTUP_REPORT_SCHEMA = 'galaxy-startup-report-v1';

/**
 * Human-readable log bundled next to JSON for paste / file workflows (no secrets).
 * @param {Record<string, unknown>} base snapshot fields only — omit report_log / report_schema
 */
function buildStartupReportLog(base) {
  const lines = [];
  lines.push('Galaxy Products — Startup apps report');
  lines.push(`Schema: ${STARTUP_REPORT_SCHEMA}`);
  lines.push(`Generated: ${base.scanned_at || '—'} (ISO)`);
  lines.push(`Platform: ${base.platform ?? '—'}`);
  lines.push(`Source: ${base.source ?? '—'}`);
  const nEnt = Array.isArray(base.entries) ? base.entries.length : 0;
  lines.push(`Total (WMI): ${base.total ?? '—'} · Rows in payload: ${base.entry_count ?? nEnt}`);
  if (base.truncated) lines.push(`Truncated at cap: ${base.cap ?? '?'}`);
  if (base.error) lines.push(`Error: ${base.error}`);
  lines.push('');
  lines.push('Notes:');
  lines.push(typeof base.notes === 'string' && base.notes ? base.notes : '—');
  lines.push('');
  const diags = Array.isArray(base.diagnostics) ? base.diagnostics : [];
  lines.push(`Diagnostics (${diags.length}):`);
  if (!diags.length) lines.push('  (none)');
  else diags.forEach((d) => lines.push(`  [${d.source}] ${d.detail}`));
  lines.push('');
  lines.push('Sample rows (name · location):');
  const ent = Array.isArray(base.entries) ? base.entries.slice(0, 12) : [];
  if (!ent.length) lines.push('  (none)');
  else ent.forEach((e) => lines.push(`  · ${e.name || '—'} — ${e.location || '—'}`));
  const more = nEnt - ent.length;
  if (more > 0) lines.push(`  … + ${more} more (see JSON entries[])`);
  return lines.join('\n');
}

/** Attach report_schema + report_log for export / Home paste viewer. */
function finalizeStartupPayload(base) {
  const report_log = buildStartupReportLog(base);
  return { ...base, report_schema: STARTUP_REPORT_SCHEMA, report_log };
}

async function snapshotStartupApps() {
  const notes =
    'From WMI Win32_StartupCommand: typical Run / RunOnce registry entries and Startup-folder programs. Some items managed only via Task Scheduler, policies, or modern Store apps may not appear — compare with Task Manager → Startup apps if something is missing.';

  if (process.platform !== 'win32') {
    return finalizeStartupPayload({
      scanned_at: new Date().toISOString(),
      platform: process.platform,
      notes,
      source: null,
      total: 0,
      truncated: false,
      cap: null,
      entry_count: 0,
      entries: [],
      diagnostics: [{ source: 'platform', detail: 'Startup enumeration runs on Windows hosts only.' }],
    });
  }

  /** @type {{ source: string; detail: string }[]} */
  const diagnostics = [];
  try {
    const raw = await execPowerShellFromScriptFile(WINDOWS_STARTUP_APPS_PS, {
      timeout: 55_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    /** @type {any} */
    const doc = parseStartupAppsPowerShellJson(raw);

    const rowObjs = coerceStartupEntriesArray(doc);

    const normalized = rowObjs.map((s) => {
      const cmd = startupPickStr(s, ['command', 'Command']);
      const cmdOut =
        typeof cmd === 'string' && cmd.length > 1200 ? `${cmd.slice(0, 1197)}…` : cmd || null;
      return {
        name: startupPickStr(s, ['name', 'Name']),
        command: cmdOut,
        location: startupPickStr(s, ['location', 'Location']),
        user: startupPickStr(s, ['user', 'User']),
      };
    });

    normalized.sort((a, b) => {
      const la = String(a.location || '');
      const lb = String(b.location || '');
      if (la !== lb) return la.localeCompare(lb);
      return String(a.name || '').localeCompare(String(b.name || ''));
    });

    const diagRaw = doc.diagnostics ?? doc.Diagnostics;
    let psDiag = [];
    if (Array.isArray(diagRaw)) psDiag = diagRaw;
    else if (diagRaw != null && typeof diagRaw === 'object') {
      const dk = Object.keys(diagRaw);
      if (dk.length && dk.every((k) => /^\d+$/.test(k))) {
        psDiag = dk.sort((a, b) => Number(a) - Number(b)).map((k) => diagRaw[k]);
      }
    }
    for (const d of psDiag) diagnostics.push({ source: 'powershell', detail: String(d) });

    const totalRaw = doc.total ?? doc.Total;
    const total =
      typeof totalRaw === 'number' && !Number.isNaN(totalRaw) ? totalRaw : normalized.length;
    const truncated = Boolean(doc.truncated ?? doc.Truncated);

    if (normalized.length === 0 && typeof totalRaw === 'number' && totalRaw > 0) {
      diagnostics.push({
        source: 'startup_parse',
        detail: `WMI reported ${totalRaw} rows but "entries" could not be read from PowerShell JSON (top-level keys: ${Object.keys(doc).join(', ')}).`,
      });
    }

    const capVal = doc.cap ?? doc.Cap;

    return finalizeStartupPayload({
      scanned_at: new Date().toISOString(),
      platform: 'win32',
      notes,
      source: doc.source || doc.Source || 'Win32_StartupCommand',
      total,
      truncated,
      cap: typeof capVal === 'number' && !Number.isNaN(capVal) ? capVal : null,
      entry_count: normalized.length,
      entries: normalized,
      diagnostics,
    });
  } catch (e) {
    diagnostics.push({
      source: 'startup_scan',
      detail: e?.message ? String(e.message) : 'Startup enumeration failed',
    });
    return finalizeStartupPayload({
      scanned_at: new Date().toISOString(),
      platform: 'win32',
      notes,
      source: null,
      total: 0,
      truncated: false,
      cap: null,
      entry_count: 0,
      entries: [],
      error: e?.message ? String(e.message) : 'Failed',
      diagnostics,
    });
  }
}

/** WMI WmiMonitorID → human-readable ASCII (EDID); one line per display. */
function parseMonitorEdidLines(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return lines.slice(0, 48).map((line) => {
    const p = line.split('|');
    return {
      manufacturer: p[0] || null,
      product_code_id: p[1] || null,
      friendly_name: p[2] || null,
      serial_edid: p[3] || null,
      instance_name: p[4] || null,
    };
  });
}

function normalizeWin32ProcessorsJson(parsed) {
  const arr = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : [];
  return arr.slice(0, 48).map((r) => ({
    socket_designation: r.SocketDesignation || null,
    name: r.Name || null,
    processor_id_hex: r.ProcessorId || null,
  }));
}

/** Per-line PowerShell compatible with WMI byte arrays → pipe-delimited ASCII. */
const WINDOWS_MONITOR_EDID_PS = `
Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorID | ForEach-Object {
  ((-join ($_.ManufacturerName | Where-Object { $_ -gt 0 } | ForEach-Object { [char]$_ })) + '|' +
  (-join ($_.ProductCodeID | Where-Object { $_ -gt 0 } | ForEach-Object { [char]$_ })) + '|' +
  (-join ($_.UserFriendlyName | Where-Object { $_ -gt 0 } | ForEach-Object { [char]$_ })) + '|' +
  (-join ($_.SerialNumberID | Where-Object { $_ -gt 0 } | ForEach-Object { [char]$_ })) + '|' +
  $_.InstanceName)
}
`.replace(/\r?\n/g, ' ');

/**
 * Firmware / motherboard / chassis / disks as reported by the OS on this machine
 * (WMI/DMI-style on Windows—same readings as many “serial checker” tools).
 */
async function snapshotPcIdentifiers() {
  const [
    systemR,
    biosR,
    baseboardR,
    chassisR,
    osR,
    diskR,
    cpuR,
    graphicsR,
    memLayoutR,
    winMonitorR,
    winProcessorR,
  ] = await Promise.all([
    trySi('system', () => si.system()),
    trySi('bios', () => si.bios()),
    trySi('baseboard', () => si.baseboard()),
    trySi('chassis', () => si.chassis()),
    trySi('os', () => si.osInfo()),
    trySi('diskLayout', () => si.diskLayout()),
    trySi('cpu', () => si.cpu()),
    trySi('graphics', () => si.graphics()),
    trySi('memLayout', () => si.memLayout()),
    process.platform === 'win32'
      ? trySi('monitor_edid', async () =>
          parseMonitorEdidLines(await execPowerShell(WINDOWS_MONITOR_EDID_PS)),
        )
      : Promise.resolve({ ok: true, data: [] }),
    process.platform === 'win32'
      ? trySi('processor_wmi', async () => {
          const txt = await execPowerShell(
            'Get-CimInstance Win32_Processor | Select-Object SocketDesignation,Name,ProcessorId | ConvertTo-Json -Compress -Depth 10',
          );
          const trimmed = txt.trim();
          if (!trimmed) return [];
          return JSON.parse(trimmed);
        })
      : Promise.resolve({ ok: true, data: [] }),
  ]);

  /** @type {any} */
  const diskLayouts = diskR.ok ? diskR.data : [];
  const disks = Array.isArray(diskLayouts)
    ? diskLayouts.slice(0, 48).map((d) => ({
        name: d.name || null,
        type: d.type || null,
        vendor: d.vendor || null,
        size_bytes: typeof d.size === 'number' ? d.size : null,
        serial: d.serialNum || null,
        firmware_revision: d.firmwareRevision || null,
      }))
    : [];

  const cpusWmi =
    winProcessorR.ok && winProcessorR.data !== undefined && winProcessorR.data !== null
      ? normalizeWin32ProcessorsJson(winProcessorR.data)
      : [];

  const cpuPayload =
    cpuR.ok && cpuR.data
      ? {
          manufacturer: cpuR.data.manufacturer || null,
          brand: cpuR.data.brand || null,
          speed_ghz:
            cpuR.data.speed != null ? +(Number(cpuR.data.speed) || 0).toFixed(2) : null,
          speed_max_ghz:
            cpuR.data.speedMax != null ? +(Number(cpuR.data.speedMax) || 0).toFixed(2) : null,
          cores_physical: cpuR.data.physicalCores ?? null,
          cores_logical: cpuR.data.cores ?? null,
          socket: cpuR.data.socket ?? null,
          stepping: cpuR.data.stepping ?? null,
          revision: cpuR.data.revision ?? null,
          cpus_packages:
            cpusWmi.length > 0
              ? cpusWmi.length
              : cpuR.data.processors != null
                ? cpuR.data.processors
                : null,
          virtualization_reports_hypervisor:
            cpuR.data.virtualization === true ? true : cpuR.data.virtualization === false ? false : null,
        }
      : { error: cpuR.ok ? null : cpuR.error };

  const gpuControllers =
    graphicsR.ok &&
    graphicsR.data?.controllers &&
    Array.isArray(graphicsR.data.controllers)
      ? graphicsR.data.controllers.slice(0, 24).map((c) => ({
          vendor: c.vendor || null,
          model: c.model || null,
          bus: c.bus || null,
          vram_mb: typeof c.vram === 'number' ? +Number(c.vram).toFixed(0) : null,
          vram_dynamic:
            c.vramDynamic === true ? true : c.vramDynamic === false ? false : null,
          pci_subsystem_id_hex: c.subDeviceId ?? null,
        }))
      : [];

  const gpuDisplays =
    graphicsR.ok &&
    graphicsR.data?.displays &&
    Array.isArray(graphicsR.data.displays)
      ? graphicsR.data.displays.slice(0, 24).map((d) => {
          let res = null;
          if (d.currentResX && d.currentResY)
            res = `${d.currentResX}x${d.currentResY}`;
          else if (d.resolutionX && d.resolutionY) res = `${d.resolutionX}x${d.resolutionY}`;
          const hz =
            typeof d.currentRefreshRate === 'number'
              ? d.currentRefreshRate
              : typeof d.refreshRate === 'number'
                ? d.refreshRate
                : null;
          return {
            vendor: d.vendor || null,
            model: d.model || null,
            label: d.deviceName || null,
            main: d.main === true,
            builtin: d.builtin ?? null,
            connection: d.connection || null,
            resolution: res,
            refresh_hz: hz != null ? hz : null,
            image_size_approx_cm:
              typeof d.sizeX === 'number' && typeof d.sizeY === 'number'
                ? `${d.sizeX}×${d.sizeY} cm`
                : null,
          };
        })
      : [];

  const memoryModulesRaw = memLayoutR.ok && Array.isArray(memLayoutR.data)
    ? memLayoutR.data.filter((m) => m.size > 0)
    : [];

  const memory_modules = memoryModulesRaw.slice(0, 96).map((m) => ({
    bank: m.bank || null,
    type: m.type || null,
    form_factor: m.formFactor ?? null,
    size_bytes: typeof m.size === 'number' ? m.size : null,
    speed_mhz: m.clockSpeed != null ? Number(m.clockSpeed) : null,
    manufacturer: m.manufacturer || null,
    part_number: m.partNum || null,
    serial: m.serialNum || null,
    ecc: typeof m.ecc === 'boolean' ? m.ecc : null,
  }));

  const monitor_edid = Array.isArray(winMonitorR?.data)
    ? winMonitorR.data
    : [];

  const payload = {
    scanned_at: new Date().toISOString(),
    node_platform: process.platform,
    notes:
      'Consumer PCs rarely expose sticker serials for CPU/GPU in software. WMI ProcessorId / PCI SUBSYS IDs are firmware/vendoring identifiers. Monitor serial often comes from EDID (WMI WmiMonitorID) when the panel reports it.',
    diagnostics: [
      ...[
        systemR,
        biosR,
        baseboardR,
        chassisR,
        osR,
        diskR,
        cpuR,
        graphicsR,
        memLayoutR,
        winMonitorR,
        winProcessorR,
      ]
        .filter((r) => !r.ok && r.error)
        .map((r) => ({ source: r.label || 'subsystem', detail: r.error })),
    ],
    machine:
      systemR.ok && systemR.data
        ? {
            manufacturer: systemR.data.manufacturer,
            model: systemR.data.model,
            version: systemR.data.version,
            serial: systemR.data.serial,
            sku: systemR.data.sku,
            uuid: systemR.data.uuid,
            virtual: systemR.data.virtual ?? null,
            virtual_host: systemR.data.virtualHost || null,
          }
        : { error: systemR.error },
    motherboard:
      baseboardR.ok && baseboardR.data
        ? {
            manufacturer: baseboardR.data.manufacturer,
            model: baseboardR.data.model,
            version: baseboardR.data.version,
            serial: baseboardR.data.serial,
            asset_tag: baseboardR.data.assetTag,
          }
        : { error: baseboardR.error },
    bios:
      biosR.ok && biosR.data
        ? {
            vendor: biosR.data.vendor,
            version: biosR.data.version,
            release_date: biosR.data.releaseDate,
            revision: biosR.data.revision,
            serial: biosR.data.serial,
          }
        : { error: biosR.error },
    chassis:
      chassisR.ok && chassisR.data
        ? {
            manufacturer: chassisR.data.manufacturer,
            model: chassisR.data.model,
            type: chassisR.data.type,
            serial: chassisR.data.serial,
            sku: chassisR.data.sku,
          }
        : { error: chassisR.error },
    os:
      osR.ok && osR.data
        ? {
            hostname: osR.data.hostname,
            distro: osR.data.distro,
            release: osR.data.release,
            serial: osR.data.serial ?? null,
            build: osR.data.build ?? null,
            codename: osR.data.codename ?? null,
            service_pack: osR.data.servicepack ?? null,
            kernel: osR.data.kernel,
            arch: osR.data.arch,
            hypervisor_present: typeof osR.data.hypervisor === 'boolean' ? osR.data.hypervisor : null,
            uefi: typeof osR.data.uefi === 'boolean' ? osR.data.uefi : null,
            remote_session: typeof osR.data.remoteSession === 'boolean' ? osR.data.remoteSession : null,
          }
        : { error: osR.error },
    cpu: cpuPayload,
    cpu_processor_wmi: cpusWmi,
    gpu_controllers: gpuControllers.length || !graphicsR.ok ? gpuControllers : [],
    gpu_displays: gpuDisplays.length || !graphicsR.ok ? gpuDisplays : [],
    memory_modules,
    monitor_edid,
    disks,
  };

  const plainGather = await snapshotWindowsReportExtrasAndArp();
  for (const row of plainGather.diagnostics) {
    payload.diagnostics.push({ source: row.source, detail: row.detail });
  }
  payload.serial_dump_text = formatVerseStyleSerialDump(payload, plainGather.extras, plainGather.arp_text);

  return payload;
}

/**
 * Resolve BM numeric player id from SteamID64 via quick-match then full match.
 * BM may omit players your API token/org has never had admin correlation with
 * (see BM_PAIRING_HELP_URL).
 */
async function bmResolvePlayerIdFromSteam(steamId64, headers) {
  const body = JSON.stringify({
    data: [{
      type: 'identifier',
      attributes: { type: 'steamID', identifier: String(steamId64) },
    }],
  });

  /** @returns {string|null} */
  function firstPlayerId(matchDoc) {
    const rows = Array.isArray(matchDoc?.data) ? matchDoc.data : [];
    for (const row of rows) {
      const pid = row?.relationships?.player?.data?.id;
      if (pid) return String(pid);
    }
    return null;
  }

  let identifierPrivate = false;

  async function attempt(path) {
    const res = await fetch(`${BM_BASE}${path}`, { method: 'POST', headers, body });
    const text = await res.text();
    /** @type {any} */
    let doc = {};
    try {
      doc = JSON.parse(text);
    } catch {
      return { ok: false, httpStatus: res.status, snippet: text.slice(0, 200), resolvedVia: path };
    }
    const rows = Array.isArray(doc?.data) ? doc.data : [];
    for (const row of rows) {
      if (row?.attributes?.private === true) identifierPrivate = true;
    }
    const pid = firstPlayerId(doc);
    if (pid) return { ok: true, bmPlayerId: pid, identifierPrivate, resolvedVia: path };
    return { ok: res.ok, httpStatus: res.status, errors: doc?.errors, resolvedVia: path, identifierPrivate };
  }

  let r = await attempt('/players/quick-match');
  if (r.bmPlayerId) return { bmPlayerId: r.bmPlayerId, identifierPrivate: r.identifierPrivate, resolvedVia: 'quick-match' };
  r = await attempt('/players/match');
  if (r.bmPlayerId) return { bmPlayerId: r.bmPlayerId, identifierPrivate: r.identifierPrivate, resolvedVia: 'match' };
  return { bmPlayerId: null, identifierPrivate, resolvedVia: null };
}

/**
 * Uses Battlemetrics quick-match (SteamID → BM player id) plus player servers.
 * Hours are summed only where relationship game id === "rust". BM caps server
 * refs per profile (often ≤100 servers); excludes Rust servers BM doesn't track.
 * @param {string} steamId
 * @param {{ manualBmPlayerId?: string|null }} [opts]
 */
async function fetchBattlemetricsRustSummary(steamId, opts = {}) {
  const headers = bmHeaders();
  if (!headers) return { configured: false };

  const redactSnippet = async (res) => (await res.text()).slice(0, 260);

  let bmPlayerId = null;
  let identifierPrivate = false;
  /** @type {string|null} */
  let resolvedVia = null;

  const manual = opts.manualBmPlayerId && String(opts.manualBmPlayerId).replace(/\D/g, '');
  if (manual && /^\d+$/.test(manual)) {
    bmPlayerId = manual;
    resolvedVia = 'manual';
  } else {
    const resolved = await bmResolvePlayerIdFromSteam(steamId, headers);
    bmPlayerId = resolved.bmPlayerId;
    identifierPrivate = resolved.identifierPrivate;
    resolvedVia = resolved.resolvedVia;
  }

  if (!bmPlayerId) {
    return {
      configured: true,
      found: false,
      identifier_private: identifierPrivate,
      steam_match_attempted: !manual,
      pairing_help_url: BM_PAIRING_HELP_URL,
      bm_profile_search_url: `https://www.battlemetrics.com/players?filter[search]=${encodeURIComponent(steamId)}`,
      explain:
        'Battlemetrics often only exposes Steam → player linking when your API account or organization has admin rights on servers that player has joined. Personal tokens may get no match even if a public BM web profile exists. Use Settings → “Battlemetrics player ID” with the number from your BM profile URL as a workaround.',
    };
  }

  const bmProfileUrl = `https://www.battlemetrics.com/players/${bmPlayerId}`;
  const u = new URL(`${BM_BASE}/players/${encodeURIComponent(bmPlayerId)}`);
  u.searchParams.set('include', 'server');

  const pRes = await fetch(u, { headers });
  if (!pRes.ok) {
    return {
      configured: true,
      found: true,
      bm_player_id: bmPlayerId,
      bm_profile_url: bmProfileUrl,
      identifier_private: identifierPrivate,
      error: `Battlemetrics player fetch failed (${pRes.status}): ${await redactSnippet(pRes)}`,
    };
  }

  const doc = await pRes.json();
  const serverRefs = doc?.data?.relationships?.servers?.data || [];
  const included = doc?.included || [];
  const serverById = new Map(included.filter((x) => x.type === 'server').map((s) => [s.id, s]));

  /** @type {{ server_id:string, name:string, seconds:number, hours:number, last_seen:string|null, first_seen:string|null, online:boolean }[]} */
  const rustRows = [];

  let rustSecondsSum = 0;

  for (const ref of serverRefs) {
    const sid = ref.id;
    const meta = ref.meta || {};
    const secs = typeof meta.timePlayed === 'number' ? meta.timePlayed : 0;
    const srv = serverById.get(sid);
    const gameSlug = srv?.relationships?.game?.data?.id ?? null;
    if (gameSlug !== 'rust') continue;

    rustSecondsSum += secs;
    const name = srv?.attributes?.name || `Server ${sid}`;
    rustRows.push({
      server_id: sid,
      name,
      seconds: secs,
      hours: +((secs / 3600).toFixed(2)),
      last_seen: meta.lastSeen ?? null,
      first_seen: meta.firstSeen ?? null,
      online: !!meta.online,
    });
  }

  rustRows.sort((a, b) => b.seconds - a.seconds);
  const totalServerRefs = serverRefs.length;

  return {
    configured: true,
    found: true,
    bm_player_id: bmPlayerId,
    bm_profile_url: bmProfileUrl,
    identifier_private: identifierPrivate,
    paired_via: resolvedVia,
    tracked_seconds_total: rustSecondsSum,
    tracked_hours_total: +(rustSecondsSum / 3600).toFixed(2),
    rust_server_count_with_time_on_bm: rustRows.length,
    /** BM returns at most ~100 servers on the profile; totals may omit some playtime */
    bm_server_refs_returned: totalServerRefs,
    bm_server_refs_likely_capped_at_100: totalServerRefs >= 100,
    top_rust_servers: rustRows.slice(0, 10),
    caveat: 'BattleMetrics counts connected time only on Rust servers it tracks (not all unofficial servers appear). Steam "Rust" hours are full client time and can be much larger.',
  };
}

if (!API_KEY || API_KEY === 'PASTE_YOUR_NEW_KEY_HERE' || API_KEY === 'your_steam_web_api_key_here') {
  console.error('\n[!] STEAM_API_KEY is not set in .env');
  console.error('    Get one (free) at: https://steamcommunity.com/dev/apikey');
  console.error('    Then put it in steamwebbot/.env and restart.\n');
}

app.get(/^\/steam-web-hour-checker$/i, (_req, res) => res.redirect(302, '/steam-web-hour-checker/'));
app.get(/^\/game-updates$/i, (_req, res) => res.redirect(302, '/game-updates/'));
app.get(/^\/loader$/i, (_req, res) => res.redirect(302, '/loader/'));

/** Old bookmarks `/` — send Steam lookups straight into the checker under /steam-web-hour-checker/ */
app.get('/', (req, res, next) => {
  const q = req.query.q;
  const hasLookup =
    (typeof q === 'string' && q.trim() !== '') ||
    (Array.isArray(q) && q.some((s) => String(s).trim()));
  if (!hasLookup) return next();
  const i = req.originalUrl.indexOf('?');
  const qs = i >= 0 ? req.originalUrl.slice(i + 1) : '';
  return res.redirect(302, qs ? `/steam-web-hour-checker/?${qs}` : `/steam-web-hour-checker/`);
});

const STEAM_BASE = 'https://api.steampowered.com';

async function steamCall(pathAndQuery) {
  const url = `${STEAM_BASE}${pathAndQuery}${pathAndQuery.includes('?') ? '&' : '?'}key=${API_KEY}&format=json`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Steam API ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Accepts: 17-digit SteamID64, vanity name, or full profile URL.
// Returns resolved SteamID64 string.
async function resolveSteamId(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Empty input');

  // Try to extract from a profile URL.
  const urlProfilesMatch = raw.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
  if (urlProfilesMatch) return urlProfilesMatch[1];

  const urlIdMatch = raw.match(/steamcommunity\.com\/id\/([^\/\?#]+)/i);
  const candidate = urlIdMatch ? urlIdMatch[1] : raw;

  // If candidate is already a 17-digit numeric SteamID64, return it.
  if (/^\d{17}$/.test(candidate)) return candidate;

  // Otherwise treat as vanity name.
  const data = await steamCall(`/ISteamUser/ResolveVanityURL/v1/?vanityurl=${encodeURIComponent(candidate)}`);
  if (data?.response?.success === 1 && data.response.steamid) {
    return data.response.steamid;
  }
  throw new Error(`Could not resolve "${candidate}" to a SteamID. Check the spelling or try the SteamID64 directly.`);
}

// Soft-fail wrapper: if a call errors (e.g. private profile), return null instead of throwing.
async function tryCall(fn) {
  try { return await fn(); } catch (e) { return { __error: e.message }; }
}

app.get('/api/lookup', async (req, res) => {
  const input = req.query.q;
  if (!input) return res.status(400).json({ error: 'Missing query param "q"' });
  if (!API_KEY || API_KEY.startsWith('PASTE_') || API_KEY === 'your_steam_web_api_key_here') {
    return res.status(500).json({ error: 'Server is missing STEAM_API_KEY. See .env file.' });
  }

  let steamId;
  try {
    steamId = await resolveSteamId(input);
  } catch (e) {
    return res.status(404).json({ error: e.message });
  }

  const bmPlayerOverrideRaw = typeof req.query.bm_player === 'string' ? req.query.bm_player.trim().replace(/\D/g, '') : '';
  const bmPlayerOverride = /^\d+$/.test(bmPlayerOverrideRaw) ? bmPlayerOverrideRaw : null;

  // Fire all calls in parallel, soft-failing private/restricted endpoints.
  const [summary, level, badges, ownedGames, recent, bans, friends, bmRustOrErr] = await Promise.all([
    tryCall(() => steamCall(`/ISteamUser/GetPlayerSummaries/v2/?steamids=${steamId}`)),
    tryCall(() => steamCall(`/IPlayerService/GetSteamLevel/v1/?steamid=${steamId}`)),
    tryCall(() => steamCall(`/IPlayerService/GetBadges/v1/?steamid=${steamId}`)),
    tryCall(() => steamCall(`/IPlayerService/GetOwnedGames/v1/?steamid=${steamId}&include_appinfo=1&include_played_free_games=1`)),
    tryCall(() => steamCall(`/IPlayerService/GetRecentlyPlayedGames/v1/?steamid=${steamId}`)),
    tryCall(() => steamCall(`/ISteamUser/GetPlayerBans/v1/?steamids=${steamId}`)),
    tryCall(() => steamCall(`/ISteamUser/GetFriendList/v1/?steamid=${steamId}&relationship=friend`)),
    tryCall(async () => {
      try {
        return await fetchBattlemetricsRustSummary(steamId, { manualBmPlayerId: bmPlayerOverride });
      } catch (e) {
        return { configured: !!BM_TOKEN_RAW, error: String(e.message || e) };
      }
    }),
  ]);

  const player = summary?.response?.players?.[0] || null;
  const ownedList = ownedGames?.response?.games || [];

  const rustSteamEntry = ownedList.find((g) => g.appid === RUST_STEAM_APPID);
  const rustSteamMinutes = rustSteamEntry ? (rustSteamEntry.playtime_forever || 0) : 0;
  const bmRust = bmRustOrErr && !bmRustOrErr.__error ? bmRustOrErr : {
    configured: !!BM_TOKEN_RAW,
    error: bmRustOrErr?.__error || null,
  };
  /** Same heuristic as totals.private_library (empty response object, no games) */
  const privateLibraryGuess =
    ownedList.length === 0 &&
    ownedGames?.response &&
    typeof ownedGames.response === 'object' &&
    Object.keys(ownedGames.response).length === 0;

  const rustSectionVisible = !!rustSteamEntry || bmRust?.configured === true;
  const totalMinutes = ownedList.reduce((s, g) => s + (g.playtime_forever || 0), 0);

  // Sort owned games by hours desc.
  const gamesSorted = ownedList
    .map(g => ({
      appid: g.appid,
      name: g.name,
      icon: g.img_icon_url ? `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${g.img_icon_url}.jpg` : null,
      header: `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/header.jpg`,
      hours: +(((g.playtime_forever || 0) / 60).toFixed(1)),
      hours_2weeks: +(((g.playtime_2weeks || 0) / 60).toFixed(1)),
      last_played: g.rtime_last_played ? new Date(g.rtime_last_played * 1000).toISOString() : null,
    }))
    .sort((a, b) => b.hours - a.hours);

  const recentList = (recent?.response?.games || []).map(g => ({
    appid: g.appid,
    name: g.name,
    icon: g.img_icon_url ? `https://media.steampowered.com/steamcommunity/public/images/apps/${g.appid}/${g.img_icon_url}.jpg` : null,
    header: `https://cdn.cloudflare.steamstatic.com/steam/apps/${g.appid}/header.jpg`,
    hours_2weeks: +(((g.playtime_2weeks || 0) / 60).toFixed(1)),
    hours_total: +(((g.playtime_forever || 0) / 60).toFixed(1)),
  }));

  const banInfo = bans?.players?.[0] || null;
  const friendCount = friends?.friendslist?.friends?.length ?? null;

  res.json({
    steamid: steamId,
    profile_url: `https://steamcommunity.com/profiles/${steamId}`,
    profile: player ? {
      persona_name: player.personaname,
      real_name: player.realname || null,
      avatar: player.avatarfull,
      profile_url: player.profileurl,
      country: player.loccountrycode || null,
      state: player.locstatecode || null,
      visibility: player.communityvisibilitystate, // 1 = private, 3 = public
      profile_state: player.profilestate, // 1 = configured
      persona_state: player.personastate, // 0 offline ... 1 online ...
      account_created: player.timecreated ? new Date(player.timecreated * 1000).toISOString() : null,
      last_logoff: player.lastlogoff ? new Date(player.lastlogoff * 1000).toISOString() : null,
      currently_playing: player.gameextrainfo || null,
      currently_playing_appid: player.gameid || null,
    } : null,
    level: {
      level: level?.response?.player_level ?? null,
      xp: badges?.response?.player_xp ?? null,
      xp_to_next: badges?.response?.player_xp_needed_to_level_up ?? null,
      xp_current_level: badges?.response?.player_xp_needed_current_level ?? null,
      badge_count: badges?.response?.badges?.length ?? null,
    },
    totals: {
      games_owned: ownedList.length,
      total_hours: +(totalMinutes / 60).toFixed(1),
      total_minutes: totalMinutes,
      private_library: ownedList.length === 0 && (ownedGames?.response && Object.keys(ownedGames.response).length === 0),
    },
    games: gamesSorted,
    recent: recentList,
    bans: banInfo ? {
      community_banned: banInfo.CommunityBanned,
      vac_banned: banInfo.VACBanned,
      vac_bans: banInfo.NumberOfVACBans,
      days_since_last_ban: banInfo.DaysSinceLastBan,
      game_bans: banInfo.NumberOfGameBans,
      economy_ban: banInfo.EconomyBan,
    } : null,
    friends: {
      count: friendCount,
      private: friendCount === null,
    },
    rust_aggregate: rustSectionVisible ? {
      steam_app_id: RUST_STEAM_APPID,
      owns_on_steam: !!rustSteamEntry,
      steam_hours: rustSteamEntry ? +(rustSteamMinutes / 60).toFixed(1) : null,
      steam_rust_hours_unavailable: privateLibraryGuess && !rustSteamEntry,
      steam_rust_hours_unavailable_hint: privateLibraryGuess && !rustSteamEntry
        ? 'Steam game library is private or empty — Facepunch hours are hidden.'
        : null,
      battlemetrics: bmRust,
    } : null,
    diagnostics: {
      summary_error: summary?.__error || null,
      level_error: level?.__error || null,
      badges_error: badges?.__error || null,
      owned_error: ownedGames?.__error || null,
      recent_error: recent?.__error || null,
      bans_error: bans?.__error || null,
      friends_error: friends?.__error || null,
      battlemetrics_error: bmRustOrErr?.__error || null,
    },
  });
});

// ----------------------------------------------------------------------------
// Profile extras: equipped profile background, mini-profile bg, animated avatar.
// Uses IPlayerService/GetProfileItemsEquipped which is sometimes blocked at Valve's
// edge with 401 even with a valid key. We soft-fail the whole call.
// ----------------------------------------------------------------------------
app.get('/api/profile-extras', async (req, res) => {
  const steamid = req.query.steamid;
  if (!steamid || !/^\d{17}$/.test(steamid)) {
    return res.status(400).json({ error: 'Invalid steamid' });
  }
  try {
    const data = await steamCall(`/IPlayerService/GetProfileItemsEquipped/v1/?steamid=${steamid}`);
    const r = data?.response || {};
    // image_large is a CDN-relative path served from steamcommunity-a.akamaihd.net.
    const cdn = (img) => img ? `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/items/${img}` : null;
    res.json({
      profile_background: cdn(r.profile_background?.image_large),
      mini_profile_background: cdn(r.mini_profile_background?.image_large),
      avatar_frame: cdn(r.avatar_frame?.image_small),
      animated_avatar: cdn(r.animated_avatar?.image_small),
      profile_modifier: cdn(r.profile_modifier?.image_small),
    });
  } catch (e) {
    res.json({
      profile_background: null,
      mini_profile_background: null,
      avatar_frame: null,
      animated_avatar: null,
      profile_modifier: null,
      error: e.message,
    });
  }
});

// ----------------------------------------------------------------------------
// Game detail: schema + player's achievements/stats for one app.
// ----------------------------------------------------------------------------
app.get('/api/game/:appid', async (req, res) => {
  const appid = req.params.appid;
  const steamid = req.query.steamid;
  if (!/^\d+$/.test(appid)) return res.status(400).json({ error: 'Invalid appid' });
  if (!/^\d{17}$/.test(steamid)) return res.status(400).json({ error: 'Invalid steamid' });

  const [schema, playerAchievements, globalAchievements] = await Promise.all([
    tryCall(() => steamCall(`/ISteamUserStats/GetSchemaForGame/v2/?appid=${appid}&l=english`)),
    tryCall(() => steamCall(`/ISteamUserStats/GetPlayerAchievements/v1/?appid=${appid}&steamid=${steamid}&l=english`)),
    tryCall(() => steamCall(`/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=${appid}`)),
  ]);

  const schemaAch = schema?.game?.availableGameStats?.achievements || [];
  const playerAch = playerAchievements?.playerstats?.achievements || [];
  const globalAch = globalAchievements?.achievementpercentages?.achievements || [];

  const playerByName = new Map(playerAch.map(a => [a.apiname, a]));
  const globalByName = new Map(globalAch.map(a => [a.name, a.percent]));

  const merged = schemaAch.map(s => {
    const p = playerByName.get(s.name);
    const rawPct = globalByName.get(s.name);
    const pct = Number(rawPct);
    return {
      api_name: s.name,
      display_name: s.displayName || s.name,
      description: s.description || '',
      hidden: s.hidden === 1,
      icon: s.icon || null,
      icon_gray: s.icongray || null,
      achieved: !!p?.achieved,
      unlock_time: p?.unlocktime ? new Date(p.unlocktime * 1000).toISOString() : null,
      global_percent: Number.isFinite(pct) ? +pct.toFixed(2) : null,
    };
  });

  const total = merged.length;
  const achieved = merged.filter(a => a.achieved).length;

  // Sort: achieved first by recency, then unachieved by global percent desc (easiest first).
  merged.sort((a, b) => {
    if (a.achieved !== b.achieved) return a.achieved ? -1 : 1;
    if (a.achieved && b.achieved) {
      return (b.unlock_time || '').localeCompare(a.unlock_time || '');
    }
    return (b.global_percent || 0) - (a.global_percent || 0);
  });

  res.json({
    appid: +appid,
    name: schema?.game?.gameName || null,
    achievements: merged,
    total,
    achieved,
    completion_pct: total > 0 ? +((achieved / total) * 100).toFixed(1) : null,
    has_achievements: total > 0,
    diagnostics: {
      schema_error: schema?.__error || null,
      player_error: playerAchievements?.__error || null,
      global_error: globalAchievements?.__error || null,
    },
  });
});

/** Latest patch-style posts are usually under Steam Community Announcements in ISteamNews. */
const STEAM_NEWS_COMMUNITY = 'steam_community_announcements';

async function fetchSteamNewsForApp(appid) {
  const keyQs =
    API_KEY && !String(API_KEY).startsWith('PASTE_') && API_KEY !== 'your_steam_web_api_key_here'
      ? `&key=${encodeURIComponent(API_KEY)}`
      : '';
  const url = `${STEAM_BASE}/ISteamNews/GetNewsForApp/v0002/?appid=${encodeURIComponent(String(appid))}&count=100&maxlength=240&format=json${keyQs}`;
  const r = await fetch(url);
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Steam news ${r.status}: ${t.slice(0, 160)}`);
  }
  return r.json();
}

async function fetchStoreAppName(appid) {
  const url = `https://store.steampowered.com/api/appdetails?appids=${encodeURIComponent(String(appid))}&l=english`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const j = await r.json();
  const block = j[String(appid)];
  if (!block?.success || !block.data?.name) return null;
  return String(block.data.name);
}

function steamNewsItemToPayload(top) {
  if (!top) return null;
  return {
    title: top.title || '—',
    date_unix: top.date,
    date_iso: new Date((top.date || 0) * 1000).toISOString(),
    url: top.url || null,
    feedlabel: top.feedlabel || top.feedname || null,
    feedname: top.feedname || null,
  };
}

/**
 * Primary timeline: newest item across *all* Steam news feeds (press + dev). Matches “something
 * happened on Steam recently” better than dev posts alone (closer to SteamDB Last Record Update).
 * Secondary: latest developer Community Announcement when different.
 */
function pickSteamNewsSignals(json) {
  const items = json?.appnews?.newsitems;
  if (!Array.isArray(items) || items.length === 0) {
    return { newestAny: null, newestCommunity: null };
  }
  const sortedAll = [...items].sort((a, b) => (b.date || 0) - (a.date || 0));
  const community = items.filter((n) => n.feedname === STEAM_NEWS_COMMUNITY);
  const sortedComm = [...community].sort((a, b) => (b.date || 0) - (a.date || 0));

  return {
    newestAny: steamNewsItemToPayload(sortedAll[0]),
    newestCommunity: sortedComm.length ? steamNewsItemToPayload(sortedComm[0]) : null,
  };
}

/**
 * GET /api/game-updates?appids=252490,730
 * Newest Steam news item (any feed) is the main clock — closer to “everything that touched the app
 * on Steam” than dev-only posts. SteamDB “Last Record Update” is not available via API (403).
 */
app.get('/api/game-updates', async (req, res) => {
  const raw = typeof req.query.appids === 'string' ? req.query.appids : '';
  const ids = [
    ...new Set(
      raw
        .split(/[,]+/)
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s))
        .map((s) => parseInt(s, 10))
        .filter((n) => n > 0 && n <= 2147483647),
    ),
  ].slice(0, 24);
  if (!ids.length) {
    return res.status(400).json({ error: 'Missing or invalid appids (comma-separated Steam app IDs), e.g. appids=252490' });
  }

  const fetchedAt = new Date().toISOString();
  const games = await Promise.all(
    ids.map(async (appid) => {
      try {
        const [news, nameFromStore] = await Promise.all([fetchSteamNewsForApp(appid), fetchStoreAppName(appid)]);
        const { newestAny, newestCommunity } = pickSteamNewsSignals(news);
        const latestCommunityIsNewest =
          newestAny &&
          newestCommunity &&
          Number(newestAny.date_unix) === Number(newestCommunity.date_unix);
        return {
          appid,
          name: nameFromStore,
          latest: newestAny,
          latest_dev_post: newestCommunity && !latestCommunityIsNewest ? newestCommunity : null,
          from_community_announcements: newestAny?.feedname === STEAM_NEWS_COMMUNITY,
          steamdb_patchnotes_url: `https://steamdb.info/app/${appid}/patchnotes/`,
          steamdb_app_url: `https://steamdb.info/app/${appid}/`,
          error: null,
        };
      } catch (e) {
        return {
          appid,
          name: null,
          latest: null,
          latest_dev_post: null,
          from_community_announcements: false,
          steamdb_patchnotes_url: `https://steamdb.info/app/${appid}/patchnotes/`,
          steamdb_app_url: `https://steamdb.info/app/${appid}/`,
          error: e?.message ? String(e.message) : 'Request failed',
        };
      }
    }),
  );

  res.json({ fetched_at: fetchedAt, games });
});

// ----------------------------------------------------------------------------
// Local PC serial / firmware identifiers (SMBIOS/WMI)—only from loopback.
// ----------------------------------------------------------------------------
app.get('/api/pc-serials', async (req, res) => {
  if (!isLoopbackReq(req)) {
    return res.status(403).json({
      error: 'This endpoint only works when the browser and Node server both run on the same machine (127.0.0.1).',
    });
  }
  try {
    const data = await snapshotPcIdentifiers();
    res.json(data);
  } catch (e) {
    res.status(500).json({
      error: e?.message || 'Failed to read system identifiers.',
    });
  }
});

// ----------------------------------------------------------------------------
// Security hints / Defender quick scan (localhost only — same as /api/pc-serials policy).
// ----------------------------------------------------------------------------
app.get('/api/pc-threat-hints', async (req, res) => {
  if (!isLoopbackReq(req)) {
    return res.status(403).json({
      error:
        'This endpoint only runs when your browser hits the hub on localhost / 127.0.0.1 — it inspects processes on this PC.',
    });
  }
  try {
    const data = await snapshotPcThreatHints();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e?.message ? String(e.message) : 'Threat hint scan failed.' });
  }
});

// ----------------------------------------------------------------------------
// Startup programs (WMI Win32_StartupCommand) — localhost only.
// ----------------------------------------------------------------------------
app.get('/api/startup-apps', async (req, res) => {
  if (!isLoopbackReq(req)) {
    return res.status(403).json({
      error: 'Use localhost / 127.0.0.1 only — startup data is read from this PC.',
    });
  }
  try {
    const data = await snapshotStartupApps();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e?.message ? String(e.message) : 'Startup enumeration failed.' });
  }
});

/**
 * Starts Windows Defender "Quick scan" via MpCmdRun.exe (slow; may fail without Defender).
 * localhost only.
 */
app.post('/api/defender-quick-scan', async (req, res) => {
  if (!isLoopbackReq(req)) {
    return res.status(403).json({ error: 'Use localhost / 127.0.0.1 only.' });
  }
  if (process.platform !== 'win32') {
    return res.status(400).json({ ok: false, error: 'Defender MpCmdRun is only available on Windows.' });
  }
  const exe = findWindowsDefenderMpCmdRun();
  if (!exe) {
    return res.status(503).json({
      ok: false,
      error:
        'MpCmdRun.exe not found under Program Files\\Windows Defender. Defender may be removed or reorganized on this SKU.',
    });
  }

  try {
    const { stdout, stderr } = await execFileAsync(exe, ['-Scan', '-ScanType', '1'], {
      timeout: DEFENDER_SCAN_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    });
    return res.json({
      ok: true,
      timed_out: false,
      exit_code: 0,
      mp_cmd_run: exe,
      stdout: stdout != null ? String(stdout) : '',
      stderr: stderr != null ? String(stderr) : '',
    });
  } catch (e) {
    const stdout =
      typeof e.stdout === 'string' || Buffer.isBuffer(e.stdout) ? String(e.stdout) : '';
    const stderr =
      typeof e.stderr === 'string' || Buffer.isBuffer(e.stderr) ? String(e.stderr) : '';
    /** @type {any} */
    const errAny = e;
    const timedOut = errAny?.code === 'ETIMEDOUT' || Boolean(errAny?.killed && errAny?.signal === 'SIGTERM');
    const code = typeof errAny?.code === 'number' ? errAny.code : null;
    return res.status(200).json({
      ok: code === 0,
      timed_out: timedOut,
      exit_code: code,
      error: timedOut
        ? `Scan timed out after ${DEFENDER_SCAN_TIMEOUT_MS}ms (see DEFENDER_SCAN_TIMEOUT_MS in .env).`
        : errAny?.message
          ? String(errAny.message)
          : stderr || 'MpCmdRun failed',
      mp_cmd_run: exe,
      stdout,
      stderr,
    });
  }
});

// ----------------------------------------------------------------------------
// Optional: run your external Windows serial checker .exe via Node (localhost only).
// Set SERIAL_CHECKER_EXE=C:\\path\\to\\Checker.exe in .env; optional SERIAL_CHECKER_ARGS="-json".
// POST JSON { "detach": true } starts the process in the background (no stdout wait) — default from the hub UI for GUI apps.
// ----------------------------------------------------------------------------
app.get('/api/external-serial-checker/status', (req, res) => {
  if (!isLoopbackReq(req)) {
    return res.status(403).json({
      configured: false,
      error: 'Use localhost / 127.0.0.1 only.',
    });
  }
  const exeEnv =
    SERIAL_CHECKER_EXE &&
    SERIAL_CHECKER_EXE.length > 0 &&
    SERIAL_CHECKER_EXE !== 'YOUR_SERIAL_CHECKER_ABSOLUTE_OR_RELATIVE_EXE_PATH_HERE';

  if (!exeEnv || !SERIAL_CHECKER_EXE) {
    return res.json({ configured: false });
  }

  const resolved = path.isAbsolute(SERIAL_CHECKER_EXE)
    ? SERIAL_CHECKER_EXE
    : path.join(__dirname, SERIAL_CHECKER_EXE);

  /** @type {{configured:true,exists:boolean,basename:string}} */
  const payload = {
    configured: true,
    exists: fs.existsSync(resolved),
    basename: path.basename(resolved),
  };
  res.json(payload);
});

app.post('/api/external-serial-checker/run', async (req, res) => {
  if (!isLoopbackReq(req)) {
    return res.status(403).json({
      error: 'This endpoint only works from the same PC (localhost / 127.0.0.1).',
    });
  }

  const exeHint =
    SERIAL_CHECKER_EXE &&
    SERIAL_CHECKER_EXE !== 'YOUR_SERIAL_CHECKER_ABSOLUTE_OR_RELATIVE_EXE_PATH_HERE'
      ? SERIAL_CHECKER_EXE
      : '';

  if (!exeHint || !SERIAL_CHECKER_EXE) {
    return res.status(503).json({
      error:
        'SERIAL_CHECKER_EXE is not set. Add the full path to your .exe in .env next to server.js.',
    });
  }

  const resolvedExe = path.isAbsolute(SERIAL_CHECKER_EXE)
    ? SERIAL_CHECKER_EXE
    : path.join(__dirname, SERIAL_CHECKER_EXE);

  if (!fs.existsSync(resolvedExe)) {
    return res.status(503).json({
      error: `SERIAL_CHECKER_EXE file not found: ${resolvedExe}`,
    });
  }

  const argv = exeArgsFromEnv(SERIAL_CHECKER_ARGS);
  const reqBody = req.body && typeof req.body === 'object' ? req.body : {};
  const detach = reqBody.detach === true;

  if (detach) {
    await new Promise((resolvePromise) => {
      const child = spawn(resolvedExe, argv, {
        cwd: path.dirname(resolvedExe),
        detached: true,
        stdio: 'ignore',
        windowsHide: process.platform === 'win32',
      });
      child.once('error', (err) => {
        if (!res.headersSent) {
          res.status(503).json({
            ok: false,
            detached: false,
            error: `Failed to start: ${err?.message ? String(err.message) : String(err)}`,
            stdout: '',
            stderr: '',
          });
        }
        resolvePromise(undefined);
      });
      child.once('spawn', () => {
        try {
          child.unref();
        } catch (_) {
          /* ignore */
        }
        if (!res.headersSent) {
          res.json({
            ok: true,
            detached: true,
            timed_out: false,
            exit_code: null,
            stdout: '',
            stderr: '',
            message: `${path.basename(
              resolvedExe,
            )} was started in the background (the hub did not wait for it to exit). Use its window — there is nothing to stream here.`,
          });
        }
        resolvePromise(undefined);
      });
    });
    return;
  }

  try {
    const { stdout, stderr } = await execFileAsync(resolvedExe, argv, {
      timeout: SERIAL_CHECKER_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: process.platform === 'win32',
      cwd: path.dirname(resolvedExe),
    });
    return res.json({
      ok: true,
      timed_out: false,
      exit_code: 0,
      stdout: stdout != null ? String(stdout) : '',
      stderr: stderr != null ? String(stderr) : '',
    });
  } catch (e) {
    const stdout =
      typeof e.stdout === 'string' || Buffer.isBuffer(e.stdout)
        ? String(e.stdout)
        : '';
    const stderr =
      typeof e.stderr === 'string' || Buffer.isBuffer(e.stderr)
        ? String(e.stderr)
        : '';

    /** @type {any} */
    const errAny = e;
    const timedOut = errAny?.code === 'ETIMEDOUT' || Boolean(errAny?.killed && errAny?.signal === 'SIGTERM');

    return res.status(200).json({
      ok: false,
      timed_out: timedOut,
      exit_code: typeof errAny?.code === 'number' ? errAny.code : null,
      error: timedOut ? `Exe timed out after ${SERIAL_CHECKER_TIMEOUT_MS}ms` : (errAny?.message || String(e)),
      stdout,
      stderr,
    });
  }
});

// ----------------------------------------------------------------------------
// Products & license-style keys (localhost only — stored on disk under data/).
// ----------------------------------------------------------------------------
const LICENSE_DATA_PATH = path.join(__dirname, 'data', 'license-store.json');

function loadLicenseStore() {
  try {
    const txt = fs.readFileSync(LICENSE_DATA_PATH, 'utf8');
    const j = JSON.parse(txt);
    return {
      products: Array.isArray(j.products) ? j.products : [],
      keys: Array.isArray(j.keys) ? j.keys : [],
    };
  } catch {
    return { products: [], keys: [] };
  }
}

function saveLicenseStore(store) {
  fs.mkdirSync(path.dirname(LICENSE_DATA_PATH), { recursive: true });
  fs.writeFileSync(LICENSE_DATA_PATH, JSON.stringify(store, null, 2), 'utf8');
}

/** When no store file exists yet, create one with a single starter product ("Product 1"). */
function bootstrapLicenseStoreIfMissing() {
  if (fs.existsSync(LICENSE_DATA_PATH)) return;
  const store = {
    products: [
      {
        id: newLicenseId('prod'),
        name: 'Product 1',
        description: 'Starter entry — generate keys below or delete and add your real products.',
        created_at: new Date().toISOString(),
      },
    ],
    keys: [],
  };
  saveLicenseStore(store);
}

function newLicenseId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function generateLicenseKeyToken() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = () =>
    Array.from({ length: 4 }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join('');
  return `GP-${seg()}-${seg()}-${seg()}-${seg()}`;
}

function licenseLoopbackOnly(req, res, next) {
  if (!isLoopbackReq(req)) {
    return res.status(403).json({ error: 'License API is localhost / 127.0.0.1 only.' });
  }
  next();
}

/** Resolve expiry ISO string from a key row (matches dashboard enrichment). */
function resolveLicenseKeyExpiresAtIso(row) {
  if (row.expires_at) return row.expires_at;
  let dd = row.duration_days;
  if (typeof dd === 'string') dd = Number(dd);
  if (typeof dd === 'number' && Number.isFinite(dd) && dd > 0 && row.created_at) {
    const t = new Date(row.created_at).getTime();
    if (Number.isFinite(t)) return new Date(t + Math.floor(dd) * 86400000).toISOString();
  }
  return null;
}

const LICENSE_KEY_TOKEN_RE = /^GP-[A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){3}$/;

function normalizeLicenseKeyToken(raw) {
  const s = typeof raw === 'string' ? raw.trim().toUpperCase().replace(/\s+/g, '') : '';
  return LICENSE_KEY_TOKEN_RE.test(s) ? s : null;
}

function normalizeBindHwid(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s.length > 256) return null;
  if (!/^[\x20-\x7E]+$/.test(s)) return null;
  return s;
}

/**
 * Bind key → HWID (mutates license store when first activation).
 * @param {string|null} keyNorm
 * @param {string|null} hwidNorm
 * @returns {{ status: number; body: Record<string, unknown> }}
 */
function executeLicenseHwidBind(keyNorm, hwidNorm) {
  if (!keyNorm) {
    return { status: 400, body: { error: 'Need the full GP-… license key.' } };
  }
  if (!hwidNorm) {
    return {
      status: 400,
      body: { error: 'Need the device fingerprint (reload client / opener).' },
    };
  }

  const store = loadLicenseStore();
  const row = store.keys.find((k) => k.key === keyNorm);
  if (!row) return { status: 404, body: { error: 'That key was not found.' } };

  const expIso = resolveLicenseKeyExpiresAtIso(row);
  if (expIso && new Date(expIso).getTime() < Date.now()) {
    return { status: 403, body: { ok: false, error: 'This key has expired.', expired: true } };
  }

  const existingHwid = row.hwid != null && String(row.hwid).trim() !== '';
  if (!existingHwid) {
    row.hwid = hwidNorm;
    row.hwid_bound_at = new Date().toISOString();
    saveLicenseStore(store);
    return {
      status: 200,
      body: {
        ok: true,
        bound: true,
        product_id: row.product_id,
        product_name: row.product_name_snapshot,
        ...(expIso ? { expires_at: expIso } : {}),
      },
    };
  }

  if (String(row.hwid).trim() === hwidNorm) {
    return {
      status: 200,
      body: {
        ok: true,
        bound: false,
        valid: true,
        product_id: row.product_id,
        product_name: row.product_name_snapshot,
        ...(expIso ? { expires_at: expIso } : {}),
      },
    };
  }

  return {
    status: 403,
    body: {
      ok: false,
      error: 'This computer is not paired with this key.',
      mismatch: true,
    },
  };
}

/** Read-only: is this key activated on this HWID and not expired? (for shipped EXEs to ping on startup) */
function evaluateLicenseRuntimeState(keyNorm, hwidNorm) {
  if (!keyNorm) {
    return {
      http: 400,
      body: { valid: false, reason: 'bad_key_format', error: 'Paste a full GP-… license key.' },
    };
  }
  if (!hwidNorm) {
    return {
      http: 400,
      body: { valid: false, reason: 'bad_hwid_format', error: 'Missing device fingerprint (reload this page).' },
    };
  }

  const store = loadLicenseStore();
  const row = store.keys.find((k) => k.key === keyNorm);
  if (!row)
    return { http: 200, body: { valid: false, reason: 'unknown_key' } };

  const bound = row.hwid != null && String(row.hwid).trim() !== '';
  if (!bound) return { http: 200, body: { valid: false, reason: 'not_activated' } };

  if (String(row.hwid).trim() !== hwidNorm) {
    return { http: 200, body: { valid: false, reason: 'hwid_mismatch' } };
  }

  const expIso = resolveLicenseKeyExpiresAtIso(row);
  if (expIso && new Date(expIso).getTime() < Date.now()) {
    return { http: 200, body: { valid: false, reason: 'expired', expires_at: expIso } };
  }

  return {
    http: 200,
    body: {
      valid: true,
      product_id: row.product_id,
      product_name: row.product_name_snapshot,
      ...(expIso ? { expires_at: expIso } : {}),
      license_has_expiry: !!(expIso || row.duration_days || row.expires_at),
    },
  };
}

/** First activation from localhost, or from anywhere with matching X-License-Bind-Secret when LICENSE_BIND_SECRET is set. */
function licenseBindOrLoopbackOrSecret(req, res, next) {
  if (isLoopbackReq(req)) return next();
  const secret = process.env.LICENSE_BIND_SECRET?.trim();
  if (!secret || secret.length < 8) {
    return res.status(403).json({
      error:
        'Non-localhost HWID bind requires LICENSE_BIND_SECRET (min 8 chars) in .env and matching X-License-Bind-Secret header.',
    });
  }
  const hdr = req.headers['x-license-bind-secret'];
  if (typeof hdr !== 'string' || hdr !== secret) {
    return res.status(403).json({ error: 'Invalid or missing X-License-Bind-Secret.' });
  }
  next();
}

const licenseRouter = express.Router();

/** @type {Map<string, number[]>} */
const licenseRuntimeVerifyByIp = new Map();

function throttleLicenseRuntimeVerify(clientAddr) {
  const addr = clientAddr && String(clientAddr).trim() ? String(clientAddr) : 'unknown';
  const windowMsRaw = Number(process.env.LICENSE_VERIFY_WINDOW_MS);
  const windowMs =
    Number.isFinite(windowMsRaw) && windowMsRaw >= 60_000 && windowMsRaw <= 86400000 * 7
      ? Math.floor(windowMsRaw)
      : 3_600_000;
  const maxRaw = Number(process.env.LICENSE_VERIFY_MAX);
  const max =
    Number.isFinite(maxRaw) && maxRaw >= 10 && maxRaw <= 2000 ? Math.floor(maxRaw) : 180;

  const now = Date.now();
  let hits = licenseRuntimeVerifyByIp.get(addr) || [];
  hits = hits.filter((t) => now - t < windowMs);
  if (hits.length >= max) return false;
  hits.push(now);
  licenseRuntimeVerifyByIp.set(addr, hits);
  return true;
}

/**
 * Public (throttled): your shipped app calls this every launch / periodically with saved key + HWID.
 * When the key expires or HWID resets, valid becomes false → EXE exits or gates features.
 */
licenseRouter.post('/verify-runtime', (req, res) => {
  if (!throttleLicenseRuntimeVerify(getClientAddr(req))) {
    return res.status(429).json({
      valid: false,
      reason: 'rate_limited',
      error: 'Too many checks — pause a minute.',
    });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const keyNorm = normalizeLicenseKeyToken(body.key);
  const hwidNorm = normalizeBindHwid(body.hwid);
  const { http, body: outBody } = evaluateLicenseRuntimeState(keyNorm, hwidNorm);
  return res.status(http).json(outBody);
});

licenseRouter.post('/keys/bind', licenseBindOrLoopbackOrSecret, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const keyNorm = normalizeLicenseKeyToken(body.key);
  const hwidNorm = normalizeBindHwid(body.hwid);
  const { status, body: outBody } = executeLicenseHwidBind(keyNorm, hwidNorm);
  return res.status(status).json(outBody);
});

licenseRouter.use(licenseLoopbackOnly);

licenseRouter.get('/dashboard', (_req, res) => {
  const store = loadLicenseStore();
  const keys = [...store.keys].map((k) => {
    const row = { ...k };
    let dur = row.duration_days;
    if (typeof dur === 'string') dur = Number(dur);
    const durN =
      typeof dur === 'number' && Number.isFinite(dur) && dur > 0 ? Math.floor(dur) : null;
    if (durN != null) row.duration_days = durN;
    if (!row.expires_at && durN != null && row.created_at) {
      const t = new Date(row.created_at).getTime();
      if (Number.isFinite(t)) {
        row.expires_at = new Date(t + durN * 86400000).toISOString();
      }
    }
    return row;
  });
  keys.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  res.json({
    products: store.products,
    keys,
    notes:
      'Plain-text keys live in data/. Buyers open /loader/. Paid months only clamp down AFTER you teach your rebuilt installer to periodically POST saved GP-key + fingerprint to /api/license/verify-runtime — the downloaded exe cannot age out by itself.',
  });
});

licenseRouter.post('/products', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 500) : '';
  if (!name || name.length > 120) {
    return res.status(400).json({ error: 'JSON body needs "name" (1–120 characters).' });
  }
  const store = loadLicenseStore();
  const product = {
    id: newLicenseId('prod'),
    name,
    ...(description ? { description } : {}),
    created_at: new Date().toISOString(),
  };
  store.products.push(product);
  saveLicenseStore(store);
  res.status(201).json({ ok: true, product });
});

licenseRouter.delete('/products/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!/^prod_[a-f0-9]{16}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid product id.' });
  }
  const store = loadLicenseStore();
  const before = store.products.length;
  store.products = store.products.filter((p) => p.id !== id);
  store.keys = store.keys.filter((k) => k.product_id !== id);
  if (store.products.length === before) {
    return res.status(404).json({ error: 'Product not found.' });
  }
  saveLicenseStore(store);
  res.json({ ok: true });
});

licenseRouter.post('/keys/generate', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const productId = typeof body.product_id === 'string' ? body.product_id.trim() : '';
  let count = Number(body.count);
  if (!Number.isFinite(count)) count = 1;
  count = Math.min(50, Math.max(1, Math.floor(count)));
  const batch_note = typeof body.batch_note === 'string' ? body.batch_note.trim().slice(0, 200) : '';

  let rawDur = body.duration_days;
  if (rawDur === undefined || rawDur === null || rawDur === '') rawDur = body.duration;

  let duration_days = null;
  if (rawDur !== undefined && rawDur !== null && rawDur !== '') {
    const n =
      typeof rawDur === 'string'
        ? Number(String(rawDur).trim().replace(/,/g, ''))
        : Number(rawDur);
    if (!Number.isFinite(n)) {
      return res.status(400).json({ error: '"duration_days" must be a number or omitted.' });
    }
    const d = Math.floor(n);
    if (d > 36500) {
      return res.status(400).json({ error: '"duration_days" must be at most 36500.' });
    }
    if (d > 0) duration_days = d;
  }

  if (!/^prod_[a-f0-9]{16}$/.test(productId)) {
    return res.status(400).json({ error: 'JSON body needs valid "product_id".' });
  }
  const store = loadLicenseStore();
  const product = store.products.find((p) => p.id === productId);
  if (!product) return res.status(404).json({ error: 'Unknown product.' });

  const issuedAtMs = Date.now();
  const created_at = new Date(issuedAtMs).toISOString();
  const expiryFields =
    duration_days != null
      ? {
          duration_days,
          expires_at: new Date(issuedAtMs + duration_days * 86400000).toISOString(),
        }
      : {};

  /** @type {object[]} */
  const generated = [];
  for (let i = 0; i < count; i++) {
    const row = {
      id: newLicenseId('key'),
      product_id: productId,
      product_name_snapshot: product.name,
      key: generateLicenseKeyToken(),
      ...(batch_note ? { batch_note } : {}),
      created_at,
      ...expiryFields,
    };
    store.keys.push(row);
    generated.push(row);
  }
  saveLicenseStore(store);
  res.status(201).json({ ok: true, keys: generated });
});

licenseRouter.delete('/keys/:id', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!/^key_[a-f0-9]{16}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid key id.' });
  }
  const store = loadLicenseStore();
  const before = store.keys.length;
  store.keys = store.keys.filter((k) => k.id !== id);
  if (store.keys.length === before) return res.status(404).json({ error: 'Key not found.' });
  saveLicenseStore(store);
  res.json({ ok: true });
});

licenseRouter.delete('/keys/:id/hwid', (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!/^key_[a-f0-9]{16}$/.test(id)) {
    return res.status(400).json({ error: 'Invalid key id.' });
  }
  const store = loadLicenseStore();
  const row = store.keys.find((k) => k.id === id);
  if (!row) return res.status(404).json({ error: 'Key not found.' });
  delete row.hwid;
  delete row.hwid_bound_at;
  saveLicenseStore(store);
  res.json({ ok: true });
});

app.use('/api/license', licenseRouter);

// ----------------------------------------------------------------------------
// Web product loader — public activate + signed EXE download (configure LOADER_* in .env).
// ----------------------------------------------------------------------------
/** @type {Map<string, number[]>} */
const loaderActivateByIp = new Map();

function getLoaderDlSecret() {
  const env = process.env.LOADER_DOWNLOAD_SECRET?.trim();
  if (env && env.length >= 16) return env;
  if (!getLoaderDlSecret._warnOnce) {
    getLoaderDlSecret._warnOnce = true;
    console.warn(
      '[!] LOADER_DOWNLOAD_SECRET unset or shorter than 16 chars — ephemeral token signing until restart.',
    );
  }
  if (!globalThis.__galaxyLoaderDlSecretEphemeral)
    globalThis.__galaxyLoaderDlSecretEphemeral = crypto.randomBytes(32).toString('hex');
  return globalThis.__galaxyLoaderDlSecretEphemeral;
}
getLoaderDlSecret._warnOnce = false;

function loaderDownloadTtlMs() {
  const s = Number(process.env.LOADER_DOWNLOAD_TTL_SEC);
  if (Number.isFinite(s) && s >= 60 && s <= 86400) return Math.floor(s) * 1000;
  return 900_000;
}

function throttleLoaderActivate(clientAddr) {
  const addr = clientAddr && String(clientAddr).trim() ? String(clientAddr) : 'unknown';
  const windowMsRaw = Number(process.env.LOADER_ACTIVATE_WINDOW_MS);
  const windowMs =
    Number.isFinite(windowMsRaw) && windowMsRaw >= 60_000 && windowMsRaw <= 86400000 * 7
      ? Math.floor(windowMsRaw)
      : 3_600_000;
  const maxRaw = Number(process.env.LOADER_ACTIVATE_MAX);
  const max =
    Number.isFinite(maxRaw) && maxRaw >= 5 && maxRaw <= 500 ? Math.floor(maxRaw) : 60;

  const now = Date.now();
  let hits = loaderActivateByIp.get(addr) || [];
  hits = hits.filter((t) => now - t < windowMs);
  if (hits.length >= max) return false;
  hits.push(now);
  loaderActivateByIp.set(addr, hits);
  return true;
}

function resolveLoaderArtifactPath() {
  const raw = process.env.LOADER_ARTIFACT_PATH?.trim();
  if (
    !raw ||
    raw === 'YOUR_EXE_PATH_HERE' ||
    raw === 'YOUR_PATH_TO_PRODUCT_EXE_HERE' ||
    raw === 'YOUR_PATH_TO_EXE_HERE'
  ) {
    return null;
  }
  const resolved = path.isAbsolute(raw) ? raw : path.join(__dirname, raw);
  try {
    const st = fs.statSync(resolved);
    if (!st.isFile()) return null;
    return resolved;
  } catch {
    return null;
  }
}

/** GalaxyLoader.exe (pkg) given to buyers after web activation — NOT the product app. */
function resolveLoaderBootstrapPath() {
  const raw = process.env.LOADER_BOOTSTRAP_EXE_PATH?.trim();
  if (
    !raw ||
    raw === 'YOUR_EXE_PATH_HERE' ||
    raw === 'YOUR_PATH_TO_PRODUCT_EXE_HERE' ||
    raw === 'YOUR_PATH_TO_EXE_HERE'
  ) {
    return null;
  }
  const resolved = path.isAbsolute(raw) ? raw : path.join(__dirname, raw);
  try {
    const st = fs.statSync(resolved);
    if (!st.isFile()) return null;
    return resolved;
  } catch {
    return null;
  }
}

function signedLoaderArtifactDownloadName() {
  const ov = process.env.LOADER_DOWNLOAD_FILENAME?.trim();
  if (ov && /^[a-zA-Z0-9._()\-\x20]+$/.test(ov) && ov.length <= 120) return ov.replace(/\x20/g, '_');
  const p = resolveLoaderArtifactPath();
  return p ? path.basename(p).replace(/[^\w.\-()+]/g, '_') || 'product.exe' : 'product.exe';
}

function signedLoaderBootstrapDownloadName() {
  const ov = process.env.LOADER_CLIENT_DOWNLOAD_FILENAME?.trim();
  if (ov && /^[a-zA-Z0-9._()\-\x20]+$/.test(ov) && ov.length <= 120)
    return ov.replace(/\x20/g, '_');
  const p = resolveLoaderBootstrapPath();
  return p ? path.basename(p).replace(/[^\w.\-()+]/g, '_') || 'GalaxyLoader.exe' : 'GalaxyLoader.exe';
}

function signLoaderDownloadToken(payload) {
  const secret = getLoaderDlSecret();
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyLoaderDownloadToken(token) {
  const secret = getLoaderDlSecret();
  const lastDot = typeof token === 'string' ? token.lastIndexOf('.') : -1;
  if (lastDot <= 0) return null;
  const dataPart = token.slice(0, lastDot);
  const sigPart = token.slice(lastDot + 1);
  let expectedSig;
  try {
    expectedSig = crypto.createHmac('sha256', secret).update(dataPart).digest('base64url');
  } catch {
    return null;
  }
  try {
    const ab = Buffer.from(sigPart);
    const bb = Buffer.from(expectedSig);
    if (ab.length !== bb.length || !crypto.timingSafeEqual(ab, bb)) return null;
  } catch {
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(dataPart, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (
    !payload ||
    payload.v !== 1 ||
    typeof payload.kid !== 'string' ||
    !/^key_[a-f0-9]{16}$/.test(payload.kid) ||
    typeof payload.hw !== 'string' ||
    typeof payload.exp !== 'number'
  )
    return null;
  if (payload.dl != null && payload.dl !== 'product' && payload.dl !== 'bootstrap') return null;
  return payload;
}

app.get('/api/loader/config', (_req, res) => {
  const artifact = resolveLoaderArtifactPath();
  const bootstrap = resolveLoaderBootstrapPath();
  res.json({
    artifact_configured: !!artifact,
    bootstrap_configured: !!bootstrap,
    download_ttl_sec: Math.round(loaderDownloadTtlMs() / 1000),
    runtime_verify_post: '/api/license/verify-runtime',
    runtime_verify_hint:
      'Shipped apps ping this with the buyer’s saved GP key + device id so subscriptions can turn off cleanly.',
    hint:
      artifact || bootstrap
        ? null
        : 'Seller sets LOADER_BOOTSTRAP_EXE_PATH (web → GalaxyLoader.exe) and/or LOADER_ARTIFACT_PATH (product).',
    web_flow_hint:
      bootstrap && artifact
        ? 'Web gives GalaxyLoader.exe; run it and enter your key again for the product installer.'
        : bootstrap
          ? 'Web gives GalaxyLoader.exe. Add LOADER_ARTIFACT_PATH so the desktop loader can fetch your product.'
          : null,
  });
});

app.get('/api/loader/machine-hwid', async (req, res) => {
  if (!isLoopbackReq(req)) {
    return res.status(403).json({
      error:
        'Machine HWID is only returned for localhost browsers (same fingerprint as CLI `npm run loader -- --show-hwid`). Remote users rely on browser binding.',
    });
  }
  try {
    const hwid = await computeGalaxyHwid();
    res.json({
      hwid,
      scheme: 'gp-hwid-v1',
      tip: 'When you open the loader from http://127.0.0.1 on this PC, HWID matches the Node CLI loader.',
    });
  } catch (e) {
    res.status(500).json({ error: e?.message ? String(e.message) : 'HWID failed' });
  }
});

app.post('/api/loader/activate', (req, res) => {
  const addr = getClientAddr(req);
  if (!throttleLoaderActivate(addr)) {
    return res.status(429).json({ error: 'Too many activation attempts. Try again later.' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const delivery = body.delivery === 'web' ? 'web' : 'native';
  const keyNorm = normalizeLicenseKeyToken(body.key);
  const hwidNorm = normalizeBindHwid(body.hwid);
  const { status, body: bindBody } = executeLicenseHwidBind(keyNorm, hwidNorm);
  if (status !== 200) {
    return res.status(status).json(bindBody);
  }

  const store = loadLicenseStore();
  const row = store.keys.find((k) => k.key === keyNorm);
  if (!row || String(row.hwid).trim() !== String(hwidNorm).trim()) {
    return res.status(500).json({ error: 'Activation did not persist. Retry.' });
  }

  const productPath = resolveLoaderArtifactPath();
  const bootstrapPath = resolveLoaderBootstrapPath();
  if (!productPath && !bootstrapPath) {
    const name = bindBody.product_name ?? row.product_name_snapshot;
    return res.status(503).json({
      error: 'Downloads aren’t plugged in yet on this hub.',
      activated: true,
      product_name: name,
      ...(bindBody.expires_at ? { expires_at: bindBody.expires_at } : {}),
    });
  }

  const expMs = Date.now() + loaderDownloadTtlMs();
  const name = bindBody.product_name ?? row.product_name_snapshot;
  const baseOut = {
    ok: true,
    product_name: name,
    ...(bindBody.bound === true ? { first_activation: true } : {}),
    ...(bindBody.expires_at ? { license_expires_at: bindBody.expires_at } : {}),
    link_expires_at: new Date(expMs).toISOString(),
  };

  const mint = (dl) =>
    signLoaderDownloadToken({
      v: 1,
      kid: row.id,
      hw: hwidNorm,
      exp: expMs,
      dl,
    });

  if (delivery === 'web') {
    if (bootstrapPath) {
      const t = mint('bootstrap');
      return res.json({
        ...baseOut,
        loader_client_token: t,
        loader_client_url: `/api/loader/download?token=${encodeURIComponent(t)}`,
        step_hint:
          'Run GalaxyLoader.exe, enter this key again — your product installer downloads from there.',
      });
    }
    if (productPath) {
      const t = mint('product');
      return res.json({
        ...baseOut,
        download_token: t,
        download_url: `/api/loader/download?token=${encodeURIComponent(t)}`,
      });
    }
  }

  if (productPath) {
    const t = mint('product');
    return res.json({
      ...baseOut,
      download_token: t,
      download_url: `/api/loader/download?token=${encodeURIComponent(t)}`,
    });
  }

  const name503 = bindBody.product_name ?? row.product_name_snapshot;
  return res.status(503).json({
    error:
      'Product installer not configured (LOADER_ARTIFACT_PATH). Set it so GalaxyLoader.exe can fetch your app.',
    activated: true,
    product_name: name503,
    ...(bindBody.expires_at ? { expires_at: bindBody.expires_at } : {}),
  });
});

app.get('/api/loader/download', (req, res) => {
  const tok =
    typeof req.query.token === 'string'
      ? req.query.token.trim()
      : typeof req.query.t === 'string'
        ? String(req.query.t).trim()
        : '';
  const payload = verifyLoaderDownloadToken(tok);
  if (!payload || payload.exp <= Date.now())
    return res.status(403).send('Invalid or expired link — activate again on the loader page.');

  const store = loadLicenseStore();
  const row = store.keys.find((k) => k.id === payload.kid);
  const keyExpIso = row ? resolveLicenseKeyExpiresAtIso(row) : null;
  if (
    !row ||
    typeof row.hwid !== 'string' ||
    String(row.hwid).trim() !== String(payload.hw).trim()
  )
    return res.status(403).send('License no longer authorized for this file.');

  if (keyExpIso && new Date(keyExpIso).getTime() < Date.now())
    return res.status(403).send('Your license key has expired.');

  const mode = payload.dl === 'bootstrap' ? 'bootstrap' : 'product';
  const filePath =
    mode === 'bootstrap' ? resolveLoaderBootstrapPath() : resolveLoaderArtifactPath();
  if (!filePath) {
    return res.status(503).send(
      mode === 'bootstrap'
        ? 'Galaxy Loader client is not configured on this hub (LOADER_BOOTSTRAP_EXE_PATH).'
        : 'Download is not configured on this hub.',
    );
  }

  const fn =
    mode === 'bootstrap'
      ? signedLoaderBootstrapDownloadName()
      : signedLoaderArtifactDownloadName();
  res.setHeader(
    'Content-Type',
    'application/vnd.microsoft.portable-executable',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${fn.replace(/"/g, '')}"`,
  );

  fs.createReadStream(filePath)
    .on('error', () => {
      if (!res.headersSent) res.status(500).send('Could not read the file.');
    })
    .pipe(res);
});

// ----------------------------------------------------------------------------
// Hub metadata (changelog) — harmless; no secrets.
// ----------------------------------------------------------------------------
app.get('/api/meta', (_req, res) => {
  try {
    const pkgPath = path.join(__dirname, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    let changelogMd = '';
    try {
      changelogMd = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8');
    } catch (_) {
      changelogMd = '';
    }
    res.json({
      name: pkg.name,
      description: pkg.description ?? '',
      version: pkg.version,
      changelog_md: changelogMd,
    });
  } catch (e) {
    res.status(500).json({ error: e?.message ? String(e.message) : 'Failed to load package metadata.' });
  }
});

// ----------------------------------------------------------------------------
// URL / phishing heuristics (localhost only — may send outbound HEAD requests).
// ----------------------------------------------------------------------------
app.post('/api/check-url', async (req, res) => {
  if (!isLoopbackReq(req)) {
    return res.status(403).json({
      error: 'This URL checker runs on localhost only (prevents SSRF from remote clients).',
    });
  }
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const input = typeof body.url === 'string' ? body.url.trim() : '';
  if (!input) return res.status(400).json({ error: 'JSON body missing string field "url".' });

  try {
    const data = await runUrlThreatCheck(input);
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: e?.message ? String(e.message) : String(e) });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

bootstrapLicenseStoreIfMissing();

app.listen(PORT, () => {
  console.log(`\n  Galaxy Products hub: http://localhost:${PORT}/`);
  console.log(`  SteamWebHourChecker:   http://localhost:${PORT}/steam-web-hour-checker/`);
  console.log(`  Game updates (Steam):  http://localhost:${PORT}/game-updates/`);
  console.log(`  PC serial WMI dump:    GET http://localhost:${PORT}/api/pc-serials (localhost only)`);
  console.log(`  Malware/RAT/cheat hints: GET http://localhost:${PORT}/api/pc-threat-hints (localhost only)`);
  console.log(`  Startup apps (WMI):      GET http://localhost:${PORT}/api/startup-apps (localhost only)`);
  console.log(`  Defender quick scan:     POST http://localhost:${PORT}/api/defender-quick-scan (slow; localhost)`);
  console.log(`  Hub metadata/changelog:  GET  http://localhost:${PORT}/api/meta`);
  console.log(`  Products & license keys: http://localhost:${PORT}/api/license/* (dashboard localhost; data/license-store.json)`);
  console.log(
    `  Optional license ping:      POST http://localhost:${PORT}/api/license/verify-runtime  {\"key\",\"hwid\"}`,
  );
  console.log(`  License HWID bind:       POST http://localhost:${PORT}/api/license/keys/bind  (localhost or LICENSE_BIND_SECRET + X-License-Bind-Secret)`);
  const _art = resolveLoaderArtifactPath();
  const _boot = resolveLoaderBootstrapPath();
  console.log(`  Web product loader:      http://localhost:${PORT}/loader/`);
  console.log(`  File / CLI loader:      GalaxyLoader.cmd  or  npm run loader`);
  console.log(
    _boot
      ? `  Web → GalaxyLoader.exe:  ${path.basename(_boot)} (LOADER_BOOTSTRAP_EXE_PATH)`
      : `  Web → GalaxyLoader.exe:  not set — LOADER_BOOTSTRAP_EXE_PATH for /loader/ two-step delivery`,
  );
  console.log(
    _art
      ? `  Desktop → product EXE:   ${path.basename(_art)} (LOADER_ARTIFACT_PATH)`
      : `  Desktop → product EXE:    not set — LOADER_ARTIFACT_PATH for installs after GalaxyLoader.exe`,
  );

  const extHint =
    SERIAL_CHECKER_EXE &&
    SERIAL_CHECKER_EXE !== 'YOUR_SERIAL_CHECKER_ABSOLUTE_OR_RELATIVE_EXE_PATH_HERE';
  if (extHint) {
    const resolvedExt = path.isAbsolute(SERIAL_CHECKER_EXE)
      ? SERIAL_CHECKER_EXE
      : path.join(__dirname, SERIAL_CHECKER_EXE);
    const ok = fs.existsSync(resolvedExt);
    console.log(
      ok
        ? `  External .exe checker: ${path.basename(resolvedExt)} (SERIAL_CHECKER_EXE)`
        : `  External .exe checker: path not found (${resolvedExt})`,
    );
  }

  if (BM_TOKEN_RAW) {
    console.log('  Battlemetrics: BATTLEMETRICS_TOKEN set → Rust BM hours appended to lookups.');
  }
});
