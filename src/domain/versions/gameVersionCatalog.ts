import * as z from "zod/mini"

const rawPlatformSchema = z.looseObject({
  filename: z.optional(z.string()),
  urls: z.looseObject({ cdn: z.string() })
})
const rawVersionSchema = z.looseObject({
  windows: z.optional(rawPlatformSchema),
  linux: z.optional(rawPlatformSchema),
  "mac-arm64": z.optional(rawPlatformSchema),
  "mac-x64": z.optional(rawPlatformSchema)
})
const rawVersionsSchema = z.record(z.string(), rawVersionSchema)

export type RawPlatform = z.infer<typeof rawPlatformSchema>
export type RawVersions = z.infer<typeof rawVersionsSchema>

export function parseGameVersionCatalog(text: string): RawVersions {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("Game version catalog is not valid JSON.")
  }

  const result = rawVersionsSchema.safeParse(parsed)
  if (!result.success) throw new Error("Game version catalog has an invalid shape.")
  return result.data
}
