---
description: Guide for those that want to translate RiftLauncher to another language.
---

# 🌐 Translation

Translation happens on [Weblate](https://hosted.weblate.org/projects/riftlauncher/), where anyone can help. This guide stays for people who prefer a pull request.

RiftLauncher is developed using i18next which makes it translatable to any language.\
In this guide you will see the 2 ways to translate RiftLauncher.

**Option 1** is quicker to start but harder to maintain: you edit a `.json` file by hand, with no visual interface and no automatic checks. Good for a one-off translation you don't plan to keep updating.

**Option 2** takes about ten minutes to set up the first time, since you have to install Visual Studio Code, create a GitHub account and configure a couple of things. After that it's the easier option to keep translating as the launcher changes: a visual interface shows you which keys are missing, offers one-click machine translation as a starting point, lets other people leave notes on entries, and syncs and submits your changes with a few clicks.

Twelve locales (be-BY, de-DE, es-ES, hu-HU, it-IT, nl-NL, pl-PL, pt-BR, pt-PT, ru-RU, uk-UA and zh-CN) were seeded with machine-drafted strings so that no file starts out half empty, and a reviewer can correct a sentence instead of writing one. Nobody who speaks those languages has read the drafts yet. Each drafted key is listed under its locale in `src/renderer/src/locales/drafted.json`, which is the review queue: a string outside that list is earlier human work, so leave it alone unless it is wrong. [Translation status](../../contribute/translation-status.md) shows how many drafts are left per locale.

On Weblate you sign in with GitHub or an email address, open your language and translate in the browser. Nothing has to be asked for first: any signed-in account can translate or leave a suggestion. Weblate gathers what changed into a pull request against `dev`, a maintainer reviews it, and your translation ships with the release that follows. The two options below stay for people who prefer to send that pull request themselves.

A language that is not listed yet has to be added by a maintainer, because the launcher registers every language it offers in `src/renderer/src/i18n.ts`. Ask for it with Start new translation on Weblate, on the Stratum Discord or in an issue.

With this said, let's start with the guide!
