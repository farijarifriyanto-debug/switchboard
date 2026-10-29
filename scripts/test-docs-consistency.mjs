#!/usr/bin/env node
/**
 * Release/documentation consistency gate.
 *
 * Keeps the source version, extension manifest, published-status table and
 * current operator docs from drifting apart. Historical QA reports are exempt.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const read = (path) => readFile(path, 'utf8')
const json = async (path) => JSON.parse(await read(path))

const pkg = await json('package.json')
const lock = await json('package-lock.json')
const manifest = await json('browser-extension/manifest.json')
const readme = await read('README.md')
const extensionReadme = await read('browser-extension/README.md')
const status = await read('docs/release-status.md')
const agents = await read('AGENTS.md')
const presets = await read('src/services/presets.ts')
const companion = await read('src/plugins/browser-companion.ts')
const background = await read('browser-extension/background.js')
const storeReview = await read('browser-extension/CHROME-STORE-REVIEW.md')

assert.equal(pkg.version, manifest.version, 'package.json and extension manifest versions must match')
assert.equal(lock.version, pkg.version, 'package-lock root version must match package.json')
assert.equal(lock.packages?.['']?.version, pkg.version, 'package-lock workspace version must match package.json')

assert.match(status, new RegExp(`Source / working tree \\| \\*\\*${pkg.version.replaceAll('.', '\\.')}\\*\\* \\| (?:Unpublished|Published)`), 'release-status must show the source version')
assert.match(status, /Chrome Web Store Browser Companion \| \*\*0\.4\.7\*\* \(developer dashboard\) \| \*\*0\.4\.8 NOT submitted\/published\*\*/, 'release-status must distinguish the latest observed Chrome dashboard version from the unpublished store update')
assert.match(status, /Microsoft Edge Add-ons \| \*\*unknown\*\* \| Unverified/, 'release-status must not invent an Edge status')
// The npm row records what is actually published, which may lag the source
// while a release is in flight; it must never claim a newer version than the tree.
const npmRow = status.match(/npm `@botconnector\/switchboard` \| \*\*(\d+\.\d+\.\d+)\*\* \| Published/)
assert.ok(npmRow, 'release-status must show the published npm version')
const versionCmp = (a, b) => {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i]
  return 0
}
assert.ok(versionCmp(npmRow[1], pkg.version) <= 0, 'published npm version cannot be newer than the source version')

for (const doc of [readme, extensionReadme]) {
  assert.match(doc, /17 browser/, 'current browser docs must use the 17-tool count')
  assert.doesNotMatch(doc, /13 browser/i, 'stale 13-tool count returned')
  assert.doesNotMatch(doc, /no authentication/i, 'stale "no authentication" claim returned')
}
assert.doesNotMatch(readme, /Playwright/i, 'README must document the shipped companion, not the old Playwright bridge')
assert.match(extensionReadme, /17 browser_\* tools/, 'extension README must show 17 browser tools')
assert.match(storeReview, /12-character, one-use Browser Companion pairing code/, 'store review must use the current pairing-code length')
assert.doesNotMatch(background, /13 browser tools/, 'extension worker comment must use the 17-tool count')
assert.match(companion, /17 browser automation tools/i, 'browser companion source must state the 17-tool count')

for (const stale of ['0.4.2', '0.4.3']) {
  for (const [name, doc] of [['README.md', readme], ['browser-extension/README.md', extensionReadme], ['AGENTS.md', agents], ['docs/release-status.md', status]]) {
    assert.ok(!doc.includes(stale), `${name} still contains stale version ${stale}`)
  }
}

for (const permission of manifest.permissions) {
  assert.ok(extensionReadme.includes('`' + permission + '`'), `extension README must list manifest permission ${permission}`)
}
assert.match(extensionReadme, /optional.*HTTP\/HTTPS|HTTP\/HTTPS.*optional/i, 'extension README must explain optional site access')

assert.match(readme, /web\.token/, 'web console docs must mention web.token')
assert.match(readme, /SWITCHBOARD_WEB_TOKEN/, 'web console docs must mention the token environment variable')
assert.match(readme, /non-loopback/i, 'web console docs must explain the non-loopback token requirement')
assert.match(readme, /ci-trust\.json/, 'CI docs must document the per-project trust file')
assert.match(readme, /envAllowlist/, 'CI docs must document the environment allowlist')
assert.match(readme, /sandbox/, 'CI docs must document step sandboxing')
assert.match(readme, /allowUnattended/, 'automation docs must document the unattended opt-in')
assert.match(readme, /browser_dom_snapshot/, 'browser docs must document snapshot selectors')
assert.match(extensionReadme, /mutual HMAC/i, 'extension docs must document mutual pairing')
assert.match(extensionReadme, /AES-256-GCM/, 'extension docs must document encrypted token delivery')
assert.match(presets, /Browser Companion/, 'browser preset description must name the shipped companion')
assert.doesNotMatch(presets, /MCP server named "browser"/, 'browser preset still advertises the old MCP bridge')

console.log('docs: OK')
