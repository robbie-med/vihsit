/* vihsit: UI and storage. All privacy rules live in core.js. This file only writes records that came out of
   Core.sanitize / Core.cleanDay / Core.sanitizeBackup / Core.cleanSettings (or puts back records it just removed, for undo). */
(function () {
'use strict';
const C = window.Core;

// ---------- DOM helpers. No innerHTML anywhere: pasted text only ever becomes textContent. ----------
function add(el, kids) { for (const k of [kids].flat(Infinity)) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k)); return el; }
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag); let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  add(el, kids);
  if (value !== undefined) el.value = value;
  return el;
}
const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...kids) { const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v); return add(el, kids); }
function select(options, current, onchange, attrs) {
  return h('select', Object.assign({ onchange: e => onchange(e.target.value), value: current == null ? '' : String(current) }, attrs),
    options.map(([v, label]) => h('option', { value: String(v) }, label)));
}
const fmt = n => (n == null || Number.isNaN(n) ? '—' : (Math.round(n * 10) / 10).toLocaleString('en-US'));
const fmtTime = m => (m == null ? '' : `${((Math.floor(m / 60) + 11) % 12) + 1}:${C.pad(m % 60)} ${m >= 720 ? 'PM' : 'AM'}`);
const today = () => C.isoDate(new Date());
const ayLabel = ay => `${ay}–${String(ay + 1).slice(2)}`;
const dayLabel = iso => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: y === new Date().getFullYear() ? undefined : 'numeric' }); };
const monthName = (k, withYear) => { const [y, m] = k.split('-').map(Number); return new Date(y, m - 1).toLocaleString('en-US', { month: 'short' }) + (withYear ? ` ’${String(y).slice(2)}` : ''); };
const AREA_OPTS = C.AREAS.map(([id, label]) => [id, label]);
const areaLabel = id => (C.AREAS.find(a => a[0] === id) || [, id])[1];
const catOpts = () => C.catOptions(S.settings);
const catLabel = id => C.catLabelOf(S.settings, id);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------- IndexedDB ----------
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('log-your-visits', 1); // original name, kept so existing data still loads
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('days', { keyPath: 'id', autoIncrement: true });
        d.createObjectStore('encounters', { keyPath: 'id', autoIncrement: true });
        d.createObjectStore('kv', { keyPath: 'k' });
      };
      r.onsuccess = () => res((DB.db = r.result));
      r.onerror = () => rej(r.error);
    });
  },
  tx(stores, fn) {
    return new Promise((res, rej) => {
      const t = DB.db.transaction(stores, 'readwrite'); const out = fn(t);
      t.oncomplete = () => res(out); t.onerror = t.onabort = () => rej(t.error);
    });
  },
  all(store) {
    return new Promise((res, rej) => { const r = DB.db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  },
  get(key) {
    return new Promise((res, rej) => { const r = DB.db.transaction('kv').objectStore('kv').get(key); r.onsuccess = () => res(r.result && r.result.v); r.onerror = () => rej(r.error); });
  },
};
function addAll(t, store, recs, keys) { for (const rec of recs) { const r = t.objectStore(store).add(rec); r.onsuccess = () => keys.push(r.result); } }
// One transaction for any mix of adds, deletes and puts. Returns what's needed to undo it.
async function applyChange({ addDays = [], addEnc = [], delDays = [], delEnc = [], putDays = [], putEnc = [] }) {
  const added = { days: [], encounters: [] };
  const removed = { days: delDays.concat(putDays.map(d => S.days.find(x => x.id === d.id)).filter(Boolean)), encounters: delEnc.concat(putEnc.map(e => S.encounters.find(x => x.id === e.id)).filter(Boolean)) };
  await DB.tx(['days', 'encounters'], t => {
    delDays.forEach(d => t.objectStore('days').delete(d.id)); delEnc.forEach(e => t.objectStore('encounters').delete(e.id));
    putDays.forEach(d => t.objectStore('days').put(d)); putEnc.forEach(e => t.objectStore('encounters').put(e));
    addAll(t, 'days', addDays, added.days); addAll(t, 'encounters', addEnc, added.encounters);
  });
  S.lastSave = { added, removed };
  await load();
}
async function undoLast() {
  const u = S.lastSave; if (!u) return;
  await DB.tx(['days', 'encounters'], t => {
    u.added.days.forEach(id => t.objectStore('days').delete(id)); u.added.encounters.forEach(id => t.objectStore('encounters').delete(id));
    u.removed.days.forEach(d => t.objectStore('days').put(d)); u.removed.encounters.forEach(e => t.objectStore('encounters').put(e));
  });
  S.lastSave = null; await load(); flash('Undone.');
}

// ---------- state ----------
const S = { settings: C.cleanSettings({}), days: [], encounters: [], view: 'log', review: null, queue: [], queueTotal: 0, teach: null,
  lastSave: null, flash: null, filter: { ay: null, site: '', area: '', mine: false }, report: { preset: 'ccc', ay: null }, showAllDays: false, persisted: null, dbError: null };

async function load() {
  S.settings = C.cleanSettings(await DB.get('settings'));
  S.days = await DB.all('days');
  S.encounters = await DB.all('encounters');
}
async function saveSettings() {
  S.settings = C.cleanSettings(S.settings);
  await DB.tx(['kv'], t => t.objectStore('kv').put({ k: 'settings', v: S.settings }));
}
function flash(text, kind, action) { S.flash = { text, kind: kind || 'ok', action }; render(); }
const existingDay = (date, site) => S.days.find(d => d.date === date && d.site === site);

// ---------- intake: paste, drop, files. Each input can hold several days, reviewed one at a time. ----------
function clearClipboard() {
  if (!navigator.clipboard || !navigator.clipboard.writeText) return Promise.resolve(false);
  return navigator.clipboard.writeText('').then(() => true, () => false);
}
function parseText(text) {
  const t = String(text || '').trim();
  if (/^[\[{]/.test(t)) { try { return C.parseDayJson(JSON.parse(t)); } catch (e) { /* not JSON after all */ } }
  const p = C.parseSchedule(t);
  return p ? [p] : [];
}
function startQueue(list, fromClipboard) {
  if (!list.length) { flash('That didn’t look like a Cerner or athena schedule. Check that the whole day was selected, or see Help for the JSON format other EMRs can use.', 'error'); return; }
  S.queue = list.slice(1); S.queueTotal = list.length;
  S.review = C.prepareReview(list[0], S.settings, today()); S.teach = null;
  if (fromClipboard) clearClipboard().then(ok => flash(ok ? 'Schedule read. Clipboard cleared.' : 'Schedule read. The clipboard could not be cleared here, so copy something harmless to overwrite it.', ok ? 'ok' : 'warn'));
  else flash(list.length > 1 ? `${list.length} days to review, one at a time.` : 'Day read.');
}
function nextInQueue() {
  if (S.queue.length) { S.review = C.prepareReview(S.queue.shift(), S.settings, today()); S.teach = null; }
  else { S.review = null; S.queueTotal = 0; }
}
document.addEventListener('paste', e => {
  if (S.view !== 'log' || S.review || !S.settings.checklistDone) return;
  if (e.target.closest && e.target.closest('input, textarea, select')) return;
  const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
  e.preventDefault(); // the raw schedule never enters the page
  startQueue(parseText(text), true);
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  if (S.view !== 'log' || S.review || !S.settings.checklistDone) return;
  const files = [...(e.dataTransfer.files || [])];
  if (files.length) return readFiles(files).then(texts => startQueue(texts.flatMap(parseText), false));
  startQueue(parseText(e.dataTransfer.getData('text/plain')), false);
});
const readFiles = files => Promise.all(files.map(f => f.text()));
function pickFiles(accept, multiple, cb) {
  const i = h('input', { type: 'file', accept, multiple, onchange: () => i.files.length && readFiles([...i.files]).then(cb) }); i.click();
}
window.addEventListener('beforeunload', e => { if (S.review) { e.preventDefault(); e.returnValue = ''; } });

// ---------- save ----------
// FMP visits about to be saved: the ones the continuity reminder asks about.
const fmpRowsToSave = R => R.sections.filter(sec => sec.area === 'fmp' && sec.fix !== 'remove').flatMap(sec => sec.rows.filter(r => r.include && !r.logged));
async function commitReview() {
  const R = S.review;
  if (!R.date) return flash('Pick the date for this schedule.', 'error');
  if (S.settings.continuityReminder && !R.contChecked && fmpRowsToSave(R).length) { R.contAsk = true; S.flash = null; render(); return; }
  for (const sec of R.sections) {
    if (existingDay(R.date, sec.site) && !sec.fix) return flash(`${sec.site} on ${dayLabel(R.date)} is already logged. Choose “Add missed visits” or “Remove visits” for it.`, 'error');
  }
  const removeSecs = R.sections.filter(sec => sec.fix === 'remove' && existingDay(R.date, sec.site));
  const normal = R.sections.filter(sec => !removeSecs.includes(sec));
  let out = { days: [], encounters: [] };
  if (normal.length) {
    out = C.sanitize(Object.assign({}, R, { sections: normal }), S.settings);
    if (out.error && !(removeSecs.length && /^Nothing to save/.test(out.error))) return flash(out.error, 'error');
    if (out.error) out = { days: [], encounters: [] };
  }
  const delDays = out.days.map(d => existingDay(d.date, d.site)).filter(Boolean); // "add missed visits" replaces the day's numbers
  const delEnc = [], putDays = []; let misses = 0;
  for (const sec of removeSecs) {
    const rows = sec.rows.filter(r => r.include);
    const m = C.matchSaved(rows.map(r => C.toEncounter(r, R, sec, S.settings)), S.encounters);
    misses += m.matched.filter(x => !x).length;
    m.ids.forEach(id => delEnc.push(S.encounters.find(e => e.id === id)));
    const hit = rows.filter((r, i) => m.matched[i]), ex = existingDay(R.date, sec.site);
    const less = (n, k) => (n == null ? null : Math.max(0, n - k));
    putDays.push(Object.assign(C.cleanDay(Object.assign({}, ex, { seen: less(ex.seen, hit.length), newCount: less(ex.newCount, hit.filter(r => r.isNew).length),
      obCount: less(ex.obCount, hit.filter(r => r.ob).length), mineCount: less(ex.mineCount, hit.filter(r => r.continuity === 'mine').length) })), { id: ex.id }));
  }
  await applyChange({ addDays: out.days, addEnc: out.encounters, delDays, delEnc, putDays });
  for (const sec of normal) {
    const k = S.settings.sites[sec.site] || {};
    S.settings.sites[sec.site] = { area: sec.area, lastHours: sec.ownSchedule ? null : sec.hours, type: sec.siteType !== undefined ? sec.siteType : k.type || null };
  }
  await saveSettings();
  const parts = [];
  if (out.encounters.length || out.days.length) parts.push(`Saved ${plural(out.encounters.length, 'visit')}${delDays.length ? ' and updated the day' : ''}.`);
  if (removeSecs.length) parts.push(`Removed ${plural(delEnc.length, 'saved visit')}${misses ? `; ${misses} had no exact match and were left alone` : ''}.`);
  const left = S.queue.length;
  nextInQueue();
  flash(parts.join(' ') + (left ? ` Next: day ${S.queueTotal - left + 1} of ${S.queueTotal}.` : ''), misses ? 'warn' : 'ok', ['Undo', undoLast]);
}

// ---------- render loop: full re-render, keeping keyboard focus on the same control ----------
const main = () => document.getElementById('main');
function render() {
  const fk = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.fk;
  document.querySelectorAll('#nav button').forEach(b => b.setAttribute('aria-current', b.dataset.view === S.view ? 'page' : 'false'));
  const ay = C.academicYear(today()), pgy = C.pgyFor(ay, S.settings.residencyStartAY);
  document.getElementById('mast-meta').textContent = [S.settings.profile.name || null, pgy ? `PGY-${pgy}` : null, `AY ${ayLabel(ay)}`, `${S.encounters.length.toLocaleString('en-US')} visits logged`].filter(Boolean).join('  ·  ');
  document.body.classList.toggle('printing-report', S.view === 'report');
  let view;
  if (S.dbError) view = h('section', { class: 'notice error' }, h('p', null, 'Storage isn’t available in this browser window, so nothing could be saved. ', S.dbError), h('p', null, 'Private windows and some browsers block storage for files opened from disk. Try a normal window, or the hosted version.'));
  else if (!S.settings.checklistDone) view = setupView();
  else view = { log: () => (S.review ? reviewView() : logView()), record: recordView, report: reportView, settings: settingsView, help: helpView }[S.view]();
  main().replaceChildren(...[flashBar(), view].filter(Boolean));
  if (fk) { const el = document.querySelector(`[data-fk="${CSS.escape(fk)}"]`); if (el) el.focus(); }
}
function flashBar() {
  if (!S.flash) return null;
  const f = S.flash;
  return h('div', { class: `flash ${f.kind}`, role: f.kind === 'error' ? 'alert' : 'status' },
    h('span', { class: 'flash-kind' }, f.kind === 'error' ? 'Not saved' : f.kind === 'warn' ? 'Note' : 'Done'),
    h('span', null, f.text),
    f.action && h('button', { class: 'link', onclick: () => { S.flash = null; f.action[1](); } }, f.action[0]),
    h('button', { class: 'link dismiss', 'aria-label': 'Dismiss', onclick: () => { S.flash = null; render(); } }, '×'));
}

// ---------- first run ----------
const CHECKS = [
  ['win', 'Windows: Settings › System › Clipboard. “Clipboard history” and “Sync across your devices” are off.'],
  ['mac', 'Mac: System Settings › General › AirDrop & Handoff. Handoff is off, which also stops Universal Clipboard.'],
  ['mgr', 'Any clipboard manager (Ditto, Maccy, Raycast, Alfred, Paste) is paused or ignores this browser.'],
  ['ext', 'This browser profile has no extensions. Extensions can read what’s on the page.'],
  ['path', 'I copy straight from the EMR on this same computer. I never email or text a schedule to myself.'],
  ['law', 'I understand this isn’t legal advice, and my hospital’s policies still apply. I’ll check with my GME office or privacy officer.'],
];
let setupState = { ticks: {}, start: null, name: '', program: '' };
function setupView() {
  const now = C.academicYear(today());
  const all = CHECKS.every(([k]) => setupState.ticks[k]) && setupState.start != null;
  return h('section', { class: 'setup' },
    h('h2', null, 'Before your first paste'),
    h('p', { class: 'lede' }, 'This app keeps de-identified counts on this computer only. Names, reasons for visit and any dates tied to a patient are thrown away the moment a schedule is read. The page itself is blocked from using the network.'),
    h('p', null, 'A web page can’t check your computer’s settings, so please confirm each one. The checklist is under Help if you need it again.'),
    h('ol', { class: 'checklist' }, CHECKS.map(([k, text]) => h('li', null, h('label', null,
      h('input', { type: 'checkbox', checked: setupState.ticks[k], onchange: e => { setupState.ticks[k] = e.target.checked; render(); }, 'data-fk': 'chk-' + k }), ' ', text)))),
    h('div', { class: 'rsec-head' },
      h('label', { class: 'ctl' }, h('span', { class: 'label' }, 'Your name (optional)'), h('input', { type: 'text', value: setupState.name, 'data-fk': 'su-name', onchange: e => { setupState.name = e.target.value; } })),
      h('label', { class: 'ctl' }, h('span', { class: 'label' }, 'Program (optional)'), h('input', { type: 'text', value: setupState.program, 'data-fk': 'su-prog', onchange: e => { setupState.program = e.target.value; } })),
      h('label', { class: 'ctl' }, h('span', { class: 'label' }, 'Residency started July of'),
        select([['', 'choose a year']].concat([0, 1, 2, 3, 4, 5].map(i => [now - i, String(now - i)])), setupState.start,
          v => { setupState.start = v === '' ? null : +v; render(); }, { 'data-fk': 'start' }))),
    h('p', { class: 'hint' }, 'Your name and program appear only on your own screen and printed reports. The start year sets your PGY year on each saved day.'),
    h('button', { class: 'btn primary', disabled: !all, onclick: async () => {
      Object.assign(S.settings, { residencyStartAY: setupState.start, checklistDone: true, profile: { name: setupState.name, program: setupState.program } });
      await saveSettings();
      try { S.persisted = navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : null; } catch (e) { S.persisted = null; }
      render();
    } }, 'Start logging'));
}

// ---------- log a day ----------
function logView() {
  return h('section', { class: 'log' },
    h('div', { class: 'paste', tabindex: '0', 'data-fk': 'paste', 'aria-label': 'Paste your schedule here' },
      h('p', { class: 'paste-big' }, 'Paste a day’s schedule'),
      h('p', null, 'Select the whole day in Cerner or athena, copy it, then press ', h('kbd', null, 'Ctrl'), ' ', h('kbd', null, 'V'), ' (', h('kbd', null, '⌘'), ' ', h('kbd', null, 'V'), ' on a Mac) anywhere on this page. Or drag the selected text onto this box.'),
      h('p', { class: 'hint' }, 'The schedule never lands in a text box. It’s read, the clipboard is cleared, and only de-identified counts reach the review screen. Nothing is saved until you press Save. To fix a day you already logged, paste it again.')),
    h('div', { class: 'alt-actions' },
      h('button', { class: 'btn', onclick: () => startManual() }, 'Manual entry'),
      Object.entries(S.settings.sites).filter(([, v]) => v.type).map(([name]) => h('button', { class: 'btn', onclick: () => startManual(name) }, `Log a day at ${name}`)),
      h('button', { class: 'btn', onclick: () => pickFiles('.json,.txt,application/json,text/plain', true, texts => startQueue(texts.flatMap(parseText), false)) }, 'Import day files'),
      h('span', { class: 'hint' }, 'Manual entry is for odd sites, away rotations, deliveries or inpatient days. Day files (JSON, or saved schedule text) can be several at once, and are reviewed one day at a time.')),
    daysList());
}
function startManual(site) { S.review = C.manualReview(today(), S.settings, site); S.queue = []; S.queueTotal = 1; S.flash = null; render(); }
function daysList() {
  const all = S.days.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.site < b.site ? -1 : 1));
  if (!all.length) return null;
  const rows = S.showAllDays ? all : all.slice(0, 12);
  return h('section', null, h('h2', null, 'Logged days'),
    h('table', { class: 'data days' }, h('thead', null, h('tr', null, ['Date', 'Site', 'Counts toward', 'Visits', 'Hours', ''].map((x, i) => h('th', { class: i === 3 || i === 4 ? 'num' : '' }, x)))),
      h('tbody', null, rows.map(d => h('tr', null,
        h('td', { class: 'nowrap' }, dayLabel(d.date)), h('td', null, d.site), h('td', null, areaLabel(d.area)),
        h('td', { class: 'num' }, fmt(d.seen + d.otherCount)),
        h('td', { class: 'num' }, h('input', { type: 'number', min: '0', max: '36', step: '0.25', class: 'numin', value: d.hours == null ? '' : d.hours, 'aria-label': 'Hours', 'data-fk': 'dh-' + d.id,
          onchange: async e => { await applyChange({ putDays: [Object.assign(C.cleanDay(Object.assign({}, d, { hours: e.target.value === '' ? null : +e.target.value })), { id: d.id })] }); flash('Hours updated.', 'ok', ['Undo', undoLast]); } })),
        h('td', null, h('button', { class: 'link', onclick: async () => {
          if (!confirm(`Delete the record for ${d.site} on ${dayLabel(d.date)}?\n\nThis removes the day’s counts and hours. Its ${plural(d.seen, 'visit')} stay saved, because visits aren’t linked to days. To remove those too, paste the day again and choose “Remove visits” first.`)) return;
          await applyChange({ delDays: [d] }); flash('Day record deleted. Its visits are still saved.', 'ok', ['Undo', undoLast]);
        } }, 'Delete')))))),
    all.length > 12 && h('button', { class: 'link', onclick: () => { S.showAllDays = !S.showAllDays; render(); } }, S.showAllDays ? 'Show fewer' : `Show all ${all.length} days`));
}

// ---------- review ----------
function reviewView() {
  const R = S.review;
  const nRows = R.sections.reduce((n, sec) => n + sec.rows.length, 0);
  const dateCtl = R.dateChoices
    ? h('div', { class: 'datepick', role: 'group', 'aria-label': 'Which day?' }, R.dateChoices.map(d =>
      h('button', { class: 'daybtn', 'aria-pressed': String(R.date === d), 'data-fk': 'date-' + d, onclick: () => { R.date = d; render(); } }, dayLabel(d))))
    : h('input', { type: 'date', value: R.date, 'data-fk': 'date', onchange: e => { R.date = e.target.value; render(); } });
  const pos = S.queueTotal > 1 ? S.queueTotal - S.queue.length : 0;
  return h('section', { class: 'review' },
    h('div', { class: 'review-head' },
      h('h2', null, R.source === 'manual' ? 'Manual entry' : 'Review this day', pos ? h('span', { class: 'qpos' }, ` · day ${pos} of ${S.queueTotal}`) : null),
      h('p', { class: 'hint' }, R.source === 'manual' ? 'Add one row per encounter. Hours and a count-only total are fine for busy inpatient days.'
        : 'Names appear only on this screen and are never saved. Untick anyone who wasn’t yours, or who didn’t come.')),
    h('div', { class: 'field-row' }, h('span', { class: 'label' }, R.dateChoices ? 'Which day was this?' : 'Date'), dateCtl),
    R.expected != null && R.expected !== nRows && h('p', { class: 'notice warn' }, `The schedule header says ${R.expected} patients, but ${nRows} were read. Check the selection covered the whole day.`),
    R.sections.map((sec, i) => sectionView(sec, i)),
    R.contAsk && continuityReminder(R),
    h('div', { class: 'review-actions' },
      h('button', { class: 'btn primary', onclick: commitReview, disabled: !R.date }, 'Save day'),
      pos ? h('button', { class: 'btn', onclick: () => { nextInQueue(); S.flash = null; render(); } }, S.queue.length ? 'Skip this day' : 'Skip and finish') : null,
      h('button', { class: 'btn', onclick: () => { if (confirm(S.queue.length ? `Discard this day and the ${plural(S.queue.length, 'day')} after it?` : 'Discard this day without saving?')) { S.review = null; S.queue = []; S.queueTotal = 0; S.teach = null; render(); } } }, S.queue.length ? 'Discard all' : 'Discard'),
      !R.date && h('span', { class: 'hint' }, 'Pick the day first.')));
}
function continuityReminder(R) {
  const rows = fmpRowsToSave(R), mine = rows.filter(r => r.continuity === 'mine').length;
  const go = () => { R.contChecked = true; R.contAsk = false; commitReview(); };
  return h('div', { class: 'notice remind', role: 'alertdialog', 'aria-label': 'Continuity check' },
    h('p', { class: 'remind-q' }, 'Did you check your continuities?'),
    h('p', null, `${mine} of ${plural(rows.length, 'clinic visit')} ${mine === 1 ? 'is' : 'are'} marked “Mine”. Tick “Mine” for each patient on your own panel.`),
    h('div', { class: 'alt-actions' },
      h('button', { class: 'btn primary', 'data-fk': 'cont-yes', onclick: go }, 'Yes, save'),
      h('button', { class: 'btn', onclick: () => { R.contAsk = false; render(); window.scrollTo(0, 0); } }, 'Let me check'),
      h('button', { class: 'link', onclick: async () => { S.settings.continuityReminder = false; await saveSettings(); go(); } }, 'Save and stop asking')),
    h('p', { class: 'hint' }, 'You can turn this reminder back on in Settings.'));
}
function fixChooser(sec, ex) {
  const setMode = mode => {
    if (sec.fix === 'remove' && mode !== 'remove') sec.rows.forEach(r => { r.include = r._inc; });
    if (mode === 'remove' && sec.fix !== 'remove') sec.rows.forEach(r => { r._inc = r.include; r.include = false; r.logged = false; });
    if (mode === 'add') {
      const m = C.matchSaved(sec.rows.map(r => (r.include ? C.toEncounter(r, S.review, sec, S.settings) : null)), S.encounters);
      sec.rows.forEach((r, i) => { r.logged = !!m.matched[i]; });
    }
    sec.fix = mode; render();
  };
  return h('div', { class: 'notice fix' },
    h('p', null, h('strong', null, `Already logged: ${ex.site} on ${dayLabel(ex.date)}`), ` (${plural(ex.seen, 'visit')} saved). What do you want to do?`),
    h('div', { class: 'datepick', role: 'group' },
      h('button', { class: 'daybtn', 'aria-pressed': String(sec.fix === 'add'), onclick: () => setMode('add') }, 'Add missed visits'),
      h('button', { class: 'daybtn', 'aria-pressed': String(sec.fix === 'remove'), onclick: () => setMode('remove') }, 'Remove visits')),
    sec.fix === 'add' && h('p', { class: 'hint' }, 'Rows that exactly match a saved visit are marked “Logged” and won’t be saved twice. Check them against the names. The day’s counts and hours are replaced with this paste’s.'),
    sec.fix === 'remove' && h('p', { class: 'hint' }, 'Tick each visit to remove. A saved visit with exactly the same details is deleted. Identical saved visits can’t be told apart, so the result is the same either way. Adjust a row’s details if it shows “no match”.'));
}
function sectionView(sec, si) {
  const surg = sec.setting === 'surgery';
  const tracked = sec.ownSchedule && sec.setting === 'clinic';
  const R = S.review, ex = R.date && existingDay(R.date, sec.site);
  if (!ex && sec.fix) { if (sec.fix === 'remove') sec.rows.forEach(r => { r.include = r._inc; }); sec.fix = null; sec.rows.forEach(r => { r.logged = false; }); }
  const set = (k, v) => { sec[k] = v; render(); };
  let matches = null;
  if (ex && sec.fix === 'remove') matches = C.matchSaved(sec.rows.map(r => (r.include ? C.toEncounter(r, R, sec, S.settings) : null)), S.encounters).matched;
  const extra = ex && sec.fix === 'add' ? 'Logged' : ex && sec.fix === 'remove' ? 'Saved match' : null;
  const head = [ex && sec.fix === 'remove' ? 'Remove' : '', 'Time', 'Patient · not saved', 'Age', 'Sex', surg ? 'Role' : 'Visit type'].concat(surg ? [] : ['New', 'OB', 'Mine', 'Interp.', 'Categories']).concat(['Procedures']).concat(extra ? [extra] : []);
  const dl = 'sites-' + si;
  return h('section', { class: 'rsec' },
    h('div', { class: 'rsec-head' },
      h('label', { class: 'ctl' }, h('span', { class: 'label' }, 'Site'),
        h('input', { type: 'text', value: sec.site, list: dl, 'data-fk': `site-${si}`, onchange: e => {
          sec.site = e.target.value.trim(); const k = S.settings.sites[sec.site];
          if (k) { sec.area = k.area; if (!sec.ownSchedule && k.lastHours != null && sec.hours == null) sec.hours = k.lastHours; if (R.source === 'manual' && k.type) setSiteType(sec, k.type); }
          render(); } }),
        h('datalist', { id: dl }, Object.keys(S.settings.sites).map(n => h('option', { value: n })))),
      h('label', { class: 'ctl' }, h('span', { class: 'label' }, 'Setting'),
        select([['clinic', 'Clinic'], ['surgery', 'Surgery / OR'], ['other', 'Other']], sec.setting, v => set('setting', v), { 'data-fk': `setting-${si}`, disabled: R.source === 'cerner' || R.source === 'athena' })),
      h('label', { class: 'ctl' }, h('span', { class: 'label' }, 'Counts toward'), select(AREA_OPTS, sec.area, v => set('area', v), { 'data-fk': `area-${si}` })),
      h('label', { class: 'ctl narrow' }, h('span', { class: 'label' }, sec.area === 'volunteer' ? 'Volunteer hours' : 'Hours'),
        h('input', { type: 'number', min: '0', max: '36', step: '0.25', value: sec.hours == null ? '' : sec.hours, placeholder: tracked ? 'auto' : '', 'data-fk': `hours-${si}`,
          onchange: e => set('hours', e.target.value === '' ? null : +e.target.value) })),
      R.source === 'manual' && h('label', { class: 'ctl' }, h('span', { class: 'label' }, 'Usual visit type here'),
        select([['', 'None']].concat(C.TYPE_NAMES.filter(t => t !== 'Surgical Case').map(t => [t, t])), sec.siteType || '', v => { setSiteType(sec, v || null); render(); }, { 'data-fk': `stype-${si}` })),
      !tracked && h('label', { class: 'ctl narrow' }, h('span', { class: 'label' }, 'Count-only'),
        h('input', { type: 'number', min: '0', step: '1', value: sec.otherCount || '', placeholder: '0', title: 'Encounters you saw but don’t want to enter one by one. No age or sex, so they count only toward totals.', 'data-fk': `oc-${si}`,
          onchange: e => set('otherCount', Math.max(0, Math.round(+e.target.value || 0))) }))),
    ex && fixChooser(sec, ex),
    h('div', { class: 'tablewrap' }, h('table', { class: 'grid' + (surg ? ' surg' : '') },
      h('thead', null, h('tr', null, head.map(x => h('th', null, x)))),
      h('tbody', null, sec.rows.map((r, i) => rowView(r, sec, ex && sec.fix, matches && matches[i], head.length)).flat()))),
    h('div', { class: 'rsec-foot' },
      h('button', { class: 'link', onclick: () => { sec.rows.push(C.blankRow(sec.setting, sec.siteType)); render(); } }, '+ Add a row'),
      tracked && sec.fix !== 'remove' && scheduleSummary(sec)),
    sec.ownSchedule && statusMapper(sec));
}
// Statuses on this schedule that don't count as seen: one click teaches the app otherwise.
function statusMapper(sec) {
  const counts = new Map();
  for (const r of sec.rows) if (r.status && !r.nurse && !C.statusSeen(r.status, S.settings.statusMap)) counts.set(r.status, (counts.get(r.status) || 0) + 1);
  if (!counts.size) return null;
  return h('p', { class: 'statusmap' }, h('span', { class: 'label' }, 'Not counted as seen'), ' ',
    [...counts].map(([st, n]) => h('span', { class: 'frag' }, `“${st}” ×${n} `, h('button', { class: 'link', onclick: async () => {
      S.settings.statusMap.push({ raw: st, seen: true }); await saveSettings();
      for (const sec2 of S.review.sections) for (const r of sec2.rows) if (r.status.toLowerCase() === st.toLowerCase() && !r.nurse) r.include = true;
      render();
    } }, 'count as seen'))),
    h('span', { class: 'hint' }, ' Only for statuses that always mean the visit happened. Change it later in Settings.'));
}
function setSiteType(sec, type) {
  const old = sec.siteType || 'Established Patient';
  for (const r of sec.rows) if (r.type === old) r.type = type || 'Established Patient';
  sec.siteType = type;
}
function scheduleSummary(sec) {
  const n = C.scheduleNumbers(sec, S.settings.lunch);
  const seen = sec.rows.filter(r => r.include).length;
  return h('p', { class: 'summary' },
    `${seen} seen · `, h('strong', null, `${n.noShows} not seen`), ' (saved as a no-show count only, no times) · ',
    `${fmt(n.emptyMin / 60)} h empty · ${fmt(n.scheduledMin / 60)} h scheduled · lunch ${S.settings.lunch.start}–${S.settings.lunch.end} left out`);
}
function rowView(r, sec, mode, matched, ncols) {
  const surg = sec.setting === 'surgery';
  const k = r.key, fk = f => `${k}-${f}`;
  const upd = (f, v) => { r[f] = v; render(); };
  const box = (f, label) => h('td', { class: 'c' }, h('input', { type: 'checkbox', checked: r[f], 'aria-label': label, 'data-fk': fk(f), onchange: e => upd(f, e.target.checked) }));
  const procs = h('td', { class: 'procs' },
    r.procs.map(p => h('span', { class: 'tag' }, p, h('button', { 'aria-label': 'Remove ' + p, onclick: () => upd('procs', r.procs.filter(x => x !== p)) }, '×'))),
    select([['', '+ procedure']].concat(S.settings.procVocab.filter(p => !r.procs.includes(p)).sort().map(p => [p, p])), '',
      v => v && upd('procs', r.procs.concat(v)), { class: 'add', 'data-fk': fk('addproc'), 'aria-label': 'Add procedure' }),
    r.include && r.type === 'Procedure' && !r.procs.length && !r.pendingProc && h('div', { class: 'askproc' }, 'Which procedure?'),
    r.pendingProc && h('div', { class: 'pending' }, h('span', { class: 'label' }, 'New procedure name'),
      h('input', { type: 'text', value: r.pendingProc, 'data-fk': fk('pp'), onchange: e => { r.pendingProc = e.target.value; } }),
      h('button', { class: 'link', onclick: async () => {
        const name = r.pendingProc.trim(); if (!name) return;
        if (!S.settings.procVocab.includes(name)) S.settings.procVocab.push(name);
        await saveSettings();
        for (const sec2 of S.review.sections) for (const x of sec2.rows) if (x.pendingProc.trim().toLowerCase() === name.toLowerCase()) { x.procs = [...new Set(x.procs.concat(name))]; x.pendingProc = ''; }
        render();
      } }, 'Add to my list')));
  const cats = h('td', { class: 'cats' },
    r.cats.map(c => h('span', { class: 'tag' }, catLabel(c), h('button', { 'aria-label': 'Remove ' + catLabel(c), onclick: () => upd('cats', r.cats.filter(x => x !== c)) }, '×'))),
    select([['', '+ category']].concat(catOpts().filter(([id]) => !r.cats.includes(id))), '', v => v && upd('cats', r.cats.concat(v)), { class: 'add', 'data-fk': fk('addcat'), 'aria-label': 'Add category' }));
  // visit type: show the EMR's own label when it wasn't recognized, and offer to remember an override
  const autoType = r.typeRaw ? C.normalizeType(r.typeRaw, S.settings.typeMap) : null;
  const typeCell = h('td', null, select(C.TYPE_NAMES.map(t => [t, t]), r.type, v => { r.type = v; r.ob = /OB$/.test(v) || r.ob; if (/^New/.test(v)) r.isNew = true; render(); }, { 'data-fk': fk('type'), 'aria-label': 'Visit type' }),
    r.typeRaw && (r.type === 'Other' || r.type !== autoType) && h('div', { class: 'rawtype' }, `EMR: “${r.typeRaw}”`,
      r.type !== autoType && h('button', { class: 'link', onclick: async () => {
        S.settings.typeMap = S.settings.typeMap.filter(t => t.raw.toLowerCase() !== r.typeRaw.toLowerCase()).concat({ raw: r.typeRaw, type: r.type });
        await saveSettings();
        for (const sec2 of S.review.sections) for (const x of sec2.rows) if (x.typeRaw.toLowerCase() === r.typeRaw.toLowerCase()) { x.type = r.type; x.ob = /OB$/.test(r.type) || x.ob; }
        render();
      } }, ' always use this')));
  const first = h('td', { class: 'c' }, h('input', { type: 'checkbox', checked: r.include, 'aria-label': mode === 'remove' ? 'Remove this saved visit' : surg ? 'I was in this case' : 'Seen by me', 'data-fk': fk('inc'), onchange: e => upd('include', e.target.checked) }));
  const extra = mode === 'add' ? h('td', { class: 'c' }, h('input', { type: 'checkbox', checked: r.logged, disabled: !r.include, 'aria-label': 'Already logged', 'data-fk': fk('logged'), onchange: e => upd('logged', e.target.checked) }))
    : mode === 'remove' ? h('td', { class: 'matchcell' }, r.include ? (matched ? 'match' : 'no match') : '') : null;
  const tr = h('tr', { class: [r.include ? '' : 'off', r.logged ? 'logged' : '', mode === 'remove' && r.include ? 'removing' : ''].join(' ').trim() },
    first,
    h('td', { class: 'time' }, fmtTime(r.start), r.status && h('div', { class: 'status' }, r.nurse ? 'Nurse visit' : r.status)),
    h('td', { class: 'name' }, r.displayName || '—'),
    h('td', null, h('input', { type: 'text', class: 'age', value: r.ageText, placeholder: '34y', 'aria-label': 'Age, like 34y, 6mo, 5d', 'data-fk': fk('age'),
      onchange: e => { const a = C.parseAgeText(e.target.value); if (a) Object.assign(r, a); else { r.ageText = e.target.value; r.age = null; } render(); } })),
    h('td', null, select([['F', 'F'], ['M', 'M'], ['U', '–']], r.sex, v => upd('sex', v), { 'data-fk': fk('sex'), 'aria-label': 'Sex' })),
    surg ? h('td', null, select([['observed', 'Observed'], ['assisted', 'Assisted'], ['primary', 'Primary']], r.role, v => upd('role', v), { 'data-fk': fk('role'), 'aria-label': 'Role' })) : typeCell,
    surg ? null : [box('isNew', 'New patient'), box('ob', 'Obstetric'), h('td', { class: 'c' }, h('input', { type: 'checkbox', checked: r.continuity === 'mine', 'aria-label': 'My own patient', 'data-fk': fk('mine'), onchange: e => upd('continuity', e.target.checked ? 'mine' : 'covering') })), box('interpreter', 'Interpreter'), cats],
    procs, extra);
  const out = [tr];
  if (!surg && r.unmatched.length && mode !== 'remove') out.push(h('tr', { class: 'teach' + (r.include ? '' : ' off') }, h('td', null), h('td', { colspan: ncols - 1 }, teachView(r))));
  return out;
}
// Unrecognized words: click one to teach the app a keyword. Shown only here; only a keyword the user confirms is saved.
function teachView(r) {
  const T = S.teach && S.teach.key === r.key ? S.teach : null;
  return h('div', { class: 'teach-box' },
    h('span', { class: 'label' }, 'Not recognized'),
    r.unmatched.map(frag => h('span', { class: 'frag' }, frag.split(/\s+/).map(w => w.replace(/[^\p{L}\p{N}&'-]/gu, '')).filter(w => w.length > 1).map(w =>
      h('button', { class: 'word', onclick: () => { S.teach = { key: r.key, kw: w.toLowerCase(), cat: '' }; render(); } }, w)))),
    T && h('span', { class: 'teach-form' },
      h('span', null, 'Teach: '),
      h('input', { type: 'text', value: T.kw, 'aria-label': 'Keyword', 'data-fk': 'teach-kw', onchange: e => { T.kw = e.target.value.trim().toLowerCase(); } }),
      h('span', null, ' means '),
      select([['', 'choose a category']].concat(catOpts()), T.cat, async v => {
        if (!v || !T.kw) return;
        S.settings.keywords.push({ kw: T.kw, cat: v }); await saveSettings();
        for (const sec of S.review.sections) for (const x of sec.rows) C.rematch(x, S.settings);
        S.teach = null; render();
      }, { 'data-fk': 'teach-cat' }),
      h('button', { class: 'link', onclick: () => { S.teach = null; render(); } }, 'Cancel'),
      h('span', { class: 'hint' }, ' Only the keyword is saved. Never save a name.')));
}

// ---------- charts: hand-drawn SVG, one hue per job, a table or CSV behind every chart ----------
const W = 640;
const niceMax = v => { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; };
function barRight(x0, y, len, t, r = 4) { if (len <= r) return `M${x0} ${y}h${Math.max(len, 0)}v${t}h${-Math.max(len, 0)}Z`; return `M${x0} ${y}H${x0 + len - r}Q${x0 + len} ${y} ${x0 + len} ${y + r}V${y + t - r}Q${x0 + len} ${y + t} ${x0 + len - r} ${y + t}H${x0}Z`; }
function barLeft(x0, y, len, t, r = 4) { if (len <= r) return `M${x0} ${y}h${-Math.max(len, 0)}v${t}h${Math.max(len, 0)}Z`; return `M${x0} ${y}H${x0 - len + r}Q${x0 - len} ${y} ${x0 - len} ${y + r}V${y + t - r}Q${x0 - len} ${y + t} ${x0 - len + r} ${y + t}H${x0}Z`; }
function barUp(x, base, len, w, r = 4) { if (len <= r) return `M${x} ${base}v${-Math.max(len, 0)}h${w}v${Math.max(len, 0)}Z`; return `M${x} ${base}V${base - len + r}Q${x} ${base - len} ${x + r} ${base - len}H${x + w - r}Q${x + w} ${base - len} ${x + w} ${base - len + r}V${base}Z`; }
function dataTable(head, rows) {
  return h('table', { class: 'data' }, h('thead', null, h('tr', null, head.map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
    h('tbody', null, rows.map(r => h('tr', null, r.map((c, i) => h('td', { class: i ? 'num' : '' }, c == null ? '—' : c))))));
}
const csvCell = v => { const t = v == null ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
function downloadBlob(name, blob) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const slug = t => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// Rasterize a chart: computed styles and the embedded fonts are copied into the SVG so it renders the same off-page.
function svgToPng(svg, name) {
  const clone = svg.cloneNode(true);
  const src = [svg, ...svg.querySelectorAll('*')], dst = [clone, ...clone.querySelectorAll('*')];
  src.forEach((el, i) => { const cs = getComputedStyle(el); for (const p of ['fill', 'stroke', 'stroke-width', 'font-family', 'font-size', 'font-weight', 'opacity', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin']) dst[i].style.setProperty(p, cs.getPropertyValue(p)); });
  const vb = svg.viewBox.baseVal, scale = 2;
  clone.setAttribute('width', vb.width); clone.setAttribute('height', vb.height);
  const fonts = [...document.styleSheets].flatMap(sh => { try { return [...sh.cssRules]; } catch (e) { return []; } }).filter(r => r.type === CSSRule.FONT_FACE_RULE).map(r => r.cssText).join('\n');
  clone.insertBefore(s('rect', { x: vb.x, y: vb.y, width: vb.width, height: vb.height, fill: getComputedStyle(document.body).backgroundColor }), clone.firstChild);
  clone.insertBefore(s('style', null, fonts), clone.firstChild);
  const img = new Image();
  img.onload = () => {
    const c = h('canvas', { width: vb.width * scale, height: vb.height * scale });
    c.getContext('2d').drawImage(img, 0, 0, vb.width * scale, vb.height * scale);
    c.toBlob(b => downloadBlob(name + '.png', b), 'image/png');
  };
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(clone));
}
// A figure: title, optional subtitle, the graphic, and a table/CSV of the same numbers.
function figure(title, sub, graphic, csv, opts = {}) {
  const tools = h('span', { class: 'figtools' },
    graphic instanceof SVGElement && h('button', { class: 'link', onclick: () => svgToPng(graphic, slug(title)) }, 'PNG'),
    csv && h('button', { class: 'link', onclick: () => downloadBlob(slug(title) + '.csv', new Blob([[csv[0]].concat(csv[1]).map(r => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv' })) }, 'CSV'));
  return h('figure', { class: 'fig' + (opts.wide ? ' wide' : '') }, h('figcaption', null, h('div', { class: 'figtitle' }, h('h3', null, title), tools), sub && h('p', { class: 'sub' }, sub)),
    graphic, csv && !opts.noTable && h('details', { class: 'tbl' }, h('summary', null, 'Show as a table'), dataTable(csv[0], csv[1])));
}
function hbars(data, aria, max = 14) {
  const rows = data.slice(0, max), lw = 236, rh = 24, t = 12, plot = W - lw - 52;
  const top = Math.max(1, ...rows.map(d => d.value));
  const el = s('svg', { viewBox: `0 0 ${W} ${rows.length * rh + 6}`, class: 'viz', role: 'img', 'aria-label': aria });
  add(el, s('line', { x1: lw, x2: lw, y1: 0, y2: rows.length * rh + 6, class: 'axis' }));
  rows.forEach((d, i) => {
    const y = i * rh + 6, len = (d.value / top) * plot;
    add(el, [s('text', { x: lw - 10, y: y + t - 1, class: 'lbl', 'text-anchor': 'end' }, d.label.length > 34 ? d.label.slice(0, 33) + '…' : d.label),
      s('path', { d: barRight(lw, y, len, t), class: d.muted ? 'mut' : 's1' }, s('title', null, `${d.label}: ${d.value.toLocaleString('en-US')}`)),
      s('text', { x: lw + len + 6, y: y + t - 1, class: 'val' }, d.value.toLocaleString('en-US'))]);
  });
  return el;
}
function columns(data, aria) {
  const H = 220, pl = 40, pb = 28, pt = 12, pw = W - pl - 8, ph = H - pb - pt;
  const top = niceMax(Math.max(1, ...data.map(d => d.value))), band = pw / data.length, bw = Math.min(24, band * 0.66);
  const el = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'viz', role: 'img', 'aria-label': aria });
  for (let i = 0; i <= 4; i++) {
    const v = (top * i) / 4, y = pt + ph - (v / top) * ph;
    add(el, [s('line', { x1: pl, x2: W - 8, y1: y, y2: y, class: i ? 'grid' : 'axis' }), s('text', { x: pl - 6, y: y + 4, class: 'tick', 'text-anchor': 'end' }, v.toLocaleString('en-US'))]);
  }
  const every = Math.ceil(data.length / 12);
  data.forEach((d, i) => {
    const x = pl + i * band + (band - bw) / 2, len = (d.value / top) * ph, m = +d.label.slice(5);
    add(el, s('path', { d: barUp(x, pt + ph, len, bw), class: 's1' }, s('title', null, `${monthName(d.label, true)}: ${d.value} visits on ${plural(d.days, 'logged day')}`)));
    if (i % every === 0) add(el, s('text', { x: x + bw / 2, y: H - 10, class: 'tick', 'text-anchor': 'middle' }, monthName(d.label, m === 1 || i === 0)));
  });
  return el;
}
// Lines over months, one shared y-axis. series: [{ name, values (null = gap), cls }]
function lineChart(labels, series, opts = {}) {
  const multi = series.length > 1, H = multi ? 220 : 200, pl = 40, pr = 56, pb = 26, pt = multi ? 34 : 12, pw = W - pl - pr, ph = H - pb - pt;
  const vals = series.flatMap(x => x.values).filter(v => v != null);
  const top = opts.max || niceMax(Math.max(1, ...vals));
  const X = i => pl + (labels.length === 1 ? pw / 2 : (i / (labels.length - 1)) * pw), Y = v => pt + ph - (Math.min(v, top) / top) * ph;
  const el = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'viz', role: 'img', 'aria-label': opts.aria });
  if (multi) { let x = pl; for (const ser of series) { add(el, [s('line', { x1: x, x2: x + 18, y1: 10, y2: 10, class: 'line ' + ser.cls }), s('text', { x: x + 24, y: 14, class: 'lbl' }, ser.name)]); x += 40 + ser.name.length * 7; } }
  for (let i = 0; i <= 4; i++) { const v = (top * i) / 4; add(el, [s('line', { x1: pl, x2: W - pr, y1: Y(v), y2: Y(v), class: i ? 'grid' : 'axis' }), s('text', { x: pl - 6, y: Y(v) + 4, class: 'tick', 'text-anchor': 'end' }, fmt(v) + (opts.unit || ''))]); }
  const every = Math.ceil(labels.length / 12);
  labels.forEach((k, i) => { if (i % every === 0) add(el, s('text', { x: X(i), y: H - 8, class: 'tick', 'text-anchor': 'middle' }, monthName(k, +k.slice(5) === 1 || i === 0))); });
  for (const ser of series) {
    let d = '', pen = false;
    ser.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`; pen = true; });
    add(el, s('path', { d, class: 'line ' + ser.cls }));
    ser.values.forEach((v, i) => { if (v != null) add(el, s('circle', { cx: X(i), cy: Y(v), r: ser.cls === 'lp' ? 0 : 4, class: 'dot ' + ser.cls }, s('title', null, `${ser.name}, ${monthName(labels[i], true)}: ${fmt(v)}${opts.unit || ''}`))); });
    const li = ser.values.map((v, i) => (v == null ? -1 : i)).filter(i => i >= 0).pop();
    if (li != null) add(el, s('text', { x: X(li) + 8, y: Y(ser.values[li]) + 4, class: 'val' }, fmt(ser.values[li]) + (opts.unit || '')));
  }
  return el;
}
function pyramid(bins) {
  const rows = bins.slice().reverse(), rh = 24, t = 13, top = 30, mid = W / 2, gap = 40, plot = mid - gap - 44;
  const max = Math.max(1, ...rows.flatMap(b => [b.F, b.M]));
  const el = s('svg', { viewBox: `0 0 ${W} ${rows.length * rh + top}`, class: 'viz', role: 'img', 'aria-label': 'Age and sex of logged visits' });
  add(el, [s('rect', { x: mid - gap - 70, y: 6, width: 10, height: 10, rx: 2, class: 's1' }), s('text', { x: mid - gap - 54, y: 15, class: 'lbl' }, 'Female'),
    s('rect', { x: mid + gap + 14, y: 6, width: 10, height: 10, rx: 2, class: 's2' }), s('text', { x: mid + gap + 30, y: 15, class: 'lbl' }, 'Male')]);
  rows.forEach((b, i) => {
    const y = top + i * rh, lf = (b.F / max) * plot, lm = (b.M / max) * plot;
    add(el, [s('text', { x: mid, y: y + t - 2, class: 'lbl mono', 'text-anchor': 'middle' }, b.label),
      s('path', { d: barLeft(mid - gap, y, lf, t), class: 's1' }, s('title', null, `Female, ${b.label}: ${b.F}`)),
      s('path', { d: barRight(mid + gap, y, lm, t), class: 's2' }, s('title', null, `Male, ${b.label}: ${b.M}`)),
      b.F ? s('text', { x: mid - gap - lf - 6, y: y + t - 2, class: 'val', 'text-anchor': 'end' }, b.F) : null,
      b.M ? s('text', { x: mid + gap + lm + 6, y: y + t - 2, class: 'val' }, b.M) : null]);
  });
  add(el, [s('line', { x1: mid - gap, x2: mid - gap, y1: top - 4, y2: top + rows.length * rh, class: 'axis' }), s('line', { x1: mid + gap, x2: mid + gap, y1: top - 4, y2: top + rows.length * rh, class: 'axis' })]);
  return el;
}
// 100% bars, female | male, per category
function splitBars(rows) {
  const lw = 236, rh = 24, t = 12, plot = W - lw - 60, top = 26;
  const el = s('svg', { viewBox: `0 0 ${W} ${rows.length * rh + top}`, class: 'viz', role: 'img', 'aria-label': 'Sex split by reason for visit' });
  add(el, [s('rect', { x: lw, y: 2, width: 10, height: 10, rx: 2, class: 's1' }), s('text', { x: lw + 16, y: 11, class: 'lbl' }, 'Female'),
    s('rect', { x: lw + 80, y: 2, width: 10, height: 10, rx: 2, class: 's2' }), s('text', { x: lw + 96, y: 11, class: 'lbl' }, 'Male')]);
  rows.forEach((r, i) => {
    const y = i * rh + top, n = r.F + r.M || 1, wf = (r.F / n) * plot;
    add(el, [s('text', { x: lw - 10, y: y + t - 1, class: 'lbl', 'text-anchor': 'end' }, r.label.length > 34 ? r.label.slice(0, 33) + '…' : r.label),
      s('rect', { x: lw, y, width: Math.max(0, wf - 1), height: t, class: 's1' }, s('title', null, `${r.label}: ${r.F} female`)),
      s('rect', { x: lw + wf + 1, y, width: Math.max(0, plot - wf - 1), height: t, class: 's2' }, s('title', null, `${r.label}: ${r.M} male`)),
      s('text', { x: lw + plot + 8, y: y + t - 1, class: 'val' }, `${Math.round((r.F / n) * 100)}% F`)]);
  });
  return el;
}
// A table whose cells are shaded by value: the chart and its table at once.
function heatTable(cols, rows, corner) {
  const max = Math.max(1, ...rows.flatMap(r => r.values));
  return h('div', { class: 'tablewrap' }, h('table', { class: 'heat' },
    h('thead', null, h('tr', null, h('th', null, corner || ''), cols.map(c => h('th', { class: 'num' }, c)))),
    h('tbody', null, rows.map(r => h('tr', null, h('th', { scope: 'row' }, r.label), r.values.map(v => {
      const q = v <= 0 ? 0 : 1 + Math.min(5, Math.floor((v / max) * 6));
      return h('td', { class: `num q${q}${q >= 4 ? ' inv' : ''}` }, v || '');
    }))))));
}
const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
function heatmap(heat, days) {
  const pl = 44, pt = 24, cw = (W - pl - 4) / 20, ch = 26;
  const el = s('svg', { viewBox: `0 0 ${W} ${pt + 5 * ch + 40}`, class: 'viz', role: 'img', 'aria-label': 'Empty clinic time by weekday and time of day' });
  for (let b = 0; b <= 20; b += 2) { const hr = 7 + b / 2; add(el, s('text', { x: pl + b * cw, y: 14, class: 'tick', 'text-anchor': 'middle' }, `${((hr + 11) % 12) + 1}${hr < 12 ? 'a' : 'p'}`)); }
  heat.forEach((row, i) => {
    add(el, s('text', { x: pl - 8, y: pt + i * ch + ch / 2 + 3, class: 'lbl', 'text-anchor': 'end' }, WD[i]));
    row.forEach((v, b) => {
      const q = v <= 0 ? 0 : 1 + Math.min(5, Math.floor((v / 30) * 6)), t0 = 420 + b * 30;
      add(el, s('rect', { x: pl + b * cw + 1, y: pt + i * ch + 1, width: cw - 2, height: ch - 2, rx: 2, class: 'q' + q },
        s('title', null, `${WD[i]} ${fmtTime(t0)}–${fmtTime(t0 + 30)}: ${days[i] ? Math.round(v) + ' min empty on average over ' + plural(days[i], 'day') : 'no clinic days logged'}`)));
    });
  });
  const ly = pt + 5 * ch + 16;
  add(el, s('text', { x: pl, y: ly + 9, class: 'tick' }, 'none'));
  for (let q = 0; q <= 6; q++) add(el, s('rect', { x: pl + 34 + q * 22, y: ly, width: 20, height: 12, rx: 2, class: 'q' + q }));
  add(el, s('text', { x: pl + 34 + 7 * 22 + 6, y: ly + 9, class: 'tick' }, 'whole 30 min empty'));
  return el;
}
function meter(p) {
  return s('svg', { viewBox: '0 0 160 10', class: 'meter', 'aria-hidden': 'true', preserveAspectRatio: 'none' },
    s('rect', { x: 0, y: 3, width: 160, height: 4, rx: 2, class: 'track' }),
    s('rect', { x: 0, y: 3, width: Math.max(0, Math.min(1, p)) * 160, height: 4, rx: 2, class: 'fill' }));
}

// ---------- record sections, shared by the Record view and printed reports ----------
function reqTable(list, title, sub, refCol) {
  return h('section', { class: 'reqs' }, h('h2', null, title), sub && h('p', { class: 'sub' }, sub),
    h('table', { class: 'data req' }, h('thead', null, h('tr', null, h('th', null, 'Requirement'), h('th', null, 'Progress'), h('th', { class: 'num' }, 'Logged'), h('th', { class: 'num' }, 'Target'), refCol && h('th', null, 'ACGME'))),
      h('tbody', null, list.map(r => h('tr', { class: r.progress >= 1 ? 'met' : '' },
        h('td', null, h('div', null, r.label, r.measure === 'proxy' ? h('span', { class: 'mark', title: 'Estimate from your logs' }, ' ≈') : null),
          r.note && h('div', { class: 'note' }, r.note)),
        h('td', { class: 'm' }, meter(r.progress), r.progress >= 1 && h('span', { class: 'met-label' }, 'met')),
        h('td', { class: 'num' }, fmt(r.value), r.unit && r.value != null ? r.unit : ''),
        h('td', { class: 'num' }, fmt(r.target), r.unit),
        refCol && h('td', { class: 'ref' }, r.ref))))));
}
const SECTION_VIEWS = {
  summary: st => {
    const T = st.totals;
    const cell = (label, value, unit) => h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'stat-v' }, fmt(value), unit && value != null ? h('span', { class: 'unit' }, unit) : null));
    return h('section', { class: 'summary-sec' },
      h('div', { class: 'hero' }, h('div', { class: 'hero-v' }, fmt(T.encounters)), h('div', { class: 'hero-l' }, 'encounters logged', h('br'), `${fmt(T.days)} days`)),
      h('div', { class: 'stats' }, cell('Per clinic day', T.perClinicDay), cell('Continuity', T.continuity, '%'), cell('New patients', T.newPct, '%'),
        cell('Unused clinic time', T.unusedPct, '%'), cell('No-shows', T.noShows), cell('Procedures', T.procedures),
        cell('Interpreter visits', T.interpreter, '%'), cell('Volunteer hours', T.volunteerHours, 'h')),
      h('p', { class: 'note' }, 'Unused clinic time = empty slots plus no-shows, as a share of scheduled clinic time with lunch left out. Many no-shows get deleted from the schedule and show up as empty slots, so the combined number is the honest one. It’s a minimum: time after your last booked patient isn’t listed by the EMR.'));
  },
  acgme: st => reqTable(st.requirements, 'ACGME Family Medicine requirements', 'From the 2026 ACGME Family Medicine program requirements. Rows marked ≈ are estimates. Rotation rows fill in from days you log under that area (use Manual entry). Each day counts toward one area only, because ACGME doesn’t allow double counting. Requirements follow the period, not the site or patient filters.', true),
  program: st => (st.program.length ? reqTable(st.program, 'Program requirements', 'Your program’s own targets. Edit them in Settings.', false) : null),
  pace: st => {
    if (!st.pace) return null;
    const P = st.pace;
    return h('div', { class: 'figs' },
      figure('FMP hours toward 1,000', 'Cumulative, against an even pace over 36 months. Whole residency, ignoring filters.', lineChart(P.months, [{ name: 'Logged', values: P.hours, cls: 'l1' }, { name: 'Even pace', values: P.hoursPace, cls: 'lp' }], { aria: 'Cumulative FMP hours' }),
        [['Month', 'Hours logged', 'Even pace'], P.months.map((m, i) => [m, P.hours[i], P.hoursPace[i]])]),
      figure(`FMP visits toward ${P.visitsTarget.toLocaleString('en-US')}`, 'The 1,650-visit goal ACGME calls reasonable, not required.', lineChart(P.months, [{ name: 'Logged', values: P.visits, cls: 'l1' }, { name: 'Even pace', values: P.visitsPace, cls: 'lp' }], { aria: 'Cumulative FMP visits' }),
        [['Month', 'Visits logged', 'Even pace'], P.months.map((m, i) => [m, P.visits[i], P.visitsPace[i]])]));
  },
  trends: st => {
    if (st.months.length < 2) return null;
    const L = st.months.map(m => m.label), col = k => st.months.map(m => m[k]);
    return h('div', { class: 'figs' },
      figure('Visits per clinic day', 'Monthly average on FMP days.', lineChart(L, [{ name: 'Visits per day', values: col('perDay'), cls: 'l1' }], { aria: 'Visits per clinic day by month' }),
        [['Month', 'Visits per clinic day'], st.months.map(m => [m.label, m.perDay])]),
      figure('Continuity and new patients', 'Share of FMP visits each month. Months saved before continuity was counted per day are left blank.', lineChart(L, [{ name: 'Continuity', values: col('contPct'), cls: 'l1' }, { name: 'New patients', values: col('newPct'), cls: 'l2' }], { unit: '%', aria: 'Continuity and new patients by month' }),
        [['Month', 'Continuity %', 'New patient %'], st.months.map(m => [m.label, m.contPct, m.newPct])]),
      figure('Unused clinic time', 'Empty slots plus no-shows, as a share of scheduled time.', lineChart(L, [{ name: 'Unused', values: col('unusedPct'), cls: 'l1' }], { unit: '%', aria: 'Unused clinic time by month' }),
        [['Month', 'Unused %'], st.months.map(m => [m.label, m.unusedPct])]));
  },
  months: st => (st.months.length ? figure('Encounters by month', null, columns(st.months, 'Encounters per month'), [['Month', 'Encounters', 'Days'], st.months.map(m => [m.label, m.value, m.days])]) : null),
  agesex: st => figure('Age and sex', 'Population pyramid of logged visits. Anyone 90 or older is stored only as 90+.', pyramid(st.pyramid), [['Age', 'Female', 'Male', 'Not recorded'], st.pyramid.map(b => [b.label, b.F, b.M, b.U])]),
  reasons: st => (st.categories.length ? figure('Reasons for visit', 'Categories only. Reason text is never kept. A visit can have more than one.', hbars(st.categories, 'Visits by reason category', 16), [['Category', 'Visits'], st.categories.map(c => [c.label, c.value])]) : null),
  types: st => (st.types.length ? figure('Visit types', null, hbars(st.types, 'Visits by type'), [['Type', 'Visits'], st.types.map(c => [c.label, c.value])]) : null),
  sites: st => (st.sites.length ? figure('Sites', null, hbars(st.sites, 'Visits by site'), [['Site', 'Visits'], st.sites.map(c => [c.label, c.value])]) : null),
  breakdowns: st => (st.reasonsByAge.rows.length ? h('div', { class: 'figs' },
    figure('Reasons for visit by age group', 'Top 12 categories. Darker = more visits.', heatTable(st.reasonsByAge.cols, st.reasonsByAge.rows, 'Category'),
      [['Category'].concat(st.reasonsByAge.cols), st.reasonsByAge.rows.map(r => [r.label].concat(r.values))], { noTable: true }),
    figure('Visit types by site', null, heatTable(st.typesBySite.cols, st.typesBySite.rows, 'Type'),
      [['Type'].concat(st.typesBySite.cols), st.typesBySite.rows.map(r => [r.label].concat(r.values))], { noTable: true }),
    figure('Sex split by reason for visit', null, splitBars(st.sexByCat),
      [['Category', 'Female', 'Male'], st.sexByCat.map(r => [r.label, r.F, r.M])])) : null),
  empty: st => (st.heatDays.some(Boolean) ? figure('Empty clinic time', 'Average empty minutes per 30-minute block, on your own clinic schedules. No-shows aren’t shown here, because their times are never stored.', heatmap(st.heat, st.heatDays),
    [['Weekday'].concat(Array.from({ length: 20 }, (_, b) => fmtTime(420 + b * 30))), st.heat.map((row, i) => [WD[i]].concat(row.map(v => Math.round(v))))], { noTable: true }) : null),
  procedures: st => (st.procedures.length ? figure('Procedure log', 'Role is recorded for surgery cases.', dataTable(['Procedure', 'Count', 'Observed', 'Assisted', 'Primary'], st.procedures.map(p => {
    const r = Object.fromEntries(p.roles); return [p.label, p.value, r.observed || '', r.assisted || '', r.primary || ''];
  })), [['Procedure', 'Count', 'Observed', 'Assisted', 'Primary'], st.procedures.map(p => { const r = Object.fromEntries(p.roles); return [p.label, p.value, r.observed || 0, r.assisted || 0, r.primary || 0]; })], { noTable: true }) : null),
  areas: st => (st.areas.length ? figure('Hours and encounters by area', null, dataTable(['Area', 'Days', 'Hours', 'Encounters'], st.areas.map(a => [a.label, a.days, fmt(a.hours), a.encounters])),
    [['Area', 'Days', 'Hours', 'Encounters'], st.areas.map(a => [a.label, a.days, a.hours, a.encounters])], { noTable: true }) : null),
};
const GRID_SECTIONS = new Set(['months', 'agesex', 'reasons', 'types', 'sites', 'empty', 'procedures', 'areas']);
function sectionsView(st, ids) {
  const out = [], grid = [];
  const flush = () => { if (grid.length) out.push(h('div', { class: 'figs' }, grid.splice(0))); };
  for (const id of ids) {
    const el = SECTION_VIEWS[id](st);
    if (!el) continue;
    if (GRID_SECTIONS.has(id)) grid.push(el); else { flush(); out.push(el); }
  }
  flush();
  return out;
}

// ---------- record ----------
function periodOptions(years) {
  return [['', 'Whole residency']].concat(years.map(ay => [ay, `AY ${ayLabel(ay)}` + (C.pgyFor(ay, S.settings.residencyStartAY) ? ` · PGY-${C.pgyFor(ay, S.settings.residencyStartAY)}` : '')]));
}
function recordView() {
  if (!S.days.length) return h('section', { class: 'empty' }, h('h2', null, 'Nothing logged yet'), h('p', null, 'Paste a schedule under “Log a day” and your record builds from there.'));
  const F = S.filter;
  const st = C.computeStats(S.days, S.encounters, S.settings, F);
  const setF = (k, v) => { F[k] = v; render(); };
  const active = F.site || F.area || F.mine;
  return h('section', { class: 'record' },
    h('div', { class: 'filters' },
      h('label', { class: 'ctl' }, h('span', { class: 'label' }, 'Period'), select(periodOptions(st.years), F.ay == null ? '' : F.ay, v => setF('ay', v === '' ? null : +v), { 'data-fk': 'f-ay' })),
      h('label', { class: 'ctl' }, h('span', { class: 'label' }, 'Site'), select([['', 'All sites']].concat(st.siteList.map(x => [x, x])), F.site, v => setF('site', v), { 'data-fk': 'f-site' })),
      h('label', { class: 'ctl' }, h('span', { class: 'label' }, 'Area'), select([['', 'All areas']].concat(AREA_OPTS.filter(([id]) => S.days.some(d => d.area === id))), F.area, v => setF('area', v), { 'data-fk': 'f-area' })),
      h('label', { class: 'ctl' }, h('span', { class: 'label' }, 'Patients'), select([['', 'Everyone'], ['1', 'My patients only']], F.mine ? '1' : '', v => setF('mine', v === '1'), { 'data-fk': 'f-mine' })),
      active && h('button', { class: 'link', onclick: () => { Object.assign(F, { site: '', area: '', mine: false }); render(); } }, 'Clear filters'),
      h('button', { class: 'btn push', onclick: () => { S.view = 'report'; S.report.ay = F.ay; render(); } }, 'Make a report')),
    F.mine && h('p', { class: 'hint' }, '“My patients only” applies to visit-level charts. Day-level numbers (visits per day, empty time, hours) can’t tell whose patients they were.'),
    sectionsView(st, C.SECTION_IDS));
}

// ---------- report ----------
function reportView() {
  if (!S.days.length) return h('section', { class: 'empty' }, h('h2', null, 'Nothing to report yet'), h('p', null, 'Log a few days first.'));
  const Rp = S.report;
  const ids = Rp.preset === 'ccc' ? C.CCC_SECTIONS : S.settings.reportSections || C.CCC_SECTIONS;
  const st = C.computeStats(S.days, S.encounters, S.settings, { ay: Rp.ay });
  const pgy = Rp.ay != null ? C.pgyFor(Rp.ay, S.settings.residencyStartAY) : C.pgyFor(C.academicYear(today()), S.settings.residencyStartAY);
  const P = S.settings.profile;
  const range = S.days.filter(d => Rp.ay == null || d.ay === Rp.ay).map(d => d.date).sort();
  return h('section', { class: 'report' },
    h('div', { class: 'report-controls no-print' },
      h('div', { class: 'datepick', role: 'group', 'aria-label': 'Report type' },
        h('button', { class: 'daybtn', 'aria-pressed': String(Rp.preset === 'ccc'), onclick: () => { Rp.preset = 'ccc'; render(); } }, 'CCC summary'),
        h('button', { class: 'daybtn', 'aria-pressed': String(Rp.preset === 'custom'), onclick: () => { Rp.preset = 'custom'; render(); } }, 'Choose sections')),
      h('label', { class: 'ctl' }, h('span', { class: 'label' }, 'Period'), select(periodOptions(st.years), Rp.ay == null ? '' : Rp.ay, v => { Rp.ay = v === '' ? null : +v; render(); }, { 'data-fk': 'r-ay' })),
      h('button', { class: 'btn primary push', onclick: () => window.print() }, 'Print or save as PDF'),
      Rp.preset === 'custom' && h('div', { class: 'section-picks' }, C.SECTIONS.map(([id, label]) => h('label', { class: 'flag' },
        h('input', { type: 'checkbox', checked: ids.includes(id), 'data-fk': 'rs-' + id, onchange: e => setAndSave(x => {
          const cur = new Set(x.reportSections || C.CCC_SECTIONS); if (e.target.checked) cur.add(id); else cur.delete(id);
          x.reportSections = C.SECTION_IDS.filter(i => cur.has(i));
        }) }), ' ', label))),
      !P.name && h('p', { class: 'hint' }, 'Add your name and program in Settings to put them on the report.')),
    h('header', { class: 'report-head' },
      h('div', { class: 'label' }, 'Resident case log'),
      h('h2', null, P.name || 'Resident'),
      h('p', null, [P.program, pgy ? `PGY-${pgy}` : null, Rp.ay != null ? `Academic year ${ayLabel(Rp.ay)}` : 'Whole residency',
        range.length ? `${dayLabel(range[0])} – ${dayLabel(range[range.length - 1])}` : null].filter(Boolean).join('  ·  ')),
      h('p', { class: 'note' }, `Generated ${dayLabel(today())}. Self-logged with vihsit from the resident’s own clinic schedules. De-identified: no patient names, dates of birth or visit dates are stored. Not an official program record.`)),
    sectionsView(st, ids));
}

// ---------- settings ----------
async function setAndSave(fn) { fn(S.settings); await saveSettings(); render(); }
function settingsView() {
  const st = S.settings, now = C.academicYear(today());
  const used = id => S.encounters.filter(e => e.cats.includes(id)).length;
  return h('section', { class: 'settings' },
    h('h2', null, 'Resident'),
    h('div', { class: 'rsec-head' },
      h('label', { class: 'ctl' }, h('span', { class: 'label' }, 'Name'), h('input', { type: 'text', value: st.profile.name, 'data-fk': 'p-name', onchange: e => setAndSave(x => { x.profile.name = e.target.value; }) })),
      h('label', { class: 'ctl wide' }, h('span', { class: 'label' }, 'Program'), h('input', { type: 'text', value: st.profile.program, 'data-fk': 'p-prog', onchange: e => setAndSave(x => { x.profile.program = e.target.value; }) })),
      h('label', { class: 'ctl' }, h('span', { class: 'label' }, 'Residency started July of'),
        select([0, 1, 2, 3, 4, 5, 6].map(i => [now - i, String(now - i)]), st.residencyStartAY, v => setAndSave(x => { x.residencyStartAY = +v; }), { 'data-fk': 'set-start' }))),
    h('p', { class: 'hint' }, 'Your name and program appear on your screen, printed reports and backups. They’re about you, not patients. The start year changes PGY only on days saved from now on.'),
    h('p', { class: 'field' }, h('label', null, h('input', { type: 'checkbox', checked: st.continuityReminder, 'data-fk': 'cont-rem', onchange: e => setAndSave(x => { x.continuityReminder = e.target.checked; }) }),
      ' Before saving a clinic day, ask “Did you check your continuities?”')),
    h('p', { class: 'field' }, h('span', null, 'Lunch, left out of unused clinic time: '),
      h('input', { type: 'time', value: st.lunch.start, 'data-fk': 'lunch-s', onchange: e => setAndSave(x => { x.lunch.start = e.target.value; }) }), ' to ',
      h('input', { type: 'time', value: st.lunch.end, 'data-fk': 'lunch-e', onchange: e => setAndSave(x => { x.lunch.end = e.target.value; }) })),

    h('h2', null, 'Sites'),
    h('p', { class: 'sub' }, 'Each site’s default area, and its usual visit type for sites you log by hand, such as a nursing home. Changing these affects new days. “Apply to saved” updates what’s already logged there.'),
    Object.keys(st.sites).length ? h('table', { class: 'data' }, h('thead', null, h('tr', null, h('th', null, 'Site'), h('th', null, 'Counts toward'), h('th', null, 'Usual visit type'), h('th', null, ''), h('th', null, ''))),
      h('tbody', null, Object.entries(st.sites).map(([name, v]) => h('tr', null, h('td', null, name),
        h('td', null, select(AREA_OPTS, v.area, a => setAndSave(x => { x.sites[name].area = a; }), { 'data-fk': 'site-' + name })),
        h('td', null, select([['', 'From the schedule']].concat(C.TYPE_NAMES.filter(t => t !== 'Surgical Case').map(t => [t, t])), v.type || '', t => setAndSave(x => { x.sites[name].type = t || null; }), { 'data-fk': 'stype-' + name })),
        h('td', null, retagButton(name, v)),
        h('td', null, h('button', { class: 'link', onclick: () => setAndSave(x => { delete x.sites[name]; }) }, 'Forget')))))) : h('p', { class: 'hint' }, 'Sites appear here after your first save.'),

    h('h2', null, 'Program requirements'),
    h('p', { class: 'sub' }, 'Your program’s own targets, shown as a second set beside ACGME’s. Each one counts visits that match every filter you set, sums hours, or gives a percentage.'),
    st.programReqs.map((r, i) => programReqEditor(r, i)),
    h('button', { class: 'btn', onclick: () => setAndSave(x => { x.programReqs.push({ label: 'New requirement', target: 10, kind: 'encounters' }); }) }, '+ Add a program requirement'),

    h('h2', null, 'ACGME targets'),
    h('p', { class: 'sub' }, 'Defaults from the 2026 ACGME Family Medicine requirements. Change one if your track differs, for example 80 deliveries on the full obstetrics track.'),
    h('table', { class: 'data' }, h('tbody', null, C.REQUIREMENTS.map(r => h('tr', null, h('td', null, r.label), h('td', { class: 'ref' }, r.ref),
      h('td', { class: 'num' }, h('input', { type: 'number', min: '0', class: 'numin', value: st.targets[r.id] != null ? st.targets[r.id] : r.target, 'data-fk': 't-' + r.id,
        onchange: e => setAndSave(x => { if (e.target.value === '' || +e.target.value === r.target) delete x.targets[r.id]; else x.targets[r.id] = +e.target.value; }) }), ' ', r.unit))))),

    h('h2', null, 'Categories'),
    h('p', { class: 'sub' }, 'Rename any built-in category, or add your own. Keywords teach the app which reasons belong where. Teach them on the review screen by clicking an unrecognized word, or add them here.'),
    h('table', { class: 'data' }, h('thead', null, h('tr', null, h('th', null, 'Category'), h('th', null, 'Your keywords'), h('th', { class: 'num' }, 'Visits'), h('th', null, ''))),
      h('tbody', null, catOpts().map(([id, label]) => {
        const custom = id.startsWith('c-'), kws = st.keywords.map((k, i) => [k, i]).filter(([k]) => k.cat === id);
        return h('tr', null,
          h('td', null, h('input', { type: 'text', value: label, 'aria-label': 'Category name', 'data-fk': 'cl-' + id, onchange: e => setAndSave(x => {
            const v = e.target.value.trim();
            if (custom) { const c = x.customCats.find(c2 => c2.id === id); if (v) c.label = v; }
            else if (!v || v === C.CAT_LABEL[id]) delete x.catLabels[id]; else x.catLabels[id] = v;
          }) })),
          h('td', null, kws.map(([k, i]) => h('span', { class: 'tag' }, k.kw, h('button', { 'aria-label': 'Remove keyword ' + k.kw, onclick: () => setAndSave(x => { x.keywords.splice(i, 1); }) }, '×'))),
            h('input', { type: 'text', class: 'kwin', placeholder: '+ keyword', 'aria-label': 'Add keyword to ' + label, 'data-fk': 'kw-' + id,
              onchange: e => { const v = e.target.value.trim().toLowerCase(); if (v) setAndSave(x => { x.keywords.push({ kw: v, cat: id }); }); } })),
          h('td', { class: 'num' }, used(id) || ''),
          h('td', null, custom && h('button', { class: 'link', onclick: () => {
            if (used(id)) return flash(`“${label}” is on ${plural(used(id), 'saved visit')}, so it can’t be removed. Rename it instead.`, 'warn');
            setAndSave(x => { x.customCats = x.customCats.filter(c2 => c2.id !== id); x.keywords = x.keywords.filter(k => k.cat !== id); });
          } }, 'Remove')));
      }))),
    h('p', { class: 'field' }, h('label', null, 'New category ', h('input', { type: 'text', 'data-fk': 'newcat', onchange: e => {
      const v = e.target.value.trim(); if (!v) return;
      setAndSave(x => { x.customCats.push({ id: 'c-' + Math.random().toString(36).slice(2, 8), label: v }); });
    } }))),

    h('h2', null, 'Label mappings'),
    h('p', { class: 'sub' }, 'What other clinics’ labels mean. Usually set from the review screen. Use “always use this” under a visit type, or “count as seen” under a schedule.'),
    h('div', { class: 'figs' },
      h('div', null, h('h3', null, 'Visit types'),
        st.typeMap.length ? h('table', { class: 'data' }, h('tbody', null, st.typeMap.map((t, i) => h('tr', null, h('td', null, `“${t.raw}”`),
          h('td', null, select(C.TYPE_NAMES.map(n => [n, n]), t.type, v => setAndSave(x => { x.typeMap[i].type = v; }), { 'data-fk': 'tm-' + i })),
          h('td', null, h('button', { class: 'link', onclick: () => setAndSave(x => { x.typeMap.splice(i, 1); }) }, 'Remove')))))) : h('p', { class: 'hint' }, 'None yet.'),
        h('p', { class: 'field' }, h('label', null, 'EMR label ', h('input', { type: 'text', 'data-fk': 'tm-new', placeholder: 'Acute Sick Visit', onchange: e => {
          const v = C.typeLabel(e.target.value); if (v) setAndSave(x => { x.typeMap.push({ raw: v, type: 'Open Access' }); });
        } })))),
      h('div', null, h('h3', null, 'Statuses that mean the visit happened'),
        st.statusMap.length ? h('table', { class: 'data' }, h('tbody', null, st.statusMap.map((t, i) => h('tr', null, h('td', null, `“${t.raw}”`),
          h('td', null, select([['1', 'Counts as seen'], ['', 'Not seen']], t.seen ? '1' : '', v => setAndSave(x => { x.statusMap[i].seen = v === '1'; }), { 'data-fk': 'sm-' + i })),
          h('td', null, h('button', { class: 'link', onclick: () => setAndSave(x => { x.statusMap.splice(i, 1); }) }, 'Remove')))))) : h('p', { class: 'hint' }, 'None yet. Built in: Checked Out, Finished, Patient Discharged, Completed.'),
        h('p', { class: 'field' }, h('label', null, 'EMR status ', h('input', { type: 'text', 'data-fk': 'sm-new', placeholder: 'Visit Complete', onchange: e => {
          const v = e.target.value.trim(); if (v) setAndSave(x => { x.statusMap.push({ raw: v, seen: true }); });
        } }))))),

    h('h2', null, 'My procedure names'),
    st.procVocab.filter(p => !C.BUILTIN_PROCS.includes(p)).length
      ? h('ul', { class: 'plain' }, st.procVocab.filter(p => !C.BUILTIN_PROCS.includes(p)).map(p => h('li', null, p, ' ', h('button', { class: 'link', onclick: () => setAndSave(x => { x.procVocab = x.procVocab.filter(q => q !== p); }) }, 'Remove'))))
      : h('p', { class: 'hint' }, 'Built-in names cover common clinic procedures. Names you approve from surgery schedules appear here.'),
    h('p', { class: 'field' }, h('label', null, 'Add a procedure name ', h('input', { type: 'text', 'data-fk': 'newproc', onchange: e => { const v = e.target.value.trim(); if (v) setAndSave(x => { x.procVocab.push(v); }); } }))),

    h('h2', null, 'Your data'),
    h('p', null, `${S.days.length} day records and ${S.encounters.length} visits are stored in this browser`, S.persisted === true ? ', and the browser has agreed to keep them.' : '. The browser hasn’t promised to keep them, so export a backup regularly.'),
    h('p', { class: 'hint' }, 'Safari deletes site data after 7 days without a visit. Data opened from a downloaded file belongs to that file’s location, so moving the file looks like starting over until you restore a backup. Backups hold the same de-identified data, so they’re safe to keep anywhere.'),
    h('div', { class: 'alt-actions' },
      h('button', { class: 'btn primary', onclick: exportBackup }, 'Export backup'),
      h('button', { class: 'btn', onclick: () => pickFiles('.json,application/json', false, ([t]) => restoreBackup(t)) }, 'Restore a backup'),
      h('button', { class: 'btn danger', onclick: deleteAll }, 'Delete everything')));
}
// Bring saved days and visits at a site in line with its settings (area, and visit type if one is set).
function retagButton(name, v) {
  const enc = S.encounters.filter(e => e.site === name && ((v.type && e.type !== v.type) || e.area !== v.area));
  const days = S.days.filter(d => d.site === name && d.area !== v.area);
  if (!enc.length && !days.length) return null;
  return h('button', { class: 'link', onclick: async () => {
    if (!confirm(`Update ${plural(enc.length, 'saved visit')} and ${plural(days.length, 'day')} at ${name}` + (v.type ? ` to “${v.type}” and` : ' to') + ` “${areaLabel(v.area)}”?`)) return;
    await applyChange({
      putEnc: enc.map(e => Object.assign(C.cleanEncounter(Object.assign({}, e, { area: v.area, type: v.type || e.type, ob: /OB$/.test(v.type || '') || e.ob }), S.settings), { id: e.id })),
      putDays: days.map(d => Object.assign(C.cleanDay(Object.assign({}, d, { area: v.area })), { id: d.id })) });
    flash(`Updated ${plural(enc.length, 'visit')} and ${plural(days.length, 'day')} at ${name}.`, 'ok', ['Undo', undoLast]);
  } }, `Apply to saved (${enc.length + days.length})`);
}
function programReqEditor(r, i) {
  const ch = (k, v) => setAndSave(x => { x.programReqs[i][k] = v; });
  const num = (k, label) => h('label', { class: 'ctl narrow' }, h('span', { class: 'label' }, label),
    h('input', { type: 'number', min: '0', value: r[k] == null ? '' : r[k], 'data-fk': `pr-${i}-${k}`, onchange: e => ch(k, e.target.value === '' ? null : +e.target.value) }));
  const flag = (k, label) => h('label', { class: 'flag' }, h('input', { type: 'checkbox', checked: r[k], 'data-fk': `pr-${i}-${k}`, onchange: e => ch(k, e.target.checked) }), ' ', label);
  return h('fieldset', { class: 'preq' },
    h('div', { class: 'rsec-head' },
      h('label', { class: 'ctl wide' }, h('span', { class: 'label' }, 'Name'), h('input', { type: 'text', value: r.label, 'data-fk': `pr-${i}-label`, onchange: e => ch('label', e.target.value) })),
      h('label', { class: 'ctl' }, h('span', { class: 'label' }, 'Measure'), select([['encounters', 'Count of visits'], ['hours', 'Hours'], ['pct', '% of visits']], r.kind, v => ch('kind', v), { 'data-fk': `pr-${i}-kind` })),
      num('target', 'Target'),
      h('label', { class: 'ctl' }, h('span', { class: 'label' }, 'Area'), select([['', 'Any']].concat(AREA_OPTS), r.area, v => ch('area', v), { 'data-fk': `pr-${i}-area` }))),
    r.kind !== 'hours' && h('div', { class: 'rsec-head' },
      num('ageMin', 'Age from'), num('ageMax', 'Age to'),
      h('label', { class: 'ctl' }, h('span', { class: 'label' }, 'Category'), select([['', 'Any']].concat(catOpts()), r.cat, v => ch('cat', v), { 'data-fk': `pr-${i}-cat` })),
      h('label', { class: 'ctl' }, h('span', { class: 'label' }, 'Visit type'), select([['', 'Any']].concat(C.TYPE_NAMES.map(t => [t, t])), r.type, v => ch('type', v), { 'data-fk': `pr-${i}-type` })),
      h('label', { class: 'ctl' }, h('span', { class: 'label' }, 'Procedure'), select([['', 'Any']].concat(S.settings.procVocab.slice().sort().map(p => [p, p])), r.proc, v => ch('proc', v), { 'data-fk': `pr-${i}-proc` })),
      flag('mineOnly', 'My patients only'), flag('newOnly', 'New patients only')),
    h('div', { class: 'rsec-head' }, flag('perYear', 'Target is per academic year'),
      h('button', { class: 'link', onclick: () => setAndSave(x => { x.programReqs.splice(i, 1); }) }, 'Remove this requirement')));
}
function exportBackup() {
  const strip = r => { const o = Object.assign({}, r); delete o.id; return o; };
  downloadBlob(`vihsit-backup-${today()}.json`, new Blob([JSON.stringify({ app: 'vihsit', version: 1, exported: today(), settings: S.settings, days: S.days.map(strip), encounters: S.encounters.map(strip) }, null, 1)], { type: 'application/json' }));
  flash('Backup exported. It contains only de-identified data.');
}
function restoreBackup(text) {
  let obj; try { obj = JSON.parse(text); } catch (e) { return flash('That file isn’t valid JSON.', 'error'); }
  const b = C.sanitizeBackup(obj);
  if (b.error) return flash(b.error, 'error');
  if (!confirm(`Replace everything here with this backup (${b.days.length} days, ${b.encounters.length} visits)?`)) return;
  b.settings.checklistDone = true;
  DB.tx(['days', 'encounters', 'kv'], t => {
    t.objectStore('days').clear(); t.objectStore('encounters').clear();
    addAll(t, 'days', b.days, []); addAll(t, 'encounters', b.encounters, []);
    t.objectStore('kv').put({ k: 'settings', v: b.settings });
  }).then(load).then(() => { S.lastSave = null; flash('Backup restored.'); });
}
function deleteAll() {
  if (prompt('This deletes every logged day, visit and setting in this browser. Type DELETE to confirm.') !== 'DELETE') return;
  DB.tx(['days', 'encounters', 'kv'], t => { t.objectStore('days').clear(); t.objectStore('encounters').clear(); t.objectStore('kv').clear(); })
    .then(load).then(() => { S.lastSave = null; setupState = { ticks: {}, start: null, name: '', program: '' }; flash('Everything was deleted.'); });
}

// ---------- help ----------
const DAY_EXAMPLE = {
  date: '2026-09-29', site: 'Example Clinic', setting: 'clinic', ownSchedule: true,
  emptySlots: [{ start: '09:00', minutes: 15 }],
  encounters: [
    { start: '08:15', minutes: 15, displayName: 'optional, never saved', age: '34y', sex: 'F', visitType: 'Established Patient', reason: 'cough, sore throat', status: 'Checked out', seen: true },
    { start: '08:30', minutes: 30, age: '6mo', sex: 'M', visitType: 'Well Child', reason: '6 month check', seen: true },
  ],
};
const AI_PROMPT = `Convert the clinic schedule below into JSON for the vihsit app. Output only JSON, no commentary.

Shape: one object per site per day, or an array of them (several days are fine):
{ "date": "YYYY-MM-DD" (if the schedule shows it), "site": clinic name, "setting": "clinic" | "surgery" | "other",
  "ownSchedule": true if this is one provider's own schedule, false if it is a whole-clinic list,
  "emptySlots": [ { "start": "HH:MM" (24-hour), "minutes": number } ] for every empty or "no appointments" slot,
  "encounters": [ { "start": "HH:MM", "minutes": number, "displayName": patient name as shown,
     "age": number plus unit, such as "34y", "6mo", "3wk" or "5d", "sex": "F" | "M" | "U",
     "visitType": the visit type text as shown, "reason": the reason for visit text as shown,
     "procedure": the procedure name for surgery cases, "status": the status text as shown,
     "seen": true only if the status shows the visit was completed } ] }

Never include medical record numbers, dates of birth, phone numbers, addresses or insurance details.

Schedule:
`;
function helpView() {
  return h('section', { class: 'help' },
    h('h2', null, 'How it works'),
    h('ol', null,
      h('li', null, 'Copy a day’s schedule from Cerner or athena and paste it on “Log a day”. The page reads it, clears your clipboard, and shows a review.'),
      h('li', null, 'On the review, untick anyone who wasn’t yours or who didn’t come, and tick “Mine” for your own continuity patients. Names are only on this screen.'),
      h('li', null, 'Save. Each visit is stored as age (90+ for anyone older), sex, visit type, categories, site, area, academic year and PGY. It has no date. Each day is stored separately as a date with counts and hours, holding no individual data. The two are never linked.'),
      h('li', null, 'To fix a day later, paste it again. The app sees it’s already logged and offers “Add missed visits” or “Remove visits”. Undo works until you close the tab.')),
    h('h2', null, 'Sites you can’t paste from (nursing homes and others)'),
    h('ol', null,
      h('li', null, 'The first time: on “Log a day”, choose Manual entry. Type the site’s name (for example UVRH), set “Counts toward” to the right area (a nursing home is usually Older adult care), and set “Usual visit type here” to Nursing Home.'),
      h('li', null, 'Add one row per patient you saw: age (like 84y), sex, categories, and tick “Mine” for your own patients. Enter the hours you spent. Busy day? Use Count-only for patients you won’t enter one by one.'),
      h('li', null, 'Save. From then on, “Log a day at UVRH” appears next to Manual entry and fills in the site, area, visit type and last hours for you.'),
      h('li', null, 'Already logged visits there before setting it up? In Settings › Sites, set the site’s area and usual visit type, then click “Apply to saved”.'),
      h('li', null, 'Days at a site whose usual visit type is Nursing Home also count toward ACGME’s long-term care requirement: care over at least 24 months.')),
    h('h2', null, 'Privacy checklist'),
    h('ol', { class: 'checklist' }, CHECKS.map(([, t]) => h('li', null, t))),
    h('p', null, 'This page’s security policy blocks every network request, including fonts and analytics, so nothing typed or pasted here can leave the computer. You can check this in your browser’s developer tools: the Network tab stays empty.'),
    h('h2', null, 'Other EMRs: the day file'),
    h('p', null, 'Any EMR works if its schedule can be turned into this JSON shape. Write a small script for your EMR, or have a local AI model do it. Import files with “Import day files” (several at once is fine), or paste the JSON like a schedule. Each day goes through the same review and the same privacy filter, so extra fields like MRNs or dates of birth are dropped even if they slip in.'),
    h('pre', { class: 'code' }, JSON.stringify(DAY_EXAMPLE, null, 2)),
    h('p', { class: 'notice warn' }, h('strong', null, 'Only use an AI model running on this computer'), ' (for example with Ollama or LM Studio, with the network off). Pasting a real schedule into a cloud AI such as ChatGPT, Claude or Gemini sends patient information to that company.'),
    h('details', { class: 'tbl' }, h('summary', null, 'A prompt for a local model'), h('pre', { class: 'code' }, AI_PROMPT + '<paste the schedule here>'),
      h('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(AI_PROMPT).then(() => flash('Prompt copied.'), () => flash('Couldn’t copy. Select the text instead.', 'warn')) }, 'Copy prompt')),
    h('h2', null, 'Sources'),
    h('p', null, 'ACGME numbers come from the 2026 ACGME Program Requirements for Graduate Medical Education in Family Medicine (section 4.11) and the Family Medicine FAQ. Programs and tracks differ, so targets are editable in Settings. This app is a personal log, not an official record.'));
}

// ---------- boot ----------
document.getElementById('nav').addEventListener('click', e => {
  const b = e.target.closest('button[data-view]'); if (!b) return;
  S.view = b.dataset.view;
  S.flash = S.review && b.dataset.view !== 'log' ? { text: 'Your unsaved review is waiting under “Log a day”.', kind: 'warn' } : null;
  render();
});
(async () => {
  try { await DB.open(); await load(); } catch (e) { S.dbError = String(e && e.message || e); }
  try { if (navigator.storage && navigator.storage.persisted) S.persisted = await navigator.storage.persisted(); } catch (e) { /* not available from file:// in some browsers */ }
  render();
})();
})();
