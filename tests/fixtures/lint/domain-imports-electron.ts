// Deliberately broken fixture for tests/config/lint-guards.test.ts, which copies it
// under src/domain for the length of one assertion so the linters' own
// src/domain/**/*.ts pattern matches it. Both lint configs ignore this folder, so
// npm run lint:ci never sees the copy's source.
import { app } from "electron"

export const userDataPath = (): string => app.getPath("userData")
