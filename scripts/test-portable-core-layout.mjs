/** End-to-end smoke for the shipped Windows ZIP's *actual* app and sibling original Core.
 * Run with SBX_PORTABLE_ROOT set to the extracted Switchboard-version folder.
 * Read-only. Does not install/download/launch any model.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
const root=process.env.SBX_PORTABLE_ROOT
assert.ok(root && path.isAbsolute(root),'SBX_PORTABLE_ROOT must be an absolute extracted ZIP folder')
const app=path.join(root,'app')
const core=path.join(root,'local-core')
const pinned='1aa37824ea5d6bcd35f499c892a68cecfa695660'
assert.ok(existsSync(path.join(core,'bin','botconnector.mjs')))
assert.match(readFileSync(path.join(core,'SOURCE-REVISION.txt'),'utf8'),new RegExp(pinned))
const cli=path.join(app,'dist','cli.js')
const version=JSON.parse(readFileSync(path.join(app,'package.json'),'utf8')).version
const cliVersion=execFileSync(process.execPath,[cli,'--version'],{encoding:'utf8',timeout:45000})
assert.match(cliVersion,new RegExp('sbx '+version.replaceAll('.','\\.')))
console.log('PORTABLE_CLI_VERSION_PASS',version)
const cliHelp=execFileSync(process.execPath,[cli,'local','--help'],{encoding:'utf8',timeout:45000})
assert.match(cliHelp,/BotConnector AI CLI/)
console.log('PORTABLE_ORIGINAL_CORE_CLI_PASS')
const recommend=await import(pathToFileURL(path.join(app,'dist','services','botconnector-local-recommendations.js')).href)
const result=await recommend.recommendBotConnectorLocal()
assert.ok(result.recommendations.length>=2)
assert.equal(result.source,'Pinned BotConnector Local Core hardware and model catalog')
console.log('PORTABLE_HARDWARE_RECOMMENDATIONS_PASS')
const manage=await import(pathToFileURL(path.join(app,'dist','services','botconnector-local-management.js')).href)
assert.equal(typeof manage.installedBotConnectorModels,'function')
assert.equal(typeof manage.openBotConnectorLocalManager,'function')
console.log('PORTABLE_INSTALLED_AND_DOWNLOAD_MANAGER_IMPORT_PASS')
console.log('PORTABLE_PINNED_CORE_SINGLE_LOCATION_PASS')
