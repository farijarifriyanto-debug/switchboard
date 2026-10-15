// Native file/folder pickers without Electron. The HTTP server runs locally
// with the same OS privileges the user has, so it can still show a real
// native dialog — no bundled Chromium involved.
//
// Windows: a tiny inline PowerShell + WinForms script (always present on
// any Windows install, nothing to bundle).
//
// Linux: no single mechanism is universally present the way PowerShell is
// on Windows. Tries zenity (GTK, common on GNOME-family desktops) then
// kdialog (KDE) — both frequently already installed — and if neither
// exists, returns null rather than crashing: the caller (webui/server.cjs's
// /api/dialog/* routes) already treats a null pick as "user picked
// nothing," so the browser UI degrades to "no folder/file chosen" instead
// of erroring. This is a real, disclosed capability gap on Linux (no
// zenity/kdialog, or a truly headless/no-display box), not a crash.
const { execFile } = require('node:child_process');

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 120000 }, (err, stdout) => {
      if (err) return resolve(null); // missing binary, user cancelled, no display, timed out — all "no pick"
      const out = String(stdout || '').trim();
      resolve(out || null);
    });
  });
}

function runPs(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 120000 }, (err, stdout) => {
      if (err && err.killed) return reject(new Error('Dialog timed out'));
      resolve(String(stdout || '').trim());
    });
  });
}

async function pickFolder(title) {
  if (process.platform !== 'win32') {
    const t = String(title || 'Choose a folder');
    return (await run('zenity', ['--file-selection', '--directory', `--title=${t}`]))
      || (await run('kdialog', ['--getexistingdirectory', '.', '--title', t]));
  }
  const t = String(title || 'Choose a folder').replace(/'/g, "''");
  const out = await runPs(`
    Add-Type -AssemblyName System.Windows.Forms | Out-Null
    $f = New-Object System.Windows.Forms.FolderBrowserDialog
    $f.Description = '${t}'
    if ($f.ShowDialog() -eq 'OK') { Write-Output $f.SelectedPath }
  `);
  return out || null;
}

async function pickFile(title, filterName, extensions) {
  if (process.platform !== 'win32') {
    const t = String(title || 'Choose a file');
    const exts = Array.isArray(extensions) && extensions.length ? extensions : ['*'];
    const zenityFilter = exts.map(e => `*.${e}`).join(' ');
    return (await run('zenity', ['--file-selection', `--title=${t}`, `--file-filter=${filterName || 'Files'} | ${zenityFilter}`]))
      || (await run('kdialog', ['--getopenfilename', '.', exts.map(e => `*.${e}`).join(' '), '--title', t]));
  }
  const t = String(title || 'Choose a file').replace(/'/g, "''");
  const fn = String(filterName || 'Files').replace(/'/g, "''");
  const exts = (Array.isArray(extensions) && extensions.length ? extensions : ['*']).map(e => `*.${e}`).join(';');
  const out = await runPs(`
    Add-Type -AssemblyName System.Windows.Forms | Out-Null
    $f = New-Object System.Windows.Forms.OpenFileDialog
    $f.Title = '${t}'
    $f.Filter = '${fn} (${exts})|${exts}'
    if ($f.ShowDialog() -eq 'OK') { Write-Output $f.FileName }
  `);
  return out || null;
}

module.exports = { pickFolder, pickFile };
