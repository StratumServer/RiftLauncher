import { ConcurrencyLimiter } from "@domain/concurrencyLimiter"

/**
 * Detail batches share QUERY_URL's six slots with catalog, version and filter requests. Keeping
 * batches to four leaves two slots for those interactive lookups even during a large import.
 */
export const modDetailLookups = new ConcurrencyLimiter(4)

/** Installed-mod scans and their card details retain the stricter two-request cap (#386). */
export const installedModLookups = new ConcurrencyLimiter(2)
