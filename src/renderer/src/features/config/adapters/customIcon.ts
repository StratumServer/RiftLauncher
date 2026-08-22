/**
 * Everything that can stop a custom icon from being added, and what the player
 * is told about each.
 *
 * The two reasons that are not on the wire belong to the renderer: the picker
 * came back empty, and the bridge call itself threw. Both used to end the flow
 * without a word, the second one without even a notification, since nothing
 * caught it (#202).
 */
export type AddCustomIconFailure = CustomIconCopyFailureReason | "no-file-selected" | "bridge-failed"

export interface AddCustomIconFeedback {
  /** i18n key to notify with. */
  messageKey: string
  /** Whether the refusal also goes to the log. */
  logged: boolean
}

/** How the UI reacts to a refused icon. */
export function describeAddCustomIconFailure(reason: AddCustomIconFailure): AddCustomIconFeedback {
  switch (reason) {
    case "no-file-selected":
      return { messageKey: "notifications.body.noFileSelected", logged: false }
    // Both are the player's to fix, and the main process has already written
    // the cause behind them at debug, so the renderer adds nothing by repeating it.
    case "unsupported-format":
      return { messageKey: "notifications.body.iconNotAPng", logged: false }
    case "source-unavailable":
      return { messageKey: "notifications.body.iconSourceUnavailable", logged: false }
    case "copy-failed":
      return { messageKey: "notifications.body.coulndtCopyIcon", logged: true }
    case "bridge-failed":
      return { messageKey: "notifications.body.iconAddFailed", logged: true }
  }
}
