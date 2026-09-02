import { Dispatch, SetStateAction, useState } from "react"
import { useTranslation } from "react-i18next"
import { PiFloppyDiskBackDuotone, PiPlusCircleDuotone, PiXCircleDuotone } from "react-icons/pi"

import { useNotificationsContext } from "@renderer/contexts/NotificationsContext"
import { useConfigDispatch, CONFIG_ACTIONS } from "@renderer/features/config/contexts/ConfigContext"
import { useAddCustomIcon } from "@renderer/features/config/hooks/useAddCustomIcon"

import PopupDialogPanel from "./PopupDialogPanel"
import { ButtonsWrapper, FormBody, FormButton, FormFieldGroup, FormGroupWrapper, FormHead, FormInputText, FormLabel, FromGroup, FromWrapper } from "./FormComponents"

export function AddCustomIconPupup({ open, setOpen }: Readonly<{ open: boolean; setOpen: Dispatch<SetStateAction<boolean>> }>): JSX.Element {
  const { t } = useTranslation()
  const { addNotification } = useNotificationsContext()
  const configDispatch = useConfigDispatch()
  const pickAndCopyIcon = useAddCustomIcon()

  const [id, setId] = useState<string | undefined>(undefined)
  const [file, setFile] = useState<string | undefined>(undefined)
  const [name, setName] = useState<string>("")

  return (
    <PopupDialogPanel title={t("generic.addIcon")} isOpen={open} close={() => setOpen(false)}>
      <FromWrapper className="w-full">
        <FormGroupWrapper bgDark={false}>
          <FromGroup className="items-center">
            <FormHead>
              <FormLabel content={t("generic.icon")} />
            </FormHead>

            <FormBody>
              <FormFieldGroup alignment="x" className="items-center">
                <FormButton
                  title={t("generic.selectIcon")}
                  variant="secondary"
                  onClick={async (e) => {
                    e.stopPropagation()
                    const picked = await pickAndCopyIcon()
                    if (picked) {
                      setFile(picked.file)
                      setId(picked.id)
                    }
                  }}
                  className="w-14 h-14 p-1 shrink-0"
                >
                  {file ? <img src={`icons:${file}`} alt={t("generic.icon")} /> : <PiPlusCircleDuotone className="text-3xl text-zinc-400/70 group-hover:scale-95 duration-200" />}
                </FormButton>
                <FormInputText value={name} onChange={(e) => setName(e.target.value)} placeholder={t("generic.iconName")} className="w-full" />
              </FormFieldGroup>
            </FormBody>
          </FromGroup>
        </FormGroupWrapper>

        <ButtonsWrapper className="text-lg" bgDark={false} equalWidth>
          <FormButton onClick={() => setOpen(false)} title={t("generic.goBack")} variant="secondary" size="md" className="p-2">
            <PiXCircleDuotone />
          </FormButton>
          <FormButton
            onClick={(e) => {
              e.stopPropagation()
              if (!file || !name || name.length < 1 || !id || id.length < 1) return addNotification(t("notifications.body.missingFields"), "error")

              configDispatch({ type: CONFIG_ACTIONS.ADD_CUSTOM_ICON, payload: { id: id, icon: file, name: name, custom: true } })
              setId(undefined)
              setFile(undefined)
              setName("")
              setOpen(false)
            }}
            title={t("generic.add")}
            variant="primary"
            size="md"
            className="p-2"
          >
            <PiFloppyDiskBackDuotone />
          </FormButton>
        </ButtonsWrapper>
      </FromWrapper>
    </PopupDialogPanel>
  )
}
