/**
 * The one way reading an Inno Setup installer gives up.
 *
 * Every refusal goes through this type, from an unknown format version to a
 * checksum that does not land, so a caller has exactly one thing to catch and
 * one place to fall back from. The two constructors only separate "this file is
 * not something we claim to read" from "this file says one thing and holds
 * another", which is the distinction worth putting in a log line.
 */
export type InnoFormatReason = "unsupported" | "corrupt"

export class InnoFormatError extends Error {
  readonly reason: InnoFormatReason

  constructor(reason: InnoFormatReason, message: string) {
    super(message)
    this.name = "InnoFormatError"
    this.reason = reason
  }

  /** A format or a version this reader does not pretend to understand. */
  static unsupported(detail: string): InnoFormatError {
    return new InnoFormatError("unsupported", `Unsupported Inno Setup installer: ${detail}.`)
  }

  /** The file declares one thing and contains another. */
  static corrupt(detail: string): InnoFormatError {
    return new InnoFormatError("corrupt", `Unreadable Inno Setup installer: ${detail}.`)
  }
}

/** True when `error` is this module's refusal rather than a programming mistake. */
export function isInnoFormatError(error: unknown): error is InnoFormatError {
  return error instanceof InnoFormatError
}
