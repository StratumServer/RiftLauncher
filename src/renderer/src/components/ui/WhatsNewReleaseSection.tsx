import type { WhatsNewRelease } from "@renderer/features/info/hooks/useWhatsNew"

/**
 * One release's name and its blocks (heading, paragraph, bullet), shared by WhatsNewDialog and
 * the Info & Help page's own section so the two never drift into two different renderings of the
 * same data.
 *
 * `block.text` is plain text by the time it reaches here (see releaseNotesToBlocks in
 * src/domain/appUpdate/whatsNew.ts): every markup character has already been stripped, so this
 * renders it as React text and nothing else, the same rule modDescriptionParagraphs' callers
 * follow for a Mod description.
 */
function WhatsNewReleaseSection({ release }: Readonly<{ release: WhatsNewRelease }>): JSX.Element {
  return (
    <div className="flex flex-col gap-1 text-left">
      <h3 className="text-lg font-bold">{release.name || release.version}</h3>
      {release.blocks.map((block, index) => {
        const key = `${release.version}-${index}`
        if (block.kind === "heading")
          return (
            <h4 key={key} className="font-semibold">
              {block.text}
            </h4>
          )
        if (block.kind === "bullet")
          return (
            <ul key={key} className="list-disc pl-5">
              <li>{block.text}</li>
            </ul>
          )
        return <p key={key}>{block.text}</p>
      })}
    </div>
  )
}

export default WhatsNewReleaseSection
