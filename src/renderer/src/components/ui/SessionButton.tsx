import { useState } from "react"
import { useTranslation } from "react-i18next"
import { AnimatePresence, motion } from "motion/react"
import clsx from "clsx"
import { PiCaretDownDuotone, PiInfoDuotone, PiShieldCheckDuotone, PiSignInDuotone, PiTrashDuotone, PiUserDuotone, PiUserPlusDuotone, PiXCircleDuotone } from "react-icons/pi"

import { Listbox, ListboxButton, ListboxOptions, ListboxOption } from "@headlessui/react"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { CONFIG_ACTIONS, useAccountList, useConfigDispatch } from "@renderer/features/config/contexts/ConfigContext"
import { loginToAccount as login, removeAccount as removeAccountSecrets } from "@renderer/features/account/adapters/account"
import { DROPDOWN_MENU_ITEM_VARIANTS, DROPDOWN_MENU_WRAPPER_VARIANTS } from "@renderer/utils/animateVariants"
import { NormalButton } from "@renderer/components/ui/Buttons"
import { useExternalLinks } from "@renderer/hooks/useExternalLinks"
import { MENU_OPTION_STYLES, MENU_TRIGGER_STYLES } from "@renderer/components/ui/buttonStyles"

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
const PRIVACY_POLICY_URL = "https://github.com/StratumServer/RiftLauncher/blob/main/PRIVACY.md"

function SessionButton(): JSX.Element {
  const { t } = useTranslation()
  const { accounts, activeAccountId } = useAccountList()
  const activeAccount = accounts.find((account) => account.playerUid === activeAccountId) ?? null
  const configDispatch = useConfigDispatch()
  const { addNotification } = useNotificationsContext()
  const { openOnBrowser } = useExternalLinks()

  // Log In states
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [twofacode, setTwofacode] = useState("")
  const [showPassword, setShowPassword] = useState(false)

  const [loggingIn, setLoggingIn] = useState(false)
  const [logInOpen, setLogInOpen] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)

  function clearTransientLoginFields(): void {
    setPassword("")
    setTwofacode("")
    setShowPassword(false)
  }

  function openLogin(): void {
    setLogInOpen(true)
  }

  function closeLogin(): void {
    if (loggingIn) return
    clearTransientLoginFields()
    setLogInOpen(false)
  }

  async function handleLogin(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (loggingIn) return
    setLoggingIn(true)
    addNotification(t("features.config.loggingin"), "info")

    // Thanks a lot to https://github.com/scgm0 for teaching me how to login using the Vintage Story Game Account

    try {
      const result = await login(email, password, twofacode || undefined)
      if (result.status === "wrong-two-factor") return addNotification(t("features.config.wrongtwofa"), "error")
      if (result.status === "invalid-credentials") return addNotification(t("features.config.invalidEmailPass"), "error")
      if (result.status === "requires-two-factor") return addNotification(t("features.config.requiresTwoFA"), "error")
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
      clearTransientLoginFields()
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
    if (value === ADD_ACCOUNT_OPTION) return openLogin()
    if (value === REMOVE_ACCOUNT_OPTION) setRemoveOpen(true)
  }

  return (
    <>
      {accounts.length < 1 ? (
        <FormButton onClick={openLogin} title={t("features.config.loginTitle")} variant="primary" className="w-full h-8">
          <PiUserDuotone aria-hidden="true" />
          <p className="text-sm overflow-hidden text-ellipsis whitespace-nowrap">{t("features.config.loginTitle")}</p>
        </FormButton>
      ) : (
        <Listbox value={activeAccountId} onChange={handleSelect}>
          {({ open }) => (
            <>
              <ListboxButton title={t("features.config.switchAccountTitle")} className={clsx(MENU_TRIGGER_STYLES, "w-full")}>
                <p className="flex items-center gap-2 overflow-hidden">
                  <PiUserDuotone aria-hidden="true" className="shrink-0" />
                  <span className="text-sm overflow-hidden text-ellipsis whitespace-nowrap">{activeAccount?.playerName ?? t("features.config.loginTitle")}</span>
                </p>
                <PiCaretDownDuotone aria-hidden="true" className={clsx("caret-optical shrink-0 duration-200", open && "-rotate-180")} />
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
                          className={clsx(MENU_OPTION_STYLES, "flex-col odd:bg-zinc-800/30 even:bg-zinc-950/30", account.playerUid === activeAccountId && "text-vsl")}
                        >
                          <span className="overflow-hidden text-ellipsis whitespace-nowrap">{account.playerName}</span>
                          <span className="text-xs text-zinc-400 overflow-hidden text-ellipsis whitespace-nowrap">{account.email}</span>
                        </ListboxOption>
                      ))}

                      <div className="w-full h-px bg-zinc-400/10 shrink-0" />

                      <ListboxOption value={ADD_ACCOUNT_OPTION} as={motion.li} variants={DROPDOWN_MENU_ITEM_VARIANTS} className={clsx(MENU_OPTION_STYLES, "odd:bg-zinc-800/30 even:bg-zinc-950/30")}>
                        <PiUserPlusDuotone aria-hidden="true" className="shrink-0" />
                        <span>{t("features.config.addAnotherAccount")}</span>
                      </ListboxOption>

                      {activeAccount && (
                        <ListboxOption
                          value={REMOVE_ACCOUNT_OPTION}
                          as={motion.li}
                          variants={DROPDOWN_MENU_ITEM_VARIANTS}
                          className={clsx(MENU_OPTION_STYLES, "text-red-300 odd:bg-zinc-800/30 even:bg-zinc-950/30")}
                        >
                          <PiTrashDuotone aria-hidden="true" className="shrink-0" />
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

      <PopupDialogPanel title={t("features.config.loginDialogTitle")} isOpen={logInOpen} close={closeLogin} scrollBody>
        <FromWrapper className="w-full min-h-0 flex-auto">
          <form onSubmit={handleLogin} className="flex w-full min-h-0 flex-auto flex-col items-center gap-2">
            <div className="flex w-full min-h-0 flex-auto flex-col items-center gap-2 overflow-y-auto">
              <FormGroupWrapper bgDark={false} flush>
                <FromGroup>
                  <FormHead>
                    <FormLabel content={t("generic.email")} htmlFor="login-email" />
                  </FormHead>

                  <FormBody>
                    <FormFieldGroup>
                      <FormInputText
                        id="login-email"
                        name="email"
                        type="email"
                        inputMode="email"
                        autoComplete="username"
                        autoFocus
                        required
                        placeholder={t("generic.emailPlaceholder")}
                        className="w-full"
                        value={email}
                        onChange={(e) => {
                          setEmail(e.target.value)
                        }}
                        readOnly={loggingIn}
                      />
                    </FormFieldGroup>
                  </FormBody>
                </FromGroup>

                <FromGroup>
                  <FormHead>
                    <FormLabel content={t("generic.password")} htmlFor="login-password" />
                  </FormHead>

                  <FormBody>
                    <FormFieldGroup>
                      {/*
                        The placeholder is a masking pattern, not guidance: placeholder text
                        disappears the moment the field is used, so a password field must not
                        carry anything the player still needs to read.
                      */}
                      <FormInputPassword
                        id="login-password"
                        name="password"
                        autoComplete="current-password"
                        required
                        placeholder="••••••••"
                        className="w-full"
                        value={password}
                        onChange={(e) => {
                          setPassword(e.target.value)
                        }}
                        readOnly={loggingIn}
                        showPassword={showPassword}
                        onToggleVisibility={() => setShowPassword((visible) => !visible)}
                        visibilityLabel={t(showPassword ? "features.config.hidePassword" : "features.config.showPassword")}
                      />
                    </FormFieldGroup>
                  </FormBody>
                </FromGroup>

                <FromGroup>
                  <FormHead>
                    <FormLabel content={t("generic.twofacode")} htmlFor="login-two-factor" />
                  </FormHead>

                  <FormBody>
                    <FormFieldGroupWithDescription>
                      <FormInputText
                        id="login-two-factor"
                        name="one-time-code"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                        placeholder="000000"
                        className="w-full"
                        value={twofacode}
                        onChange={(e) => {
                          setTwofacode(e.target.value.replace(/\D/g, "").slice(0, 6))
                        }}
                        ariaDescribedBy="login-two-factor-help"
                        readOnly={loggingIn}
                      />
                      <FormFieldDescription
                        id="login-two-factor-help"
                        className="flex-nowrap items-start"
                        content={
                          <>
                            <PiInfoDuotone aria-hidden="true" className="mt-0.5 shrink-0 text-vsl" />
                            <span className="flex-1">{t("features.config.onlyIfEnabledTwoFA")}</span>
                          </>
                        }
                      />
                    </FormFieldGroupWithDescription>
                  </FormBody>
                </FromGroup>
              </FormGroupWrapper>

              <aside aria-labelledby="login-privacy-title" className="w-full rounded-md border border-vsl/30 bg-vsl/5 px-3 py-2.5 text-left text-sm">
                <div className="flex items-start gap-2">
                  <PiShieldCheckDuotone aria-hidden="true" className="mt-0.5 shrink-0 text-vsl" />
                  <div className="flex flex-col gap-1.5">
                    <h2 id="login-privacy-title" className="font-semibold">
                      {t("features.config.loginPrivacyTitle")}
                    </h2>
                    <p className="text-zinc-300">{t("features.config.loginPrivacySent")}</p>
                    <p className="text-zinc-300">{t("features.config.loginPrivacyStored")}</p>
                    <p className="text-zinc-300">{t("features.config.loginPrivacyGame")}</p>
                    <NormalButton onClick={() => openOnBrowser(PRIVACY_POLICY_URL)} title={t("features.config.loginPrivacyPolicy")} variant="link" className="w-fit text-left">
                      {t("features.config.loginPrivacyPolicy")}
                    </NormalButton>
                  </div>
                </div>
              </aside>
            </div>

            <ButtonsWrapper className="text-base" bgDark={false} equalWidth flush>
              <FormButton onClick={closeLogin} title={t("generic.cancel")} icon={<PiXCircleDuotone />} variant="secondary" size="md" disabled={loggingIn} />
              <FormButton nativeType="submit" title={t("features.config.loginAction")} icon={<PiSignInDuotone />} variant="primary" size="md" busy={loggingIn} />
            </ButtonsWrapper>
          </form>
        </FromWrapper>
      </PopupDialogPanel>

      <PopupDialogPanel title={t("features.config.removeAccountTitle", { user: activeAccount?.playerName ?? "" })} isOpen={removeOpen} close={() => setRemoveOpen(false)}>
        <>
          <p>{t("features.config.areYouSureRemoveAccount", { user: activeAccount?.playerName ?? "" })}</p>
          <p className="text-zinc-400">{t("features.config.removeAccountNotReversible")}</p>
          <ButtonsWrapper className="text-base" bgDark={false} equalWidth flush>
            <FormButton title={t("generic.cancel")} icon={<PiXCircleDuotone />} size="md" onClick={() => setRemoveOpen(false)} variant="secondary" />
            <FormButton
              title={t("features.config.removeAccountAction")}
              icon={<PiTrashDuotone />}
              size="md"
              onClick={(e) => {
                e.stopPropagation()
                handleRemove()
              }}
              variant="destructive"
            />
          </ButtonsWrapper>
        </>
      </PopupDialogPanel>
    </>
  )
}

export default SessionButton
