import basalt from "@renderer/assets/basalt.png"
import bookshelf from "@renderer/assets/bookshelf.png"
import crystal from "@renderer/assets/crystal.png"
import granite from "@renderer/assets/granite.png"
import rusty from "@renderer/assets/rusty.png"
import temporal from "@renderer/assets/temporal.png"
import soil from "@renderer/assets/soil.png"

export const INSTALLATION_ICONS: [IconType, ...IconType[]] = [
  { id: "basalt", name: "Basalt", icon: basalt },
  { id: "bookshelf", name: "Book shelf", icon: bookshelf },
  { id: "crystal", name: "Crystal", icon: crystal },
  { id: "granite", name: "Granite", icon: granite },
  { id: "rusty", name: "Rusty gear", icon: rusty },
  { id: "temporal", name: "Temporal gear", icon: temporal },
  { id: "soil", name: "Soil", icon: soil }
]

/**
 * The image source for the icon an installation names.
 *
 * Built-in icons carry their own bundled source; a custom one is a file the
 * launcher copied, reached through the `icons:` protocol. An id that matches
 * neither falls back to the first built-in rather than rendering nothing.
 */
export function installationIconSrc(iconId: string, customIcons: readonly IconType[]): string {
  const builtIn = INSTALLATION_ICONS.find((icon) => icon.id === iconId)
  if (builtIn) return builtIn.icon

  const custom = customIcons.find((icon) => icon.id === iconId)
  if (custom) return `icons:${custom.icon}`

  return INSTALLATION_ICONS[0].icon
}
