#!/usr/bin/env node
// Research-only weekly GitHub repository watch. Never executes third-party code.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PREFIX = '[GitHub Trending]';
const SNAPSHOT_START = '<!-- GITHUB_TREND_SNAPSHOT_V1:';
const SEARCHES = [
  ['New repositories (30d)', (d) => 'created:>=' + d + ' stars:>=100 archived:false'],
  ['AI agents', (d) => 'topic:ai-agent pushed:>=' + d + ' stars:>=500 archived:false'],
  ['Local AI', (d) => 'topic:local-ai pushed:>=' + d + ' stars:>=200 archived:false'],
  ['Browser agents', (d) => 'topic:browser-automation pushed:>=' + d + ' stars:>=50 archived:false'],
  ['Image editors', (d) => 'topic:image-editing pushed:>=' + d + ' stars:>=100 archived:false'],
  ['Document tools', (d) => 'topic:document-processing pushed:>=' + d + ' stars:>=100 archived:false'],
];

export function mondayISO(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

export function safeRepository(item) {
  const name = String(item.full_name ?? '');
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(name)) return null;
  if (!Number.isFinite(item.stargazers_count) || item.stargazers_count < 0) return null;
  return { name, stars: item.stargazers_count, categories: [] };
}

export function parseSnapshot(body) {
  const match = String(body ?? '').match(/<!-- GITHUB_TREND_SNAPSHOT_V1:([A-Za-z0-9+/=]+) -->/);
  if (!match) return {};
  try {
    const data = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    return Object.fromEntries(Object.entries(data).filter(([key, n]) =>
      /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(key) && Number.isFinite(n) && n >= 0));
  } catch {
    return {};
  }
}

export function score(items, previous) {
  return items.map((r) => ({
    ...r,
    delta: Object.hasOwn(previous, r.name)
      ? Math.max(0, r.stars - previous[r.name])
      : null,
  })).sort((a, b) => {
    if ((a.delta === null) !== (b.delta === null)) return a.delta === null ? 1 : -1;
    return (b.delta ?? 0) - (a.delta ?? 0) || b.stars - a.stars || a.name.localeCompare(b.name);
  });
}

export function formatReport(items, previous, today, queries) {
  const ranked = score(items, previous);
  const baseline = Object.keys(previous).length === 0;
  const top = ranked.slice(0, 25);
  const snapshot = Object.fromEntries(items.map((r) => [r.name, r.stars]));
  const columns = top.map((r, i) =>
    '| ' + (i + 1) + ' | [' + r.name + '](https://github.com/' + r.name + ') | ' +
    r.stars.toLocaleString('en-US') + ' | ' +
    (r.delta === null ? 'new to watch' : '+' + r.delta.toLocaleString('en-US')) + ' | ' +
    r.categories.join(', ') + ' |');
  return [
    '# GitHub repository watch — week of ' + today,
    '',
    '**Source:** GitHub Search API. **Stars = total stars; change = difference from the prior weekly snapshot, not the official GitHub Trending ranking.**',
    baseline ? '**First run / baseline:** weekly star changes are not available yet.' : '**Comparison:** versus last available report snapshot. Negative differences are clamped to zero.',
    '**Scope:** source repositories only; no dependency installation, code execution, or cloning. Public metadata is untrusted.',
    '',
    '| # | Repository | Total stars | Change | Search categories |',
    '| ---: | --- | ---: | ---: | --- |',
    ...columns,
    '',
    '## Selection method',
    '- Search includes newly created repositories and active AI/browser/local/image/document categories.',
    '- Results are limited to the leading 20 by total stars in each query. This is **not** a complete trending survey.',
    '- The first run records a baseline; subsequent runs rank known repositories by weekly star increase.',
    '- New entrants show "new to watch"; their weekly growth is unknown, not zero.',
    '- Current week snapshot is embedded for reproducible comparison in next week’s report.',
    '',
    '## GitHub search queries',
    ...queries.map((q) => '- \`' + q + '\`'),
    '',
    '## Product follow-up (manual review only)',
    '- Switchboard: compare Magpie model/provider switching and browser-use/jev-ultrafast action latency; Claude in Chrome remains the authoritative browser UX reference per AGENTS.md.',
    '- OlahDokumen / Image Studio: examine PdfCraft, PhotoCraft, and similar tools separately; do not blindly embed them.',
    '- Require independent visible laptop E2E, security/license checks, and owner release approval before integration.',
    '',
    SNAPSHOT_START + Buffer.from(JSON.stringify(snapshot)).toString('base64') + ' -->',
    '',
  ].join('\n');
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const target = process.env.GITHUB_REPOSITORY;
  if (!token || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(target ?? '')) {
    throw new Error('Requires GITHUB_TOKEN and GITHUB_REPOSITORY; no API requests made.');
  }
  const api = async (path, options = {}) => {
    const response = await fetch('https://api.github.com' + path, {
      ...options,
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'botconnector-github-trending-watch',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (!response.ok) throw new Error('GitHub API HTTP ' + response.status + ' at ' + path);
    return response.json();
  };
  const now = new Date();
  const since = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  const week = mondayISO(now);
  const queries = [];
  const seen = new Map();
  for (const [category, makeQuery] of SEARCHES) {
    const query = makeQuery(since);
    queries.push(query);
    const found = await api('/search/repositories?q=' + encodeURIComponent(query) + '&sort=stars&order=desc&per_page=20');
    for (const raw of found.items ?? []) {
      if (raw.archived || raw.private) continue;
      const record = safeRepository(raw);
      if (!record) continue;
      if (!seen.has(record.name)) seen.set(record.name, record);
      const r = seen.get(record.name);
      r.stars = record.stars;
      if (!r.categories.includes(category)) r.categories.push(category);
    }
  }
  if (!seen.size) throw new Error('All searches empty; refusing to publish an empty watch.');
  const existing = await api('/repos/' + target + '/issues?state=all&sort=created&direction=desc&per_page=100');
  const priorReports = existing.filter((it) => !it.pull_request && it.title?.startsWith(PREFIX));
  const thisWeek = priorReports.find((it) => it.title === PREFIX + ' ' + week);
  const previous = priorReports.find((it) => it.title !== PREFIX + ' ' + week);
  let oldSnapshot = previous ? parseSnapshot(previous.body) : {};
  // If only one report exists (rerun during the first week), use its baseline rather than claiming a weekly delta.
  if (!previous && thisWeek) oldSnapshot = {};
  const report = formatReport([...seen.values()], oldSnapshot, week, queries);
  if (thisWeek) {
    await api('/repos/' + target + '/issues/' + thisWeek.number, {
      method: 'PATCH', body: JSON.stringify({ body: report }),
    });
    console.log('Updated weekly GitHub watch issue #' + thisWeek.number);
  } else {
    const made = await api('/repos/' + target + '/issues', {
      method: 'POST', body: JSON.stringify({ title: PREFIX + ' ' + week, body: report }),
    });
    console.log('Created weekly GitHub watch issue: ' + made.html_url);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
