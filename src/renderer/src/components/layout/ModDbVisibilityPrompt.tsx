import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { CONFIG_ACTIONS, useConfigDispatch, useSettingsConfig } from "@renderer/features/config/contexts/ConfigContext"
import { useAppInfo } from "@renderer/features/info/hooks/useAppInfo"
import { countModDbDownload } from "@renderer/features/moddb/adapters/moddb"
import {
  answerModDbVisibility,
  moddbLaunchAction,
  MODDB_VISIBILITY_ALWAYS,
  MODDB_VISIBILITY_ASK,
  MODDB_VISIBILITY_NEVER,
  MODDB_VISIBILITY_ONCE,
  type ModDbVisibilityConsent
} from "@domain/moddbVisibility"

import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import { ButtonsWrapper, FormButton } from "@renderer/components/ui/FormComponents"

/**
 * Asks whether the launcher may count this version on its own ModDB listing, which is what
 * registers a download there (#219, #477).
 *
 * The question belongs to a launcher version, not to an install: the listing counts per release
 * entry, so a question asked once per player made every beta after the first read as undownloaded.
 * It comes back on the first launch of a version nobody has answered for, and the two lasting
 * answers are what keeps that from becoming a prompt every few weeks.
 *
 * The four answers are equal on purpose: same styling, same size, no default focus, none of them
 * pre-selected, and no download count on screen to turn a question into a scoreboard. Only the two
 * that say yes fetch anything, and a version is counted at most once whatever is clicked.
 *
 * The two answers that record nothing but a preference go through the config the way every other
 * setting does. The two that say yes do not: the main process writes them and only then requests,
 * because a request the config never remembers is a second question and a second count later on.
 * This component only mirrors what the main process says reached disk, so the two copies of the
 * config never disagree about what has been counted.
 *
 * Closing the dialog (Escape, or the area around it) writes nothing, so the question comes back
 * next launch. Silence is not consent, and it is not a refusal either.
 */
function ModDbVisibilityPrompt(): JSX.Element {
  const { t } = useTranslation()
  const { schemaVersion, moddbVisibility } = useSettingsConfig()
  const { vslVersion } = useAppInfo()
  const configDispatch = useConfigDispatch()
  const [dismissed, setDismissed] = useState(false)
  // One trip to the main process per launch, whichever way the count was reached. The main process
  // refuses a second one anyway; this keeps the renderer from asking for a refusal it can predict.
  const counting = useRef(false)

  // schemaVersion 0 is the "stored config has not arrived yet" sentinel (see configReducer's
  // initialState). Without this the prompt would flash in front of someone who answered it years
  // ago, for as long as the read takes. An empty version is the same kind of wait.
  const action = schemaVersion === 0 ? "nothing" : moddbLaunchAction(moddbVisibility, vslVersion)

  /**
   * Records what the main process actually wrote. A refused write leaves the config alone, so the
   * question survives. Memoised only because the silent count below is an effect, and a new
   * function on every render would be a new reason to run it.
   */
  const mirror = useCallback(
    (result: ModDbCountResult): void => {
      if (result.reason === "not-saved") return
      configDispatch({ type: CONFIG_ACTIONS.SET_MODDB_VISIBILITY, payload: result.visibility })
    },
    [configDispatch]
  )

  // The silent count a stored "always" owes this launch. No dialog, no notification: the player
  // already said yes to exactly this, and a failure is theirs to never hear about.
  useEffect(() => {
    if (action !== "count" || counting.current) return
    counting.current = true
    void countModDbDownload(null).then(mirror)
  }, [action, mirror])

  // Closes at once rather than waiting on the network: the answer is the main process's to record,
  // and a refused write leaves it unrecorded, which is the same as never having been asked.
  const consent = (value: ModDbVisibilityConsent): void => {
    setDismissed(true)
    if (counting.current) return
    counting.current = true
    void countModDbDownload(value).then(mirror)
  }

  const refuse = (policy: typeof MODDB_VISIBILITY_ASK | typeof MODDB_VISIBILITY_NEVER): void => {
    setDismissed(true)
    configDispatch({ type: CONFIG_ACTIONS.SET_MODDB_VISIBILITY, payload: answerModDbVisibility(moddbVisibility, policy, vslVersion) })
  }

  return (
    <PopupDialogPanel title={t("components.moddbVisibility.title")} isOpen={action === "prompt" && !dismissed} close={() => setDismissed(true)}>
      <>
        <p className="text-left text-zinc-300">{t("components.moddbVisibility.body")}</p>

        <ButtonsWrapper className="text-base self-center" bgDark={false} equalWidth flush>
          <FormButton onClick={() => consent(MODDB_VISIBILITY_ONCE)} title={t("components.moddbVisibility.countOnce")} variant="secondary" size="md">
            {t("components.moddbVisibility.countOnce")}
          </FormButton>
          <FormButton onClick={() => consent(MODDB_VISIBILITY_ALWAYS)} title={t("components.moddbVisibility.countAlways")} variant="secondary" size="md">
            {t("components.moddbVisibility.countAlways")}
          </FormButton>
          <FormButton onClick={() => refuse(MODDB_VISIBILITY_ASK)} title={t("components.moddbVisibility.notThisTime")} variant="secondary" size="md">
            {t("components.moddbVisibility.notThisTime")}
          </FormButton>
          <FormButton onClick={() => refuse(MODDB_VISIBILITY_NEVER)} title={t("components.moddbVisibility.neverAsk")} variant="secondary" size="md">
            {t("components.moddbVisibility.neverAsk")}
          </FormButton>
        </ButtonsWrapper>
      </>
    </PopupDialogPanel>
  )
}

export default ModDbVisibilityPrompt
