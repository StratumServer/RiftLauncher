export const DEFAULT_LOADED_MODS = 45

export type ModsBrowseState = {
  textFilter: string
  authorFilter: DownloadableModAuthorType
  versionsFilter: DownloadableModGameVersionType[]
  tagsFilter: DownloadableModTagType[]
  sideFilter: string
  installedFilter: string
  onlyFav: boolean
  orderBy: string
  orderByOrder: string
  visibleMods: number
  scrollTop: number
}

function createInitialState(): ModsBrowseState {
  return {
    textFilter: "",
    authorFilter: { userid: "", name: "" },
    versionsFilter: [],
    tagsFilter: [],
    sideFilter: "any",
    installedFilter: "all",
    onlyFav: false,
    orderBy: "follows",
    orderByOrder: "desc",
    visibleMods: DEFAULT_LOADED_MODS,
    scrollTop: 0
  }
}

let browseState = createInitialState()

export function getModsBrowseState(): ModsBrowseState {
  return {
    ...browseState,
    authorFilter: { ...browseState.authorFilter },
    versionsFilter: [...browseState.versionsFilter],
    tagsFilter: [...browseState.tagsFilter]
  }
}

export function updateModsBrowseState(updates: Partial<ModsBrowseState>): void {
  browseState = { ...browseState, ...updates }
}

/** Resets the navigation snapshot between independent renderer sessions/tests. */
export function resetModsBrowseState(): void {
  browseState = createInitialState()
}
