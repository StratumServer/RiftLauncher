import { useState } from "react"

export type ExpandableNameGroup = Readonly<{
  key: string
  label: string
  names?: readonly string[]
}>

/** A native disclosure for names that should stay out of the page until someone asks to see them. */
function ExpandableNameList({ summary, groups, className = "text-sm text-zinc-400" }: Readonly<{ summary: string; groups: readonly ExpandableNameGroup[]; className?: string }>): JSX.Element {
  const [opened, setOpened] = useState(false)

  return (
    <details className={className} onToggle={(event) => setOpened(event.currentTarget.open)}>
      <summary className="cursor-pointer focus-visible:outline-2 focus-visible:outline-vsl focus-visible:outline-offset-2">{summary}</summary>
      {opened && (
        <ul className="max-h-48 overflow-y-auto break-words px-2 pt-1 text-left">
          {groups.map((group) => (
            <li key={group.key}>
              {group.label}
              {group.names && group.names.length > 0 && (
                <ul className="list-disc pl-4">
                  {group.names.map((name, index) => (
                    <li key={`${name}:${index}`}>{name}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </details>
  )
}

export default ExpandableNameList
