# Security and privacy

vihsit's job is to store nothing identifying and to send nothing anywhere. A bug that breaks either promise is treated as a security issue.

## In scope

- Anything identifying that reaches IndexedDB, a backup or an export: names, reason text, MRNs, dates of birth, visit dates on individual visits, no-show times.
- Any way for the page to make a network request, or for its Content Security Policy to be weakened.
- Script injection from pasted or imported content.
- Ways for a visit to be linked back to its date.

## Reporting

Please **don't open a public issue** for these. Use GitHub's private reporting: **Security › Report a vulnerability** on this repository. Include steps to reproduce with **invented data only**. Never include a real schedule.

You'll get an acknowledgement within a week. Fixes for confirmed issues are prioritized above everything else.

## Not in scope

- Your hospital's policies about personal devices. vihsit can't enforce or check them; talk to your GME office or privacy officer.
- Operating-system clipboard history or sync, and browser extensions. These sit outside the page. The first-run checklist explains how to turn them off.
