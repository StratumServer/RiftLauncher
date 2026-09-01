import { Trans, useTranslation } from "react-i18next"
import { FiLoader } from "react-icons/fi"

import { ListGroup, ListWrapper } from "@renderer/components/ui/List"
import { LinkButton } from "@renderer/components/ui/Buttons"

/** What an empty Mods folder shows: the scan spinner while it runs, then where to get some Mods. */
function NoInstalledModsNotice({ gettingMods }: Readonly<{ gettingMods: boolean }>): JSX.Element {
  const { t } = useTranslation()

  return (
    <ListWrapper className="w-full">
      <ListGroup>
        {gettingMods ? (
          <div className="w-full flex flex-col items-center justify-center gap-2 rounded-sm p-4">
            <FiLoader className="animate-spin text-4xl text-zinc-400" />
          </div>
        ) : (
          <div className="w-full flex flex-col items-center justify-center gap-2 rounded-sm p-4">
            <p className="text-2xl">{t("features.mods.noModsFound")}</p>
            <p className="w-full flex gap-1 items-center justify-center">
              <Trans
                i18nKey="features.mods.noModsInstalled"
                components={{
                  link: (
                    <LinkButton title={t("components.mainMenu.modsTitle")} to="/mods" className="text-vsl underline">
                      {t("components.mainMenu.modsTitle")}
                    </LinkButton>
                  )
                }}
              />
            </p>
          </div>
        )}
      </ListGroup>
    </ListWrapper>
  )
}

export default NoInstalledModsNotice
