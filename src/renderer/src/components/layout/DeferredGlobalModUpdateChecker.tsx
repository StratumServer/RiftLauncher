import { lazy, Suspense, useEffect, useState } from "react"

const GlobalModUpdateChecker = lazy(() => import("./GlobalModUpdateChecker"))

function DeferredGlobalModUpdateChecker(): JSX.Element | null {
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => setEnabled(true), 5_000)
    return (): void => window.clearTimeout(timer)
  }, [])

  if (!enabled) return null
  return (
    <Suspense fallback={null}>
      <GlobalModUpdateChecker />
    </Suspense>
  )
}

export default DeferredGlobalModUpdateChecker
