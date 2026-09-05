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
 * `resetKey` is the current pathname, and a change to it clears the error: a player who reaches
 * the crashed page again gets a real attempt at rendering it, not a cached failure. That alone is
 * not a recovery path, though. The Home route is inside this boundary too, so a fallback that only
 * navigates home leaves `resetKey` at "/" when Home is what threw, React holds the boundary in its
 * error state until something changes it, and the one button does nothing at all. Hence `reset`:
 * the fallback's actions clear the state themselves and do not depend on the route changing.
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

  reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    return this.state.error ? <PageErrorFallback onReset={this.reset} /> : this.props.children
  }
}

/**
 * What the player sees instead of a blank window: what happened, that the rest of the launcher is
 * fine, where the log that explains it lives, and two ways out.
 *
 * Both clear the boundary first, then navigate. "Go to the main menu" is the one a player wants,
 * and on any page but Home it is enough on its own. Home is the case it cannot cover: if Home is
 * what threw, resetting re-renders it and it throws again, which is why the second action leads
 * somewhere that is not Home. Info & Help is the useful destination for it, since it is where the
 * text above says the logs are.
 */
function PageErrorFallback({ onReset }: Readonly<{ onReset: () => void }>): JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const actionRef = useRef<HTMLDivElement | null>(null)

  // The page the player was looking at just vanished, so keyboard focus is somewhere that no
  // longer exists. Parking it on the first action here is both the a11y fix and the useful default.
  useEffect(() => {
    actionRef.current?.querySelector("button")?.focus()
  }, [])

  function recoverTo(route: string): void {
    onReset()
    navigate(route)
  }

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
                <FormButton title={t("components.pageError.goHome")} onClick={() => recoverTo("/")} variant="primary" size="md" />
                <FormButton title={t("components.pageError.goToInfoAndHelp")} onClick={() => recoverTo("/info-and-help")} variant="secondary" size="md" />
              </ButtonsWrapper>
            </div>
          </div>
        </ListGroup>
      </ListWrapper>
    </div>
  )
}

export default PageErrorBoundary
