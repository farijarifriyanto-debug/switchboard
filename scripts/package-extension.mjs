import { execSync, execFileSync } from 'node:child_process'
import { readFileSync, statSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

const ROOT = process.cwd()
const EXT_DIR = path.join(ROOT, 'browser-extension')
const MANIFEST_PATH = path.join(EXT_DIR, 'manifest.json')

console.log('=== Packaging Switchboard Browser Extension (Chrome & Edge) ===')

// 1. Validate manifest
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
if (manifest.manifest_version !== 3) throw new Error('Manifest version must be 3')
if (!manifest.permissions.includes('activeTab')) throw new Error('Manifest must include activeTab permission')
const allowedHosts = new Set(['http://127.0.0.1/*', 'http://localhost/*'])
if ((manifest.host_permissions || []).some(host => !allowedHosts.has(host))) throw new Error('Only explicit loopback bridge host permissions are allowed')
if (!manifest.side_panel?.default_path) throw new Error('Manifest must specify side_panel.default_path')
const onboardingMatches = new Set(['http://127.0.0.1/*', 'http://localhost/*'])
if ((manifest.content_scripts || []).length !== 1 ||
  manifest.content_scripts[0].js.join(',') !== 'onboarding-bridge.js' ||
  manifest.content_scripts[0].matches.some(match => !onboardingMatches.has(match)) ||
  manifest.content_scripts[0].matches.length !== onboardingMatches.size
) throw new Error('Onboarding content script must be restricted to both HTTP loopback sites')
for (const size of [16, 48, 128]) {
  const icon = manifest.icons?.[String(size)]
  if (!icon || !icon.startsWith('icons/') || !statSync(path.join(EXT_DIR, icon)).isFile()) {
    throw new Error('Store icon missing: ' + size)
  }
}

console.log('✓ Manifest V3 contract validation passed')

// 2. Syntax check
execSync('node --check ' + path.join(EXT_DIR, 'background.js'), { stdio: 'inherit' })
execSync('node --check ' + path.join(EXT_DIR, 'panel.js'), { stdio: 'inherit' })
execSync('node --check ' + path.join(EXT_DIR, 'onboarding-bridge.js'), { stdio: 'inherit' })
console.log('✓ Service worker and panel script syntax checks passed')

// 3. Package Chrome ZIP
const chromeZip = path.join(ROOT, 'switchboard-chrome.zip')
const edgeZip = path.join(ROOT, 'switchboard-edge.zip')

const python = process.platform === 'win32' ? 'python' : 'python3'
execFileSync(python, [path.join(ROOT, 'scripts', 'build-browser-extension-zip.py'), EXT_DIR, chromeZip], { stdio: 'inherit' })
copyFileSync(chromeZip, edgeZip)

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

const chromeStats = statSync(chromeZip)
const edgeStats = statSync(edgeZip)

console.log(`✓ Chrome package: ${chromeZip} (${chromeStats.size} bytes, SHA256: ${sha256(chromeZip)})`)
console.log(`✓ Edge package:   ${edgeZip} (${edgeStats.size} bytes, SHA256: ${sha256(edgeZip)})`)
console.log('=== Packaging complete: PASS ===')
