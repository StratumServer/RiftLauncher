import { useTranslation } from "react-i18next"
import { PiTrashDuotone } from "react-icons/pi"

import ConfirmDialog from "@renderer/components/ui/ConfirmDialog"

/**
 * Asks before one server's downloaded Mods are removed.
 *
 * Its own dialog rather than a third mode inside DeleteModDialog: what this deletes is a folder, not
 * an archive, and what it has to say is the opposite of "this is not reversible", because the game
 * downloads the set again on the next join. The server is named so the player can see which one they
 * are clearing, and the name is plain text React escapes.
 */
function RemoveServerModsDialog({ group, close, onConfirm }: Readonly<{ group: ServerModGroupType | null; close: () => void; onConfirm: () => Promise<void> }>): JSX.Element {
  const { t } = useTranslation()

  return (
    <ConfirmDialog
      title={t("features.mods.serverModsRemoveTitle")}
      isOpen={group !== null}
      close={close}
      /* A folder the launcher could not open has no count to state, and "0 Mods" would be a
         claim about a folder nothing was ever read from. */
      question={
        group?.unlistable
          ? t("features.mods.serverModsRemoveUnlistable", { server: group.server, interpolation: { escapeValue: false } })
          : t("features.mods.serverModsRemoveConfirm", { count: group?.mods.length ?? 0, server: group?.server ?? "", interpolation: { escapeValue: false } })
      }
      consequence={t("features.mods.serverModsRemoveReassurance")}
      /* generic.delete, not a label of this feature's own: a dialog button rendering its title as
         visible text has to resolve in all fourteen locales, and this one already does. */
      confirmLabel={t("generic.delete")}
      confirmIcon={<PiTrashDuotone />}
      onConfirm={onConfirm}
    >
      {/* The count above is what the scan listed, not what the folder holds, so stating it alone
          would understate what this button is about to delete. */}
      {group?.truncated && <p>{t("features.mods.serverModsRemoveTruncated")}</p>}
    </ConfirmDialog>
  )
}

export default RemoveServerModsDialog
