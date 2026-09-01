import { useState } from "react"
import { useTranslation } from "react-i18next"
import { AnimatePresence, motion } from "motion/react"
import clsx from "clsx"
import { PiCaretDownDuotone, PiFloppyDiskBackDuotone, PiTrashDuotone, PiUserDuotone, PiUserPlusDuotone, PiXCircleDuotone } from "react-icons/pi"

import { Listbox, ListboxButton, ListboxOptions, ListboxOption } from "@headlessui/react"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { CONFIG_ACTIONS, useAccountList, useConfigDispatch } from "@renderer/features/config/contexts/ConfigContext"
import { loginToAccount as login, removeAccount as removeAccountSecrets } from "@renderer/features/account/adapters/account"
import { DROPDOWN_MENU_ITEM_VARIANTS, DROPDOWN_MENU_WRAPPER_VARIANTS } from "@renderer/utils/animateVariants"

import {
  ButtonsWrapper,
  FormBody,
  FormButton,
  FormFieldDescription,
  FormFieldGroup,
  FormFieldGroupWithDescription,
  FormGroupWrapper,
  FormHead,
  FormInputPassword,
  FormInputText,
  FormLabel,
  FromGroup,
  FromWrapper
} from "@renderer/components/ui/FormComponents"
import PopupDialogPanel from "@renderer/components/ui/PopupDialogPanel"

// Sentinel option values a real playerUid cannot collide with in practice: `handleSelect` checks
// list membership first regardless, so even a collision would resolve to the switch, never these.
const ADD_ACCOUNT_OPTION = "__add-account__"
const REMOVE_ACCOUNT_OPTION = "__remove-account__"

function SessionButton(): JSX.Element {
  const { t } = useTranslation()
  const { accounts, activeAccountId } = useAccountList()
  const activeAccount = accounts.find((account) => account.playerUid === activeAccountId) ?? null
  const configDispatch = useConfigDispatch()
  const { addNotification } = useNotificationsContext()

  // Log In states
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [twofacode, setTwofacode] = useState("")

  const [loggingIn, setLoggingIn] = useState(false)
  const [logInOpen, setLogInOpen] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)

  async function handleLogin(): Promise<void> {
    setLoggingIn(true)
    addNotification(t("features.config.loggingin"), "info")

    // Thanks a lot to https://github.com/scgm0 for teaching me how to login using the Vintage Story Game Account

    try {
      const result = await login(email, password, twofacode || undefined)
      if (result.status === "wrong-two-factor") return addNotification(t("features.config.wrongtwofa"), "error")
      if (result.status === "invalid-credentials") return addNotification(t("features.config.invalidEmailPass"), "error")
      if (result.status === "requires-two-factor") return addNotification(t("features.config.wrongtwofa"), "error")
      if (result.status === "unexpected-response") return addNotification(t("features.config.unexpectedResponse"), "error")
      if (result.status === "session-store-unreadable") return addNotification(t("features.config.sessionStoreUnreadable"), "error")
      if (result.status !== "success") return

      if (result.storeRebuilt) addNotification(t("features.config.sessionStoreRebuilt"), "warning")
      await saveLogin(result.account)
    } catch {
      // A throw here means the request never produced a verdict (network down,
      // firewall, service unreachable): the credentials were never judged, so
      // saying they were wrong sends the user to reset a working password.
      addNotification(t("features.config.loginUnreachable"), "error")
    } finally {
      setPassword("")
      setTwofacode("")
      setLoggingIn(false)
    }
  }

  async function handleRemove(): Promise<void> {
    if (!activeAccount) return
    const removed = await removeAccountSecrets(activeAccount.playerUid)
    if (!removed) return addNotification(t("features.config.removeAccountFailed"), "error")

    // The IPC call lands first: dropping the config entry before the secrets are confirmed gone
    // would leave a secret in the store with no account naming it and no way back to it.
    configDispatch({ type: CONFIG_ACTIONS.REMOVE_ACCOUNT, payload: { playerUid: activeAccount.playerUid } })
    addNotification(t("features.config.accountRemoved", { user: activeAccount.playerName }), "success")
    setRemoveOpen(false)
  }

  async function saveLogin(newAccount: AccountPublicType): Promise<void> {
    configDispatch({ type: CONFIG_ACTIONS.ADD_ACCOUNT, payload: newAccount })

    addNotification(t("features.config.loggedin", { user: newAccount.playerName }), "success")
    setLoggingIn(false)
    setLogInOpen(false)
  }

  function handleSelect(value: string): void {
    if (accounts.some((account) => account.playerUid === value)) {
      configDispatch({ type: CONFIG_ACTIONS.SET_ACTIVE_ACCOUNT, payload: value })
      return
    }
    if (value === ADD_ACCOUNT_OPTION) return setLogInOpen(true)
    if (value === REMOVE_ACCOUNT_OPTION) setRemoveOpen(true)
  }

  return (
    <>
      {accounts.length < 1 ? (
        <FormButton onClick={() => setLogInOpen(true)} title={t("features.config.loginTitle")} className="w-full h-8">
          <PiUserDuotone />
          <p className="text-sm overflow-hidden text-ellipsis whitespace-nowrap">{t("features.config.loginTitle")}</p>
        </FormButton>
      ) : (
        <Listbox value={activeAccountId} onChange={handleSelect}>
          {({ open }) => (
            <>
              <ListboxButton
                title={t("features.config.switchAccountTitle")}
                className="w-full h-8 px-2 py-1 flex items-center justify-between gap-2 rounded-sm overflow-hidden border border-zinc-400/5 bg-zinc-950/50 shadow-sm shadow-zinc-950/50 hover:shadow-none cursor-pointer"
              >
                <p className="flex items-center gap-2 overflow-hidden">
                  <PiUserDuotone className="shrink-0" />
                  <span className="text-sm overflow-hidden text-ellipsis whitespace-nowrap">{activeAccount?.playerName ?? t("features.config.loginTitle")}</span>
                </p>
                <PiCaretDownDuotone className={clsx("shrink-0 duration-200", open && "-rotate-180")} />
              </ListboxButton>

              <AnimatePresence>
                {open && (
                  <ListboxOptions static anchor="bottom" className="w-[var(--button-width)] z-600 mt-1 select-none rounded-sm overflow-hidden">
                    <motion.ul
                      variants={DROPDOWN_MENU_WRAPPER_VARIANTS}
                      initial="initial"
                      animate="animate"
                      exit="exit"
                      className="max-h-60 flex flex-col bg-zinc-950/50 backdrop-blur-md border border-zinc-400/5 shadow-sm shadow-zinc-950/50 hover:shadow-none rounded-sm overflow-y-scroll text-sm"
                    >
                      {accounts.map((account) => (
                        <ListboxOption
                          key={account.playerUid}
                          value={account.playerUid}
                          as={motion.li}
                          variants={DROPDOWN_MENU_ITEM_VARIANTS}
                          className={clsx(
                            "w-full px-2 py-1 shrink-0 flex flex-col overflow-hidden odd:bg-zinc-800/30 even:bg-zinc-950/30 cursor-pointer",
                            account.playerUid === activeAccountId && "text-vsl"
                          )}
                        >
                          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{account.playerName}</span>
                          <span className="text-xs text-zinc-400 overflow-hidden text-ellipsis whitespace-nowrap">{account.email}</span>
                        </ListboxOption>
                      ))}

                      <div className="w-full h-px bg-zinc-400/10 shrink-0" />

                      <ListboxOption
                        value={ADD_ACCOUNT_OPTION}
                        as={motion.li}
                        variants={DROPDOWN_MENU_ITEM_VARIANTS}
                        className="w-full px-2 py-1 shrink-0 flex items-center gap-2 odd:bg-zinc-800/30 even:bg-zinc-950/30 cursor-pointer"
                      >
                        <PiUserPlusDuotone className="shrink-0" />
                        <span>{t("features.config.addAnotherAccount")}</span>
                      </ListboxOption>

                      {activeAccount && (
                        <ListboxOption
                          value={REMOVE_ACCOUNT_OPTION}
                          as={motion.li}
                          variants={DROPDOWN_MENU_ITEM_VARIANTS}
                          className="w-full px-2 py-1 shrink-0 flex items-center gap-2 text-red-700 odd:bg-zinc-800/30 even:bg-zinc-950/30 cursor-pointer"
                        >
                          <PiTrashDuotone className="shrink-0" />
                          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{t("features.config.removeAccountTitle", { user: activeAccount.playerName })}</span>
                        </ListboxOption>
                      )}
                    </motion.ul>
                  </ListboxOptions>
                )}
              </AnimatePresence>
            </>
          )}
        </Listbox>
      )}

      <PopupDialogPanel title={t("features.config.loginTitle")} isOpen={logInOpen} close={() => setLogInOpen(false)}>
        <FromWrapper className="w-full">
          <FormGroupWrapper bgDark={false}>
            <FromGroup>
              <FormHead>
                <FormLabel content={t("generic.email")} />
              </FormHead>

              <FormBody>
                <FormFieldGroup>
                  <FormInputText
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value)
                    }}
                    placeholder={t("generic.email")}
                    readOnly={loggingIn}
                  />
                </FormFieldGroup>
              </FormBody>
            </FromGroup>

            <FromGroup>
              <FormHead>
                <FormLabel content={t("generic.password")} />
              </FormHead>

              <FormBody>
                <FormFieldGroup>
                  <FormInputPassword
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value)
                    }}
                    placeholder={t("generic.password")}
                    readOnly={loggingIn}
                  />
                </FormFieldGroup>
              </FormBody>
            </FromGroup>

            <FromGroup>
              <FormHead>
                <FormLabel content={t("generic.twofacode")} />
              </FormHead>

              <FormBody>
                <FormFieldGroupWithDescription>
                  <FormInputText
                    value={twofacode}
                    onChange={(e) => {
                      setTwofacode(e.target.value)
                    }}
                    placeholder={t("generic.twofacode")}
                    minLength={6}
                    maxLength={6}
                    readOnly={loggingIn}
                  />
                  <FormFieldDescription content={t("features.config.onlyIfEnabledTwoFA")} />
                </FormFieldGroupWithDescription>
              </FormBody>
            </FromGroup>
          </FormGroupWrapper>

          <ButtonsWrapper className="text-lg" bgDark={false}>
            <FormButton onClick={() => setLogInOpen(false)} title={t("generic.goBack")} type="error" className="p-2">
              <PiXCircleDuotone />
            </FormButton>
            <FormButton onClick={handleLogin} title={t("generic.add")} type="success" className="p-2">
              <PiFloppyDiskBackDuotone />
            </FormButton>
          </ButtonsWrapper>
        </FromWrapper>
      </PopupDialogPanel>

      <PopupDialogPanel title={t("features.config.removeAccountTitle", { user: activeAccount?.playerName ?? "" })} isOpen={removeOpen} close={() => setRemoveOpen(false)}>
        <>
          <p>{t("features.config.areYouSureRemoveAccount", { user: activeAccount?.playerName ?? "" })}</p>
          <p className="text-zinc-400">{t("features.config.removeAccountNotReversible")}</p>
          <div className="flex gap-4 items-center justify-center text-lg">
            <FormButton title={t("generic.cancel")} className="p-2" onClick={() => setRemoveOpen(false)} type="success">
              <PiXCircleDuotone />
            </FormButton>
            <FormButton
              title={t("features.config.removeAccountTitle", { user: activeAccount?.playerName ?? "" })}
              className="p-2"
              onClick={(e) => {
                e.stopPropagation()
                handleRemove()
              }}
              type="error"
            >
              <PiTrashDuotone />
            </FormButton>
          </div>
        </>
      </PopupDialogPanel>
    </>
  )
}

export default SessionButton
