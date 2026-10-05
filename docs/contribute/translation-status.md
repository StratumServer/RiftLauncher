---
description: How complete each translation is, and how much of it is still a machine draft.
---

# Translation status

`npm run i18n:status` builds the table below from `src/renderer/src/locales`. en-US is the source, so every other file is measured against it.

- **Keys**: how many strings the file defines.
- **Missing**: en-US keys the file does not have yet. The launcher shows the English string for those.
- **Stale**: keys the file still carries that en-US has dropped. Harmless, but dead weight a translator can delete.
- **Drafted to review**: values that were machine-drafted when the locale was seeded, and that nobody who speaks the language has read yet. They are listed key by key in `src/renderer/src/locales/drafted.json`, so reviewing a locale means going through that list rather than the whole file.

A pull request that touches the locale files gets this same table as a comment, which is where the numbers are easiest to act on. This page is refreshed in that same pull request: run `npm run i18n:status -- --write docs/contribute/translation-status.md` and commit what changes.

Community translation happens on [Weblate](https://hosted.weblate.org/projects/riftlauncher/), which opens a pull request against `dev` with what translators changed. That pull request comes from a fork, whose token cannot comment, so it does not get the table as a comment. It changes values only, which leaves the numbers below as they are. When it corrects drafted strings, a maintainer takes those keys out of `drafted.json` and refreshes this page in a follow-up pull request.

<!-- i18n-status:start -->

en-US is the source and carries 903 keys.

| Locale | Keys | Missing | Stale | Drafted to review |
| ------ | ---: | ------: | ----: | ----------------: |
| be-BY  |  883 |      54 |     0 |               655 |
| de-DE  |  856 |      47 |     0 |               707 |
| es-ES  |  883 |      54 |     0 |               545 |
| fr-FR  |  937 |       0 |     0 |                 1 |
| hu-HU  |  856 |      47 |     0 |               590 |
| it-IT  |  883 |      54 |     0 |               552 |
| nl-NL  |  856 |      47 |     0 |               711 |
| pl-PL  |  883 |      54 |     0 |               549 |
| pt-BR  |  883 |      54 |     0 |               453 |
| pt-PT  |  883 |      54 |     0 |               559 |
| ru-RU  |  883 |      54 |     0 |               643 |
| uk-UA  |  883 |      54 |     0 |               568 |
| zh-CN  |  829 |      40 |     0 |               677 |

<!-- i18n-status:end -->
