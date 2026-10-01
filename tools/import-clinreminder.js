// One-off migration: ClinReminder (desktop_clinic_aide) SQLite -> a Log Your Visits backup, merged with an existing backup.
//   node --experimental-sqlite tools/import-clinreminder.js <clinic.db> <existing-backup.json> <out.json>
// Patient names are never selected from the database. Every day goes through Core.sanitize, the same gate the app uses,
// and the merged file goes through Core.sanitizeBackup again when it's restored.
// Dates already in the existing backup are skipped (the reviewed version wins).
'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const C = require('../src/core.js');

// Optional 4th argument: comma-separated dates to take from ClinReminder even though the backup has them (partial pastes).
// Visits already saved for those dates can't be found by date, so they're matched by content and not added twice.
const [dbPath, backupPath, outPath, replaceArg] = process.argv.slice(2);
const replace = new Set((replaceArg || '').split(',').filter(Boolean));
if (!outPath) { console.error('usage: node --experimental-sqlite tools/import-clinreminder.js <clinic.db> <backup.json> <out.json>'); process.exit(1); }
const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
const settings = C.cleanSettings(backup.settings);
const db = new DatabaseSync(dbPath, { readOnly: true });

// ClinReminder's parser only understood "N Years", so infants were saved with the whole "LAST, FIRST 5 Days, M" line
// as the name and no age. Pull just the age and sex back out; the name part is discarded right here.
const AGE_IN_NAME = /\s(\d+)\s+(Year|Month|Week|Day|Hour)s?,\s*([MFU])\w*$/i;
const UNIT = { year: 'y', month: 'mo', week: 'wk', day: 'd', hour: 'h' };
const ageOf = v => {
  if (v.age != null) return { a: C.ageFrom(v.age, 'y'), sex: v.sex };
  const m = AGE_IN_NAME.exec(v.name_tail || '');
  return m ? { a: C.ageFrom(+m[1], UNIT[m[2].toLowerCase()]), sex: v.sex || m[3].toUpperCase() } : null;
};

// substr(name, -24): only the tail of the name field, enough to hold "5 Days, M" for the infant rows.
const visits = db.prepare(`
  SELECT v.date, v.sched_time, v.sched_minutes, v.type, v.rfv, v.status, p.age, p.sex, p.on_panel,
         CASE WHEN p.age IS NULL THEN substr(p.name, -24) END AS name_tail
  FROM visits v JOIN patients p ON p.id = v.patient_id
  WHERE v.status != 'deleted' ORDER BY v.date, v.sched_time`).all();

const have = new Set(backup.days.map(d => d.date).filter(d => !replace.has(d)));
let pool = backup.encounters.map((e, i) => Object.assign({ id: i }, e)); // ids only for matching
const byDate = new Map();
for (const v of visits) if (!have.has(v.date)) (byDate.get(v.date) || byDate.set(v.date, []).get(v.date)).push(v);

const report = { days: 0, encounters: 0, noAge: 0, untyped: 0, scheduledAsSeen: 0, noShows: 0, mine: 0, satellite: [] };
const days = [], encounters = [];
for (const [date, vs] of byDate) {
  const usable = vs.filter(v => { const ok = ageOf(v); if (!ok) report.noAge++; return ok; });
  if (!usable.length) continue;
  const obShare = usable.filter(v => /OB$/i.test(v.type || '')).length / usable.length;
  const site = obShare >= 0.6 ? 'SJC FMC Catholic Charities' : 'SJC FMC';
  if (site !== 'SJC FMC') report.satellite.push(date);
  const iv = usable.map(v => { const [hh, mm] = v.sched_time.split(':').map(Number); return [hh * 60 + mm, hh * 60 + mm + (v.sched_minutes || 15)]; });
  const span = [[Math.min(...iv.map(x => x[0])), Math.max(...iv.map(x => x[1]))]];
  const empties = C.subtract(span, iv).map(([a, b]) => ({ start: a, minutes: b - a, empty: true })); // gaps were "No appointments" rows ClinReminder skipped
  const parsed = { source: 'cerner', date, dateChoices: null, expected: null, sections: [{ site, setting: 'clinic', ownSchedule: true, slots: usable.map((v, i) => {
    const { a, sex } = ageOf(v);
    if (v.status === 'scheduled') report.scheduledAsSeen++;
    return { start: iv[i][0], minutes: iv[i][1] - iv[i][0], visit: { displayName: '', ageText: a.ageText, age: a.age, ageMo: a.ageMo, sex: sex || 'U',
      typeRaw: v.type || '', status: v.status === 'no-show' ? 'No Show' : 'Checked Out', reason: v.rfv || '' } };
  }).concat(empties) }] };
  const review = C.prepareReview(parsed, settings, date);
  review.source = 'import';
  const sec = review.sections[0];
  sec.area = 'fmp';
  sec.rows.forEach((r, i) => {
    if (!usable[i].type) { r.type = 'Other'; report.untyped++; }
    if (usable[i].on_panel) { r.continuity = 'mine'; report.mine++; }
    if (!r.include) report.noShows++;
  });
  if (replace.has(date)) {
    const old = backup.days.find(d => d.date === date && d.site === sec.site);
    const m = C.matchSaved(sec.rows.map(r => (r.include ? C.toEncounter(r, review, sec, settings) : null)), pool);
    sec.rows.forEach((r, i) => { r.logged = m.matched[i]; });
    pool = pool.filter(e => !m.ids.includes(e.id));
    // ClinReminder keeps the age from a patient's first visit, so a saved visit can differ by a year. The old day says how many
    // visits are already saved; cover the rest with near matches (same site, year, sex and type, age within 1).
    let need = (old ? old.seen : 0) - m.ids.length;
    const yrs = a => (a === '90+' ? 90 : a);
    for (const sameType of [true, false]) for (const r of sec.rows) { // second pass drops the type (ClinReminder lost some types)
      if (need <= 0 || !r.include || r.logged) continue;
      const e = C.toEncounter(r, review, sec, settings);
      const near = e && pool.find(p => p.site === e.site && p.ay === e.ay && p.sex === e.sex && (!sameType || p.type === e.type) && Math.abs(yrs(p.age) - yrs(e.age)) <= 1);
      if (near) { r.logged = true; pool = pool.filter(p => p !== near); need--; report.nearMatches = (report.nearMatches || 0) + 1; }
    }
    if (need > 0) report.unresolved = (report.unresolved || 0) + need;
    (report.replaced = report.replaced || []).push(`${date}: ${m.ids.length} already saved (old day had ${old ? old.seen : 0}), ${sec.rows.filter(r => r.include && !r.logged).length} added`);
    backup.days = backup.days.filter(d => d !== old);
  }
  const out = C.sanitize(review, settings);
  if (out.error) { console.error(date, out.error); continue; }
  days.push(...out.days); encounters.push(...out.encounters);
  report.days += out.days.length; report.encounters += out.encounters.length;
}

const merged = C.sanitizeBackup({ app: 'vihsit', version: 1, settings: backup.settings,
  days: backup.days.concat(days), encounters: backup.encounters.concat(encounters) });
const file = { app: 'vihsit', version: 1, exported: C.isoDate(new Date()), settings: merged.settings, days: merged.days, encounters: merged.encounters };

// Every text value left must be a site name or one of the app's own labels.
const allowed = new Set([...Object.keys(merged.settings.sites), 'SJC FMC', 'SJC FMC Catholic Charities', ...C.TYPE_NAMES, ...C.CAT_IDS, ...C.AREA_IDS, ...merged.settings.procVocab,
  'clinic', 'surgery', 'other', 'cerner', 'athena', 'import', 'manual', 'F', 'M', 'U', 'mine', 'covering', 'observed', 'assisted', 'primary', '90+']);
const strays = new Set();
(function walk(o) { if (typeof o === 'string') { if (!allowed.has(o) && !/^\d{4}-\d{2}-\d{2}$|^\d{2}:\d{2}$/.test(o)) strays.add(o); } else if (o && typeof o === 'object') Object.values(o).forEach(walk); })({ d: file.days, e: file.encounters });
if (strays.size) { console.error('Refusing to write: unexpected text values found', strays.size); process.exit(1); }

fs.writeFileSync(outPath, JSON.stringify(file, null, 1));
console.log(JSON.stringify(report), `\nwrote ${outPath}: ${file.days.length} days, ${file.encounters.length} visits total`);
