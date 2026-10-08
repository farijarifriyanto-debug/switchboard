/**
 * Tests for the local CI module (src/ci). Grows with each task.
 *
 *   node scripts/test-ci.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { listWorkflows, loadWorkflow, parseWorkflow, SetupError } from '../dist/ci/index.js'

const { newRunId, saveRun, getRun, listRuns, runsDir, resolveKeepRuns } = await import('../dist/ci/index.js')

const scratch = await mkdtemp(path.join(tmpdir(), 'sb-ci-'))
const wfDir = path.join(scratch, '.switchboard', 'workflows')
await mkdir(wfDir, { recursive: true })
const writeWf = (name, text) => writeFile(path.join(wfDir, name), text, 'utf8')

try {
  // ------------------------------------------------------------ parse: valid
  const wf = parseWorkflow(
    [
      'name: CI',
      'on: [push, workflow_dispatch]',
      'env: { GLOBAL: "g" }',
      'jobs:',
      '  second:',
      '    needs: [first]',
      '    steps:',
      '      - name: S2',
      '        run: echo two',
      '  first:',
      '    env: { JOB: "j" }',
      '    steps:',
      '      - run: echo one',
      '        name: S1',
      '        timeout-minutes: 5',
      '        working-directory: sub',
      '        env: { STEP: "s" }',
    ].join('\n'),
    'ci.yml',
  )
  assert.equal(wf.id, 'ci', 'id comes from the file stem')
  assert.equal(wf.name, 'CI', 'display name comes from name:')
  assert.deepEqual(wf.jobs.map((j) => j.id), ['second', 'first'], 'file order preserved')
  assert.deepEqual(wf.jobs[0].needs, ['first'])
  assert.equal(wf.jobs[1].steps[0].timeoutMinutes, 5)
  assert.equal(wf.jobs[1].steps[0].workingDirectory, 'sub')
  assert.equal(wf.jobs[1].steps[0].env.STEP, 's')
  assert.equal(wf.jobs[1].env.JOB, 'j')
  assert.equal(wf.env?.GLOBAL, 'g', 'root-level env parsed into Workflow.env')
  assert.deepEqual(wf.schedule, [], 'list-form on: carries no schedule')

  // name: falls back to the stem
  assert.equal(parseWorkflow('jobs:\n  a:\n    steps:\n      - run: x\n', 'my-wf.yml').name, 'my-wf')

  // unknown keys are ignored at any depth, but forbidden ones are not
  const nestedUnknown = parseWorkflow('jobs:\n  a:\n    strategy:\n      fail-fast: false\n    steps:\n      - run: x\n', 'nested.yml')
  assert.equal(nestedUnknown.jobs[0].steps[0].run, 'x', 'unknown nested keys are ignored, not rejected')

  // ---------------------------------------------------------- parse: rejects
  const throws = (text, file, re, msg) => assert.throws(() => parseWorkflow(text, file), re, msg)
  throws('jobs: {}\n', 'x.yml', /non-empty/, 'empty jobs rejected')
  throws('not-a-mapping\n', 'x.yml', /mapping/, 'scalar document rejected')
  throws('jobs:\n  a:\n    steps:\n      - uses: actions/setup-node@v4\n', 'x.yml', /unsupported key "uses"/, 'uses rejected')
  throws('jobs:\n  a:\n    if: x\n    steps:\n      - run: y\n', 'x.yml', /unsupported key "if"/, 'job-level if rejected')
  throws(
    'jobs:\n  a:\n    strategy:\n      matrix:\n        node: [20, 22]\n    steps:\n      - run: y\n',
    'x.yml',
    /unsupported key "matrix"/,
    'nested strategy.matrix rejected',
  )
  throws('jobs:\n  a:\n    steps:\n      - run: y\n    needs: [ghost]\n', 'x.yml', /unknown job "ghost"/, 'unknown needs rejected')
  throws(
    'jobs:\n  a:\n    needs: [b]\n    steps:\n      - run: x\n  b:\n    needs: [a]\n    steps:\n      - run: y\n',
    'x.yml',
    /cycle/,
    'cycle rejected',
  )
  throws('jobs:\n  a:\n    steps:\n      - name: no run\n', 'x.yml', /run: is required/, 'missing run rejected')
  throws(
    'jobs:\n  a:\n    steps:\n      - run: x\n        timeout-minutes: banana\n',
    'x.yml',
    /timeout-minutes/,
    'bad timeout rejected',
  )
  throws('{{{\n', 'x.yml', /invalid YAML/, 'malformed yaml wrapped in SetupError')

  // --------------------------------------------------- discovery + load
  await writeWf('build.yml', 'name: Build\njobs:\n  j:\n    steps:\n      - run: echo hi\n')
  await writeWf('broken.yml', 'jobs: { oops\n')
  const list = await listWorkflows(scratch)
  const byId = Object.fromEntries(list.map((w) => [w.id, w]))
  assert.deepEqual(Object.keys(byId).sort(), ['broken', 'build'], 'both files discovered')
  assert.equal(byId.build.name, 'Build')
  assert.ok(byId.broken.error, 'unparseable file surfaces an error instead of throwing')
  const loaded = await loadWorkflow(scratch, 'build')
  assert.equal(loaded.jobs[0].steps[0].run, 'echo hi')
  await assert.rejects(() => loadWorkflow(scratch, 'missing'), SetupError, 'unknown id throws SetupError')
  assert.deepEqual(await listWorkflows(path.join(scratch, 'nowhere')), [], 'missing dir lists empty')

  // ------------------------------------------------------------------- store
  const iso = () => new Date().toISOString()
  const record = (id, startedAt) => ({
    id,
    workflow: 'build',
    name: 'Build',
    root: scratch,
    status: 'success',
    trigger: 'cli',
    startedAt,
    updatedAt: startedAt,
    endedAt: startedAt,
    jobs: [{ id: 'j', name: 'j', status: 'success', steps: [{ name: 's', run: 'echo', status: 'success', exitCode: 0, startedAt, endedAt: startedAt, log: 'hello-log' }] }],
  })

  await saveRun(scratch, record('run-a', iso()))
  const round = await getRun(scratch, 'run-a')
  assert.equal(round.status, 'success')
  assert.equal(round.jobs[0].steps[0].log, 'hello-log')
  assert.equal(await getRun(scratch, 'run-missing'), null, 'missing run is null')

  // summaries drop step logs so the list endpoint stays small
  const [summary] = (await listRuns(scratch, { limit: 10 })).runs
  assert.equal(summary.id, 'run-a')
  assert.equal(summary.jobs[0].steps[0].log, undefined, 'summaries omit logs')

  // a record stuck in running past the stale window reads back as failed.
  // Written directly to the store file: saveRun() always stamps updatedAt=now.
  const old = new Date(Date.now() - 61 * 60 * 1000).toISOString()
  await mkdir(runsDir(scratch), { recursive: true })
  await writeFile(
    path.join(runsDir(scratch), 'run-stale.json'),
    JSON.stringify({ ...record('run-stale', iso()), status: 'running', updatedAt: old }),
    'utf8',
  )
  assert.equal((await getRun(scratch, 'run-stale')).status, 'failed', 'stale running reads as failed')
  assert.equal((await listRuns(scratch, { limit: 10 })).runs.find((r) => r.id === 'run-stale').status, 'failed')

  // prune honours the configured retention; invalid values fall back to 200
  assert.equal(resolveKeepRuns(undefined), 200, 'absent keepRuns defaults to 200')
  assert.equal(resolveKeepRuns(15), 15, 'integers >= 10 are used as-is')
  assert.equal(resolveKeepRuns(5), 200, 'values below 10 are invalid -> default')
  assert.equal(resolveKeepRuns(15.5), 200, 'non-integers are invalid -> default')
  assert.equal(resolveKeepRuns('500'), 200, 'non-numbers are invalid -> default')

  for (let i = 0; i < 20; i += 1) {
    await saveRun(scratch, { ...record(`run-p${i}`, new Date(Date.now() + i * 1000).toISOString()), id: `run-p${i}` }, 15)
  }
  assert.equal((await listRuns(scratch, { limit: 200 })).runs.length, 15, 'prune honours keepRuns')
  assert.equal(await getRun(scratch, 'run-p0'), null, 'oldest pruned')
  assert.ok(await getRun(scratch, 'run-p19'), 'newest kept')

  // ------------------------------------------------------- listRuns query
  const qDir = await mkdtemp(path.join(tmpdir(), 'sb-ci-query-'))
  const qRecord = (id, startedAt, extra = {}) => ({ ...record(id, startedAt), root: qDir, ...extra })
  await saveRun(qDir, qRecord('q-b0', new Date(Date.now() + 1000).toISOString()))
  await saveRun(qDir, qRecord('q-b1', new Date(Date.now() + 2000).toISOString()))
  await saveRun(qDir, qRecord('q-b2', new Date(Date.now() + 3000).toISOString()))
  await saveRun(qDir, qRecord('q-f1', new Date(Date.now() + 4000).toISOString(), { status: 'failed' }))
  await saveRun(qDir, qRecord('q-f2', new Date(Date.now() + 5000).toISOString(), { status: 'failed' }))
  await saveRun(qDir, qRecord('q-o1', new Date(Date.now() + 6000).toISOString(), { workflow: 'other', name: 'Other' }))

  const page = await listRuns(qDir, { limit: 2, offset: 1 })
  assert.equal(page.total, 6, 'total counts every run before pagination')
  assert.equal(page.limit, 2, 'limit echoed back')
  assert.equal(page.offset, 1, 'offset echoed back')
  assert.deepEqual(page.runs.map((r) => r.id), ['q-f2', 'q-f1'], 'newest first, windowed by limit/offset')

  const pastEnd = await listRuns(qDir, { limit: 2, offset: 99 })
  assert.equal(pastEnd.offset, pastEnd.total, 'offset clamps to total')
  assert.equal(pastEnd.runs.length, 0, 'a clamped offset yields an empty page')

  const wfOnly = await listRuns(qDir, { workflow: 'build', limit: 50 })
  assert.equal(wfOnly.total, 5, 'workflow filter is exact')
  assert.ok(wfOnly.runs.every((r) => r.workflow === 'build'), 'filtered runs all match')

  const failedOnly = await listRuns(qDir, { status: 'failed', limit: 50 })
  assert.deepEqual(failedOnly.runs.map((r) => r.id).sort(), ['q-f1', 'q-f2'], 'status filter is exact')
  assert.equal((await listRuns(qDir, { status: 'FAILED' })).total, 0, 'filters are case-sensitive')

  const defaults = await listRuns(qDir)
  assert.equal(defaults.limit, 20, 'default limit is 20')
  assert.equal(defaults.runs.length, 6, 'default page fits every fixture run')

  await rm(path.dirname(runsDir(qDir)), { recursive: true, force: true })
  await rm(qDir, { recursive: true, force: true })

  assert.match(newRunId(), /^run-/, 'run ids are prefixed')

  // ------------------------------------------------------------------ runner
  const { run } = await import('../dist/ci/index.js')

  const orderWf = parseWorkflow(
    [
      'jobs:',
      '  late:',
      '    needs: [early]',
      '    steps:',
      '      - run: node -e "require(\'fs\').appendFileSync(\'order.txt\',\'B\')"',
      '  early:',
      '    steps:',
      '      - run: node -e "require(\'fs\').appendFileSync(\'order.txt\',\'A\')"',
    ].join('\n'),
    'order.yml',
  )
  const orderRun = await run(scratch, orderWf, { trigger: 'cli' })
  assert.equal(orderRun.status, 'success', 'healthy run succeeds')
  assert.equal(await readFile(path.join(scratch, 'order.txt'), 'utf8'), 'AB', 'topological order despite file order')

  // failure: dependents skip, independents continue
  const failWf = parseWorkflow(
    [
      'jobs:',
      '  broken:',
      '    steps:',
      '      - run: node -e "process.exit(3)"',
      '  dependent:',
      '    needs: [broken]',
      '    steps:',
      '      - run: node -e "require(\'fs\').appendFileSync(\'side.txt\',\'NO\')"',
      '  independent:',
      '    steps:',
      '      - run: node -e "require(\'fs\').appendFileSync(\'side.txt\',\'YES\')"',
    ].join('\n'),
    'fail.yml',
  )
  const events = []
  let persistedBeforeObserve = false
  const failRun = await run(scratch, failWf, {
    trigger: 'cli',
    runId: 'run-failtest',
    onEvent: (ev) => {
      events.push(ev.type + ':' + (ev.job?.id ?? ''))
      if (ev.type === 'step_end') {
        // saveRun must have flushed the step BEFORE the observer runs
        void getRun(scratch, 'run-failtest').then((saved) => {
          const step = saved?.jobs
            .find((j) => j.id === ev.job.id)
            ?.steps.find((s) => s.name === ev.step.name)
          if (step && step.status === ev.record.status) persistedBeforeObserve = true
        })
      }
    },
  })
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(persistedBeforeObserve, true, 'record persisted before step_end observers run')
  assert.equal(failRun.status, 'failed', 'a failing step fails the run')
  const jobStatus = Object.fromEntries(failRun.jobs.map((j) => [j.id, j.status]))
  assert.equal(jobStatus.broken, 'failed')
  assert.equal(jobStatus.dependent, 'skipped', 'dependent job skipped')
  assert.equal(jobStatus.independent, 'success', 'independent job still ran')
  assert.equal(await readFile(path.join(scratch, 'side.txt'), 'utf8'), 'YES', 'skip actually prevented execution')
  assert.ok(events.includes('step_end:independent'), 'onEvent fires per step')
  const failedStep = failRun.jobs.find((j) => j.id === 'broken').steps[0]
  assert.equal(failedStep.exitCode, 3, 'exit code captured')

  // env precedence: step beats job beats workflow beats runner vars
  const envWf = parseWorkflow(
    [
      'env: { MIX: "wf", ONLY_WF: "w" }',
      'jobs:',
      '  j:',
      '    env: { MIX: "job" }',
      '    steps:',
      '      - run: node -e "console.log(process.env.MIX + \'/\' + process.env.ONLY_WF + \'/\' + process.env.CI + \'/\' + process.env.SWITCHBOARD_CI_WORKFLOW)"',
      '        env: { MIX: "step" }',
    ].join('\n'),
    'env.yml',
  )
  const envRun = await run(scratch, envWf, { trigger: 'cli' })
  assert.equal(envRun.status, 'success')
  assert.match(envRun.jobs[0].steps[0].log, /^step\/w\/true\/env$/m, 'precedence + runner vars in log')

  // timeout
  const slowWf = parseWorkflow(
    'jobs:\n  j:\n    steps:\n      - run: node -e "setTimeout(() => {}, 60000)"\n        timeout-minutes: 0.02\n',
    'slow.yml',
  )
  const before = Date.now()
  const slowRun = await run(scratch, slowWf, { trigger: 'cli' })
  assert.ok(Date.now() - before < 20_000, 'timeout kills the step quickly')
  assert.equal(slowRun.status, 'failed')
  assert.match(slowRun.jobs[0].steps[0].note ?? '', /timed out/, 'timeout note recorded')

  // log cap
  const bigWf = parseWorkflow(
    'jobs:\n  j:\n    steps:\n      - run: node -e "process.stdout.write(\'x\'.repeat(300000))"\n',
    'big.yml',
  )
  const bigRun = await run(scratch, bigWf, { trigger: 'cli' })
  const bigStep = bigRun.jobs[0].steps[0]
  assert.equal(bigStep.truncated, true, 'oversized log flagged truncated')
  assert.ok(bigStep.log.length <= 256 * 1024 + 40, 'log stays under the cap')

  // cancellation
  const cancelWf = parseWorkflow('jobs:\n  j:\n    steps:\n      - run: node -e "setTimeout(() => {}, 60000)"\n', 'cancel.yml')
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 400)
  const cancelBefore = Date.now()
  const cancelRun = await run(scratch, cancelWf, { trigger: 'cli', signal: controller.signal })
  assert.equal(cancelRun.status, 'cancelled', 'aborted run reports cancelled')
  assert.ok(Date.now() - cancelBefore < 20_000, 'abort kills the step')

  // abort after a passing job leaves [success, cancelled] — never a success run
  const mixWf = parseWorkflow(
    [
      'jobs:',
      '  pass:',
      '    steps:',
      '      - run: node -e "require(\'fs\').appendFileSync(\'mix.txt\',\'A\')"',
      '  later:',
      '    steps:',
      '      - run: node -e "require(\'fs\').appendFileSync(\'mix.txt\',\'B\')"',
    ].join('\n'),
    'mix.yml',
  )
  const mixController = new AbortController()
  const mixRun = await run(scratch, mixWf, {
    trigger: 'cli',
    signal: mixController.signal,
    onEvent: (ev) => {
      if (ev.type === 'job_end' && ev.job.id === 'pass') mixController.abort()
    },
  })
  assert.equal(mixRun.jobs.find((j) => j.id === 'pass').status, 'success', 'first job finished before the abort')
  assert.equal(mixRun.jobs.find((j) => j.id === 'later').status, 'cancelled', 'second job cancelled by the abort')
  assert.equal(mixRun.status, 'cancelled', 'a run mixing success and cancelled jobs is cancelled, not success')

  // abort landing after a failed step must not downgrade the job to cancelled
  const raceWf = parseWorkflow(
    [
      'jobs:',
      '  good:',
      '    steps:',
      '      - run: node -e "require(\'fs\').appendFileSync(\'race.txt\',\'OK\')"',
      '  bad:',
      '    steps:',
      '      - run: node -e "process.exit(7)"',
      '      - run: node -e "require(\'fs\').appendFileSync(\'race.txt\',\'NO\')"',
    ].join('\n'),
    'race.yml',
  )
  const raceController = new AbortController()
  const raceRun = await run(scratch, raceWf, {
    trigger: 'cli',
    signal: raceController.signal,
    onEvent: (ev) => {
      if (ev.type === 'step_end' && ev.job.id === 'bad' && ev.record.status === 'failed') raceController.abort()
    },
  })
  const raceBad = raceRun.jobs.find((j) => j.id === 'bad')
  assert.equal(raceBad.steps[1].status, 'skipped', 'abort after a failed step skips, never cancels')
  assert.equal(raceBad.status, 'failed', 'failed job stays failed across abort')
  assert.equal(raceRun.jobs.find((j) => j.id === 'good').status, 'success', 'independent job succeeded')
  assert.equal(raceRun.status, 'failed', 'run with a non-zero step is never success')
  assert.equal(await readFile(path.join(scratch, 'race.txt'), 'utf8'), 'OK', 'step after the failed one never executed')

  // a failure raised only by a PowerShell cmdlet must not read as success:
  // $LASTEXITCODE stays null for cmdlets (sh exits 127 for the unknown command)
  const cmdletWf = parseWorkflow('jobs:\n  j:\n    steps:\n      - run: Get-Item sbx-ci-no-such-item\n', 'cmdlet.yml')
  const cmdletRun = await run(scratch, cmdletWf, { trigger: 'cli' })
  const cmdletStep = cmdletRun.jobs[0].steps[0]
  assert.equal(cmdletStep.status, 'failed', 'cmdlet failure marks the step failed')
  assert.notEqual(cmdletStep.exitCode, 0, 'cmdlet failure exits non-zero')
  assert.equal(cmdletRun.status, 'failed', 'cmdlet failure fails the run')

  // trigger: schedule is a first-class trigger
  const trigWf = parseWorkflow('jobs:\n  j:\n    steps:\n      - run: node -e "console.log(1)"\n', 'trig.yml')
  const trigRun = await run(scratch, trigWf, { trigger: 'schedule' })
  assert.equal(trigRun.trigger, 'schedule', 'run record carries trigger: schedule')

  // --------------------------------------------------------------------- CLI
  const { spawn } = await import('node:child_process')
  const cliJs = path.resolve('dist', 'cli.js')
  const cli = (argv, cwd) =>
    new Promise((resolveCli, rejectCli) => {
      const child = spawn(process.execPath, [cliJs, ...argv], { cwd })
      let out = ''
      const timer = setTimeout(() => {
        // kill the whole tree — a hung run leaves powershell holding the pipes
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
        } else {
          child.kill()
        }
        rejectCli(new Error(`cli(${argv.join(' ')}) timed out after 30s — output so far: ${out}`))
      }, 30_000)
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (out += d))
      child.on('error', (error) => {
        clearTimeout(timer)
        rejectCli(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolveCli({ code, out })
      })
    })

  const enabledDir = await mkdtemp(path.join(tmpdir(), 'sb-ci-cli-'))
  await mkdir(path.join(enabledDir, '.switchboard', 'workflows'), { recursive: true })
  await writeFile(
    path.join(enabledDir, 'switchboard.config.jsonc'),
    '{ "ci": { "enabled": true } }',
    'utf8',
  )
  await writeFile(
    path.join(enabledDir, '.switchboard', 'workflows', 'ok.yml'),
    'name: Ok\njobs:\n  j:\n    steps:\n      - run: node -e "console.log(\'cli-ci-marker\')"\n',
    'utf8',
  )
  await writeFile(
    path.join(enabledDir, '.switchboard', 'workflows', 'bad.yml'),
    'jobs:\n  j:\n    steps:\n      - uses: whatever@v1\n',
    'utf8',
  )

  const listed = await cli(['ci', '--list'], enabledDir)
  assert.equal(listed.code, 0, `--list exits 0 (got ${listed.code}: ${listed.out})`)
  assert.match(listed.out, /ok/, 'lists the ok workflow')
  assert.match(listed.out, /bad/, 'lists the broken workflow with its error')

  const runOne = await cli(['ci', 'ok'], enabledDir)
  assert.equal(runOne.code, 0, `ci ok exits 0 (got ${runOne.code}: ${runOne.out})`)
  assert.match(runOne.out, /cli-ci-marker/, 'step log reaches the console')
  assert.match(runOne.out, /run success/, 'summary printed')

  const listedAfter = await cli(['ci', '--list'], enabledDir)
  assert.equal(listedAfter.code, 0, `re-list exits 0 (got ${listedAfter.code}: ${listedAfter.out})`)
  const plainList = listedAfter.out.replace(/\x1b\[[0-9;]*m/g, '')
  assert.match(plainList, /^ok\s+Ok\s+.*last: success .*cron: - .*next: -$/m, 'list shows last status and empty schedule columns')
  assert.match(plainList, /^bad\s+bad\s+.*last: - .*cron: - .*next: -$/m, 'never-run workflow shows last: - and empty schedule columns')

  await writeFile(
    path.join(enabledDir, '.switchboard', 'workflows', 'night.yml'),
    'name: Night\non:\n  schedule: "0 3 * * *"\njobs:\n  j:\n    steps:\n      - run: node -e "console.log(\'night-marker\')"\n',
    'utf8',
  )
  const listedNight = await cli(['ci', '--list'], enabledDir)
  assert.equal(listedNight.code, 0, `scheduled workflow lists cleanly (got ${listedNight.out})`)
  const nightPlain = listedNight.out.replace(/\x1b\[[0-9;]*m/g, '')
  assert.match(
    nightPlain,
    /^night\s+Night\s+.*cron: 0 3 \* \* \* next: \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m,
    'scheduled workflow shows cron + next fire time in local format',
  )

  const runBad = await cli(['ci', 'bad'], enabledDir)
  assert.equal(runBad.code, 1, 'setup-failed run exits 1')
  assert.match(runBad.out, /setup-failed/, 'setup failure reported')

  const runUnknown = await cli(['ci', 'ghost'], enabledDir)
  assert.equal(runUnknown.code, 1, 'unknown workflow exits 1')
  assert.match(runUnknown.out, /unknown workflow/, 'unknown workflow message')

  // a display name shared by several files runs only the first match (spec §7)
  await writeFile(
    path.join(enabledDir, '.switchboard', 'workflows', 'dup-a.yml'),
    'name: Dup\njobs:\n  j:\n    steps:\n      - run: node -e "console.log(\'dup-a-marker\')"\n',
    'utf8',
  )
  await writeFile(
    path.join(enabledDir, '.switchboard', 'workflows', 'dup-b.yml'),
    'name: Dup\njobs:\n  j:\n    steps:\n      - run: node -e "console.log(\'dup-b-marker\')"\n',
    'utf8',
  )
  const dupRun = await cli(['ci', 'Dup'], enabledDir)
  assert.equal(dupRun.code, 0, `ci Dup exits 0 (got ${dupRun.code}: ${dupRun.out})`)
  const dupMarkers = ['dup-a-marker', 'dup-b-marker'].filter((m) => dupRun.out.includes(m))
  assert.equal(dupMarkers.length, 1, 'only one workflow with a matching name runs')
  const dupRecords = (await listRuns(enabledDir, { limit: 50 })).runs.filter((r) => r.workflow === 'dup-a' || r.workflow === 'dup-b')
  assert.equal(dupRecords.length, 1, 'a single run record is created')

  const disabledDir = await mkdtemp(path.join(tmpdir(), 'sb-ci-off-'))
  const off = await cli(['ci'], disabledDir)
  assert.equal(off.code, 1, 'disabled ci exits 1')
  assert.match(off.out, /ci is disabled/, 'enable hint printed')
  assert.match(off.out, /"ci": \{ "enabled": true \}/, 'hint shows the exact config flag')

  await rm(enabledDir, { recursive: true, force: true })
  await rm(path.dirname(runsDir(enabledDir)), { recursive: true, force: true })
  await rm(disabledDir, { recursive: true, force: true })

  // ------------------------------------------- interrupt (SIGINT/SIGTERM -> cancelled)
  // The CLI wires process signals to the run's AbortController. OS console
  // delivery is Node's job, so the handlers are driven via process.emit.
  const sigDir = await mkdtemp(path.join(tmpdir(), 'sb-ci-sig-'))
  await mkdir(path.join(sigDir, '.switchboard', 'workflows'), { recursive: true })
  await writeFile(path.join(sigDir, 'switchboard.config.jsonc'), '{ "ci": { "enabled": true } }', 'utf8')
  await writeFile(
    path.join(sigDir, '.switchboard', 'workflows', 'slow.yml'),
    'name: Slow\njobs:\n  j:\n    steps:\n      - run: node -e "setTimeout(() => {}, 15000)"\n',
    'utf8',
  )
  const { runCiCommand } = await import('../dist/cli.js')
  const keepLog = [console.log, console.error]
  const keepExit = process.exitCode
  console.log = () => {}
  console.error = () => {}
  try {
    for (const [signal, expectedExit] of [['SIGINT', 130], ['SIGTERM', 143]]) {
      const running = runCiCommand(
        { command: 'ci', positional: ['slow'], cwd: sigDir, plugins: [], session: true, open: true },
        { ci: { enabled: true } },
      )
      let started = null
      const deadline = Date.now() + 15_000
      while (!started && Date.now() < deadline) {
        started = (await listRuns(sigDir, { limit: 5 })).runs.find((r) => r.status === 'running') ?? null
        if (!started) await new Promise((r) => setTimeout(r, 100))
      }
      assert.ok(started, `${signal}: run reaches running state`)
      process.emit(signal)
      await running
      const record = await getRun(sigDir, started.id)
      assert.equal(record.status, 'cancelled', `${signal}: run persisted as cancelled`)
      assert.equal(process.exitCode, expectedExit, `${signal}: exits with ${expectedExit}`)
    }
  } finally {
    console.log = keepLog[0]
    console.error = keepLog[1]
    process.exitCode = keepExit
    await rm(sigDir, { recursive: true, force: true })
    await rm(path.dirname(runsDir(sigDir)), { recursive: true, force: true })
  }

  console.log('ci workflows: OK')
} finally {
  await rm(path.dirname(runsDir(scratch)), { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
}
