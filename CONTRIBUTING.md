# Contributing to vihsit

Thanks for helping. vihsit handles clinical schedules, so a few rules are stricter than in most projects.

## The one rule that matters most

**Never put real patient information anywhere in this repository.** That covers issues, pull requests, commits, test fixtures, screenshots and discussion comments. A schedule with names changed can still identify people through ages, dates, visit reasons and room numbers.

To share a schedule format, rebuild it by hand:
- invented names (`TESTER, ALPHA`)
- changed ages
- generic reasons
- no real dates, phone numbers, room numbers or provider names

Keep the layout exactly as it pastes: the line breaks, spacing and field order are what matter.

## Ground rules for code

- **No network, ever.** Don't add anything that fetches: no CDNs, web fonts, analytics or update checks. The CSP (`connect-src 'none'`) must stay.
- **No dependencies.** The app is one self-contained HTML file, built with Node's standard library only.
- **One gate to storage.** Everything written to IndexedDB goes through `sanitize()`, `cleanDay()`, `cleanEncounter()`, `sanitizeBackup()` or `cleanSettings()` in `src/core.js`. A new parser or importer should need no privacy code of its own.
- **Visits never carry a date, or a link to their day.** Day records hold only counts and hours. Don't add fields that tie an individual visit to a date or time.
- **No `innerHTML`.** Pasted text only ever becomes `textContent`, through the `h()` and `s()` helpers in `src/app.js`. Don't add `style="..."` attributes either: the hash-based CSP blocks them.
- **Match the surrounding code.** Plain modern JavaScript, two-space indents, single quotes, sparse comments that explain why.

## Development

```sh
npm test          # node --test
npm run build     # writes dist/vihsit.html
```

Open `dist/vihsit.html` in a browser to try your change. **Commit the rebuilt `dist/vihsit.html` with your source changes.** CI fails if it's out of date.

## Pull requests

- Keep each PR to one change, and explain what it changes for a resident using the app.
- Add or update tests in `test/core.test.js` for any parsing, privacy-gate or stats change.
- Run `npm test` and `npm run build` before pushing.
- UI changes: include a screenshot made with invented data.

## Adding an EMR

1. Add a fixture to `test/fixtures.js`: the schedule exactly as it pastes, with invented patients.
2. Write a parser in `src/core.js` that returns the `ParsedPaste` shape documented above `parseCerner`. Anchor on something stable, such as the age and sex pattern, rather than line positions.
3. Have `parseSchedule()` detect it.
4. Add tests: counts, ages (including infants and 90+), statuses, and that the output of `sanitize()` contains no names.
