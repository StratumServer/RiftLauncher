import { Component, ReactNode, useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "react-router-dom"

import { logRenderError } from "@renderer/adapters/errorLog"
import { ListGroup, ListWrapper } from "@renderer/components/ui/List"
import { ButtonsWrapper, FormButton } from "@renderer/components/ui/FormComponents"

/**
 * Contains a render exception to the page it came from.
 *
 * It sits inside `<main>`, around the route element and nothing else, so the shell (main menu,
 * session button, activity center, notifications) stays mounted and usable while one page is
 * broken. A single boundary around the whole app would have turned every page bug into an app
 * with nothing left to click.
 *
 * `resetKey` is the current pathname. React keeps a boundary in its error state until something
 * changes it, and the fallback's own action navigates, so without this the launcher would show
 * the fallback for the rest of the session. Clearing on a pathname change also means a player who
 * reaches the crashed page again gets a real attempt at rendering it, not a cached failure.
 */
class PageErrorBoundary extends Component<Readonly<{ resetKey: string; children: ReactNode }>, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    logRenderError("PageErrorBoundary", error, info.componentStack)
  }

  componentDidUpdate(previous: Readonly<{ resetKey: string }>): void {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null })
  }

  render(): ReactNode {
    return this.state.error ? <PageErrorFallback /> : this.props.children
  }
}

/**
 * What the player sees instead of a blank window: what happened, that the rest of the launcher is
 * fine, where the log that explains it lives, and one way out.
 */
function PageErrorFallback(): JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const actionRef = useRef<HTMLDivElement | null>(null)

  // The page the player was looking at just vanished, so keyboard focus is somewhere that no
  // longer exists. Parking it on the one action here is both the a11y fix and the useful default.
  useEffect(() => {
    actionRef.current?.querySelector("button")?.focus()
  }, [])

  return (
    <div className="w-full h-full flex items-center justify-center p-4">
      <ListWrapper className="max-w-[40rem] w-full">
        <ListGroup>
          <div role="alert" aria-label={t("components.pageError.title")} className="w-full flex flex-col items-center justify-center gap-3 rounded-sm p-4 text-center">
            <p className="text-2xl">{t("components.pageError.title")}</p>
            <p className="text-zinc-300">{t("components.pageError.desc")}</p>
            <p className="text-sm text-zinc-400">{t("components.pageError.logsHint")}</p>

            <div ref={actionRef}>
              <ButtonsWrapper>
                <FormButton title={t("components.pageError.goHome")} onClick={() => navigate("/")} variant="primary" size="md" />
              </ButtonsWrapper>
            </div>
          </div>
        </ListGroup>
      </ListWrapper>
    </div>
  )
}

export default PageErrorBoundary
