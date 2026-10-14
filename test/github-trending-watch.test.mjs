import test from 'node:test';
import assert from 'node:assert/strict';
import { mondayISO, safeRepository, parseSnapshot, score, formatReport } from '../scripts/github-trending-watch.mjs';

test('Monday UTC is stable for Wednesday and Monday', () => {
  assert.equal(mondayISO('2026-10-14T08:00:00Z'), '2026-10-12');
  assert.equal(mondayISO('2026-10-12T01:00:00Z'), '2026-10-12');
  assert.equal(mondayISO('2026-10-11T23:59:00Z'), '2026-10-05');
});

test('reject unsafe names and malformed counts', () => {
  assert.equal(safeRepository({full_name: 'owner/good-repo', stargazers_count: 10}).name, 'owner/good-repo');
  assert.equal(safeRepository({full_name: 'x](https://evil)/y', stargazers_count: 10}), null);
  assert.equal(safeRepository({full_name: 'owner/name', stargazers_count: NaN}), null);
});

test('rank known growth before unknown entrants, without fabricating growth', () => {
  const items = [
    {name: 'new/app', stars: 999, categories: ['New']},
    {name: 'old/fast', stars: 250, categories: ['AI']},
    {name: 'old/slow', stars: 150, categories: ['AI']},
  ];
  const ranked = score(items, {'old/fast': 200, 'old/slow': 149});
  assert.deepEqual(ranked.map((x) => x.name), ['old/fast', 'old/slow', 'new/app']);
  assert.equal(ranked[2].delta, null);
});

test('report embeds a reusable snapshot and discloses baseline limitation', () => {
  const items = [{name: 'owner/repo', stars: 100, categories: ['AI agents']}];
  const body = formatReport(items, {}, '2026-10-12', ['topic:ai-agent']);
  assert.match(body, /First run \/ baseline/);
  assert.match(body, /not the official GitHub Trending ranking/);
  assert.match(body, /new to watch/);
  assert.deepEqual(parseSnapshot(body), {'owner/repo': 100});
  assert.deepEqual(parseSnapshot('bad body'), {});
});

test('malformed hidden snapshot is ignored', () => {
  assert.deepEqual(parseSnapshot('<!-- GITHUB_TREND_SNAPSHOT_V1:bm90anNvbg== -->'), {});
});
