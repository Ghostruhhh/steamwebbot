/**
 * Lets pkg overwrite dist/GalaxyLoader.exe on Windows — EPERM if the exe still runs.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function sleepMs(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}

const exe = path.join(__dirname, '..', 'dist', 'GalaxyLoader.exe');

if (process.platform === 'win32') {
  spawnSync('taskkill', ['/F', '/IM', 'GalaxyLoader.exe'], {
    stdio: 'ignore',
    windowsHide: true,
  });
}

sleepMs(500);

try {
  if (fs.existsSync(exe)) fs.unlinkSync(exe);
} catch (err) {
  if (err && err.code === 'EPERM') {
    console.error(
      'Cannot replace dist\\GalaxyLoader.exe — close it if it is running, check antivirus/UI overlays, ' +
        'or delete dist\\GalaxyLoader.exe manually, then run npm run build:loader-exe again.',
    );
    process.exit(1);
  }
  throw err;
}
