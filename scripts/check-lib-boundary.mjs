import { existsSync, readFileSync, readdirSync } from "node:fs"
import { resolve, relative } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)))
const root = resolve(process.argv[2] ?? resolve(scriptDir, ".."))
const errors = []

const read = (path) => readFileSync(path, "utf8")

const walk = (directory) => {
  if (!existsSync(directory)) return []
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...walk(path))
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      files.push(path)
    }
  }
  return files
}

const moduleSpecifiers = (path) => {
  const specifiers = []
  const source = ts.createSourceFile(
    path,
    read(path),
    ts.ScriptTarget.Latest,
    true,
    ts.getScriptKindFromFileName(path),
  )
  const addSpecifier = (node) => {
    if (node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      specifiers.push(node.text)
    }
  }
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addSpecifier(node.moduleSpecifier)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addSpecifier(node.moduleReference.expression)
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      addSpecifier(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specifiers
}

const verifyManifest = () => {
  const path = resolve(root, "packages/lib/package.json")
  if (!existsSync(path)) {
    errors.push("packages/lib/package.json is missing")
    return
  }
  const manifest = JSON.parse(read(path))
  const dependencyGroups = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
  const dependencies = new Set(dependencyGroups.flatMap((group) => Object.keys(manifest[group] ?? {})))
  const allowedDependencies = new Set(["@finch/core", "effect"])
  for (const dependency of dependencies) {
    if (!allowedDependencies.has(dependency)) {
      errors.push(`packages/lib/package.json has forbidden dependency: ${dependency}`)
    }
  }
  const exports = manifest.exports ?? {}
  if (Object.keys(exports).length !== 1 || exports["."] !== "./src/index.ts") {
    errors.push("packages/lib/package.json must not expose legacy subpaths")
  }
}

const verifyLibSources = () => {
  for (const path of walk(resolve(root, "packages/lib/src"))) {
    for (const specifier of moduleSpecifiers(path)) {
      if (specifier.startsWith(".")) continue
      if (specifier === "effect" || specifier === "@finch/core/domain") continue
      const display = relative(root, path)
      if (specifier === "@finch/core") {
        errors.push(`${display} imports bare @finch/core; use @finch/core/domain`)
      } else if (specifier.startsWith("@finch/core/")) {
        errors.push(`${display} imports unsafe core domain path: ${specifier}`)
      } else {
        errors.push(`${display} imports forbidden adapter or external package: ${specifier}`)
      }
    }
  }
}

const verifyDomainBarrel = () => {
  const path = resolve(root, "packages/core/src/domain/index.ts")
  if (!existsSync(path)) {
    errors.push("packages/core/src/domain/index.ts is missing")
    return
  }
  const safeModules = new Set([
    "./tenant.ts",
    "./money.ts",
    "./time.ts",
    "./errors.ts",
    "./validation.ts",
  ])
  for (const specifier of moduleSpecifiers(path)) {
    if (!safeModules.has(specifier)) {
      errors.push(`packages/core/src/domain/index.ts imports unsafe domain barrel path: ${specifier}`)
    }
  }
}

const verifyLegacyImports = () => {
  const allowedLegacyConsumers = new Set([
    "packages/mcp/src/server.ts",
  ])
  for (const path of walk(resolve(root, "packages"))) {
    if (!moduleSpecifiers(path).includes("@finch/lib-legacy")) continue
    const display = relative(root, path)
    if (!display.startsWith("packages/lib-legacy/") && !allowedLegacyConsumers.has(display)) {
      errors.push(`${display} imports @finch/lib-legacy outside a legacy implementation seam`)
    }
  }
}

verifyManifest()
verifyLibSources()
verifyDomainBarrel()
verifyLegacyImports()

if (errors.length > 0) {
  console.error(errors.join("\n"))
  process.exitCode = 1
} else {
  console.log("adapter boundary verification passed")
}
