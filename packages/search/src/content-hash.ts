import { createHash } from "node:crypto"

export const contentHash = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex")
