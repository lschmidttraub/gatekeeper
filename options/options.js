// Gatekeeper options page.
import { DEFAULT_CONFIG, normalizeHostInput } from '../lib/common.js';

const $ = (id) => document.getElementById(id);

async function getConfig() {
  const { config } = await chrome.storage.local.get('config');
  return { ...DEFAULT_CONFIG, ...(config || {}) };
}
async function setGatedHosts(hosts) {
  const config = await getConfig();
  config.gatedHosts = hosts;
  await chrome.storage.local.set({ config });
}
async function getLogs() {
  const { logs } = await chrome.storage.local.get('logs');
  return logs || [];
}

const OUTCOME_LABEL = {
  completed: 'Completed',
  abandoned_early: 'Left early',
  cancelled: 'Cancelled',
};

// --- Gated sites -----------------------------------------------------------

async function renderSites() {
  const config = await getConfig();
  const list = $('siteList');
  list.innerHTML = '';
  const hosts = [...config.gatedHosts].sort();
  if (!hosts.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No gated sites yet. Add one above.';
    list.appendChild(li);
    return;
  }
  for (const host of hosts) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'site-name';
    name.textContent = host;
    const btn = document.createElement('button');
    btn.className = 'remove';
    btn.textContent = 'Remove';
    btn.addEventListener('click', async () => {
      const next = (await getConfig()).gatedHosts.filter((h) => h !== host);
      await setGatedHosts(next);
    });
    li.append(name, btn);
    list.appendChild(li);
  }
}

async function addSite(e) {
  e.preventDefault();
  const input = $('addInput');
  const host = normalizeHostInput(input.value);
  if (!host) {
    input.focus();
    return;
  }
  const config = await getConfig();
  if (!config.gatedHosts.includes(host)) {
    await setGatedHosts([...config.gatedHosts, host]);
  }
  input.value = '';
  input.focus();
}

// --- Stats (today) ---------------------------------------------------------

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

async function renderStats() {
  const logs = await getLogs();
  const since = startOfToday();
  const today = logs.filter((e) => e.ts >= since);
  const byHost = {};
  for (const e of today) {
    const h = (byHost[e.host] = byHost[e.host] || { sessions: 0, minutes: 0, cancels: 0 });
    if (e.outcome === 'completed' || e.outcome === 'abandoned_early') {
      h.sessions += 1;
      h.minutes += e.requestedMinutes || 0;
    } else if (e.outcome === 'cancelled') {
      h.cancels += 1;
    }
  }

  const stats = $('stats');
  stats.innerHTML = '';
  const hosts = Object.keys(byHost).sort();
  if (!hosts.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'No sessions yet today.';
    stats.appendChild(p);
    return;
  }
  for (const host of hosts) {
    const s = byHost[host];
    const prompts = s.sessions + s.cancels;
    const rate = prompts ? Math.round((s.cancels / prompts) * 100) : 0;
    const card = document.createElement('div');
    card.className = 'stat-card';
    const title = document.createElement('div');
    title.className = 'stat-host';
    title.textContent = host;
    card.appendChild(title);
    card.appendChild(statRow('Sessions', String(s.sessions)));
    card.appendChild(statRow('Minutes', String(s.minutes)));
    card.appendChild(statRow('Cancel rate', rate + '%'));
    stats.appendChild(card);
  }
}

function statRow(label, value) {
  const row = document.createElement('div');
  row.className = 'stat-row';
  const l = document.createElement('span');
  l.textContent = label;
  const v = document.createElement('b');
  v.textContent = value;
  row.append(l, v);
  return row;
}

// --- Log table -------------------------------------------------------------

async function renderLog() {
  const logs = await getLogs();
  const body = $('logBody');
  body.innerHTML = '';
  $('logCount').textContent = logs.length ? `last ${logs.length}` : '';
  if (!logs.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.className = 'empty';
    td.textContent = 'No sessions logged yet.';
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  for (let i = logs.length - 1; i >= 0; i--) {
    const e = logs[i];
    const tr = document.createElement('tr');
    tr.append(
      cell(new Date(e.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
      cell(e.host),
      cell(e.reason || '—', 'reason'),
      cell(e.requestedMinutes != null ? String(e.requestedMinutes) : '—'),
      outcomeCell(e.outcome),
      cell(e.fulfilled == null ? '—' : e.fulfilled ? '✓' : '✕')
    );
    body.appendChild(tr);
  }
}

function cell(text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text;
  return td;
}

function outcomeCell(outcome) {
  const td = document.createElement('td');
  const span = document.createElement('span');
  span.className = 'tag ' + outcome;
  span.textContent = OUTCOME_LABEL[outcome] || outcome;
  td.appendChild(span);
  return td;
}

// --- Wire up + live refresh ------------------------------------------------

async function renderAll() {
  await Promise.all([renderSites(), renderStats(), renderLog()]);
}

$('addForm').addEventListener('submit', addSite);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.config) renderSites();
  if (changes.logs) {
    renderStats();
    renderLog();
  }
});

renderAll();
