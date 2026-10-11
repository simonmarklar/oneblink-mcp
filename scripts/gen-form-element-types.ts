/**
 * Codegen: derive the authoritative Form element type set from @oneblink/types
 * and emit a committed constant at src/lib/generated/form-element-types.ts.
 *
 * WHY (steering rule 1 / D1): the valid element types must track the SDK, never
 * a hand-maintained list. `FormTypes.FormElementType = FormElement['type']` is a
 * union we cannot read at runtime, so we resolve it with the TypeScript compiler
 * API at build time. Each type is classified by INSPECTING the element's own
 * declared members (not a hard-coded table):
 *   - named     : the element shape has a `name` property
 *                 (PageElement/SectionElement are FormElementWithoutName)
 *   - container : the element shape has an `elements` property
 *                 (section/page/repeatableSet via _NestedElementsElement,
 *                  form/infoPage via FormFormElement)
 *   - options   : the element shape has an `options` property
 *                 (radio/checkboxes/select/autocomplete/compliance)
 *
 * Run: npm run gen:types   (tsx scripts/gen-form-element-types.ts)
 * Re-run after bumping @oneblink/types; commit the generated file.
 */
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')

/** Entry .d.ts of the forms module inside @oneblink/types. */
function resolveFormsDts(): string {
  const pkgJson = require.resolve('@oneblink/types/package.json')
  return resolve(dirname(pkgJson), 'typescript', 'forms.d.ts')
}

type Meta = { named: boolean; container: boolean; options: boolean }

function main(): void {
  const formsDts = resolveFormsDts()
  const program = ts.createProgram([formsDts], {
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    module: ts.ModuleKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    skipLibCheck: true,
  })
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(formsDts)
  if (!source) throw new Error(`could not load ${formsDts}`)

  // Find the `FormElementType` alias and resolve its union of string literals.
  let typeSymbol: ts.Symbol | undefined
  ts.forEachChild(source, (node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'FormElementType') {
      typeSymbol = checker.getSymbolAtLocation(node.name)
    }
  })
  if (!typeSymbol) throw new Error('FormElementType alias not found in forms.d.ts')

  const aliased = checker.getDeclaredTypeOfSymbol(typeSymbol)
  const literals = collectStringLiterals(aliased, checker)
  if (literals.length === 0) throw new Error('FormElementType resolved to no string literals')

  // The FormElement union gives us the per-type member shapes to classify from.
  const metaByType = classifyFromFormElementUnion(source, checker, new Set(literals))

  const types = [...literals].sort()
  const meta: Record<string, Meta> = {}
  for (const t of types) {
    meta[t] = metaByType.get(t) ?? { named: true, container: false, options: false }
  }

  const out = outputPath()
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, render(types, meta), 'utf8')
  // eslint-disable-next-line no-console
  console.log(`wrote ${types.length} element types to ${out}`)
}

function outputPath(): string {
  return resolve(projectRoot, 'src', 'lib', 'generated', 'form-element-types.ts')
}

/** Flatten a union type to its string-literal members. */
function collectStringLiterals(type: ts.Type, checker: ts.TypeChecker): string[] {
  const out: string[] = []
  const parts = type.isUnion() ? type.types : [type]
  for (const p of parts) {
    if (p.isStringLiteral()) out.push(p.value)
    else {
      // Nested alias/union — recurse.
      const nested = checker.getApparentType(p)
      if (nested.isUnion()) out.push(...collectStringLiterals(nested, checker))
    }
  }
  return [...new Set(out)]
}

/**
 * Walk the `FormElement` union's member types; for each, read its `type`
 * literal and whether it declares `name` / `elements` / `options` properties.
 */
function classifyFromFormElementUnion(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  known: Set<string>,
): Map<string, Meta> {
  const result = new Map<string, Meta>()
  let formElementSym: ts.Symbol | undefined
  ts.forEachChild(source, (node) => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === 'FormElement') {
      formElementSym = checker.getSymbolAtLocation(node.name)
    }
  })
  if (!formElementSym) return result

  const union = checker.getDeclaredTypeOfSymbol(formElementSym)
  const members = union.isUnion() ? union.types : [union]
  for (const member of members) {
    const typeProp = member.getProperty('type')
    if (!typeProp) continue
    const typeOfType = checker.getTypeOfSymbolAtLocation(typeProp, source)
    const literals = collectStringLiterals(typeOfType, checker)
    const named = member.getProperty('name') !== undefined
    const container = member.getProperty('elements') !== undefined
    const options = member.getProperty('options') !== undefined
    for (const lit of literals) {
      if (!known.has(lit)) continue
      const prev = result.get(lit)
      // A `type` may appear in several union members (e.g. form|infoPage share a
      // shape). OR the capabilities so none is lost.
      result.set(lit, {
        named: (prev?.named ?? false) || named,
        container: (prev?.container ?? false) || container,
        options: (prev?.options ?? false) || options,
      })
    }
  }
  return result
}

function render(types: string[], meta: Record<string, Meta>): string {
  const typeUnion = types.map((t) => `  | '${t}'`).join('\n')
  const metaEntries = types
    .map((t) => {
      const m = meta[t] as Meta
      return `  ${JSON.stringify(t)}: { named: ${m.named}, container: ${m.container}, options: ${m.options} },`
    })
    .join('\n')
  return `/**
 * GENERATED by scripts/gen-form-element-types.ts — DO NOT EDIT BY HAND.
 *
 * Source of truth: @oneblink/types FormElementType (FormElement['type']).
 * Regenerate with: npm run gen:types
 *
 * Each entry's metadata is read from the SDK element shape:
 *   named     — the element has a \`name\` property (page/section do NOT).
 *   container — the element has an \`elements\` (child) property.
 *   options   — the element has an \`options\` property (choice elements).
 */

export type GeneratedFormElementType =
${typeUnion}

export interface FormElementTypeMeta {
  /** The element shape declares a \`name\` property. */
  named: boolean
  /** The element shape declares an \`elements\` (children) property. */
  container: boolean
  /** The element shape declares an \`options\` property. */
  options: boolean
}

export const FORM_ELEMENT_TYPES: readonly GeneratedFormElementType[] = [
${types.map((t) => `  '${t}',`).join('\n')}
] as const

export const FORM_ELEMENT_TYPE_META: Record<GeneratedFormElementType, FormElementTypeMeta> = {
${metaEntries}
}
`
}

main()
