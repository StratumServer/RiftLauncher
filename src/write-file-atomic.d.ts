// write-file-atomic@8 ships no types, and @types/write-file-atomic only covers older
// majors. The async signature has been stable across majors, and this is the entire
// surface src/ipc/atomicJsonFile.ts calls.
//
// No import or export here, on purpose: that keeps this a "script" file rather than a
// module, which is what lets `declare module` introduce a brand new ambient module
// instead of being read as an augmentation of one that would need to already be typed.
declare module "write-file-atomic" {
  function writeFileAtomic(filename: string, data: string, options?: { mode?: number; fsync?: boolean }): Promise<void>
  export = writeFileAtomic
}
