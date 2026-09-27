import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Input } from "@headlessui/react"
import { PiCheckCircleDuotone, PiXCircleDuotone } from "react-icons/pi"

import { checkServerBookmark, formatServerAddress, MAX_SERVER_BOOKMARKS } from "@domain/servers/bookmarks"

import { useConfigDispatch, CONFIG_ACTIONS } from "@renderer/features/config/contexts/ConfigContext"
import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"

import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"
import { ButtonsWrapper, FormButton } from "@renderer/components/ui/FormComponents"

/**
 * What a modpack's server list gets before any of it reaches the config.
 *
 * A modpack is a stranger's file, so this dialog is the only thing between it and the
 * Installation: every carried server is listed, each one is a checkbox the player can clear, and
 * nothing is added until they press the button. The boxes default to ON, which is the opposite of
 * the export side's default and for the same reason: adding an address to your own launcher
 * discloses nothing, putting one in a file you hand around does.
 *
 * Each chosen entry is re-checked and given an id of ours rather than the pack's, so importing the
 * same pack twice cannot collide and a duplicate address is quietly skipped the way the Add dialog
 * refuses one.
 */
function ImportServersDialog({
  servers,
  installation,
  close
}: Readonly<{
  /** The servers the pack carried, or null when it carried none and this dialog stays shut. */
  servers: readonly ServerBookmarkType[] | null
  installation: InstallationType | undefined
  close: () => void
}>): JSX.Element {
  const { t } = useTranslation()
  const configDispatch = useConfigDispatch()
  const { addNotification } = useNotificationsContext()

  const [chosen, setChosen] = useState<readonly string[]>([])

  useEffect(() => {
    setChosen(servers?.map((server) => server.id) ?? [])
  }, [servers])

  function addChosen(): void {
    if (!installation || !servers) return close()

    const existing = [...(installation.servers ?? [])]
    let added = 0

    for (const server of servers) {
      if (!chosen.includes(server.id)) continue
      if (existing.length >= MAX_SERVER_BOOKMARKS) break
      const checked = checkServerBookmark({ id: crypto.randomUUID(), name: server.name, host: server.host, port: server.port }, existing)
      if (!checked.ok) continue
      existing.push(checked.bookmark)
      added += 1
    }

    if (added > 0) {
      configDispatch({ type: CONFIG_ACTIONS.EDIT_INSTALLATION, payload: { id: installation.id, updates: { servers: existing } } })
      addNotification(t("features.servers.serversImported", { count: added }), "success")
    }

    close()
  }

  return (
    <PopupDialogPanel title={t("features.servers.importServersTitle")} isOpen={servers !== null} close={close}>
      <>
        <p>{t("features.servers.importServersDesc", { count: servers?.length ?? 0 })}</p>

        <ul className="w-full flex flex-col gap-1 text-left">
          {servers?.map((server) => (
            <li key={server.id} className="flex items-center gap-2 rounded-sm bg-zinc-950/50 px-2 py-1">
              <Input
                id={`import-server-${server.id}`}
                type="checkbox"
                checked={chosen.includes(server.id)}
                onChange={(e) => setChosen((current) => (e.target.checked ? [...current, server.id] : current.filter((id) => id !== server.id)))}
              />
              <label htmlFor={`import-server-${server.id}`} className="flex-1 overflow-hidden">
                <span className="block truncate font-bold">{server.name}</span>
                <span className="block truncate text-sm text-zinc-300">{formatServerAddress(server)}</span>
              </label>
            </li>
          ))}
        </ul>

        <ButtonsWrapper className="text-base" bgDark={false} equalWidth flush>
          <FormButton title={t("features.servers.importServersSkip")} onClick={close} variant="secondary" size="md" icon={<PiXCircleDuotone />} />
          <FormButton title={t("features.servers.importServersAdd")} onClick={addChosen} variant="primary" size="md" icon={<PiCheckCircleDuotone />} />
        </ButtonsWrapper>
      </>
    </PopupDialogPanel>
  )
}

export default ImportServersDialog
