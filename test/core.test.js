const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core.js');
const F = require('./fixtures.js');

const settings = () => C.cleanSettings({ residencyStartAY: 2025 });
const review = (text, s = settings()) => C.prepareReview(C.parseSchedule(text), s, '2026-10-01');

test('cerner clinic: date, count, empty slots, ages, statuses', () => {
  const p = C.parseSchedule(F.cernerClinic);
  assert.equal(p.source, 'cerner');
  assert.equal(p.date, '2026-09-29');
  assert.equal(p.expected, 6);
  const sec = p.sections[0];
  assert.equal(sec.site, 'Example FMC');
  assert.equal(sec.slots.filter(s => s.visit).length, 7);
  assert.equal(sec.slots.filter(s => s.empty).length, 2);
  const v = sec.slots.filter(s => s.visit).map(s => s.visit);
  assert.equal(v[0].displayName, 'TESTER, ALPHA M');
  assert.deepEqual([v[1].age, v[1].ageMo], [0, 0]);   // 5 days
  assert.equal(v[2].age, '90+');
  assert.equal(v[6].reason, '');                       // no RFV block at all
});

test('cerner defaults: no-show rule, new patient, interpreter, categories, procedures', () => {
  const r = review(F.cernerClinic).sections[0].rows;
  assert.deepEqual(r.map(x => x.include), [true, true, true, true, false, true, true]); // "Seen By Resident" is not final
  assert.equal(r[3].type, 'Long Appointment');
  assert.equal(r[3].isNew, true);
  assert.equal(r[3].interpreter, true);
  assert.ok(r[0].cats.includes('gyn'));
  assert.ok(r[2].cats.includes('resp'));
  assert.deepEqual(r[5].procs, ['Endometrial biopsy']);
  assert.ok(!r[0].unmatched.some(f => /acme|self pay/i.test(f))); // admin noise isn't offered for categorizing
});

test('lunch and overlaps: unused time math', () => {
  const rv = review(F.cernerClinic);
  const n = C.scheduleNumbers(rv.sections[0], { start: '11:15', end: '13:00' });
  // empty: 9:00-9:15, then 10:15-1:15 minus the 11:15-1:00 lunch = 10:15-11:15 + 1:00-1:15
  assert.equal(n.emptyMin, 90);
  assert.equal(n.noShows, 1);
  assert.equal(n.noShowMin, 15);
  assert.deepEqual(n.emptySlots, [{ start: '09:00', min: 15 }, { start: '10:15', min: 60 }, { start: '13:00', min: 15 }]);
});

test('surgery: procedure needs approval, cases default unticked', () => {
  const r = review(F.cernerSurgery).sections[0];
  assert.equal(r.setting, 'surgery');
  assert.equal(r.area, 'surgery');
  assert.equal(r.rows[0].pendingProc, 'Lesion Excision');
  assert.ok(r.rows.every(x => !x.include && x.role === 'assisted'));
});

test('satellite site name and OB, HL7 line-break escape', () => {
  const r = review(F.cernerSatellite).sections[0];
  assert.equal(r.site, 'Example FMC Satellite');
  assert.ok(r.rows.every(x => x.ob && x.cats.includes('prenatal')));
  assert.equal(r.rows[1].isNew, true);
});

test('athena: week choices, type vs reason, nurse visit, all unticked', () => {
  const a = C.parseSchedule(F.athenaOpen);
  assert.equal(a.source, 'athena');
  assert.deepEqual(a.dateChoices, ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10']);
  const rv = C.prepareReview(a, settings(), '2026-10-01');
  assert.equal(rv.date, '');
  assert.equal(rv.sections[0].site, 'EXAMPLE ROAD CHURCH');
  assert.equal(rv.sections[0].area, 'volunteer');
  assert.equal(rv.sections[0].rows.length, 2);
  assert.equal(rv.sections[0].rows[0].type, 'Established Patient');

  const d = C.prepareReview(C.parseSchedule(F.athenaDone), settings(), '2026-10-01');
  assert.equal(d.dateChoices[0], '2026-09-27');
  assert.equal(d.dateChoices[6], '2026-10-03');
  const [dm, nurse] = d.sections[0].rows;
  assert.ok(dm.cats.includes('endo') && dm.cats.includes('meds'));
  assert.equal(nurse.nurse, true);
  assert.ok(!dm.include && !nurse.include);
});

test('privacy gate: no names, reasons, or dates on encounters; unknown fields dropped', () => {
  const rv = review(F.cernerClinic);
  rv.sections[0].rows[0].mrn = 'SJ123';
  const out = C.sanitize(rv, settings());
  const blob = JSON.stringify(out.encounters);
  assert.ok(!/TESTER|ALPHA|odor|cham|555|2026-09/i.test(blob));
  for (const e of out.encounters) assert.deepEqual(Object.keys(e).sort(), ['age', 'ageMo', 'area', 'ay', 'cats', 'continuity', 'interpreter', 'isNew', 'ob', 'pgy', 'procs', 'role', 'setting', 'sex', 'site', 'type'].sort());
  assert.equal(out.encounters.find(e => e.age === '90+').age, '90+');
  const day = out.days[0];
  assert.equal(day.pgy, 2);
  assert.equal(day.noShows, 1);
  assert.equal(day.hours, 4.25); // 8:15-2:15 is 360 min, minus 105 min lunch
  assert.ok(!JSON.stringify(out.days).includes('TESTER'));
});

test('privacy gate: imported JSON cannot smuggle fields; unknown procedures rejected', () => {
  const [p] = C.parseDayJson({ date: '2026-09-01', site: 'Away', setting: 'other', encounters: [
    { displayName: 'Zulu Tester', age: 95, sex: 'F', visitType: 'whatever', reason: 'cough', seen: true, dob: '1931-01-01', procedure: 'Secret Name Procedure' }] });
  const rv = C.prepareReview(p, settings(), '2026-10-01');
  assert.equal(rv.sections[0].rows[0].pendingProc, 'Secret Name Procedure');
  const out = C.sanitize(rv, settings());
  const e = out.encounters[0];
  assert.equal(e.age, '90+');
  assert.equal(e.type, 'Other');
  assert.deepEqual(e.procs, []);
  assert.ok(!JSON.stringify(out).match(/Zulu|1931|Secret/));
});

test('backup restore goes through the gate', () => {
  const b = C.sanitizeBackup({ app: 'log-your-visits', days: [{ date: '2026-09-29', site: 'X', name: 'leak', area: 'fmp', hours: 4 }],
    encounters: [{ age: 40, sex: 'M', name: 'leak', cats: ['resp', 'bogus'] }], settings: { keywords: [{ kw: 'Cough', cat: 'resp' }, { kw: 'x', cat: 'nope' }] } });
  assert.ok(!JSON.stringify(b).includes('leak'));
  assert.deepEqual(b.encounters[0].cats, ['resp']);
  assert.deepEqual(b.settings.keywords, [{ kw: 'cough', cat: 'resp' }]);
});

test('user keyword teaches the categorizer', () => {
  const s = settings();
  assert.ok(C.matchCategories('elavated sugar..QH', s.keywords).cats.includes('endo'));
  const m = C.matchCategories('physucal form', []);
  assert.ok(m.cats.includes('forms'));
  s.keywords.push({ kw: 'physucal', cat: 'preventive' });
  assert.ok(C.matchCategories('physucal form', s.keywords).cats.includes('preventive'));
});

test('stats and requirements', () => {
  const s = settings();
  const a = C.sanitize(review(F.cernerClinic), s);
  a.encounters.forEach((e, i) => { if (i < 2) e.continuity = 'mine'; });
  const st = C.computeStats(a.days, a.encounters, s, null);
  assert.equal(st.totals.encounters, 6);
  const req = Object.fromEntries(st.requirements.map(r => [r.id, r.value]));
  assert.equal(req['fmp-visits'], 6);
  assert.equal(req.continuity, 33.3);
  assert.equal(req['fmp-weeks'], 1);
  s.programReqs = [C.cleanProgramReq({ label: 'Peds under 5', target: 10, kind: 'encounters', ageMax: 4 })];
  const st2 = C.computeStats(a.days, a.encounters, s, null);
  assert.equal(st2.program[0].value, 1);
});

test('json with several dates becomes a queue of days', () => {
  const q = C.parseDayJson([
    { date: '2026-09-02', site: 'A', encounters: [{ age: '30y', sex: 'F', seen: true }] },
    { date: '2026-09-01', site: 'A', encounters: [{ age: '40y', sex: 'M', seen: true }] },
    { date: '2026-09-01', site: 'B', encounters: [{ age: '50y', sex: 'M', seen: true }] }]);
  assert.deepEqual(q.map(p => [p.date, p.sections.length]), [['2026-09-01', 2], ['2026-09-02', 1]]);
});

test('resident mappings: visit-type labels and statuses', () => {
  const s = settings();
  s.typeMap = [{ raw: 'Acute Sick', type: 'Walk In' }];
  s.statusMap = [{ raw: 'Seen By Resident', seen: true }];
  assert.equal(C.normalizeType('Acute Sick 15', s.typeMap), 'Walk In');
  assert.equal(C.typeLabel('Long Appt 30 Mins (30 min)'), 'Long Appt');
  const r = review(F.cernerClinic, s).sections[0].rows;
  assert.equal(r[4].include, true); // "Seen By Resident" now counts as seen
});

test('custom categories survive the gate; unknown ones do not', () => {
  const s = C.cleanSettings({ residencyStartAY: 2025, customCats: [{ id: 'c-abc123', label: 'Refugee health' }, { id: 'bad id', label: 'x' }],
    keywords: [{ kw: 'refugee', cat: 'c-abc123' }], catLabels: { resp: 'Respiratory' } });
  assert.deepEqual(s.customCats.map(c => c.id), ['c-abc123']);
  assert.ok(C.matchCategories('refugee intake', s).cats.includes('c-abc123'));
  const e = C.cleanEncounter({ age: 30, cats: ['c-abc123', 'c-nope99', 'resp'] }, s);
  assert.deepEqual(e.cats, ['c-abc123', 'resp']);
  assert.equal(C.catLabelOf(s, 'resp'), 'Respiratory');
});

test('re-paste fix: logged rows count as seen but are not saved again; removal matches by content', () => {
  const s = settings();
  const rv = review(F.cernerClinic, s);
  const first = C.sanitize(rv, s);
  const stored = first.encounters.map((e, i) => Object.assign({ id: i + 1 }, e));
  rv.sections[0].rows.forEach((r, i) => { r.logged = r.include && i < 3; });
  const again = C.sanitize(rv, s);
  assert.equal(again.days[0].seen, first.days[0].seen);
  assert.equal(again.encounters.length, first.encounters.length - 3);
  const wanted = rv.sections[0].rows.slice(0, 2).map(r => C.toEncounter(r, rv, rv.sections[0], s));
  const m = C.matchSaved(wanted, stored);
  assert.deepEqual(m.matched, [true, true]);
  assert.equal(new Set(m.ids).size, 2);
});

test('filters, trends and pace', () => {
  const s = settings();
  const a = C.sanitize(review(F.cernerClinic), s), b = C.sanitize(review(F.cernerSatellite), s);
  const days = a.days.concat(b.days.map(d => Object.assign(d, { date: '2026-09-30' }))), enc = a.encounters.concat(b.encounters);
  const all = C.computeStats(days, enc, s, null), sat = C.computeStats(days, enc, s, { site: 'Example FMC Satellite' });
  assert.equal(sat.totals.encounters, 2);
  assert.equal(sat.requirements.find(r => r.id === 'fmp-visits').value, all.requirements.find(r => r.id === 'fmp-visits').value); // requirements ignore site
  assert.equal(all.months[0].perDay, 4);
  assert.equal(all.months[0].contPct, 0);
  assert.equal(all.pace.months[0], '2025-07');
  assert.equal(all.pace.months.at(-1), '2026-09');
  assert.equal(all.pace.visits.at(-1), 8);
  assert.ok(all.categories.every(c => c.label));
});

test('nursing home: visit type, site defaults for manual entry, long-term-care months', () => {
  assert.equal(C.normalizeType('Nursing Home Visit'), 'Nursing Home');
  assert.equal(C.normalizeType('SNF follow up'), 'Nursing Home');
  assert.equal(C.normalizeType('Nurse Visit'), 'Nurse Visit');
  const s = C.cleanSettings({ residencyStartAY: 2025, sites: { UVRH: { area: 'geri', type: 'Nursing Home', lastHours: 3 } } });
  const rv = C.manualReview('2026-09-30', s, 'UVRH');
  assert.deepEqual([rv.sections[0].area, rv.sections[0].hours, rv.sections[0].rows[0].type], ['geri', 3, 'Nursing Home']);
  rv.sections[0].rows[0] = Object.assign(rv.sections[0].rows[0], C.parseAgeText('84y'), { sex: 'F' });
  const out = C.sanitize(rv, s);
  assert.equal(out.encounters[0].type, 'Nursing Home');
  const days = out.days.concat(C.sanitize(Object.assign({}, rv, { date: '2026-10-02' }), s).days);
  const st = C.computeStats(days, out.encounters, s, null);
  assert.equal(st.requirements.find(r => r.id === 'ltc-months').value, 2);
  assert.ok(st.requirements.find(r => r.id === 'geri-enc').value >= 1);
});
