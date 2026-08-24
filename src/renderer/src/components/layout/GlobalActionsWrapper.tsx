import { ReactNode } from "react"

import { useNotifyOnPreventedAppClose } from "@renderer/features/launch/hooks/useNotifyOnPreventedAppClose"

/**
 * This is a little workaround to execute hooks that need to acces configs, notifications... but need to be execute globally and not
 * when opening a page or something.
 *
 * Maybe there are better options but this one is clean, easy to unserstand and read... is perfect!
 *
 * @param {Object} props
 * @param {ReactNode} [props.children] All the content to be rendered.
 * @returns {JSX.Element} Wrapper with NOTHING. Literally nothing. Just children. return <>{children}</>
 */
function GlobalActionsWrapper({ children }: Readonly<{ children: ReactNode }>): JSX.Element {
  useNotifyOnPreventedAppClose()

  return <>{children}</>
}

export default GlobalActionsWrapper
