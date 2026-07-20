// Gatekeeper prompt page logic.
import {
  hostFromUrl,
  pageKey,
  validateReason,
  distinctWordCount,
  requiredReasonChars,
  formatCountdown,
} from '../lib/common.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

let state = null; // prompt state from the SW
let target = null; // exact URL to restore on Continue
let host = null; // actual host being gated
let cooldownRAF = null;

async function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

// The SW stores the intended URL for this tab; it may land a moment after the
// redirect, so retry briefly.
async function fetchTarget() {
  for (let i = 0; i < 12; i++) {
    const res = await send({ type: 'getTarget' });
    if (res && res.target) return res.target;
    await sleep(150);
  }
  return null;
}

function init() {
  if (isMac) $('metaLabel').textContent = '⌘';

  // Build quick-duration buttons once state is known.
  boot();
}

async function boot() {
  target = await fetchTarget();
  host = hostFromUrl(target) || null;

  if (!host) {
    // Nothing to restore — offer a graceful exit rather than trapping the tab.
    $('host').textContent = 'this tab';
    $('reasonHint').textContent = '';
    $('card').hidden = false;
    $('error').hidden = false;
    $('error').textContent = 'Could not determine the page. Use “Never mind” to close this tab.';
    $('form').querySelectorAll('textarea,input,button.primary').forEach((el) => (el.disabled = true));
    wireCancel();
    return;
  }

  state = await send({ type: 'getPromptState', host });

  // Host is no longer gated (e.g. removed from the list) — don't trap the tab.
  if (!state || state.gated === false) {
    window.location.replace(target);
    return;
  }

  render();
  $('card').hidden = false;
  $('reason').focus();
}

function render() {
  $('host').textContent = host;

  // Quick buttons
  const quick = $('quick');
  quick.innerHTML = '';
  for (const m of state.quickMinutes || [2, 5, 10, 15]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = m + 'm';
    b.dataset.min = String(m);
    b.addEventListener('click', () => {
      $('minutes').value = String(m);
      markActiveQuick();
      updateHints();
    });
    quick.appendChild(b);
  }
  $('minutes').max = String(state.hardCapMinutes);
  $('durationHint').textContent = `1–${state.hardCapMinutes} minutes.`;

  // Reflection block (reprompt)
  if (state.awaitingReflection && state.prevReason) {
    $('prevReason').textContent = state.prevReason;
    $('reflect').hidden = false;
    $('fulfilledYes').addEventListener('click', () => reflect(true, $('fulfilledYes')));
    $('fulfilledNo').addEventListener('click', () => reflect(false, $('fulfilledNo')));
  }

  // "Always allow this page" — a one-tap permanent per-page exclusion.
  const key = pageKey(target);
  if (key) {
    $('allowPreview').textContent = key;
    $('allowRow').hidden = false;
    $('allowPage').addEventListener('click', allowPage);
  }

  updateHints();
  wireForm();
  wireCancel();

  // Cooldown
  if (state.cooldownUntil && state.cooldownUntil > Date.now()) {
    startCooldown(state.cooldownUntil);
  }
}

function markActiveQuick() {
  const v = $('minutes').value;
  document.querySelectorAll('#quick .chip').forEach((c) => {
    c.classList.toggle('active', c.dataset.min === v);
  });
}

function updateHints() {
  const text = $('reason').value.trim();
  const need = state.requiredChars;
  const words = distinctWordCount(text);
  const hint = $('reasonHint');
  hint.textContent = `${text.length} / ${need} characters · ${words} / ${state.minWords} distinct words`;
  const ok = text.length >= need && words >= state.minWords;
  hint.classList.toggle('ok', ok);
}

async function reflect(value, btn) {
  await send({ type: 'reflectFulfilled', host, fulfilled: value });
  $('fulfilledYes').classList.toggle('active', value === true);
  $('fulfilledNo').classList.toggle('active', value === false);
  btn.blur();
}

function wireForm() {
  $('reason').addEventListener('input', updateHints);
  $('minutes').addEventListener('input', () => {
    markActiveQuick();
  });
  $('form').addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });
}

function wireCancel() {
  $('cancel').addEventListener('click', cancel);
}

function showError(msg) {
  const el = $('error');
  el.textContent = msg;
  el.hidden = !msg;
}

async function submit() {
  if ($('card').classList.contains('cooling')) return;
  showError('');
  const reason = $('reason').value;
  const minutes = Number($('minutes').value);

  // Mirror the SW validation for instant feedback (SW re-validates authoritatively).
  const k = state.k;
  const v = validateReason(reason, k, {
    baseMinChars: state.baseMinChars,
    minWords: state.minWords,
  });
  if (!v.ok) return showError(v.error);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > state.hardCapMinutes) {
    return showError(`Enter a duration between 1 and ${state.hardCapMinutes} minutes.`);
  }

  $('continue').disabled = true;
  const res = await send({ type: 'startSession', host, reason, minutes });
  if (res && res.ok) {
    // The gate for this host is lifted; restore the exact original URL.
    window.location.replace(target);
  } else {
    $('continue').disabled = false;
    if (res && res.cooldownUntil) startCooldown(res.cooldownUntil);
    showError((res && res.error) || 'Could not start the session.');
  }
}

async function allowPage() {
  // Not a session, so this stays available even during cooldown.
  $('allowPage').disabled = true;
  const res = await send({ type: 'excludePage', host, url: target });
  if (res && res.ok) {
    window.location.replace(target);
  } else {
    $('allowPage').disabled = false;
    showError((res && res.error) || 'Could not allow this page.');
  }
}

async function cancel() {
  await send({ type: 'cancelPrompt', host });
  // The SW closes this tab; if it somehow doesn't, fall back to window.close().
  setTimeout(() => window.close(), 400);
}

function startCooldown(until) {
  $('card').classList.add('cooling');
  $('cooldown').hidden = false;
  $('continue').disabled = true;
  const tick = () => {
    const remaining = until - Date.now();
    if (remaining <= 0) {
      $('cooldownTime').textContent = '0:00';
      $('card').classList.remove('cooling');
      $('cooldown').hidden = true;
      $('continue').disabled = false;
      if (cooldownRAF) cancelAnimationFrame(cooldownRAF);
      cooldownRAF = null;
      updateHints();
      return;
    }
    $('cooldownTime').textContent = formatCountdown(remaining);
    cooldownRAF = requestAnimationFrame(tick);
  };
  tick();
}

init();
