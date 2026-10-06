import assert from "node:assert/strict"
import { gunzipSync } from "node:zlib"
import images from "../../fixtures/assemblyReferences/images.json"
import { describe, it } from "vitest"

import { readOptimumAssemblyReferences } from "@domain/optimum/assemblyReferences"
import { makeManagedAssembly } from "../../fixtures/managedAssembly"

describe("readOptimumAssemblyReferences", () => {
  it("reads exact Optimum names from the PE AssemblyRef table", () => {
    const image = makeManagedAssembly(["Optimum.Api.Contracts", "Optimum.GameContent"], ["Optimum.Namespace.Type", "Optimum.Tests.dll", "Optimum.Patcher.pdb.dll"])

    assert.deepEqual(readOptimumAssemblyReferences(image)?.sort(), ["Optimum.Api.Contracts.dll", "Optimum.GameContent.dll"])
  })

  it("does not treat namespaces, debug names or InternalsVisibleTo strings as assembly references", () => {
    const image = makeManagedAssembly([], ["Optimum.Namespace.Type", "Optimum.Tests.dll", "Optimum.Patcher.pdb.dll"])

    assert.deepEqual(readOptimumAssemblyReferences(image), [])
  })

  it("reads adjacent reference names without swallowing the next table entry", () => {
    const image = makeManagedAssembly(["Optimum.Api.Contracts", "Optimum.GameContent"])

    assert.deepEqual(readOptimumAssemblyReferences(image), ["Optimum.Api.Contracts.dll", "Optimum.GameContent.dll"])
  })

  it("rejects non-managed and truncated images", () => {
    assert.equal(readOptimumAssemblyReferences(Buffer.from("Optimum.GameContent")), undefined)
    assert.equal(readOptimumAssemblyReferences(makeManagedAssembly(["Optimum.GameContent"]).subarray(0, 140)), undefined)
  })
  it.each(Object.entries(images))("reads Optimum references from a Cecil image with populated tables: %s", (_name, encoded) => {
    const image = gunzipSync(Buffer.from(encoded, "base64"))
    assert.deepEqual(readOptimumAssemblyReferences(image), ["Optimum.GameContent.dll"])
  })

  it("refuses an oversized AssemblyRef name before scanning the whole string heap", () => {
    const image = makeManagedAssembly(["Optimum." + "A".repeat(1500)])
    assert.equal(readOptimumAssemblyReferences(image), undefined)
  })
})
