import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

const ROOT = new URL("../..", import.meta.url).pathname
const gate = process.argv[2]
const read = (p) => readFileSync(join(ROOT, p), "utf8")
const fail = (msg) => {
  console.error(`GATE ${gate} FAIL: ${msg}`)
  process.exit(1)
}
const need = (cond, msg) => {
  if (!cond) fail(msg)
}

const has = (src, re) => re.test(src)

if (new Set(["g5", "g6", "g7", "g8", "g9", "g10"]).has(gate)) {
  console.log(`GATE ${gate} ARCHIVED: see .unlazy/connectrpc-cutover-20260910/GATES.md`)
  process.exit(0)
}

switch (gate) {
  case "g1": {
    const src = read("packages/llm/src/openai-compatible.ts")
    need(has(src, /AbortSignal\.timeout|signal\s*:|timeoutMs|TIMEOUT/i), "no fetch timeout signal")
    need(has(src, /\.slice\(0,|\.substring\(0,|MAX_ERROR_BODY|truncate/i), "no error-body bound")
    break
  }
  case "g2": {
    for (const f of ["packages/llm/src/openai-compatible.ts", "packages/enablebanking/src/client.ts"]) {
      const src = read(f)
      need(has(src, /ValidationFailed/), `${f}: no ValidationFailed on empty credentials`)
      need(has(src, /===\s*""|\.trim\(\)|length\s*===\s*0/), `${f}: no empty-string guard`)
    }
    break
  }
  case "g3": {
    const dir = join(ROOT, "packages/core/src/adapters")
    need(existsSync(dir), "packages/core/src/adapters missing")
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"))
    need(files.length > 0, "no shared registry module")
    const shared = files.map((f) => read(`packages/core/src/adapters/${f}`)).join("\n")
    need(has(shared, /export (const|function)/), "shared module exports nothing")
    for (const f of ["packages/llm/src/adapter.ts", "packages/enablebanking/src/adapter.ts"]) {
      const src = read(f)
      need(has(src, /from "@finch\/core\/adapters|from "\.\.\/\.\.\/core\/src\/adapters/), `${f}: does not import shared registry`)
    }
    break
  }
  default:
    fail(`unknown gate ${gate}`)
}

console.log(`GATE ${gate} PASS`)
