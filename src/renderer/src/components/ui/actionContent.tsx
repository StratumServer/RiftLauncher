import { useCallback, useEffect, useRef, useState } from "react"
import { PiSpinnerGapDuotone } from "react-icons/pi"

/**
 * An action's icon and its label are one unit: the icon carries the recognition,
 * the label carries the meaning. Rendering them from the same `title` a button
 * already needs keeps them from drifting apart, and keeps a call site from
 * shipping an icon-only control whose meaning is only reachable by hovering.
 *
 * `children` still wins when a button's content is genuinely not that pairing.
 */
export function renderActionContent(children: React.ReactNode, icon: React.ReactNode, title: string, busy = false): React.ReactNode {
  const label = <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{title}</span>

  /*
   * A button must not resize when it starts working: a control that grows under the cursor is
   * how a second click lands somewhere else. So the spinner never joins the resting content, it
   * takes its place.
   *
   * With an icon there is already a slot the same size to take over, and the label stays put, so
   * the player can still read what is running. Without one — an icon-only tool button, or Play,
   * whose label is its own child — the resting content is kept in the layout at `invisible`, so
   * it goes on reserving exactly the box it had, and the spinner is laid over it.
   */
  if (busy) {
    if (icon !== undefined) {
      return (
        <>
          <span aria-hidden="true" className="flex shrink-0 items-center">
            <PiSpinnerGapDuotone className="animate-spin" />
          </span>
          {label}
        </>
      )
    }

    return (
      <>
        <span aria-hidden="true" className="invisible">
          {children}
        </span>
        <span className="absolute inset-0 flex items-center justify-center">
          <PiSpinnerGapDuotone className="animate-spin" />
        </span>
      </>
    )
  }

  if (children !== undefined) return children
  if (icon === undefined) return null

  return (
    <>
      <span aria-hidden="true" className="flex shrink-0 items-center">
        {icon}
      </span>
      {label}
    </>
  )
}

/**
 * Work a button starts is work the player can start again while it runs: launching the game,
 * writing an installation, deleting a version. Every one of those handlers is async, and until
 * it settles the button looks exactly as it did before the click, so a second and third press
 * are the natural thing to do.
 *
 * Rather than ask each page to carry its own pending flag, a handler that returns a promise is
 * treated as the signal: the button disables itself and shows a spinner for as long as that
 * promise is unsettled. A synchronous handler returns undefined and nothing changes, so this is
 * inert for the buttons that only toggle local state.
 *
 * `busy` overrides it for the callers whose pending state is not the click's own promise, such
 * as a form submitted through onSubmit.
 */
export function useActionBusy(
  onClick: ((event: React.MouseEvent<HTMLButtonElement>) => void | Promise<unknown>) | undefined,
  busy: boolean | undefined,
  disabled: boolean | undefined
): { busy: boolean; onClick: (event: React.MouseEvent<HTMLButtonElement>) => void } {
  const [pending, setPending] = useState(false)
  // Several of these handlers navigate away or close the dialog they live in, so the button can
  // be gone by the time its promise settles.
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return (): void => {
      live.current = false
    }
  }, [])

  const isBusy = busy ?? pending

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (disabled || isBusy) return
      const result = onClick?.(event)
      if (!(result instanceof Promise)) return

      setPending(true)
      void result.finally(() => {
        if (live.current) setPending(false)
      })
    },
    [disabled, isBusy, onClick]
  )

  return { busy: isBusy, onClick: handleClick }
}
