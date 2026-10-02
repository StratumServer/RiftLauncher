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

en-US is the source and carries 854 keys.

| Locale | Keys | Missing | Stale | Drafted to review |
| ------ | ---: | ------: | ----: | ----------------: |
| be-BY  |  879 |       2 |     0 |               651 |
| de-DE  |  852 |       2 |     0 |               703 |
| es-ES  |  879 |       2 |     0 |               541 |
| fr-FR  |  881 |       0 |     0 |                 0 |
| hu-HU  |  852 |       2 |     0 |               586 |
| it-IT  |  879 |       2 |     0 |               548 |
| nl-NL  |  852 |       2 |     0 |               707 |
| pl-PL  |  879 |       2 |     0 |               545 |
| pt-BR  |  879 |       2 |     0 |               449 |
| pt-PT  |  879 |       2 |     0 |               555 |
| ru-RU  |  879 |       2 |     0 |               639 |
| uk-UA  |  879 |       2 |     0 |               564 |
| zh-CN  |  825 |       2 |     0 |               673 |

<!-- i18n-status:end -->
