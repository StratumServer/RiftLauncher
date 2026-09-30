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

en-US is the source and carries 841 keys.

| Locale | Keys | Missing | Stale | Drafted to review |
| ------ | ---: | ------: | ----: | ----------------: |
| be-BY  |  868 |       0 |     0 |               640 |
| de-DE  |  841 |       0 |     0 |               692 |
| es-ES  |  868 |       0 |     0 |               530 |
| fr-FR  |  868 |       0 |     0 |                 0 |
| hu-HU  |  841 |       0 |     0 |               575 |
| it-IT  |  868 |       0 |     0 |               537 |
| nl-NL  |  841 |       0 |     0 |               696 |
| pl-PL  |  868 |       0 |     0 |               534 |
| pt-BR  |  868 |       0 |     0 |               438 |
| pt-PT  |  868 |       0 |     0 |               544 |
| ru-RU  |  868 |       0 |     0 |               628 |
| uk-UA  |  868 |       0 |     0 |               553 |
| zh-CN  |  814 |       0 |     0 |               662 |

<!-- i18n-status:end -->
