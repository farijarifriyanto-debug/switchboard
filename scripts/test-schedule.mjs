/**
 * Tests for the schedule module (src/ci/schedule.ts) + on.schedule parsing.
 *
 *   node scripts/test-schedule.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { evaluateSchedules, loadScheduleState, listWorkflows, nextFire, parseCron, parseWorkflow, runsDir, saveScheduleState, scheduleStateFile, SetupError } from '../dist/ci/index.js'

const scratch = await mkdtemp(path.join(tmpdir(), 'sb-sched-'))

try {
  // ------------------------------------------------------------- parseCron
  const spec = parseCron('*/15 9-17 1,15 * 1-5')
  assert.deepEqual([...spec.minutes].sort((a, b) => a - b), [0, 15, 30, 45], '*/n expands')
  assert.deepEqual([...spec.hours].sort((a, b) => a - b), [9, 10, 11, 12, 13, 14, 15, 16, 17], 'ranges expand')
  assert.deepEqual([...spec.doms].sort((a, b) => a - b), [1, 15], 'lists expand')
  assert.equal(spec.months.size, 12, 'bare * covers everything')
  assert.equal(spec.domRestricted, true, 'non-* dom is restricted')
  assert.equal(spec.dowRestricted, true, 'non-* dow is restricted')

  const full = parseCron('* * * * *')
  assert.equal(full.minutes.size, 60, 'minute field covers 0-59')
  assert.equal(full.hours.size, 24, 'hour field covers 0-23')
  assert.equal(full.doms.size, 31, 'dom field covers 1-31')
  assert.equal(full.months.size, 12, 'month field covers 1-12')
  assert.equal(full.dows.size, 7, 'dow field covers 0-6')
  assert.equal(full.domRestricted, false, 'bare * is unrestricted')
  assert.equal(full.dowRestricted, false, 'bare * is unrestricted')

  assert.ok(parseCron('0 0 * * 7').dows.has(0), 'dow 7 normalizes to Sunday (0)')
  assert.ok(parseCron('0 0 * * 0-7').dows.size === 7, '0-7 dow dedupes to 7 values')
  assert.deepEqual([...parseCron('0 0 * * 5-6').dows], [5, 6], 'plain ranges work in dow')

  const throws = (expr, re) => assert.throws(() => parseCron(expr), re, `rejects ${expr}`)
  throws('@daily', /expected 5 fields/)
  throws('0 0 0 * * *', /expected 5 fields/, '6-field rejected')
  throws('0 0 * *', /expected 5 fields/, '4-field rejected')
  throws('', /expected 5 fields/)
  throws('? * * * *', /unsupported token "\?"/)
  throws('L * * * *', /unsupported token "L"/)
  throws('1#1 * * * *', /unsupported token/)
  throws('JAN * * * *', /unsupported token "JAN"/)
  throws('MON * * * *', /unsupported token "MON"/)
  throws('*/0 * * * *', /positive/)
  throws('60 * * * *', /out of range/)
  throws('* 24 * * *', /out of range/)
  throws('* * 0 * *', /out of range/, 'dom starts at 1')
  throws('* * * 13 *', /out of range/)
  throws('* * * * 8', /out of range/)
  throws('5-1 * * * *', /descending/)
  throws('1,,2 * * * *', /empty entry/)
  throws('1-5/2 * * * *', /unsupported token/, 'step-ranged lists are not in the supported grammar')

  // -------------------------------------------------------------- nextFire
  const daily = parseCron('0 3 * * *')
  const at = (y, m, d, h, min, s = 0) => new Date(y, m - 1, d, h, min, s)

  const sameDay = nextFire(daily, at(2026, 10, 7, 2, 59))
  assert.equal(sameDay.getFullYear(), 2026)
  assert.equal(sameDay.getMonth(), 9)
  assert.equal(sameDay.getDate(), 7, 'next fire today when the slot is ahead')
  assert.equal(sameDay.getHours(), 3, 'fires at 03:00 local')
  assert.equal(sameDay.getMinutes(), 0)

  const afterSlot = nextFire(daily, at(2026, 10, 7, 3, 0))
  assert.equal(afterSlot.getDate(), 8, 'strictly after: an exact slot jumps to tomorrow')

  const minutePrecision = nextFire(daily, at(2026, 10, 7, 3, 0, 15))
  assert.equal(minutePrecision.getDate(), 8, 'seconds inside the slot still jump to tomorrow')

  const monthly = parseCron('0 0 1 * *')
  const monthSkip = nextFire(monthly, at(2026, 1, 15, 12, 0))
  assert.equal(monthSkip.getMonth(), 1, 'skips to February')
  assert.equal(monthSkip.getDate(), 1)
  assert.equal(monthSkip.getHours(), 0)

  const mondays = parseCron('0 9 * * 1')
  const nextMon = nextFire(mondays, at(2026, 10, 7, 10, 0)) // 2026-10-07 is a Wednesday
  assert.equal(nextMon.getDay(), 1, 'lands on Monday')
  assert.equal(nextMon.getDate(), 12)
  assert.equal(nextMon.getHours(), 9)

  // Vixie OR rule: both dom and dow restricted -> fires on the 13th OR on Fridays
  const orRule = parseCron('0 0 13 * 5')
  const oct9 = nextFire(orRule, at(2026, 10, 7, 12, 0))
  assert.equal(oct9.getDate(), 9, 'dow match (Friday) lands before the 13th')
  const oct13 = nextFire(orRule, at(2026, 10, 9, 0, 0))
  assert.equal(oct13.getDate(), 13, 'dom match fires after the Friday')
  const oct16 = nextFire(orRule, at(2026, 10, 13, 0, 0))
  assert.equal(oct16.getDate(), 16, 'after the dom match, the dow match (Friday) fires')

  // dom restricted, dow unrestricted -> dom alone decides
  const domOnly = parseCron('0 0 15 * *')
  const domNext = nextFire(domOnly, at(2026, 10, 7, 0, 0))
  assert.equal(domNext.getDate(), 15)

  assert.equal(nextFire(parseCron('0 0 30 2 *'), at(2026, 1, 1, 0, 0)), null, 'impossible date returns null')

  // --------------------------------------------------- on.schedule parsing
  const wfDir = path.join(scratch, '.switchboard', 'workflows')
  await mkdir(wfDir, { recursive: true })
  const writeWf = (name, text) => writeFile(path.join(wfDir, name), text, 'utf8')
  const body = 'jobs:\n  j:\n    steps:\n      - run: echo x\n'

  const stringForm = parseWorkflow(`on:\n  schedule: "*/5 * * * *"\n${body}`, 'string.yml')
  assert.deepEqual(stringForm.schedule, [{ cron: '*/5 * * * *' }], 'bare string form accepted')
  assert.deepEqual(
    parseWorkflow('jobs:\n  j:\n    steps:\n      - run: x\n', 'none.yml').schedule,
    [],
    'missing on: yields no schedule',
  )
  assert.deepEqual(
    parseWorkflow(`on: [push, workflow_dispatch]\n${body}`, 'list.yml').schedule,
    [],
    'list-form on: is ignored',
  )
  assert.deepEqual(
    parseWorkflow(`on: push\n${body}`, 'str.yml').schedule,
    [],
    'string-form on: is ignored',
  )
  assert.deepEqual(
    parseWorkflow(`on:\n  push:\n    branches: [main]\n${body}`, 'map.yml').schedule,
    [],
    'non-schedule on: mapping is ignored',
  )
  assert.deepEqual(
    parseWorkflow(`on:\n  schedule:\n    - cron: "0 3 * * *"\n    - cron: "0 9 * * 1"\n${body}`, 'gh.yml').schedule,
    [{ cron: '0 3 * * *' }, { cron: '0 9 * * 1' }],
    'GitHub array form accepted, multiple entries kept',
  )

  const throwsWf = (text, re, msg) => assert.throws(() => parseWorkflow(text, 'sched-bad.yml'), re, msg)
  throwsWf(`on:\n  schedule: "@daily"\n${body}`, /invalid cron "@daily"/, 'nickname rejected with context')
  throwsWf(`on:\n  schedule: "0 0 0 * * *"\n${body}`, /invalid cron/, '6-field rejected with context')
  throwsWf(`on:\n  schedule: 5\n${body}`, /on\.schedule must be a string or a list/, 'scalar schedule rejected')
  throwsWf(`on:\n  schedule:\n    - "0 3 * * *"\n${body}`, /entries must be \{ cron/, 'bare-string list entries rejected')
  assert.throws(
    () => parseWorkflow(`on:\n  schedule: "nope"\n${body}`, 'sched-bad.yml'),
    SetupError,
    'cron failures surface as SetupError',
  )

  // invalid cron still lists the workflow, carrying the error
  await writeWf('bad-schedule.yml', `name: BadSched\non:\n  schedule: "@daily"\n${body}`)
  const listed = await listWorkflows(scratch)
  const bad = listed.find((w) => w.id === 'bad-schedule')
  assert.ok(bad, 'workflow with an invalid cron still appears in listings')
  assert.match(bad.error, /invalid cron "@daily"/, 'the listing carries the schedule error')
  assert.deepEqual(bad.schedule, [], 'error workflow carries no schedule')
  assert.deepEqual(bad.jobs, [], 'parse failed before jobs were built')

  // -------------------------------------------------------- schedule state
  assert.deepEqual(await loadScheduleState(scratch), { version: 1, workflows: {} }, 'missing state file defaults to empty')
  await saveScheduleState(scratch, { version: 1, workflows: { nightly: { lastFired: '2026-10-01T00:00:00.000Z' } } })
  assert.equal((await loadScheduleState(scratch)).workflows.nightly.lastFired, '2026-10-01T00:00:00.000Z', 'state round-trips')
  await writeFile(scheduleStateFile(scratch), '{not json', 'utf8')
  assert.deepEqual(await loadScheduleState(scratch), { version: 1, workflows: {} }, 'corrupt state recovers to empty')
  await writeFile(scheduleStateFile(scratch), JSON.stringify({ version: 1, workflows: { x: { lastFired: 'ok' }, junk: 3 } }), 'utf8')
  const loosely = await loadScheduleState(scratch)
  assert.equal(loosely.workflows.x.lastFired, 'ok', 'well-formed entries load')

  // ----------------------------------------------------- evaluateSchedules
  const stateOf = (id, lastFired) => ({ version: 1, workflows: { [id]: { lastFired } } })
  const nightly = [{ id: 'nightly', schedule: ['0 3 * * *'] }]
  const before = at(2026, 10, 7, 2, 59)
  const due = at(2026, 10, 7, 3, 0, 15)

  const notDue = evaluateSchedules(nightly, stateOf('nightly', at(2026, 10, 6, 3, 0).toISOString()), before)
  assert.deepEqual(notDue.toFire, [], 'not due before the slot')
  assert.equal(notDue.changed, false, 'untouched state is not rewritten')

  const fired = evaluateSchedules(nightly, stateOf('nightly', at(2026, 10, 6, 3, 0).toISOString()), due)
  assert.deepEqual(fired.toFire, ['nightly'], 'due workflow fires')
  assert.deepEqual(fired.skipped, [], 'nothing skipped without a running run')
  assert.equal(fired.changed, true, 'state changed')
  assert.equal(fired.state.workflows.nightly.lastFired, due.toISOString(), 'lastFired advances to now')

  const again = evaluateSchedules(nightly, fired.state, at(2026, 10, 7, 3, 0, 45))
  assert.deepEqual(again.toFire, [], 'the same slot does not fire twice')

  // catch-up collapses: many missed minutes -> exactly one fire, then quiet
  const minute = [{ id: 'm', schedule: ['* * * * *'] }]
  const catchUp = evaluateSchedules(minute, stateOf('m', at(2026, 10, 4, 0, 0).toISOString()), at(2026, 10, 7, 12, 0, 30))
  assert.deepEqual(catchUp.toFire, ['m'], 'one catch-up run regardless of missed slots')
  assert.deepEqual(evaluateSchedules(minute, catchUp.state, at(2026, 10, 7, 12, 0, 45)).toFire, [], 'no immediate re-fire')
  assert.deepEqual(evaluateSchedules(minute, catchUp.state, at(2026, 10, 7, 12, 1, 0)).toFire, ['m'], 'fires again on the next slot')

  // overlap: still advances lastFired, but does not fire
  const overlap = evaluateSchedules(nightly, stateOf('nightly', at(2026, 10, 6, 3, 0).toISOString()), due, new Set(['nightly']))
  assert.deepEqual(overlap.toFire, [], 'running workflow is not fired')
  assert.deepEqual(overlap.skipped, ['nightly'], 'skipped workflows are reported')
  assert.equal(overlap.changed, true, 'lastFired advances even when skipped')
  assert.deepEqual(evaluateSchedules(nightly, overlap.state, at(2026, 10, 7, 3, 1, 0)).toFire, [], 'no catch-up fire after the skip')

  // fresh state initializes to now (never floods)
  const fresh = evaluateSchedules(nightly, { version: 1, workflows: {} }, due)
  assert.deepEqual(fresh.toFire, [], 'unseen workflow does not fire immediately')
  assert.equal(fresh.changed, true, 'initialization counts as a change')
  assert.equal(fresh.state.workflows.nightly.lastFired, due.toISOString(), 'lastFired seeds to now')

  const garbage = evaluateSchedules(nightly, stateOf('nightly', 'not-a-date'), due)
  assert.equal(garbage.changed, true, 'corrupt lastFired re-initializes')
  assert.deepEqual(garbage.toFire, [], 'corrupt lastFired never fires')

  const multi = [{ id: 'x', schedule: ['0 3 * * *', '0 4 * * *'] }]
  const multiTick = evaluateSchedules(multi, stateOf('x', at(2026, 10, 6, 4, 0).toISOString()), at(2026, 10, 7, 5, 0))
  assert.equal(multiTick.toFire.length, 1, 'at most one run per workflow per tick')

  assert.equal(
    evaluateSchedules([{ id: 'manual', schedule: [] }], { version: 1, workflows: {} }, due).changed,
    false,
    'workflows without a schedule are ignored',
  )

  console.log('schedule: OK')
} finally {
  await rm(path.dirname(runsDir(scratch)), { recursive: true, force: true })
  await rm(scratch, { recursive: true, force: true })
}
