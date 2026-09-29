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

en-US is the source and carries 840 keys.

| Locale | Keys | Missing | Stale | Drafted to review |
| ------ | ---: | ------: | ----: | ----------------: |
| be-BY  |  816 |      51 |     0 |               588 |
| de-DE  |  790 |      50 |     0 |               641 |
| es-ES  |  816 |      51 |     0 |               478 |
| fr-FR  |  867 |       0 |     0 |                 0 |
| hu-HU  |  790 |      50 |     0 |               524 |
| it-IT  |  816 |      51 |     0 |               485 |
| nl-NL  |  790 |      50 |     0 |               645 |
| pl-PL  |  816 |      51 |     0 |               482 |
| pt-BR  |  852 |      15 |     0 |               422 |
| pt-PT  |  816 |      51 |     0 |               492 |
| ru-RU  |  816 |      51 |     0 |               576 |
| uk-UA  |  816 |      51 |     0 |               501 |
| zh-CN  |  764 |      49 |     0 |               612 |

<!-- i18n-status:end -->
