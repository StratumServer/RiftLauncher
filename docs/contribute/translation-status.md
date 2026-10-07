---
description: How complete each translation is, and where the strings still waiting for a review are listed.
---

# Translation status

`npm run i18n:status` builds the table below from `src/renderer/src/locales`. en-US is the source, so every other file is measured against it.

- **Keys**: how many strings the file defines, leaving out any that are empty.
- **Missing**: en-US keys the file does not have yet, or has as an empty string. The launcher shows the English string for those.
- **Stale**: keys the file still carries that en-US has dropped. Harmless, but dead weight a translator can delete.
- **To review on Weblate**: a link to the strings Weblate marks Needs editing for that language. It lists the machine drafts made before Weblate, plus any string whose English changed since it was translated. A translator clears a string by correcting or confirming it on Weblate.

A pull request that touches the locale files gets this same table as a comment, which is where the numbers are easiest to act on. This page is refreshed in that same pull request: run `npm run i18n:status -- --write docs/contribute/translation-status.md` and commit what changes.

Community translation happens on [Weblate](https://hosted.weblate.org/projects/riftlauncher/), which pushes a branch to this repository through its GitHub App and opens a pull request against `dev` from it. Because the branch lives in this repository rather than in a fork, that pull request gets the table as a comment like any other. Its numbers can move, Missing and Stale included: Weblate writes a plural form nobody has translated yet as an empty string, which counts as missing, and it swaps the old key of a family that en-US has since made plural for the new plural keys. When they move, the comment says this page is out of date, and a maintainer refreshes it in a follow-up pull request.

<!-- i18n-status:start -->

en-US is the source and carries 920 keys.

| Locale | Keys | Missing | Stale | To review on Weblate                                                                                       |
| ------ | ---: | ------: | ----: | ---------------------------------------------------------------------------------------------------------- |
| be-BY  |  883 |      74 |     0 | [Needs editing](https://hosted.weblate.org/translate/riftlauncher/launcher/be/?q=state:needs-editing)      |
| de-DE  |  856 |      64 |     0 | [Needs editing](https://hosted.weblate.org/translate/riftlauncher/launcher/de/?q=state:needs-editing)      |
| es-ES  |  883 |      74 |     0 | [Needs editing](https://hosted.weblate.org/translate/riftlauncher/launcher/es/?q=state:needs-editing)      |
| fr-FR  |  957 |       0 |     0 | [Needs editing](https://hosted.weblate.org/translate/riftlauncher/launcher/fr/?q=state:needs-editing)      |
| hu-HU  |  856 |      64 |     0 | [Needs editing](https://hosted.weblate.org/translate/riftlauncher/launcher/hu/?q=state:needs-editing)      |
| it-IT  |  883 |      74 |     0 | [Needs editing](https://hosted.weblate.org/translate/riftlauncher/launcher/it/?q=state:needs-editing)      |
| nl-NL  |  856 |      64 |     0 | [Needs editing](https://hosted.weblate.org/translate/riftlauncher/launcher/nl/?q=state:needs-editing)      |
| pl-PL  |  883 |      74 |     0 | [Needs editing](https://hosted.weblate.org/translate/riftlauncher/launcher/pl/?q=state:needs-editing)      |
| pt-BR  |  883 |      74 |     0 | [Needs editing](https://hosted.weblate.org/translate/riftlauncher/launcher/pt_BR/?q=state:needs-editing)   |
| pt-PT  |  883 |      74 |     0 | [Needs editing](https://hosted.weblate.org/translate/riftlauncher/launcher/pt_PT/?q=state:needs-editing)   |
| ru-RU  |  883 |      74 |     0 | [Needs editing](https://hosted.weblate.org/translate/riftlauncher/launcher/ru/?q=state:needs-editing)      |
| uk-UA  |  883 |      74 |     0 | [Needs editing](https://hosted.weblate.org/translate/riftlauncher/launcher/uk/?q=state:needs-editing)      |
| zh-CN  |  829 |      54 |     0 | [Needs editing](https://hosted.weblate.org/translate/riftlauncher/launcher/zh_Hans/?q=state:needs-editing) |

<!-- i18n-status:end -->
