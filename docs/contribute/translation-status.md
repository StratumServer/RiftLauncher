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

Community translation is moving to Weblate, tracked in [#496](https://github.com/StratumServer/RiftLauncher/issues/496). Until it is live, a translation reaches the launcher as a pull request, the way the [translation guide](../get-started/translation/README.md) describes.

<!-- i18n-status:start -->

en-US is the source and carries 898 keys.

| Locale | Keys | Missing | Stale | Drafted to review |
| ------ | ---: | ------: | ----: | ----------------: |
| be-BY  |  898 |       0 |     0 |               668 |
| de-DE  |  898 |       0 |     0 |               749 |
| es-ES  |  898 |       0 |     0 |               554 |
| fr-FR  |  898 |       0 |     0 |                 0 |
| hu-HU  |  898 |       0 |     0 |               622 |
| it-IT  |  898 |       0 |     0 |               561 |
| nl-NL  |  898 |       0 |     0 |               748 |
| pl-PL  |  898 |       0 |     0 |               558 |
| pt-BR  |  898 |       0 |     0 |               497 |
| pt-PT  |  898 |       0 |     0 |               572 |
| ru-RU  |  898 |       0 |     0 |               656 |
| uk-UA  |  898 |       0 |     0 |               581 |
| zh-CN  |  898 |       0 |     0 |               738 |

<!-- i18n-status:end -->
