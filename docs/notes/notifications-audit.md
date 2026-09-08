# Notification area audit

Everything a player reads as a notification: the toast overlay, the Activity Center, the task
rows it draws from, and the call sites that fire a message. Written against `origin/dev` at
5f6c464. File and line references are relative to that commit and are not maintained after merge;
the decisions that outlive this pass are the ones in `docs/decisions/`.

Each finding is ranked:

- **fix** goes in this pass
- **follow-up** gets its own issue
- **fine** is deliberate and stays

Where a number appears it was measured, not guessed. The queue figure comes from a throwaway
probe over the real provider with fake timers, the contrast figures from the same arithmetic
`tests/text-contrast.test.ts` uses.

## Timing and queue

**Durations.** `DEFAULT_TOAST_DURATIONS` in
`src/renderer/src/contexts/NotificationsContext.tsx:77`: success and info 4500 ms, warning and
error 8000 ms. A toast carrying actions stays open until answered
(`resolveToastDuration`, `NotificationsContext.tsx:79`). Those numbers are reasonable and I am
leaving them. **fine**

**One toast at a time.** `activeToastId` holds a single id
(`NotificationsContext.tsx:109`) and the overlay renders exactly one banner
(`src/renderer/src/components/layout/NotificationsOverlay.tsx:25`). Everything else waits in
`toastQueue`. The overlay's container is already a column with `gap-2`, so it was built for a
stack that never arrives. **follow-up**

**The backlog is the real problem, and the #336 review was right.** The queue drains strictly
in order and every toast serves its full duration before the next one starts
(`NotificationsContext.tsx:120-145`). Five errors fired in the same tick take 40 s to drain:
the fifth reaches the screen 32 s after the thing it is reporting. A bulk mod update queues
one completion toast per mod, so twenty mods put the last toast about 160 s out, which is the
180 s figure that review quoted. Nothing has fixed it. A message that arrives three minutes
after the event is not a notification, it is a puzzle. **fix**

**Dismiss is immediate.** `dismissToast` clears `activeToastId` synchronously
(`NotificationsContext.tsx:207`) and the next queued toast is picked up by the effect on the
following render. No lag. **fine**

**Hover does not pause the timer.** The countdown is a bare `window.setTimeout`
(`NotificationsContext.tsx:140`) and the overlay attaches no pointer or focus handlers. A
player who moves the mouse onto a toast to read a long message, or tabs to its action button,
watches it disappear underneath them. WCAG 2.2.1 asks for a pause on anything that
auto-hides; more to the point it is the thing every player expects. **fix**

**The countdown does not restart when the center is opened.** Deliberate, keyed on the toast
id alone with the reasoning written out at `NotificationsContext.tsx:132-145` and pinned by
`tests/renderer-dom/activityCenter.test.tsx:259`. **fine**

**Two `setTimeout(..., 2000)` delays before an update offer**
(`NotificationsContext.tsx:167` and `:175`) and one before the mod update notice
(`src/renderer/src/components/layout/GlobalModUpdateChecker.tsx:29`). They keep a
startup-time message from landing on top of the splash. Fine as they are. **fine**

## Redundancy and wording

**"Click here" on toasts that have a button.**
`notifications.body.updateDownloaded` reads "Update downloaded successfully! Click here to
restart RiftLauncher and update it!" and
`features.mods.updatesAvailableInstallation` reads "... Click here to see them them!" Both
toasts ship a real action button ("Restart and update" at `NotificationsContext.tsx:178`,
"View updates" at `GlobalModUpdateChecker.tsx:34`), and clicking the toast body does nothing
at all. The sentence tells the player to do the one thing that will not work. **fix**

**"them them".** A duplicated word in the plural base of
`features.mods.updatesAvailableInstallation` in `src/renderer/src/locales/en-US.json`. The
`_other` variant next to it is correct, so this only shows on the count that falls through to
the base. **fix**

**Exclamation marks everywhere.** Twenty-odd notification strings end in one, including every
failure: "Error downloading: {{downloadName}}!", "An error has occurred during the process!",
"There was an error making a backup!". Shouting at a player about a thing that already went
wrong reads as panic. The newer strings (`features.backups.compress*`,
`notifications.body.gameLaunch*`) already dropped it, so the file is halfway there and just
inconsistent. **fix** for the notification and task strings; the rest of the file is out of
scope here.

**The backup task's third line says nothing.** A backup row shows the task name
`features.backups.cmpressTaskName` ("{{name}} Backup"), then "Compressing · In progress" from
`OPERATION_LABELS`, then the description
`features.backups.compressingBackupDescription` ("Backing up {{name}}!"). Three lines, one
fact. `src/renderer/src/components/ui/ActivityCenter.tsx:51` only hides the description when
it is character-for-character the name, which this is not. **fix** by making the description
carry something the other two lines do not.

**The pair a player quoted is already half fixed.** "There was an error making a backup!"
(`features.backups.errorMakingBackup`) is dead: nothing outside a doc comment in
`tests/i18n/helpers.ts:55` references it. #345 replaced it with the seven
`features.backups.*` sentences that each name a cause, picked in
`src/renderer/src/features/installations/adapters/backupFailure.ts:52`. The remaining half of
the pair, the "Starting compression" line, is the task description above. **fix** the dead key
by deleting it.

**Error toasts and their causes.** Checked every error call site against #345. Backups name
their cause (`backupFailure.ts:21-33`). Config saves name theirs
(`src/renderer/src/features/config/contexts/ConfigContext.tsx:106`). Game launch names its
own (`src/renderer/src/utils/playOutcomeNotifications.ts`). Custom icons and backgrounds
name theirs. The only generic ones left are the four task-runner failures
(`notifications.body.downloadError` and friends) and the Activity Center's per-row
`components.tasksMenu.error`, and neither has a cause to show because `TaskType`
(`src/renderer/src/contexts/TaskManagerContext.tsx:7`) carries no error field. That is a
change to the file #387 is in flight on. **follow-up**

**No double toast for a failed mod install.** I went looking for one and it is not there:
`describeModInstallFailure` deliberately returns a null message for `download-failed`
(`src/renderer/src/features/mods/adapters/install.ts:67`) because the task runner already
spoke. The reasoning is written above it. **fine**

**Success toasts repeat the Completed row.** A finished download fires
`notifications.body.downloaded` (`TaskManagerContext.tsx:249`) while the same task is sitting
in the Activity Center's Completed section saying the same thing. This is genuine redundancy,
but removing it changes what a player gets told about, which is a call for the maintainers
rather than a polish pass. **follow-up**

**Internal ids never reach the screen.** Every task is named through a `t()` call with a
display name (`features.mods.modTaskName`, `features.backups.cmpressTaskName`,
`launcherUpdateName`), and no notification interpolates a uuid or a raw path. The one path
that does reach a player, `features.backups.restoreLeftDataAside`, is showing it on purpose
so they can go and find the folder. **fine**

**Key typo.** `features.backups.cmpressTaskName` is missing its `o`. Renaming it means
touching all fourteen locale files, which this pass is not doing. **follow-up**

**Capitalisation.** "Mod", "Installation", "Backup" and "Version" are capitalised mid-sentence
across the whole file, inherited from VS Launcher. It is consistent enough to read as a
convention rather than an accident, and changing it is a repo-wide prose decision. **fine**
for now, worth its own issue if anyone disagrees.

## Activity Center

**Section order.** In progress, then Needs attention, then Completed, then Notifications
(`ActivityCenter.tsx:137-140`). The one section a player has to act on is buried under the one
they can only watch. Failures should come first. **fix**

**Empty states.** Only the notifications section has one
(`ActivityCenter.tsx:163`), and it switches text on whether any task exists. With tasks
present but no messages it says "No notifications yet." under a "Notifications" heading, which
is right. With nothing at all it says "No activity right now." under that same heading, which
is a whole-panel statement sitting in one section. Small enough to leave. **fine**

**Badge, seen and read.** Two different markers on one trigger: a count bubble for active
tasks (`ActivityCenter.tsx:241`) and a dot for unseen notifications (`:249`). `seen` means the
panel has been open with the record in it and never goes back to false; `read` means the
player acknowledged it and gates "Clear read". The distinction is documented at
`NotificationsContext.tsx:26-33` and it does map onto something a player can feel: the dot
stops nagging once you look, the row marker stays until you deal with it. **fine**

**Clearing completed rows.** One at a time only, through the per-row discard button at
`ActivityCenter.tsx:55`. There is no bulk clear, while the notification half right below it has
both "Mark all read" and "Clear read". After an installation with a dozen steps the player
dismisses a dozen rows by hand. I built it and then took it back out:
`tests/i18n/i18n-parity.test.ts` holds the whole `components.activityCenter` namespace complete
in all fourteen locales, and a new label there is a translation round, not a polish pass. It
belongs in its own change with the translations beside it. **follow-up**

**A failed row does not explain itself.** It shows the same
`components.tasksMenu.error` sentence for every failure (`ActivityCenter.tsx:52`). See the
cause note above. **fix** the wording now, **follow-up** for the real cause.

**"Finalizing".** `ActivityCenter.tsx:38` shows it whenever a task is in-progress at 100 %.
That is genuinely the right label for the window between the last progress tick and the
awaited operation resolving, which is real for downloads (the file still has to flush) and
for the launcher update on Windows (the signature check). It is not only the #387 race. Once
#387 lands, the label stops being a place a task can get stuck in and goes back to meaning
what it says. **fine**

**Keyboard reachability, and this is the bad one.** `PopoverPanel` is rendered with `static`
(`ActivityCenter.tsx:253`) so it can play an exit animation through `AnimatePresence`. `static`
also turns off what Headless UI does for a panel, and the panel is portalled through `anchor`
to the end of the document. Measured on the mounted component: after opening the panel,
`document.activeElement` is still the trigger, Escape leaves the panel open, and the panel is
not inside the trigger's subtree. So a keyboard player opens the Activity Center, presses Tab,
and lands on whatever follows the trigger in the header. Every control in the panel is
reachable only after tabbing through the rest of the app, and the panel cannot be closed from
the keyboard at all.

Worth writing down, because it is not what I expected when I started fixing it: the Escape key
is not a second problem. Headless UI's own Escape handling is gated on focus being inside the
panel, so moving focus in on open is the whole fix and an Escape handler of my own on top of it
is dead code. A mutant proved that: flipping the handler's key comparison changed nothing,
because the framework was already doing the work. **fix**

**Names on controls.** Every button in the panel and the overlay passes `ariaLabel`, and
`NormalButton` falls back to `title` anyway
(`src/renderer/src/components/ui/Buttons.tsx`). Nothing unnamed. **fine**

**Progress bars.** `role="progressbar"` with a label, min, max, now and a text value
(`ActivityCenter.tsx:68`). **fine**

## Accessibility

**Live regions.** The overlay is a permanently mounted `role="status" aria-live="polite"`
container (`NotificationsOverlay.tsx:22`) so a toast that arrives minutes later is still
announced, and error toasts carry their own `role="alert"`
(`NotificationsOverlay.tsx:29`). An alert is its own live region, so the innermost one wins
and the message is announced once, assertively. Pinned by
`tests/renderer-dom/activityCenter.test.tsx:383`. **fine**

**Contrast, and there are two real failures.** Running the notification classes through the
same arithmetic as `tests/text-contrast.test.ts`, worst case over a white and a black
background image:

| what                | class             | stack                      | ratio      | floor |
| ------------------- | ----------------- | -------------------------- | ---------- | ----- |
| toast error icon    | `text-red-700`    | shell + toast              | **2.34:1** | 3     |
| failed task icon    | `text-red-800`    | shell + menu + panel + row | **1.97:1** | 3     |
| failed task line    | `text-red-800`    | shell + menu + panel + row | **1.97:1** | 4.5   |
| toast body          | `text-zinc-400`   | shell + toast              | 5.72:1     | 4.5   |
| toast dismiss       | `text-zinc-400`   | shell + toast              | 5.72:1     | 3     |
| toast success icon  | `text-lime-600`   | shell + toast              | 4.90:1     | 3     |
| toast warning icon  | `text-yellow-400` | shell + toast              | 9.54:1     | 3     |
| task name           | inherited         | shell + menu + panel + row | 16.47:1    | 4.5   |
| task operation line | `text-zinc-400`   | shell + menu + panel + row | 6.28:1     | 4.5   |
| task percentage     | `text-zinc-400`   | shell + menu + panel + row | 6.28:1     | 4.5   |
| completed icon      | `text-lime-600`   | shell + menu + panel + row | 5.38:1     | 3     |
| in-progress icon    | `text-yellow-400` | shell + menu + panel + row | 10.47:1    | 3     |
| section heading     | `text-zinc-400`   | shell + menu + panel       | 6.53:1     | 4.5   |
| panel summary       | `text-zinc-400`   | shell + menu + panel       | 6.53:1     | 4.5   |
| empty state         | `text-zinc-400`   | shell + menu + panel       | 6.53:1     | 4.5   |
| Mark all read       | `text-vsl`        | shell + menu + panel       | 6.81:1     | 4.5   |
| active task badge   | white on `bg-vs`  | opaque                     | 6.88:1     | 4.5   |

The red is the one that matters. On a failed task row it is the icon, the status colour and
the explanation sentence all at once, so the least readable thing in the panel is the one
thing the player has to read. **fix**

Of that table, `tests/text-contrast.test.ts` currently pins only three notification values:
the toast scrim and panel scrim (`:225-226`), the history body and answered marker
(`:358`), and the accent icons (`:420`). Everything else in the table is unpinned and free to
regress. **fix** by pinning the lot.

## Consistency with the rest of the UI

**Buttons.** Every control in both files goes through `NormalButton`, so #350's system is
respected. Three of them then override the variant's own colour with a `className`
(`ActivityCenter.tsx:147`, `:152`, `:180`) and most fight the `sm` size's `min-h-8 min-w-8`
with a `p-1`. It works and it is not worth the churn. **fine**

**Scrims.** Toast at `zinc-950/60`, panel at `/50`, row tint at `zinc-800/30`. Consistent with
the shell at `/70` and the tile convention. **fine**

**Accent.** `#d49754` through `--color-vsl`, used for the unseen dot, the pending icon, the
trigger border and "Mark all read". **fine**

**Motion.** Both respect `useReducedMotion`, the panel uses the same `opacity + y: -4` entrance
as the other dropdowns, the toast slides in from `x: 400`. **fine**

## What this pass does

1. Cap how long a queued toast waits behind a backlog, and stop the modpack import raising a
   completion toast per mod into it.
2. Pause the countdown while the pointer is over a toast or focus is inside it.
3. Fix the two red contrast failures and pin every notification text class.
4. Reword: no "Click here" where a button exists, no "them them", no exclamation marks on any
   string that reaches a notification, a backup description that says something its own row was
   not already saying, drop the dead `errorMakingBackup` key.
5. Activity Center: failures first, and a panel a keyboard player can open, use and close.

## What it leaves

- Stacking more than one toast at a time.
- A bulk clear for completed rows, which needs fourteen translations.
- A concrete cause on a failed task row, which needs a field on `TaskType` and waits on #387.
- Dropping the success toast that repeats the Completed row.
- The `cmpressTaskName` typo, which is a fourteen-locale rename.
- The mid-sentence capitalisation convention.
