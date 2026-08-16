import { useState } from "react"
import { useTranslation } from "react-i18next"
import { PiFloppyDiskBackDuotone, PiTrashDuotone, PiUserDuotone, PiXCircleDuotone } from "react-icons/pi"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { CONFIG_ACTIONS, useAccount, useConfigDispatch } from "@renderer/features/config/contexts/ConfigContext"
import { useAccountSession } from "@renderer/features/account/hooks/useAccountSession"

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

function SessionButton(): JSX.Element {
  const { t } = useTranslation()
  const account = useAccount()
  const configDispatch = useConfigDispatch()
  const { addNotification } = useNotificationsContext()
  const { login, logout } = useAccountSession()

  // Log In states
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [twofacode, setTwofacode] = useState("")

  const [loggingIn, setLoggingIn] = useState(false)
  const [logInOpen, setLogInOpen] = useState(false)
  const [logOutOpen, setLogOutOpen] = useState(false)

  async function handleLogin(): Promise<void> {
    setLoggingIn(true)
    addNotification(t("features.config.loggingin"), "info")

    // Thanks a lot to https://github.com/scgm0 for teaching me how to login using the Vintage Story Game Account
    // If you're reading this, make sure to check out MVL https://github.com/scgm0/MVL

    try {
      const result = await login(email, password, twofacode || undefined)
      if (result.status === "wrong-two-factor") return addNotification(t("features.config.wrongtwofa"), "error")
      if (result.status === "invalid-credentials") return addNotification(t("features.config.invalidEmailPass"), "error")
      if (result.status === "requires-two-factor") return addNotification(t("features.config.wrongtwofa"), "error")
      if (result.status === "unexpected-response") return addNotification(t("features.config.unexpectedResponse"), "error")
      if (result.status !== "success") return

      await saveLogin(result.account)
    } catch {
      addNotification(t("features.config.invalidEmailPass"), "error")
    } finally {
      setPassword("")
      setTwofacode("")
      setLoggingIn(false)
    }
  }

  async function handleLogout(): Promise<void> {
    const loggedOut = await logout()
    if (!loggedOut) return addNotification(t("features.config.invalidEmailPass"), "error")
    configDispatch({ type: CONFIG_ACTIONS.SET_ACCOUNT, payload: null })
    addNotification(t("features.config.loggedout"), "success")
    setLogOutOpen(false)
  }

  async function saveLogin(newAccount: AccountPublicType): Promise<void> {
    configDispatch({ type: CONFIG_ACTIONS.SET_ACCOUNT, payload: newAccount })

    addNotification(t("features.config.loggedin", { user: newAccount.playerName }), "success")
    setLoggingIn(false)
    setLogInOpen(false)
  }

  return (
    <>
      <FormButton
        onClick={() => {
          if (!account) {
            setLogInOpen(true)
          } else {
            setLogOutOpen(true)
          }
        }}
        title={!account ? t("features.config.loginTitle") : t("features.config.logoutTitle")}
        className="w-full h-8"
      >
        <PiUserDuotone />

        <p className="text-sm overflow-hidden text-ellipsis whitespace-nowrap">{!account ? t("features.config.loginTitle") : account.playerName}</p>
      </FormButton>

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

      <PopupDialogPanel title={t("features.config.logoutTitle")} isOpen={logOutOpen} close={() => setLogOutOpen(false)}>
        <>
          <p>{t("features.config.areYouSureLogout")}</p>
          <p className="text-zinc-400">{t("features.config.loginoutNotReversible")}</p>
          <div className="flex gap-4 items-center justify-center text-lg">
            <FormButton title={t("generic.cancel")} className="p-2" onClick={() => setLogOutOpen(false)} type="success">
              <PiXCircleDuotone />
            </FormButton>
            <FormButton
              title={t("features.config.logoutTitle")}
              className="p-2"
              onClick={(e) => {
                e.stopPropagation()
                handleLogout()
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
