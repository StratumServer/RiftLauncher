import { lazy, Suspense, useEffect, useState } from "react"
import { HashRouter as Router, Route, Routes, useLocation } from "react-router-dom"
import { FiLoader } from "react-icons/fi"
import { useTranslation } from "react-i18next"
import { AnimatePresence, motion } from "motion/react"
import clsx from "clsx"

import { ConfigProvider } from "@renderer/features/config/contexts/ConfigContext"
import { NotificationsProvider } from "@renderer/contexts/NotificationsContext"
import { TaskProvider } from "@renderer/contexts/TaskManagerContext"

import { changeLanguage } from "./i18n"
import NotificationsOverlay from "@renderer/components/layout/NotificationsOverlay"

import MainMenu from "@renderer/components/layout/MainMenu"
import GlobalActionsWrapper from "@renderer/components/layout/GlobalActionsWrapper"
import DeferredGlobalModUpdateChecker from "@renderer/components/layout/DeferredGlobalModUpdateChecker"
import ModDbVisibilityPrompt from "@renderer/components/layout/ModDbVisibilityPrompt"

const HomePage = lazy(() => import("@renderer/features/home/pages/HomePage"))
const ListInslallations = lazy(() => import("@renderer/features/installations/pages/ListInstallations"))
const AddInslallation = lazy(() => import("@renderer/features/installations/pages/AddInstallation"))
const EditInslallation = lazy(() => import("@renderer/features/installations/pages/EditInstallation"))
const ManageInstallationBackups = lazy(() => import("@renderer/features/installations/pages/ManageInstallationBackups"))
const ManageInstallationMods = lazy(() => import("@renderer/features/installations/pages/ManageMods"))
const ListVersions = lazy(() => import("@renderer/features/versions/pages/ListVersions"))
const AddVersion = lazy(() => import("@renderer/features/versions/pages/AddVersion"))
const LookForAVersion = lazy(() => import("@renderer/features/versions/pages/LookForAVersion"))
const ListMods = lazy(() => import("@renderer/features/mods/pages/ListMods"))
const ConfigPage = lazy(() => import("@renderer/features/config/pages/ConfigPage"))
const InfoAndHelpPage = lazy(() => import("./features/info/pages/InfoAndHelpPage"))

function App(): JSX.Element {
  useEffect(() => {
    document.documentElement.setAttribute("data-uiscale", window.localStorage.getItem("uiScale") || "100")

    const lang = window.localStorage.getItem("lang")
    if (lang) void changeLanguage(lang)
  }, [])

  return (
    // NotificationsProvider wraps ConfigProvider, not the other way around:
    // ConfigContext's SAVE_CONFIG effect calls useNotificationsContext to
    // report save failures, which only resolves to a real provider (not the
    // no-op default) when NotificationsProvider is an ancestor.
    <NotificationsProvider>
      <ConfigProvider>
        <TaskProvider>
          <Router>
            <GlobalActionsWrapper>
              <DeferredGlobalModUpdateChecker />
              <div
                className={clsx(
                  "relative w-screen h-screen select-none bg-image-vs bg-center bg-cover",
                  "before:absolute before:left-0 before:top-0 before:w-full before:h-full before:backdrop-blur-[2px]"
                )}
              >
                <div className="w-full h-full flex bg-zinc-950/70">
                  <Loader />

                  <MainMenu />

                  <main className="relative w-full h-full flex-1">
                    <Suspense fallback={<RouteLoader />}>
                      <AnimatedRoutes />
                    </Suspense>
                  </main>

                  <NotificationsOverlay />

                  <ModDbVisibilityPrompt />
                </div>
              </div>
            </GlobalActionsWrapper>
          </Router>
        </TaskProvider>
      </ConfigProvider>
    </NotificationsProvider>
  )
}

function AnimatedRoutes(): JSX.Element {
  const location = useLocation()

  return (
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.pathname}>
        <Route path="/" element={<AnimatedRoute element={<HomePage />} />} />
        <Route path="/installations" element={<AnimatedRoute element={<ListInslallations />} />} />
        <Route path="/installations/add" element={<AnimatedRoute element={<AddInslallation />} />} />
        <Route path="/installations/edit/:id" element={<AnimatedRoute element={<EditInslallation />} />} />
        <Route path="/installations/backups/:id" element={<AnimatedRoute element={<ManageInstallationBackups />} />} />
        <Route path="/installations/mods/:id" element={<AnimatedRoute element={<ManageInstallationMods />} />} />
        <Route path="/versions" element={<AnimatedRoute element={<ListVersions />} />} />
        <Route path="/versions/add" element={<AnimatedRoute element={<AddVersion />} />} />
        <Route path="/versions/look-for-a-version" element={<AnimatedRoute element={<LookForAVersion />} />} />
        <Route path="/mods" element={<AnimatedRoute element={<ListMods />} />} />
        <Route path="/config" element={<AnimatedRoute element={<ConfigPage />} />} />
        <Route path="/info-and-help" element={<AnimatedRoute element={<InfoAndHelpPage />} />} />
      </Routes>
    </AnimatePresence>
  )
}

function AnimatedRoute({ element }: Readonly<{ element: React.ReactElement }>): JSX.Element {
  return (
    <motion.div transition={{ duration: 0.1 }} initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="w-full h-full">
      {element}
    </motion.div>
  )
}

function Loader(): JSX.Element {
  const { t } = useTranslation()

  const [minTimeElapsed, setMinTimeElapsed] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => {
      setMinTimeElapsed(true)
    }, 2000)

    return (): void => clearTimeout(timer)
  }, [])

  return (
    <AnimatePresence>
      {!minTimeElapsed && (
        <motion.div
          initial={{ opacity: 1 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute top-0 left-0 w-full h-full flex items-center justify-center bg-image-vs bg-center bg-cover z-1000"
        >
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { delay: 0.5 } }}
            exit={{ opacity: 0 }}
            className="w-full h-full flex flex-col gap-4 items-center justify-center bg-zinc-950/70 backdrop-blur-xs"
          >
            <h1 className="text-4xl">{t("components.loader.title")}</h1>
            <p className="text-xl">{t("components.loader.desc")}</p>
            <p className="pt-4">
              <FiLoader className="animate-spin text-5xl text-zinc-400 " />
            </p>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function RouteLoader(): JSX.Element {
  return (
    <div className="w-full h-full flex items-center justify-center bg-zinc-950/20">
      <FiLoader className="animate-spin text-4xl text-zinc-400" />
    </div>
  )
}

export default App
