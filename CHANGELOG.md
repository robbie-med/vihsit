# Changelog

## 0.1.0 (2026-10-01)

First public release.

- **Schedules:** paste parsing for Cerner (clinic, surgery, satellite, OB and procedure schedules) and athenahealth (whole-clinic lists), JSON day files for other EMRs, and manual entry with per-site defaults for nursing homes and other sites logged by hand.
- **Privacy:** de-identification through a single allowlist gate. Visits are stored without dates, reason text is reduced to categories, and ages of 90 or older become `90+`. The page clears the clipboard after a paste and is blocked from the network by its CSP.
- **Review screen:** smart defaults, keyword teaching, label mappings, a continuity reminder, and a re-paste fix to add missed or remove wrong visits.
- **Requirements:** the 2026 ACGME Family Medicine requirements with editable targets, plus user-defined program requirements.
- **Record:** charts with filters, trends, pace toward graduation targets, and breakdowns, each exportable as PNG or CSV.
- **Reports:** a CCC summary and custom reports, printable or saved as PDF.
- **Backups:** export and restore.
