import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { PiCheckCircleDuotone, PiXCircleDuotone } from "react-icons/pi"

import { checkServerBookmark, DEFAULT_GAME_SERVER_PORT, MAX_GAME_SERVER_PORT, MAX_SERVER_BOOKMARK_NAME_LENGTH, MIN_GAME_SERVER_PORT } from "@domain/servers/bookmarks"
import type { ServerBookmarkProblem } from "@domain/servers/bookmarks"

import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import { ButtonsWrapper, FormBody, FormButton, FormGroupWrapper, FormHead, FormInputNumber, FormInputText, FormLabel, FromGroup, FromWrapper } from "@renderer/components/ui/FormComponents"

/** One message per problem the domain can report, so no refusal ever reaches a player unexplained. */
const PROBLEM_KEYS: Record<ServerBookmarkProblem, string> = {
  "empty-name": "features.servers.errorEmptyName",
  "name-too-long": "features.servers.errorNameTooLong",
  "control-character": "features.servers.errorControlCharacter",
  "invalid-host": "features.servers.errorInvalidHost",
  "invalid-port": "features.servers.errorInvalidPort",
  duplicate: "features.servers.errorDuplicate"
}

/**
 * Add or edit one server bookmark.
 *
 * The port hides behind an Advanced disclosure while it is the default one, which is the case for
 * almost every server anybody joins: the game's own Multiplayer screen says as much. A bookmark
 * being edited that carries a different port opens with the disclosure already down, so nothing a
 * player set is ever out of sight.
 */
function ServerBookmarkDialog({
  isOpen,
  close,
  onSave,
  server,
  existing
}: Readonly<{
  isOpen: boolean
  close: () => void
  /** Handed a validated bookmark. The caller owns writing it into the config. */
  onSave: (bookmark: ServerBookmarkType) => void
  /** The bookmark being edited, or null when this is a new one. */
  server: ServerBookmarkType | null
  /** This Installation's list, which is what the duplicate check reads. */
  existing: readonly ServerBookmarkType[]
}>): JSX.Element {
  const { t } = useTranslation()

  const [name, setName] = useState("")
  const [host, setHost] = useState("")
  const [port, setPort] = useState(DEFAULT_GAME_SERVER_PORT)
  const [problem, setProblem] = useState<ServerBookmarkProblem | null>(null)

  // Keyed off the dialog opening rather than off `server` alone, so reopening Add after a save
  // starts empty instead of showing what was typed last time.
  useEffect(() => {
    if (!isOpen) return
    setName(server?.name ?? "")
    setHost(server?.host ?? "")
    setPort(server?.port ?? DEFAULT_GAME_SERVER_PORT)
    setProblem(null)
  }, [isOpen, server])

  /** Clears the last refusal as soon as the player edits anything, so no message outlives its cause. */
  function edit<T>(set: (value: T) => void): (value: T) => void {
    return (value) => {
      setProblem(null)
      set(value)
    }
  }

  function save(): void {
    const checked = checkServerBookmark({ id: server?.id ?? crypto.randomUUID(), name, host, port }, existing)
    if (!checked.ok) return setProblem(checked.problem)
    onSave(checked.bookmark)
    close()
  }

  return (
    <PopupDialogPanel title={server ? t("features.servers.editServer") : t("features.servers.addServer")} isOpen={isOpen} close={close}>
      <>
        <FromWrapper className="w-full">
          <FromGroup>
            <FormHead>
              <FormLabel content={t("features.servers.serverName")} htmlFor="server-name" />
            </FormHead>
            <FormBody>
              <FormInputText id="server-name" value={name} onChange={(e) => edit(setName)(e.target.value)} maxLength={MAX_SERVER_BOOKMARK_NAME_LENGTH} autoFocus />
            </FormBody>
          </FromGroup>

          <FromGroup>
            <FormHead>
              <FormLabel content={t("features.servers.serverAddress")} htmlFor="server-host" />
            </FormHead>
            <FormBody>
              <FormInputText id="server-host" value={host} onChange={(e) => edit(setHost)(e.target.value)} placeholder="play.example.com" inputMode="url" autoComplete="off" />
            </FormBody>
          </FromGroup>

          {/* Open only when the stored port is not the default one: a player who set 30000 should
              see it without going looking, and everybody else should not have to look at a field
              they will never touch. The same Advanced section the Installation form already uses. */}
          <FormGroupWrapper title={t("generic.advanced")} startOpen={port !== DEFAULT_GAME_SERVER_PORT} bgDark={false} flush>
            <FromGroup>
              <FormHead>
                <FormLabel content={t("features.servers.serverPort")} htmlFor="server-port" />
              </FormHead>
              <FormBody>
                <FormInputNumber id="server-port" value={port} onChange={(e) => edit(setPort)(e.target.valueAsNumber)} min={MIN_GAME_SERVER_PORT} max={MAX_GAME_SERVER_PORT} />
              </FormBody>
            </FromGroup>
          </FormGroupWrapper>
        </FromWrapper>

        {problem && (
          <p role="alert" className="text-orange-300">
            {t(PROBLEM_KEYS[problem], { max: problem === "invalid-port" ? MAX_GAME_SERVER_PORT : MAX_SERVER_BOOKMARK_NAME_LENGTH, min: MIN_GAME_SERVER_PORT })}
          </p>
        )}

        <ButtonsWrapper className="text-base" bgDark={false} equalWidth flush>
          <FormButton title={t("generic.cancel")} onClick={close} variant="secondary" size="md" icon={<PiXCircleDuotone />} />
          <FormButton title={t("generic.save")} onClick={save} variant="primary" size="md" icon={<PiCheckCircleDuotone />} />
        </ButtonsWrapper>
      </>
    </PopupDialogPanel>
  )
}

export default ServerBookmarkDialog
