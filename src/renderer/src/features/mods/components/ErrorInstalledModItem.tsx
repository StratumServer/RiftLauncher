import { useTranslation } from "react-i18next"
import { PiTrashDuotone } from "react-icons/pi"

import { ListItem } from "@renderer/components/ui/List"
import { NormalButton } from "@renderer/components/ui/Buttons"

/** An archive the scan could not read: only its file name is known, so only deleting it is offered. */
function ErrorInstalledModItem({ iModE, onDeleteClick }: Readonly<{ iModE: ErrorInstalledModType; onDeleteClick: () => void }>): JSX.Element {
  const { t } = useTranslation()

  return (
    <ListItem key={iModE.zipname + iModE.zipname}>
      <div className="flex gap-4 p-2 justify-between items-center whitespace-nowrap bg-red-700/15">
        <div className="shrink-0">
          <div className="w-16 h-16 bg-zinc-950/50 rounded-sm shadow-sm shadow-zinc-950" />
        </div>

        <div className="w-full flex flex-col gap-1 justify-center overflow-hidden">
          <div className="flex gap-2 items-center">
            <p>{iModE.zipname}</p>
          </div>
        </div>

        <div className="flex gap-1 justify-end text-lg">
          <NormalButton
            className="p-1"
            title={t("generic.delete")}
            variant="ghost"
            onClick={async () => {
              onDeleteClick()
            }}
          >
            <PiTrashDuotone />
          </NormalButton>
        </div>
      </div>
    </ListItem>
  )
}

export default ErrorInstalledModItem
