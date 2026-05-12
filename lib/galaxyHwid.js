const crypto = require('crypto');
const si = require('systeminformation');

const SCHEMA = 'gp-hwid-v1';

/** Stable fingerprint (SHA-256 hex, 64 chars) — same as CLI loader */
async function computeGalaxyHwid() {
  const [system, baseboard, bios, diskLayout, osInfo] = await Promise.all([
    si.system(),
    si.baseboard(),
    si.bios(),
    si.diskLayout(),
    si.osInfo(),
  ]);

  const disks = Array.isArray(diskLayout) ? diskLayout : [];
  const diskSer =
    disks.find(
      (d) =>
        d &&
        typeof d.serialNum === 'string' &&
        String(d.serialNum).trim() &&
        !/^0+$/.test(String(d.serialNum).trim()),
    )?.serialNum || '';

  const parts = [
    SCHEMA,
    String(system.uuid || '').trim(),
    String(system.serial || '').trim(),
    String(baseboard.serial || '').trim(),
    String(baseboard.manufacturer || '').trim(),
    String(baseboard.model || '').trim(),
    String(bios.serial || '').trim(),
    String(osInfo.serial || '').trim(),
    String(diskSer).trim(),
  ].join('|');

  return crypto.createHash('sha256').update(parts, 'utf8').digest('hex');
}

module.exports = { computeGalaxyHwid };
