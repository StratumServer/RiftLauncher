// Shared by the electron-builder.yml config tests. The file is read as text by
// each caller, on purpose: js-yaml is only a transitive dependency of
// electron-updater, and importing it here would be an undeclared dependency.

/**
 * The list under `key:`, optionally nested inside a `section:` block, read off
 * the indentation electron-builder.yml uses (each nesting level costs two
 * spaces). Pass `section` as `""` for a `key:` that sits at the top level of
 * the document rather than inside a section. A value wrapped in double quotes
 * has them stripped.
 */
export function listUnder(yml: string, section: string, key: string): string[] {
  const block = section === "" ? yml : (yml.split(new RegExp(`^${section}:$`, "m"))[1] ?? "")
  const keyIndent = section === "" ? "" : "  "
  const afterKey = block.split(new RegExp(`^${keyIndent}${key}:$`, "m"))[1] ?? ""
  const itemIndent = section === "" ? "\\s+" : " {4}"
  const entries: string[] = []
  for (const line of afterKey.split("\n").slice(1)) {
    const value = new RegExp(`^${itemIndent}-\\s+(.+?)\\s*$`).exec(line)?.[1]
    if (value === undefined) break
    entries.push(value.replace(/^"(.*)"$/, "$1"))
  }
  return entries
}
