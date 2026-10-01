/* vihsit: pure logic. Parsing, categorizing, the privacy gate (sanitize) and stats.
   No DOM and no storage, so it runs in the browser and under `node --test`. */
(function (root) {
'use strict';

// ---------- small utils ----------
const pad = n => String(n).padStart(2, '0');
const hhmm = m => pad(Math.floor(m / 60)) + ':' + pad(m % 60);
const toMin = (h, m, ap) => ((+h % 12) + (/p/i.test(ap) ? 12 : 0)) * 60 + +m;
const hmToMin = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
const isoDate = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const HM_RE = /^\d{2}:\d{2}$/;
function academicYear(iso) { const [y, m] = iso.split('-').map(Number); return m >= 7 ? y : y - 1; }
function weekday(iso) { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).getDay(); }
function isoWeek(iso) { // yyyy-Www, Monday-start, used to count FMP weeks
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d)); const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return t.getUTCFullYear() + '-W' + pad(Math.ceil(((t - y0) / 864e5 + 1) / 7));
}
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function parseDuration(s) {
  const h = /(\d+)\s*hrs?\b/i.exec(s), m = /(\d+)\s*min/i.exec(s);
  return (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0);
}

// Age in any EMR unit -> what we keep: whole years (90+ capped) and months under 2 years.
function ageFrom(n, unit) {
  n = +n; let y, mo;
  if (unit === 'y') { y = n; mo = n < 2 ? n * 12 : null; }
  else if (unit === 'mo') { y = Math.floor(n / 12); mo = n; }
  else if (unit === 'wk') { y = 0; mo = Math.floor(n * 7 / 30.44); }
  else if (unit === 'd') { y = 0; mo = Math.floor(n / 30.44); }
  else { y = 0; mo = 0; } // hours
  return { age: y >= 90 ? '90+' : y, ageMo: y < 2 ? mo : null, ageText: n + unit };
}
const UNITS = { year: 'y', yo: 'y', y: 'y', month: 'mo', mo: 'mo', week: 'wk', wk: 'wk', day: 'd', d: 'd', hour: 'h', h: 'h' };
function parseAgeText(s) { // "34y", "5d", 34, "6 Months"
  if (typeof s === 'number') return ageFrom(s, 'y');
  const m = /^\s*(\d+)\s*([a-z]+)?/i.exec(String(s || ''));
  if (!m) return null;
  const u = UNITS[(m[2] || 'y').toLowerCase().replace(/s$/, '')];
  return u ? ageFrom(+m[1], u) : null;
}
const ageYears = e => (e.age === '90+' ? 90 : e.age);

// ---------- requirement areas: each day counts toward exactly one (ACGME FAQ: no double counting) ----------
const AREAS = [
  ['fmp', 'Family Medicine Practice (continuity clinic)'],
  ['peds-out', 'Pediatrics, outpatient'],
  ['peds-inpt', 'Pediatrics, inpatient / newborn'],
  ['ed-peds', 'Emergency, pediatric'],
  ['ed', 'Emergency, adult'],
  ['inpt-adult', 'Inpatient adult medicine / ICU'],
  ['ob', 'Pregnancy care / L&D'],
  ['gyn', 'Gynecology'],
  ['geri', 'Older adult care (NH, home, hospital)'],
  ['surgery', 'Surgery'],
  ['volunteer', 'Volunteer / free clinic'],
  ['elective', 'Elective / other'],
];
const AREA_IDS = AREAS.map(a => a[0]);

// ---------- complaint categories ----------
// Keywords match at a word start; keywords of 3 letters or fewer must be whole words. Spaces are optional ("toe nail" = "toenail").
const CATEGORIES = [
  ['preventive', 'Preventive / annual exam', ['annual', 'physical', 'amwe', 'awv', 'wellness', 'check up', 'checup', 'cpe', 'preventive', 'sports phys']],
  ['wcc', 'Well child / newborn', ['wcc', 'well child', 'newborn', 'nb', 'nicu', 'month old', '2 month', '4 month', '6 month', '9 month', '12 month', '15 month', '18 month']],
  ['prenatal', 'Prenatal care', ['ob', 'prenatal', 'pregnan', 'vbac', 'gestation', 'wks', 'new ob', 'hyperemesis']],
  ['postpartum', 'Postpartum', ['postpartum', 'pp visit', 'post partum']],
  ['contraception', 'Contraception', ['birth control', 'contracept', 'iud', 'nexplanon', 'depo', 'ocp']],
  ['gyn', 'Gynecologic', ['vaginal', 'vagina', 'pap', 'menstru', 'period', 'pelvic', 'endometrial', 'menopaus', 'breast', 'discharge', 'bleeding']],
  ['gu', 'Urinary / GU / sexual health', ['uti', 'urinat', 'urine', 'urinary', 'dysuria', 'scrot', 'testic', 'prostat', 'kidney', 'std', 'sti', 'hiv']],
  ['resp', 'Respiratory / URI', ['cough', 'sore throat', 'throat', 'congestion', 'stuffy', 'sinus', 'flu', 'uri', 'cold', 'wheez', 'asthma', 'copd', 'sob', 'shortness of breath', 'drainage', 'covid', 'pneumonia']],
  ['ent-eye', 'Ear / eye', ['ear', 'eye', 'pink eye', 'vision', 'hearing', 'otitis']],
  ['cv', 'Hypertension / cardiovascular', ['htn', 'hypertension', 'blood pressure', 'bp', 'chest pain', 'heart', 'palpitat', 'chf', 'afib', 'cholesterol', 'lipid', 'hld', 'edema']],
  ['endo', 'Diabetes / endocrine', ['diabet', 'dm', 'a1c', 'sugar', 'glucose', 'thyroid', 'tsh', 'hormone', 'cortisol', 'insulin', 'prediabet']],
  ['weight', 'Weight management', ['weight', 'obesity', 'obese']],
  ['gi', 'GI / abdominal', ['abd', 'abdominal', 'stomach', 'nausea', 'vomit', 'diarrhea', 'constip', 'bm', 'bms', 'anal', 'rectal', 'hemorrhoid', 'gerd', 'reflux', 'liver', 'heartburn']],
  ['msk', 'Musculoskeletal / pain', ['back pain', 'back', 'neck', 'shoulder', 'knee', 'hip', 'foot', 'feet', 'ankle', 'arm', 'leg', 'wrist', 'hand', 'joint', 'carpal', 'rotator', 'sprain', 'fracture', 'gout', 'arthrit', 'pinched nerve', 'swelling', 'swollen']],
  ['derm', 'Skin', ['rash', 'skin', 'acne', 'breaking out', 'mole', 'lesion', 'wart', 'eczema', 'itch', 'infected', 'wound', 'toenail', 'nail', 'cyst', 'mosquito', 'yeast']],
  ['neuro', 'Neurologic / headache', ['headache', 'migraine', 'dizz', 'numb', 'seizure', 'neuro', 'tingl', 'vertigo', 'disorient', 'memory']],
  ['mh', 'Mental health', ['depress', 'dep', 'anxiety', 'anx', 'mood', 'bipolar', 'ptsd', 'mental', 'psych', 'insomnia', 'not sleeping', 'sleep', 'stress', 'grief']],
  ['adhd', 'ADHD / behavioral', ['adhd', 'add', 'behavior', 'autism']],
  ['sud', 'Substance use', ['alcohol', 'smok', 'tobacco', 'vape', 'opioid', 'suboxone', 'withdrawal']],
  ['meds', 'Medication refill / review', ['refill', 'med review', 'medication', 'meds', 'rx', 'decrease in med']],
  ['hospfu', 'Hospital / ED follow-up', ['hosp', 'hospital', 'er', 'ed', 'emergency', 'after nicu', 'discharged']],
  ['labs', 'Lab / imaging review', ['lab', 'labs', 'results', 'us', 'ultrasound', 'x-ray', 'xray', 'mri', 'imaging', 'testing']],
  ['forms', 'Forms / clearance / letters', ['form', 'forms', 'clearance', 'letter', 'paperwork', 'accommodation', 'disability', 'fmla', 'work note']],
  ['injury', 'Injury / trauma', ['fall', 'injury', 'injured', 'laceration', 'dog bite', 'bite', 'cut', 'accident', 'gsw', 'burn']],
  ['establish', 'Establish care', ['establish', 'est care', 'np', 'new patient', 'new pt']],
  ['allergy', 'Allergy', ['allerg']],
  ['general', 'General symptoms', ['fatigue', 'tired', 'fever', 'sick', 'not feeling well', 'dehydrat', 'weak', 'malaise']],
  ['chronic', 'Chronic disease follow-up', ['chronic', 'multiple chronic']],
  ['followup', 'General follow-up', ['follow up', 'f/u', 'fu', 'recheck', 'follow-up', 'check']],
  ['procedure', 'Procedure visit', ['procedure', 'biopsy', 'removal', 'excision', 'injection']],
  ['other', 'Other', []],
];
const CAT_IDS = CATEGORIES.map(c => c[0]);
const CAT_LABEL = Object.fromEntries(CATEGORIES.map(c => [c[0], c[1]]));
// Dropped when anything more specific matches.
const GENERIC = new Set(['followup', 'general', 'procedure', 'chronic', 'labs']);

function kwRegex(kw) {
  const body = esc(kw.toLowerCase()).replace(/\s+/g, '\\s*');
  return new RegExp('(?:^|[^a-z0-9])' + body + (kw.replace(/\W/g, '').length <= 3 ? '(?![a-z0-9])' : ''), 'i');
}
const CAT_RX = CATEGORIES.map(([id, , kws]) => [id, kws.map(kwRegex)]);
// Built-in categories (with any renames) plus the resident's own. Custom ids look like "c-xxxxxx".
function catOptions(settings) {
  const ren = (settings && settings.catLabels) || {};
  return CATEGORIES.map(([id, label]) => [id, ren[id] || label]).concat(((settings && settings.customCats) || []).map(c => [c.id, c.label]));
}
const catIdSet = settings => new Set(CAT_IDS.concat(((settings && settings.customCats) || []).map(c => c.id)));
function catLabelOf(settings, id) { const o = catOptions(settings).find(c => c[0] === id); return o ? o[1] : 'Removed category'; }

// Strip sign-in stamps, phone numbers, dates, times and labels, so what's left is the clinical reason.
function cleanReason(raw) {
  return String(raw || '')
    .replace(/\\X0A\\/gi, ' ')
    .replace(/\*+/g, ' ')
    .replace(/\b(chief complaint|booking notes|reason for visit|application)\s*:/gi, ';')
    .replace(/\bsign(?:ed)?[\s-]*in\b\s*(?:@\s*)?(?:cham\s*)?\d{1,2}:?\d{0,2}/gi, ';')
    .replace(/\bprepped\b/gi, ' ')
    .replace(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
const ADMIN_RX = /\b(ins|insurance|self ?pay|ambetter|medicaid|soonercare|resched\w*|rs|call|called|cancel\w*|no show|interpret\w*|translat\w*|speaking|packet|please schedule|with nurse|nurse|consumer scheduling|due|pt states?|states?)\b/i;
const LANGS = 'spanish|portuguese|pashto|russian|arabic|swahili|burmese|vietnamese|somali|dari|farsi|persian|french|haitian creole|mandarin|cantonese|korean|nepali|kinyarwanda|tigrinya|amharic|marshallese|ukrainian|zomi|hakha|karenni|asl|sign language';
const INTERP_RX = new RegExp('interpret|translat|\\b(' + LANGS + ')\\b', 'i');
const LANG_ONLY_RX = new RegExp('^\\(?(' + LANGS + ')\\)?(\\s+speaking)?$', 'i');

function fragments(clean) {
  return clean.replace(/\b([a-z])\/([a-z])\b/gi, '$1$2') // f/u -> fu, u/s -> us, before splitting on "/"
    .split(/[;\/,]|\s-\s|\.\s|\.$|\s\+\s/).map(s => s.replace(/^[\s\-:(]+|[\s\-:)]+$/g, '')).filter(Boolean);
}

// -> { cats: [ids], unmatched: [fragment text, memory only] }
// Second argument: settings (keywords + custom categories) or a bare keyword list.
function matchCategories(reason, settingsOrKeywords) {
  const clean = cleanReason(reason);
  const arr = Array.isArray(settingsOrKeywords), valid = arr ? new Set(CAT_IDS) : catIdSet(settingsOrKeywords);
  const kws = arr ? settingsOrKeywords : (settingsOrKeywords && settingsOrKeywords.keywords) || [];
  const user = kws.filter(k => valid.has(k.cat)).map(k => [k.cat, kwRegex(k.kw)]);
  const cats = new Set(), unmatched = [];
  for (const frag of fragments(clean)) {
    let hit = false;
    for (const [id, rxs] of user.map(([c, rx]) => [c, [rx]]).concat(CAT_RX)) {
      if (rxs.some(rx => rx.test(' ' + frag))) { cats.add(id); hit = true; }
    }
    if (!hit && /[a-z]{3,}/i.test(frag) && !ADMIN_RX.test(frag) && !LANG_ONLY_RX.test(frag.trim()) && !unmatched.includes(frag)) unmatched.push(frag);
  }
  if ([...cats].some(c => !GENERIC.has(c))) GENERIC.forEach(c => cats.delete(c));
  return { cats: [...cats], unmatched };
}

// ---------- visit types ----------
const VISIT_TYPES = [
  ['New OB', /^new\s*ob\b/i], ['Established OB', /^est\w*\s*ob\b/i],
  ['New Patient', /^new\s*(patient|pt)/i], ['Established Patient', /^est\w*\s*(patient|pt)/i],
  ['Open Access', /open\s*access|same\s*day|acute/i], ['Walk In', /walk[\s-]?in/i],
  ['Hospital Follow-up', /hosp|hospital|\bed\b|\ber\b/i], ['Well Child', /well\s*child|\bwcc\b/i],
  ['Annual / Preventive', /annual|medicare|physical|preventive|wellness/i], ['Procedure', /procedure/i],
  ['Long Appointment', /long\s*appt|long\s*appointment/i], ['Nursing Home', /nursing|\bsnf\b|\bltc\b|long[-\s]?term\s*care|skilled/i], ['Nurse Visit', /nurse/i],
  ['Telehealth', /tele|video|virtual|phone/i], ['Surgical Case', /^surgical case$/i], ['Other', /$^/],
];
const TYPE_NAMES = VISIT_TYPES.map(t => t[0]);
// "Long Appt 30 Mins (30 min)" -> "Long Appt": the label as the resident would map it.
function typeLabel(raw) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) s = s.replace(/\s*\(\d+\s*min\w*\)\s*$/i, '').replace(/\s+\d+\s*(mins?)?\s*$/i, '').trim();
  return s.slice(0, 60);
}
// The resident's own mappings win over the built-in patterns.
function normalizeType(raw, typeMap) {
  const s = typeLabel(raw);
  const own = (typeMap || []).find(t => t.raw.toLowerCase() === s.toLowerCase());
  if (own && TYPE_NAMES.includes(own.type)) return own.type;
  const hit = VISIT_TYPES.find(([, rx]) => rx.test(s));
  return hit ? hit[0] : 'Other';
}
const TYPE_CATS = { 'Well Child': 'wcc', 'New OB': 'prenatal', 'Established OB': 'prenatal', 'Annual / Preventive': 'preventive', 'Hospital Follow-up': 'hospfu' };

// ---------- procedures ----------
const PROCEDURES = [
  ['Toenail removal', ['toenail', 'toe nail', 'ingrown']],
  ['Punch biopsy', ['punch biopsy', 'punch bx']],
  ['Shave biopsy', ['shave biopsy', 'shave bx']],
  ['Endometrial biopsy', ['endometrial biopsy', 'emb']],
  ['IUD insertion', ['iud insert', 'iud placement']],
  ['IUD removal', ['iud remov']],
  ['Contraceptive implant insertion', ['nexplanon insert', 'implant insert', 'nexplanon placement']],
  ['Contraceptive implant removal', ['nexplanon remov', 'implant remov']],
  ['Joint injection / aspiration', ['joint injection', 'knee injection', 'shoulder injection', 'steroid injection', 'joint aspiration']],
  ['Laceration repair', ['laceration', 'lac repair', 'sutures', 'stitches']],
  ['Incision and drainage', ['i&d', 'i & d', 'abscess', 'incision and drainage']],
  ['Cryotherapy', ['cryo', 'wart freez']],
  ['Skin lesion excision', ['lesion excision', 'cyst removal', 'lipoma']],
  ['Skin tag removal', ['skin tag']],
  ['Colposcopy', ['colpo']],
  ['Newborn circumcision', ['circumcision']],
  ['Vasectomy', ['vasectomy']],
  ['Vaginal delivery', ['vaginal delivery', 'svd', 'nsvd']],
  ['Cesarean delivery (assist)', ['c-section', 'cesarean']],
];
const BUILTIN_PROCS = PROCEDURES.map(p => p[0]);
const PROC_RX = PROCEDURES.map(([name, kws]) => [name, kws.map(kwRegex)]);
function matchProcedures(reason) {
  const t = ' ' + cleanReason(reason);
  return PROC_RX.filter(([, rxs]) => rxs.some(rx => rx.test(t))).map(p => p[0]);
}

// ---------- statuses ----------
const DONE_RX = /^(checked\s*out|finished|patient discharged|discharged|completed|signed off)/i;
// true = counts as seen by default. The resident's status mappings win over the built-in final-status list.
function statusSeen(status, statusMap) {
  const s = String(status || '').trim();
  const own = (statusMap || []).find(x => x.raw.toLowerCase() === s.toLowerCase());
  return own ? own.seen === true : DONE_RX.test(s);
}
const NEW_RX = /\b(np|new patient|new pt|new ob|est(ablish)?\s*care)\b/i;

// ---------- parsers: text -> ParsedPaste ----------
// ParsedPaste = { source, date, dateChoices, expected, sections: [{ kind, site, setting, ownSchedule, slots }] }
// slot = { start (min), minutes, empty: true } | { start, minutes, visit: { displayName, ageText, age, ageMo, sex, typeRaw, status, reason } }

const TIME_RX = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i;
const CERNER_PT_RX = /^(.*\S)\s+(\d+)\s+(Year|Month|Week|Day|Hour)s?,\s*([MFU])\w*$/i;
const CERNER_SECTION_RX = /^(Clinic|Surgery)\s+-\s+(.+)$/i;
const ATHENA_TIME_RX = /^(\d{1,2}):(\d{2})\s*([AP]M)\s+(\d+\s*(?:hrs?|min)\s*(?:\d+\s*min)?)$/i;
const ATHENA_AGE_RX = /^(\d+)\s*(yo|mo|wk|d)\s+([MFU])\b/i;
const ATHENA_JUNK = /^(check in|check out|check-in|check-out|view|reschedule|cancel|go to|view by:?|time)$/i;

function lines(text) { return String(text).replace(/\r/g, '').split('\n').map(s => s.trim()).filter(Boolean); }

function parseCerner(text) {
  const L = lines(text);
  const first = L.findIndex(l => CERNER_SECTION_RX.test(l) || TIME_RX.test(l));
  if (first < 0) return null;
  const pre = L.slice(0, first).join('');
  const dm = /(\d{2})\/(\d{2})\/(\d{4})/.exec(pre.replace(/\s/g, ''));
  const em = /List\s*\((\d+)\)/i.exec(pre);
  const sections = []; let sec = null, cur = null;
  const newSection = (kind, site) => { sec = { kind, site, setting: /surgery/i.test(kind) ? 'surgery' : 'clinic', ownSchedule: !/surgery/i.test(kind), slots: [] }; sections.push(sec); };
  for (let i = first; i < L.length; i++) {
    const l = L[i]; let m;
    if ((m = CERNER_SECTION_RX.exec(l))) { newSection(m[1], m[2].trim()); cur = null; continue; }
    if ((m = TIME_RX.exec(l))) {
      if (!sec) newSection('Clinic', '');
      cur = { start: toMin(m[1], m[2], m[3]), minutes: parseDuration(L[i + 1] || ''), lines: [] };
      sec.slots.push(cur); i++; continue;
    }
    if (cur) cur.lines.push(l);
  }
  for (const s of sections) {
    s.slots = s.slots.map(slot => {
      const ls = slot.lines;
      if (/^no appointments?$/i.test(ls[0] || '')) return { start: slot.start, minutes: slot.minutes, empty: true };
      const pi = ls.findIndex(l => CERNER_PT_RX.test(l));
      if (pi < 0) return null;
      const pm = CERNER_PT_RX.exec(ls[pi]);
      const a = ageFrom(+pm[2], UNITS[pm[3].toLowerCase()]);
      const rest = ls.slice(pi + 1);
      const rfv = rest.findIndex(l => /^rfv$/i.test(l));
      let reason = '';
      if (rfv >= 0) reason = rest.slice(rfv + 1).filter(l => l !== ':').join(' ');
      return { start: slot.start, minutes: slot.minutes, visit: {
        displayName: pm[1], ageText: a.ageText, age: a.age, ageMo: a.ageMo, sex: pm[4].toUpperCase(),
        typeRaw: s.setting === 'surgery' ? 'Surgical Case' : (rest[0] || ''),
        procedureRaw: s.setting === 'surgery' ? (rest[0] || '') : '',
        status: rest[1] || '', reason } };
    }).filter(Boolean);
  }
  const out = sections.filter(s => s.slots.length);
  if (!out.length || !out.some(s => s.slots.some(x => x.visit))) return null;
  return { source: 'cerner', date: dm ? `${dm[3]}-${dm[1]}-${dm[2]}` : null, dateChoices: null, expected: em ? +em[1] : null, sections: out };
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function athenaWeek(L) {
  const m = /week of\s+([a-z]+)\s+(\d{1,2})\s*-\s*(?:([a-z]+)\s+)?(\d{1,2}),\s*(\d{4})/i.exec(L.join(' '));
  if (!m) return null;
  const m1 = MONTHS.indexOf(m[1].toLowerCase()), m2 = m[3] ? MONTHS.indexOf(m[3].toLowerCase()) : m1;
  if (m1 < 0 || m2 < 0) return null;
  const y = +m[5], start = new Date(m2 < m1 ? y - 1 : y, m1, +m[2]);
  return Array.from({ length: 7 }, (_, i) => isoDate(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)));
}
function parseAthena(text) {
  const L = lines(text).filter(l => !ATHENA_JUNK.test(l));
  const ages = L.map((l, i) => (ATHENA_AGE_RX.test(l) ? i : -1)).filter(i => i >= 2);
  if (!ages.length) return null;
  const bySite = new Map();
  ages.forEach((ai, k) => {
    const tm = ATHENA_TIME_RX.exec(L[ai - 2]);
    if (!tm) return;
    const end = k + 1 < ages.length ? ages[k + 1] - 2 : L.length;
    const after = L.slice(ai + 1, end); // schedule, status, [type or reason...], department
    const am = ATHENA_AGE_RX.exec(L[ai]);
    const a = ageFrom(+am[1], UNITS[am[2].toLowerCase()]);
    const site = after.length >= 3 ? after[after.length - 1] : '';
    const middle = after.slice(2, after.length - 1);
    const isType = middle.length === 1 && /^[A-Z0-9 /&-]+\s\d+$/.test(middle[0]);
    const nurse = middle.some(x => /^nurse visit$/i.test(x));
    const visit = {
      displayName: L[ai - 1], ageText: a.ageText, age: a.age, ageMo: a.ageMo, sex: am[3].toUpperCase(),
      typeRaw: nurse ? 'Nurse Visit' : isType ? middle[0] : '', status: after[1] || '', reason: isType || nurse ? '' : middle.join('; '), nurse,
    };
    if (!bySite.has(site)) bySite.set(site, { kind: 'Clinic', site, setting: 'clinic', ownSchedule: false, slots: [] });
    bySite.get(site).slots.push({ start: toMin(tm[1], tm[2], tm[3]), minutes: parseDuration(tm[4]), visit });
  });
  if (!bySite.size) return null;
  return { source: 'athena', date: null, dateChoices: athenaWeek(L), expected: null, sections: [...bySite.values()] };
}

function parseSchedule(text) {
  const L = lines(text);
  if (L.some(l => ATHENA_AGE_RX.test(l) && /\|/.test(l))) return parseAthena(text);
  return parseCerner(text) || parseAthena(text);
}

// JSON day file(s) from someone else's parser (another EMR, a local script, an offline AI).
// Returns one ParsedPaste per date, so a file holding a week becomes a queue of days to review.
function parseDayJson(input) {
  const byDate = new Map();
  for (const d of Array.isArray(input) ? input : [input]) {
    if (!d || typeof d !== 'object') continue;
    const date = typeof d.date === 'string' && ISO_RE.test(d.date) ? d.date : '';
    const sec = daySection(d);
    if (!sec) continue;
    if (!byDate.has(date)) byDate.set(date, { source: 'import', date: date || null, dateChoices: null, expected: null, sections: [] });
    byDate.get(date).sections.push(sec);
  }
  return [...byDate.values()].sort((a, b) => ((a.date || '') < (b.date || '') ? -1 : 1));
}
function daySection(d) {
  {
    const setting = ['clinic', 'surgery', 'other'].includes(d.setting) ? d.setting : 'clinic';
    const slots = [];
    for (const s of Array.isArray(d.emptySlots) ? d.emptySlots : []) {
      if (HM_RE.test(s && s.start) && +s.minutes > 0) slots.push({ start: hmToMin(s.start), minutes: Math.round(+s.minutes), empty: true });
    }
    for (const e of Array.isArray(d.encounters) ? d.encounters : []) {
      if (!e || typeof e !== 'object') continue;
      const a = parseAgeText(e.age);
      if (!a) continue;
      slots.push({ start: HM_RE.test(e.start) ? hmToMin(e.start) : null, minutes: +e.minutes > 0 ? Math.round(+e.minutes) : null, visit: {
        displayName: String(e.displayName || '').slice(0, 80), ageText: a.ageText, age: a.age, ageMo: a.ageMo,
        sex: /^[MF]$/i.test(e.sex) ? e.sex.toUpperCase() : 'U', typeRaw: String(e.visitType || ''), status: String(e.status || ''),
        reason: String(e.reason || ''), procedureRaw: String(e.procedure || ''), seen: e.seen === true ? true : e.seen === false ? false : undefined } });
    }
    return slots.length ? { kind: setting, site: String(d.site || '').slice(0, 80), setting, ownSchedule: d.ownSchedule === true, slots } : null;
  }
}

// ---------- review state: parsed visits -> editable rows with smart defaults ----------
let rowSeq = 0;
function prepareRow(v, sec, settings, source) {
  // athena replaces the visit type with the reason once a visit is checked out; assume established (resident can flip it)
  const type = v.typeRaw ? normalizeType(v.typeRaw, settings.typeMap) : 'Established Patient';
  const m = matchCategories(v.reason, settings);
  const cats = new Set(m.cats);
  if (TYPE_CATS[type]) cats.add(TYPE_CATS[type]);
  if (cats.size > 1) GENERIC.forEach(c => cats.delete(c));
  const vocab = new Set((settings.procVocab || []).map(s => s.toLowerCase()));
  let procs = matchProcedures(v.reason), pendingProc = '';
  if (v.procedureRaw) {
    const name = v.procedureRaw.trim();
    const known = (settings.procVocab || []).find(p => p.toLowerCase() === name.toLowerCase());
    if (known) procs = [known]; else pendingProc = name;
  }
  procs = procs.filter(p => vocab.has(p.toLowerCase()) || BUILTIN_PROCS.includes(p));
  const done = statusSeen(v.status, settings.statusMap);
  const nurse = !!v.nurse || type === 'Nurse Visit';
  let include;
  if (v.seen !== undefined) include = v.seen;
  else if (source === 'athena' || sec.setting === 'surgery') include = false;
  else include = done && !nurse;
  return {
    key: ++rowSeq, start: v.start, minutes: v.minutes, displayName: v.displayName, ageText: v.ageText,
    age: v.age, ageMo: v.ageMo, sex: v.sex, type, typeRaw: typeLabel(v.typeRaw), status: v.status || '', reason: v.reason || '',
    logged: false,
    isNew: /^New/.test(type) || NEW_RX.test(cleanReason(v.reason)), ob: /OB$/.test(type),
    cats: [...cats], unmatched: m.unmatched, procs, pendingProc,
    continuity: 'covering', interpreter: INTERP_RX.test(v.reason || ''),
    role: sec.setting === 'surgery' ? 'assisted' : null, include, nurse,
  };
}
function blankRow(setting, type) {
  return { key: ++rowSeq, start: null, minutes: null, displayName: '', ageText: '', age: null, ageMo: null, sex: 'U',
    type: setting === 'surgery' ? 'Surgical Case' : type || 'Established Patient', typeRaw: '', status: '', reason: '', isNew: false, ob: false, logged: false,
    cats: [], unmatched: [], procs: [], pendingProc: '', continuity: 'covering', interpreter: false,
    role: setting === 'surgery' ? 'assisted' : null, include: true, nurse: false };
}
// After the user adds a keyword: add newly matched categories, never remove ones they chose.
function rematch(row, settings) {
  const m = matchCategories(row.reason, settings);
  row.cats = [...new Set(row.cats.concat(m.cats))];
  if (row.cats.some(c => !GENERIC.has(c))) row.cats = row.cats.filter(c => !GENERIC.has(c));
  row.unmatched = m.unmatched;
}

function defaultArea(sec, source, settings) {
  const known = settings.sites && settings.sites[sec.site];
  if (known && AREA_IDS.includes(known.area)) return known.area;
  if (source === 'athena') return 'volunteer';
  if (sec.setting === 'surgery') return 'surgery';
  if (sec.setting === 'clinic' && source === 'cerner') return 'fmp';
  return 'elective';
}

function prepareReview(parsed, settings, today) {
  const date = parsed.date || (parsed.dateChoices ? (parsed.dateChoices.includes(today) ? today : '') : today);
  return {
    source: parsed.source, date, dateChoices: parsed.dateChoices, expected: parsed.expected,
    sections: parsed.sections.map(sec => {
      const area = defaultArea(sec, parsed.source, settings);
      const known = settings.sites && settings.sites[sec.site];
      return {
        site: sec.site, setting: sec.setting, ownSchedule: sec.ownSchedule, area,
        hours: known && known.lastHours != null && !sec.ownSchedule ? known.lastHours : null, otherCount: 0,
        empties: sec.slots.filter(s => s.empty).map(s => ({ start: s.start, minutes: s.minutes })),
        rows: sec.slots.filter(s => s.visit).map(s => prepareRow(Object.assign({ start: s.start, minutes: s.minutes }, s.visit), sec, settings, parsed.source)),
      };
    }),
  };
}
// Manual entry, optionally at a known site: its usual area, visit type and hours come along.
function manualReview(today, settings, site) {
  const k = site && settings.sites && settings.sites[site];
  return { source: 'manual', date: today, dateChoices: null, expected: null,
    sections: [{ site: site || '', setting: 'clinic', ownSchedule: false, area: k ? k.area : 'elective', siteType: k ? k.type : null,
      hours: k && k.lastHours != null ? k.lastHours : null, otherCount: 0, empties: [], rows: [blankRow('clinic', k && k.type)] }] };
}

// ---------- interval math for unused clinic time ----------
function union(ivs) {
  const s = ivs.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]), out = [];
  for (const [a, b] of s) { if (out.length && a <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b); else out.push([a, b]); }
  return out;
}
function subtract(ivs, cut) {
  let out = union(ivs);
  for (const [c0, c1] of union(cut)) out = out.flatMap(([a, b]) => (b <= c0 || a >= c1 ? [[a, b]] : [[a, Math.min(b, c0)], [Math.max(a, c1), b]].filter(([x, y]) => y > x)));
  return out;
}
const total = ivs => ivs.reduce((n, [a, b]) => n + b - a, 0);

// Day-level numbers for an own-schedule clinic: scheduled, empty and no-show minutes, with lunch removed.
function scheduleNumbers(sec, lunch) {
  const iv = s => (s.start == null || !s.minutes ? null : [s.start, s.start + s.minutes]);
  const lunchIv = lunch && HM_RE.test(lunch.start) && HM_RE.test(lunch.end) ? [[hmToMin(lunch.start), hmToMin(lunch.end)]] : [];
  const seen = union(sec.rows.filter(r => r.include).map(iv).filter(Boolean));
  const missed = sec.rows.filter(r => !r.include && !r.nurse);
  const all = subtract(sec.rows.map(iv).concat(sec.empties.map(iv)).filter(Boolean), lunchIv);
  const empty = subtract(sec.empties.map(iv).filter(Boolean), lunchIv.concat(seen));
  const noShow = subtract(missed.map(iv).filter(Boolean), lunchIv.concat(seen, empty));
  return { scheduledMin: total(all), emptyMin: total(empty), noShows: missed.length, noShowMin: total(noShow),
    emptySlots: empty.map(([a, b]) => ({ start: hhmm(a), min: b - a })) };
}

// ---------- THE PRIVACY GATE ----------
// The only path to storage. Builds records from allowlisted fields; everything else (names, reasons, MRNs,
// DOBs, notes, anything an importer adds) is dropped here. Encounter records never carry a date.
function pgyFor(ay, startAY) { return Number.isInteger(startAY) ? clamp(ay - startAY + 1, 1, 9) : null; }
const str = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);

function cleanEncounter(e, settings) {
  if (!e || typeof e !== 'object') return null;
  let age = e.age === '90+' ? '90+' : Number.isFinite(+e.age) && e.age !== null && e.age !== '' ? Math.floor(+e.age) : null;
  if (age === null || age < 0) return null;
  if (age !== '90+' && age >= 90) age = '90+';
  const v = new Set(((settings && settings.procVocab) || []).map(p => p.toLowerCase()).concat(BUILTIN_PROCS.map(p => p.toLowerCase())));
  const validCats = catIdSet(settings);
  return {
    ay: Number.isInteger(e.ay) ? e.ay : null, pgy: Number.isInteger(e.pgy) ? e.pgy : null,
    site: str(e.site, 80), setting: ['clinic', 'surgery', 'other'].includes(e.setting) ? e.setting : 'other',
    area: AREA_IDS.includes(e.area) ? e.area : 'elective',
    age, ageMo: age !== '90+' && age < 2 && Number.isFinite(+e.ageMo) && e.ageMo !== null ? clamp(Math.floor(+e.ageMo), 0, 23) : null,
    sex: ['F', 'M', 'U'].includes(e.sex) ? e.sex : 'U',
    type: TYPE_NAMES.includes(e.type) ? e.type : 'Other',
    isNew: e.isNew === true, ob: e.ob === true, interpreter: e.interpreter === true,
    continuity: e.continuity === 'mine' ? 'mine' : 'covering',
    cats: [...new Set(Array.isArray(e.cats) ? e.cats.filter(c => validCats.has(c)) : [])],
    procs: [...new Set(Array.isArray(e.procs) ? e.procs.filter(p => typeof p === 'string' && v.has(p.toLowerCase())).map(p => str(p, 80)) : [])],
    role: ['observed', 'assisted', 'primary'].includes(e.role) ? e.role : null,
  };
}
function cleanDay(d) {
  if (!d || typeof d !== 'object' || !ISO_RE.test(d.date)) return null;
  const int = x => (Number.isFinite(+x) && x !== null && x !== '' ? Math.max(0, Math.round(+x)) : null);
  return {
    date: d.date, ay: academicYear(d.date), pgy: Number.isInteger(d.pgy) ? d.pgy : null,
    site: str(d.site, 80), setting: ['clinic', 'surgery', 'other'].includes(d.setting) ? d.setting : 'other',
    area: AREA_IDS.includes(d.area) ? d.area : 'elective',
    source: ['cerner', 'athena', 'import', 'manual'].includes(d.source) ? d.source : 'manual',
    seen: int(d.seen) || 0, newCount: int(d.newCount) || 0, obCount: int(d.obCount) || 0, otherCount: int(d.otherCount) || 0,
    mineCount: int(d.mineCount), // null on days saved before this was counted
    hours: Number.isFinite(+d.hours) && d.hours !== null && d.hours !== '' ? clamp(Math.round(+d.hours * 4) / 4, 0, 36) : null,
    tracked: d.tracked === true,
    scheduledMin: d.tracked === true ? int(d.scheduledMin) : null, emptyMin: d.tracked === true ? int(d.emptyMin) : null,
    noShows: d.tracked === true ? int(d.noShows) : null, noShowMin: d.tracked === true ? int(d.noShowMin) : null,
    emptySlots: d.tracked === true && Array.isArray(d.emptySlots) ? d.emptySlots.filter(s => s && HM_RE.test(s.start) && int(s.min) > 0).map(s => ({ start: s.start, min: int(s.min) })) : [],
  };
}

// One review row -> a stored encounter (or null if it has no age).
function toEncounter(r, review, sec, settings) {
  const ay = academicYear(review.date);
  return cleanEncounter(Object.assign({}, r, { ay, pgy: pgyFor(ay, settings.residencyStartAY), site: sec.site, setting: sec.setting, area: sec.area }), settings);
}

// Review state -> records ready for storage (or { error }).
// Rows marked `logged` (already saved on an earlier paste of the same day) count as seen for the day's numbers
// but aren't saved again.
function sanitize(review, settings) {
  if (!ISO_RE.test(review.date || '')) return { error: 'Pick the date for this schedule.' };
  const ay = academicYear(review.date), pgy = pgyFor(ay, settings.residencyStartAY);
  const days = [], encounters = [];
  for (const sec of review.sections) {
    const rows = sec.rows.filter(r => r.include);
    if (!str(sec.site, 80)) return { error: 'Every section needs a site name.' };
    if (!rows.length && !sec.otherCount && sec.hours == null && !(sec.ownSchedule && sec.setting === 'clinic')) continue;
    for (const r of rows) {
      const e = toEncounter(r, review, sec, settings);
      if (!e) return { error: 'One of the ticked rows has no age. Add it, or untick the row.' };
      if (!r.logged) encounters.push(e);
    }
    const tracked = sec.ownSchedule && sec.setting === 'clinic';
    const nums = tracked ? scheduleNumbers(sec, settings.lunch) : {};
    let hours = sec.hours;
    if (hours == null && tracked) hours = Math.round(nums.scheduledMin / 15) / 4;
    days.push(cleanDay(Object.assign({ date: review.date, pgy, site: sec.site, setting: sec.setting, area: sec.area, source: review.source,
      seen: rows.length, newCount: rows.filter(r => r.isNew).length, obCount: rows.filter(r => r.ob).length,
      mineCount: rows.filter(r => r.continuity === 'mine').length, otherCount: sec.otherCount, hours, tracked }, nums)));
  }
  if (!days.length) return { error: 'Nothing to save: tick at least one visit, or enter hours.' };
  return { days, encounters };
}

// Saved encounters carry no date or link to their day, so a re-pasted row is matched by content.
// Identical saved visits can't be told apart, so removing any one of them leaves the same record.
const encKey = e => JSON.stringify([e.ay, e.pgy, e.site, e.setting, e.area, e.age, e.ageMo, e.sex, e.type, e.isNew, e.ob, e.interpreter,
  e.continuity, e.cats.slice().sort(), e.procs.slice().sort(), e.role]);
function matchSaved(wanted, stored) { // -> { ids, matched: [bool per wanted] }
  const pool = new Map();
  for (const s of stored) { const k = encKey(s); (pool.get(k) || pool.set(k, []).get(k)).push(s.id); }
  const ids = [], matched = wanted.map(w => { const list = w && pool.get(encKey(w)); if (list && list.length) { ids.push(list.pop()); return true; } return false; });
  return { ids, matched };
}

// Backup restore goes through the same gate.
function sanitizeBackup(obj) {
  if (!obj || !['vihsit', 'log-your-visits'].includes(obj.app)) return { error: 'That file is not a vihsit backup.' };
  const s = obj.settings || {};
  const settings = cleanSettings(s);
  return {
    days: (obj.days || []).map(cleanDay).filter(Boolean),
    encounters: (obj.encounters || []).map(e => cleanEncounter(e, settings)).filter(Boolean),
    settings,
  };
}

// ---------- settings ----------
const DEFAULT_SETTINGS = {
  residencyStartAY: null, lunch: { start: '11:15', end: '13:00' }, sites: {}, keywords: [], procVocab: BUILTIN_PROCS.slice(),
  targets: {}, programReqs: [], checklistDone: false,
  profile: { name: '', program: '' }, customCats: [], catLabels: {}, typeMap: [], statusMap: [], reportSections: null,
  continuityReminder: true,
};
function cleanSettings(s) {
  s = s || {};
  const out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (Number.isInteger(s.residencyStartAY)) out.residencyStartAY = s.residencyStartAY;
  if (s.profile) out.profile = { name: str(s.profile.name, 80), program: str(s.profile.program, 120) };
  const seenIds = new Set();
  out.customCats = (Array.isArray(s.customCats) ? s.customCats : []).filter(c => c && /^c-[a-z0-9]{4,12}$/.test(c.id) && str(c.label, 60) && !seenIds.has(c.id) && seenIds.add(c.id))
    .map(c => ({ id: c.id, label: str(c.label, 60) }));
  for (const [id, label] of Object.entries(s.catLabels || {})) if (CAT_IDS.includes(id) && str(label, 60)) out.catLabels[id] = str(label, 60);
  out.typeMap = (Array.isArray(s.typeMap) ? s.typeMap : []).filter(t => t && str(t.raw, 60) && TYPE_NAMES.includes(t.type)).map(t => ({ raw: str(t.raw, 60), type: t.type }));
  out.statusMap = (Array.isArray(s.statusMap) ? s.statusMap : []).filter(t => t && str(t.raw, 60)).map(t => ({ raw: str(t.raw, 60), seen: t.seen === true }));
  if (Array.isArray(s.reportSections)) out.reportSections = s.reportSections.filter(x => SECTION_IDS.includes(x));
  if (s.lunch && HM_RE.test(s.lunch.start) && HM_RE.test(s.lunch.end)) out.lunch = { start: s.lunch.start, end: s.lunch.end };
  for (const [name, v] of Object.entries(s.sites || {})) {
    const n = str(name, 80); if (!n || !v) continue;
    out.sites[n] = { area: AREA_IDS.includes(v.area) ? v.area : 'elective', lastHours: Number.isFinite(+v.lastHours) && v.lastHours !== null ? +v.lastHours : null,
      type: TYPE_NAMES.includes(v.type) ? v.type : null }; // usual visit type, e.g. Nursing Home for a facility logged by hand
  }
  const validCats = catIdSet(out);
  out.keywords = (s.keywords || []).filter(k => k && validCats.has(k.cat) && str(k.kw, 40)).map(k => ({ kw: str(k.kw, 40).toLowerCase(), cat: k.cat }));
  if (Array.isArray(s.procVocab)) out.procVocab = [...new Set(BUILTIN_PROCS.concat(s.procVocab.map(p => str(p, 80)).filter(Boolean)))];
  for (const [id, v] of Object.entries(s.targets || {})) if (REQ_IDS.includes(id) && Number.isFinite(+v) && v !== null) out.targets[id] = +v;
  out.programReqs = (Array.isArray(s.programReqs) ? s.programReqs : []).map(r => cleanProgramReq(r, validCats)).filter(Boolean);
  out.checklistDone = s.checklistDone === true;
  out.continuityReminder = s.continuityReminder !== false;
  return out;
}

// Program-specific requirements: the second set of metrics, built from the same filters the stats use.
// kind 'encounters' counts visits matching every filter given; 'hours' sums day hours; 'pct' = matching / all encounters in area.
function cleanProgramReq(r, validCats) {
  if (!r || typeof r !== 'object' || !str(r.label, 120) || !Number.isFinite(+r.target) || r.target === null) return null;
  const int = x => (x === '' || x == null || !Number.isFinite(+x) ? null : Math.floor(+x));
  return {
    id: str(r.id, 40) || 'p' + Math.random().toString(36).slice(2, 9), label: str(r.label, 120), target: +r.target,
    kind: ['encounters', 'hours', 'pct'].includes(r.kind) ? r.kind : 'encounters',
    area: AREA_IDS.includes(r.area) ? r.area : '', ageMin: int(r.ageMin), ageMax: int(r.ageMax),
    cat: (validCats || new Set(CAT_IDS)).has(r.cat) ? r.cat : '', type: TYPE_NAMES.includes(r.type) ? r.type : '',
    proc: typeof r.proc === 'string' ? str(r.proc, 80) : '', mineOnly: r.mineOnly === true, newOnly: r.newOnly === true,
    perYear: r.perYear === true, note: str(r.note, 200),
  };
}
function encounterFilter(r) {
  return e => (!r.area || e.area === r.area) && (r.ageMin == null || ageYears(e) >= r.ageMin) && (r.ageMax == null || ageYears(e) <= r.ageMax)
    && (!r.cat || e.cats.includes(r.cat)) && (!r.type || e.type === r.type) && (!r.proc || e.procs.includes(r.proc))
    && (!r.mineOnly || e.continuity === 'mine') && (!r.newOnly || e.isNew);
}
function evalProgramReq(r, D, E) {
  if (r.kind === 'hours') return D.filter(d => !r.area || d.area === r.area).reduce((n, d) => n + (d.hours || 0), 0);
  const hit = E.filter(encounterFilter(r)).length;
  if (r.kind === 'pct') { const base = E.filter(e => !r.area || e.area === r.area).length; return base ? Math.round((hit / base) * 1000) / 10 : null; }
  return hit;
}

// ---------- ACGME Family Medicine requirements (2026 program requirements, IDs 4.11.x) ----------
// Targets are editable in Settings because programs add their own and ACGME revises.
// `measure` says how well the app can know it from logs: 'direct', 'proxy' or 'logged' (resident logs that rotation).
const REQUIREMENTS = [
  { id: 'fmp-hours', label: 'FMP patient-care hours', target: 1000, unit: 'h', ref: '4.11.c.5.c', measure: 'direct',
    note: 'Scheduled in-person or telehealth time in your own FMP, by graduation. Estimated from your clinic sessions. Lunch excluded.' },
  { id: 'fmp-weeks', label: 'Weeks in FMP this academic year', target: 40, unit: 'wk', ref: '4.11.c.1', measure: 'direct', perYear: true,
    note: 'ACGME says "should": at least 40 weeks every year.' },
  { id: 'continuity', label: 'Continuity (your side)', target: 40, unit: '%', ref: '4.11.c.5.d–e', measure: 'direct',
    note: 'Share of your FMP visits that are with your own patients. At least 30% by the end of PGY-2 and 40% by the end of PGY-3.' },
  { id: 'panel-peds', label: 'Your patients under 18', target: 10, unit: '%', ref: '4.11.c.5.f', measure: 'proxy',
    note: 'The real rule is about your panel, at least 10%. This uses your own-patient visits as a stand-in.' },
  { id: 'panel-older', label: 'Your patients over 65', target: 10, unit: '%', ref: '4.11.c.5.g', measure: 'proxy',
    note: 'The real rule is about your panel, at least 10%. This uses your own-patient visits as a stand-in.' },
  { id: 'ltc-months', label: 'Long-term care: months with nursing-home days', target: 24, unit: 'mo', ref: '4.11.c.5.a', measure: 'proxy',
    note: 'Care for long-term-care patients over at least 24 months. Counts months with a day logged at a site whose usual visit type is Nursing Home (Settings › Sites).' },
  { id: 'fmp-visits', label: 'FMP visits (goal, not required)', target: 1650, unit: '', ref: 'FAQ', measure: 'direct',
    note: 'No longer required since 2023. ACGME calls 1,650 a "reasonable goal".' },
  { id: 'peds-out-hours', label: 'Outpatient pediatrics hours', target: 200, unit: 'h', ref: '4.11.f', measure: 'logged', note: 'Or 2 months. FMP hours do not count here.' },
  { id: 'peds-acute-hours', label: 'Acutely ill children: hours', target: 100, unit: 'h', ref: '4.11.g', measure: 'logged', note: 'Hospital and/or ED. Or 1 month.' },
  { id: 'peds-inpt-enc', label: 'Inpatient children: encounters', target: 50, unit: '', ref: '4.11.g.1', measure: 'logged', note: 'ACGME says "should".' },
  { id: 'peds-ed-enc', label: 'ED children: encounters', target: 50, unit: '', ref: '4.11.g.2', measure: 'logged', note: 'ACGME says "should". Urgent care alone does not count.' },
  { id: 'gyn-hours', label: 'Gynecology hours', target: 100, unit: 'h', ref: '4.11.h', measure: 'logged', note: 'Or 1 month.' },
  { id: 'ob-hours', label: 'Pregnancy care hours', target: 200, unit: 'h', ref: '4.11.i', measure: 'logged', note: 'Or 2 months.' },
  { id: 'deliveries', label: 'Vaginal deliveries', target: 20, unit: '', ref: '4.11.i.1.b', measure: 'logged', note: 'Log each as the procedure "Vaginal delivery". The optional full obstetrics track needs 80.' },
  { id: 'inpt-hours', label: 'Inpatient adult hours', target: 600, unit: 'h', ref: '4.11.j', measure: 'logged', note: 'Including ICU. Or 6 months.' },
  { id: 'inpt-enc', label: 'Inpatient adult encounters', target: 750, unit: '', ref: '4.11.j', measure: 'logged', note: '' },
  { id: 'ed-hours', label: 'Emergency adult hours', target: 100, unit: 'h', ref: '4.11.k', measure: 'logged', note: '' },
  { id: 'ed-enc', label: 'Emergency adult encounters', target: 125, unit: '', ref: '4.11.k', measure: 'logged', note: '' },
  { id: 'geri-hours', label: 'Older adult care hours', target: 100, unit: 'h', ref: '4.11.l', measure: 'logged', note: 'Or 1 month. FMP hours do not count here.' },
  { id: 'geri-enc', label: 'Older adults (over 65), non-FMP encounters', target: 125, unit: '', ref: '4.11.l', measure: 'logged', note: 'Nursing home, home visit, hospital or ED. Age over 65.' },
];
const REQ_IDS = REQUIREMENTS.map(r => r.id);

// ---------- stats ----------
const AGE_BINS = [['<1 mo', e => e.ageMo === 0], ['1–11 mo', e => e.age === 0 && e.ageMo > 0], ['1–4', e => ageYears(e) >= 1 && ageYears(e) <= 4],
  ['5–12', e => ageYears(e) >= 5 && ageYears(e) <= 12], ['13–17', e => ageYears(e) >= 13 && ageYears(e) <= 17], ['18–39', e => ageYears(e) >= 18 && ageYears(e) <= 39],
  ['40–64', e => ageYears(e) >= 40 && ageYears(e) <= 64], ['65–89', e => ageYears(e) >= 65 && ageYears(e) <= 89], ['90+', e => e.age === '90+']];
const AGE_GROUPS = [['Under 5', a => a < 5], ['5–17', a => a >= 5 && a < 18], ['18–39', a => a >= 18 && a < 40], ['40–64', a => a >= 40 && a < 65], ['65+', a => a >= 65]];

// Record and report sections, in display order. The CCC preset is the pre-built report.
const SECTIONS = [['summary', 'Summary'], ['acgme', 'ACGME requirements'], ['program', 'Program requirements'], ['pace', 'Pace toward graduation targets'],
  ['trends', 'Trends by month'], ['months', 'Encounters by month'], ['agesex', 'Age and sex'], ['reasons', 'Reasons for visit'], ['types', 'Visit types'],
  ['sites', 'Sites'], ['breakdowns', 'Breakdowns'], ['empty', 'Empty clinic time'], ['procedures', 'Procedure log'], ['areas', 'Hours and encounters by area']];
const SECTION_IDS = SECTIONS.map(s => s[0]);
const CCC_SECTIONS = ['summary', 'acgme', 'program', 'pace', 'agesex', 'reasons', 'procedures', 'areas'];

const sumBy = (xs, f) => xs.reduce((n, x) => n + (f(x) || 0), 0);
const pctOf = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);

function requirementValues(D, E, days, curAY, settings) {
  const nhSite = site => !!(settings.sites && settings.sites[site] && settings.sites[site].type === 'Nursing Home');
  const hoursIn = area => sumBy(D.filter(d => d.area === area), d => d.hours);
  const encIn = (area, f) => E.filter(e => e.area === area && (!f || f(e))).length + (f ? 0 : sumBy(D.filter(d => d.area === area), d => d.otherCount));
  const fmpE = E.filter(e => e.area === 'fmp'), mine = fmpE.filter(e => e.continuity === 'mine');
  const weeks = new Set(days.filter(d => d.area === 'fmp' && d.ay === curAY).map(d => isoWeek(d.date)));
  const over65 = e => ageYears(e) > 65;
  return {
    'fmp-hours': sumBy(D.filter(d => d.area === 'fmp'), d => d.hours), 'fmp-weeks': weeks.size,
    continuity: pctOf(mine.length, fmpE.length), 'panel-peds': pctOf(mine.filter(e => ageYears(e) < 18).length, mine.length),
    'panel-older': pctOf(mine.filter(over65).length, mine.length), 'fmp-visits': encIn('fmp'),
    'peds-out-hours': hoursIn('peds-out'), 'peds-acute-hours': hoursIn('peds-inpt') + hoursIn('ed-peds'),
    'peds-inpt-enc': encIn('peds-inpt'), 'peds-ed-enc': encIn('ed-peds') + encIn('ed', e => ageYears(e) < 18),
    'gyn-hours': hoursIn('gyn'), 'ob-hours': hoursIn('ob'),
    deliveries: E.filter(e => e.procs.includes('Vaginal delivery')).length,
    'inpt-hours': hoursIn('inpt-adult'), 'inpt-enc': encIn('inpt-adult'),
    'ed-hours': hoursIn('ed'), 'ed-enc': encIn('ed', e => ageYears(e) >= 18) + sumBy(D.filter(d => d.area === 'ed'), d => d.otherCount),
    'geri-hours': hoursIn('geri'), 'geri-enc': E.filter(e => e.area !== 'fmp' && over65(e)).length,
    'ltc-months': new Set(D.filter(d => nhSite(d.site)).map(d => d.date.slice(0, 7))).size,
  };
}

// filter: { ay, site, area, mine } (or a bare academic year, or null). Requirements follow the period only:
// a requirement is about the whole record, so narrowing it to one site would misstate it.
function computeStats(days, encounters, settings, filter) {
  const f = filter != null && typeof filter === 'object' ? filter : { ay: filter == null ? null : filter };
  const ay = f.ay == null ? null : f.ay;
  const inPeriod = x => ay == null || x.ay === ay;
  const RD = days.filter(inPeriod), RE = encounters.filter(inPeriod);
  const D = RD.filter(d => (!f.site || d.site === f.site) && (!f.area || d.area === f.area));
  const E = RE.filter(e => (!f.site || e.site === f.site) && (!f.area || e.area === f.area) && (!f.mine || e.continuity === 'mine'));
  const curAY = ay != null ? ay : Math.max(-Infinity, ...days.map(d => d.ay));
  const label = id => catLabelOf(settings, id);

  const values = requirementValues(RD, RE, days, curAY, settings);
  const requirements = REQUIREMENTS.map(r => {
    const target = settings.targets && Number.isFinite(settings.targets[r.id]) ? settings.targets[r.id] : r.target;
    const value = values[r.id];
    return Object.assign({}, r, { target, value, progress: value == null || !target ? 0 : Math.min(1, value / target) });
  });
  const program = (settings.programReqs || []).map(r => {
    const scoped = r.perYear && ay == null; // per-year targets are judged on the latest academic year
    const value = evalProgramReq(r, scoped ? days.filter(d => d.ay === curAY) : RD, scoped ? encounters.filter(e => e.ay === curAY) : RE);
    return Object.assign({}, r, { unit: r.kind === 'hours' ? 'h' : r.kind === 'pct' ? '%' : '', value, progress: value == null || !r.target ? 0 : Math.min(1, value / r.target) });
  });

  const count = (xs, key) => { const m = new Map(); for (const x of xs) for (const k of [].concat(key(x))) m.set(k, (m.get(k) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
  const tracked = D.filter(d => d.tracked && d.scheduledMin);
  const fmpDays = D.filter(d => d.area === 'fmp'), fmpE = E.filter(e => e.area === 'fmp');

  // monthly trends come from day records, the only records with dates
  const byMonth = new Map();
  for (const d of D) {
    const k = d.date.slice(0, 7);
    const m = byMonth.get(k) || { visits: 0, days: 0, fDays: 0, fSeen: 0, fNew: 0, mine: 0, mineBase: 0, sched: 0, unused: 0 };
    m.visits += d.seen + d.otherCount; m.days++;
    if (d.area === 'fmp') { m.fDays++; m.fSeen += d.seen; m.fNew += d.newCount; if (d.mineCount != null) { m.mine += d.mineCount; m.mineBase += d.seen; } }
    if (d.tracked && d.scheduledMin) { m.sched += d.scheduledMin; m.unused += d.emptyMin + d.noShowMin; }
    byMonth.set(k, m);
  }
  const months = [...byMonth].sort().map(([k, m]) => ({ label: k, value: m.visits, days: m.days,
    perDay: m.fDays ? Math.round((m.fSeen / m.fDays) * 10) / 10 : null, newPct: pctOf(m.fNew, m.fSeen),
    contPct: pctOf(m.mine, m.mineBase), unusedPct: pctOf(m.unused, m.sched) }));

  // cumulative FMP hours and visits against an even pace to the graduation targets (whole residency, 36 months)
  let pace = null;
  if (Number.isInteger(settings.residencyStartAY) && days.length) {
    const tgt = id => (settings.targets && Number.isFinite(settings.targets[id]) ? settings.targets[id] : REQUIREMENTS.find(r => r.id === id).target);
    const start = settings.residencyStartAY, lastMonth = days.map(d => d.date.slice(0, 7)).sort().pop();
    const pm = [];
    for (let i = 0; i < 36; i++) { const y = start + Math.floor((6 + i) / 12), mo = ((6 + i) % 12) + 1, k = y + '-' + pad(mo); pm.push(k); if (k >= lastMonth) break; }
    let h = 0, v = 0;
    const fmp = days.filter(d => d.area === 'fmp');
    pace = { months: pm, hoursTarget: tgt('fmp-hours'), visitsTarget: tgt('fmp-visits'), hours: [], visits: [], hoursPace: [], visitsPace: [] };
    pm.forEach((k, i) => {
      for (const d of fmp) if (d.date.slice(0, 7) === k) { h += d.hours || 0; v += d.seen + d.otherCount; }
      pace.hours.push(Math.round(h * 4) / 4); pace.visits.push(v);
      pace.hoursPace.push(Math.round((pace.hoursTarget * (i + 1)) / 36)); pace.visitsPace.push(Math.round((pace.visitsTarget * (i + 1)) / 36));
    });
  }

  const heat = Array.from({ length: 5 }, () => new Array(20).fill(0)); // Mon–Fri x 30-min bins from 07:00
  const heatDays = Array.from({ length: 5 }, () => new Set());
  for (const d of tracked) {
    const wd = weekday(d.date) - 1; if (wd < 0 || wd > 4) continue;
    heatDays[wd].add(d.date);
    for (const s of d.emptySlots) for (let t = hmToMin(s.start); t < hmToMin(s.start) + s.min; t++) { const b = Math.floor((t - 420) / 30); if (b >= 0 && b < 20) heat[wd][b] += 1; }
  }

  const cats = count(E, e => e.cats).map(([id, n]) => ({ id, label: label(id), value: n }));
  const uncategorized = E.filter(e => !e.cats.length).length;
  const topCats = cats.slice(0, 12);
  const topSites = count(E, e => e.site || '(no site)').slice(0, 6).map(x => x[0]);
  return {
    totals: {
      encounters: E.length + sumBy(D, d => d.otherCount), days: D.length, clinicDays: fmpDays.length,
      perClinicDay: fmpDays.length ? Math.round((sumBy(fmpDays, d => d.seen) / fmpDays.length) * 10) / 10 : null,
      continuity: pctOf(fmpE.filter(e => e.continuity === 'mine').length, fmpE.length), newPct: pctOf(fmpE.filter(e => e.isNew).length, fmpE.length),
      unusedPct: pctOf(sumBy(tracked, d => d.emptyMin + d.noShowMin), sumBy(tracked, d => d.scheduledMin)), noShows: sumBy(tracked, d => d.noShows),
      emptyHours: Math.round(sumBy(tracked, d => d.emptyMin) / 6) / 10, volunteerHours: sumBy(D.filter(d => d.area === 'volunteer'), d => d.hours),
      procedures: sumBy(E, e => e.procs.length), interpreter: pctOf(E.filter(e => e.interpreter).length, E.length),
    },
    requirements, program, months, pace,
    pyramid: AGE_BINS.map(([lbl, fn]) => ({ label: lbl, F: E.filter(e => e.sex === 'F' && fn(e)).length, M: E.filter(e => e.sex === 'M' && fn(e)).length, U: E.filter(e => e.sex === 'U' && fn(e)).length })),
    categories: uncategorized ? cats.concat([{ id: '', label: 'Uncategorized', value: uncategorized, muted: true }]) : cats,
    types: count(E, e => e.type).map(([lbl, n]) => ({ label: lbl, value: n })),
    sites: count(E, e => e.site || '(no site)').map(([lbl, n]) => ({ label: lbl, value: n })),
    reasonsByAge: { cols: AGE_GROUPS.map(g => g[0]), rows: topCats.map(c => ({ label: c.label, values: AGE_GROUPS.map(([, fn]) => E.filter(e => e.cats.includes(c.id) && fn(ageYears(e))).length) })) },
    typesBySite: { cols: topSites, rows: count(E, e => e.type).map(([t]) => ({ label: t, values: topSites.map(s => E.filter(e => e.type === t && (e.site || '(no site)') === s).length) })) },
    sexByCat: topCats.map(c => ({ label: c.label, F: E.filter(e => e.cats.includes(c.id) && e.sex === 'F').length, M: E.filter(e => e.cats.includes(c.id) && e.sex === 'M').length })),
    procedures: count(E, e => e.procs).map(([lbl, n]) => ({ label: lbl, value: n, roles: count(E.filter(e => e.procs.includes(lbl) && e.role), e => e.role) })),
    heat: heat.map((row, i) => row.map(min => (heatDays[i].size ? min / heatDays[i].size : 0))), heatDays: heatDays.map(s => s.size),
    areas: AREAS.map(([id, lbl]) => ({ id, label: lbl, hours: sumBy(D.filter(d => d.area === id), d => d.hours), encounters: E.filter(e => e.area === id).length + sumBy(D.filter(d => d.area === id), d => d.otherCount), days: D.filter(d => d.area === id).length })).filter(a => a.days),
    years: [...new Set(days.map(d => d.ay))].sort(), siteList: [...new Set(days.map(d => d.site))].sort(),
  };
}

const Core = {
  pad, hhmm, isoDate, academicYear, weekday, isoWeek, parseDuration, ageFrom, parseAgeText,
  AREAS, AREA_IDS, CATEGORIES, CAT_IDS, CAT_LABEL, TYPE_NAMES, BUILTIN_PROCS, REQUIREMENTS, DEFAULT_SETTINGS, SECTIONS, SECTION_IDS, CCC_SECTIONS,
  cleanReason, matchCategories, matchProcedures, normalizeType, typeLabel, statusSeen, catOptions, catLabelOf, INTERP_RX,
  parseCerner, parseAthena, parseSchedule, parseDayJson, prepareReview, manualReview, blankRow, rematch,
  union, subtract, scheduleNumbers, cleanEncounter, cleanDay, toEncounter, matchSaved, sanitize, sanitizeBackup, cleanSettings, cleanProgramReq, evalProgramReq, pgyFor, computeStats,
};
if (typeof module !== 'undefined' && module.exports) module.exports = Core; else root.Core = Core;
})(this);
