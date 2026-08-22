import { useState } from "react"
import { useTranslation } from "react-i18next"

import { CONFIG_ACTIONS, useConfigDispatch, useSettingsConfig } from "@renderer/features/config/contexts/ConfigContext"
import { MODDB_VISIBILITY_ACCEPTED, MODDB_VISIBILITY_ALREADY_DONE, MODDB_VISIBILITY_DECLINED, MODDB_VISIBILITY_UNASKED, type ModDbVisibilityAnswer } from "@domain/moddbVisibility"

import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import { ButtonsWrapper, FormButton } from "@renderer/components/ui/FormComponents"

/**
 * Asks once whether the launcher may fetch its own ModDB listing archive, which is what registers a
 * download on that listing (#219).
 *
 * The three answers are equal on purpose: same styling, same size, no default focus, none of them
 * pre-selected, and no download count on screen to turn a question into a scoreboard. Only "count
 * me in" fetches anything, and it fetches once whether that attempt succeeds or not.
 *
 * Closing the dialog (Escape, or the area around it) writes nothing, so the question comes back
 * next launch. Silence is not consent, and it is not a refusal either.
 */
function ModDbVisibilityPrompt(): JSX.Element {
  const { t } = useTranslation()
  const { schemaVersion, moddbVisibilityAnswer } = useSettingsConfig()
  const configDispatch = useConfigDispatch()
  const [dismissed, setDismissed] = useState(false)

  // schemaVersion 0 is the "stored config has not arrived yet" sentinel (see configReducer's
  // initialState). Without this the prompt would flash in front of someone who answered it years
  // ago, for as long as the read takes.
  const isOpen = schemaVersion !== 0 && moddbVisibilityAnswer === MODDB_VISIBILITY_UNASKED && !dismissed

  const answer = (value: ModDbVisibilityAnswer): void => {
    configDispatch({ type: CONFIG_ACTIONS.SET_MODDB_VISIBILITY_ANSWER, payload: value })
    if (value === MODDB_VISIBILITY_ACCEPTED) void window.api.netManager.fetchModDbListingArchive()
  }

  return (
    <PopupDialogPanel title={t("components.moddbVisibility.title")} isOpen={isOpen} close={() => setDismissed(true)}>
      <>
        <p className="text-left text-zinc-300">{t("components.moddbVisibility.body")}</p>

        <ButtonsWrapper className="text-lg self-center" bgDark={false}>
          <FormButton onClick={() => answer(MODDB_VISIBILITY_ACCEPTED)} title={t("components.moddbVisibility.accept")} className="p-2 px-4">
            {t("components.moddbVisibility.accept")}
          </FormButton>
          <FormButton onClick={() => answer(MODDB_VISIBILITY_DECLINED)} title={t("components.moddbVisibility.decline")} className="p-2 px-4">
            {t("components.moddbVisibility.decline")}
          </FormButton>
          <FormButton onClick={() => answer(MODDB_VISIBILITY_ALREADY_DONE)} title={t("components.moddbVisibility.alreadyDone")} className="p-2 px-4">
            {t("components.moddbVisibility.alreadyDone")}
          </FormButton>
        </ButtonsWrapper>
      </>
    </PopupDialogPanel>
  )
}

export default ModDbVisibilityPrompt
