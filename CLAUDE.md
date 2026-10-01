# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**vihsit** (the misspelling is intentional; repo `robbie-med/vihsit`, public, MIT) is a free web app that lets medical residents log their clinic experience. A resident pastes their day's schedule from the EMR. The app parses it on their own device, throws away identifiers, and keeps de-identified stats: visits per day, chief complaint categories, age and sex distribution, new vs. established vs. OB visits, own patient vs. covering, and site (main clinic or a satellite such as Catholic Charities). It is used either from a hosted URL or as a downloaded single HTML file.

## Commands

- `node --test` runs the parser, privacy-gate and stats tests. No dependencies.
- `node build.mjs` writes `dist/vihsit.html`, the file users download (and that GitHub Pages serves). Rebuild after every change to `src/` and commit `dist/` with it. CI fails if `dist/` is stale. Never edit `dist/` by hand: the build inlines the fonts and computes the CSP's script and style hashes, after normalizing line endings to LF.
- The IndexedDB name stays `log-your-visits` (the app's old name), so existing data keeps loading. Backups are written with `app: 'vihsit'`, and both names are accepted on restore.
- Screenshots in `docs/screenshots/` are made from synthetic data and invented names only. Never use a resident's real backup for them.

- `tools/import-clinreminder.js` is a one-off migration from the author's older ClinReminder app (`../desktop_clinic_aide/data/clinic.db`, which holds PHI). It never selects patient names and writes through `sanitize()`. When inspecting that database, print aggregates only, never rows.

## Code layout gotchas

- `src/core.js` has no DOM and no storage, so it runs under Node tests. All parsing, categorizing, `sanitize()` and stats live there.
- `src/app.js` never uses `innerHTML`. Pasted text becomes `textContent` only, through the `h()` and `s()` helpers. Don't add `style="..."` attributes, because the hash-based CSP blocks them. Use classes, or set `el.style` from JS.
- ACGME numbers come from the 2026 Family Medicine requirements (section 4.11), in `REQUIREMENTS` in `core.js`. Each day counts toward exactly one area (`AREAS`), because ACGME doesn't allow double counting. Program-specific requirements are user-defined filters (`programReqs` in settings).

## Privacy constraints (never violate)

The design depends on PHI never being stored and never leaving the device. Treat any change that breaks one of these rules as a bug, even if it fixes something else.

- **No network, ever.** Keep the CSP `connect-src 'none'`. Don't add analytics, crash reporting, web fonts, CDNs or any other external resource. All JS and CSS must be inline or same-origin. Fonts are embedded as base64 `data:` URIs, so the CSP needs `font-src data:`.
- **One gate to storage.** Every input path (Cerner parser, Athena parser, manual entry form, JSON import from someone else's parser) builds the same in-memory row shape. They all pass through a single `sanitize()` function, and it is the only code allowed to write to IndexedDB. It keeps only allowlisted fields and drops everything else. Parsers and importers never touch storage directly. A new EMR parser should need no privacy code of its own.
- **Patient name:** Hold it in memory only, for the review screen. Never write it to storage, logs or the console.
- **Inpatient census lists are out of scope.** They contain MRNs, dates of birth and room numbers. Only clinic and surgery schedules are supported.
- **Chief complaint:** At parse time, map the free text to a fixed category list, then discard the text. If something doesn't map, the user picks a category. Remembered mappings must be user-reviewed keywords, never raw complaint strings, because free text can contain names ("f/u per Dr. X").
- **Age:** Store anyone 90 or older as `90+`.
- **Dates are split from encounters.** Encounter rows hold age, sex, visit type, complaint category, site, continuity flag, academic year and PGY level, with no date. Daily rows hold date, site and counts by visit type, with no individual data. Never join the two. Daily rows may also list empty slots (`No appointments`) with their start time and length, because no patient is involved. No-shows are stored only as a count and total minutes per day, never with times, because each one is a specific patient's missed appointment. Don't add an opt-in setting to store no-show times. It was considered and rejected because exports would then contain PHI.
- **Continuity:** Use a per-visit "my patient / covering" toggle, set automatically from a PCP column when the paste has one. Never hash names or other PHI to track patients.
- **Re-pasting a day:** Encounter rows have no date and no link to their day, so a day's visits can't be found by date. That's a deliberate choice: the resident rejected a 14-day edit link. Don't add one. Fixing a day works by pasting it again. The review then offers "Add missed visits" (rows marked logged count as seen but aren't re-saved, and the day record is replaced) or "Remove visits" (`matchSaved` deletes saved encounters with identical content, which can't be told apart anyway). Deleting a day in the day list removes only the day record. Undo (`applyChange`/`undoLast`) works only within the current session.
- **Day-level counts only:** day records may hold counts (`seen`, `newCount`, `obCount`, `mineCount`) but never per-visit times or attributes.
- **Test fixtures and sample schedules in the repo:** Use invented names, and scrub dates, provider names and room numbers from the notes. The repo is public.
- **Paste handling:** Read from `clipboardData`, call `preventDefault()` so the raw text never enters the DOM, clear the clipboard (`navigator.clipboard.writeText('')`), then parse. Also accept text dropped by drag-and-drop. Never keep the raw schedule in a textarea. Turn autocomplete off.

## Platform requirements

- The app must work as one self-contained HTML file opened from `file://`. Test clipboard clearing and storage there as well as over https, because the Clipboard API needs a secure context.
- **Storage:** Use IndexedDB with `navigator.storage.persist()`. Safari deletes site storage after 7 days without a visit, so one-tap export and import of the de-identified data is required, not optional.
- **Parsing:** Two EMRs are supported, Cerner and athenahealth. Each has its own small parser, and the app picks one by detecting the paste's format. Both paste one field per line, not in columns. Each parser anchors on the age/sex pattern (Cerner `34 Years, F`, Athena `61yo F | 12-17-1964`), because nearby lines shift and extra page text gets swept in. Athena pastes include a date of birth. Drop it at parse time.
- **Other EMRs:** These come in through a documented JSON import format, explained in the README and in the app's help, that a local script or an offline AI can produce. The import goes through `sanitize()` like everything else. The help text must say the AI has to run offline or locally, because pasting a schedule into a cloud AI is a disclosure.
- **No-shows:** Only final statuses (`Checked Out`, `Finished`, `Patient Discharged…`) default a visit to seen. "In progress" statuses such as `Seen By Resident` get left behind on visits that were cancelled, so they default to unticked. athena lists are the whole clinic's, so every row starts unticked, and unticked athena rows are not no-shows.
- **Site:** Detect it from the department field, with a one-tap override.

## Design

- Aim for a clinical flowsheet or a printed lab report, not a SaaS dashboard. Use hairline rules, tables, left-aligned type, tabular numerals and one accent color.
- Don't use cards, drop shadows, gradients, glassmorphism, rounded "pill" everything, or emoji icons.
- Draw charts by hand as inline SVG. No chart libraries.
- Keep friction low. Pasting a day, reviewing it and saving it should take seconds.

## User-facing docs

The README and the first-run checklist must tell users to turn off Windows clipboard history and "Sync across your devices", Mac Handoff (which also turns off Universal Clipboard), and any clipboard manager (Ditto, Maccy, Raycast, Alfred). They must also recommend a browser profile with no extensions. A page can't detect these settings, so the user confirms the checklist. Frame the tool as "not legal advice; check with your GME office and privacy officer."
