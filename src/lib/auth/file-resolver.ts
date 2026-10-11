/**
 * File-backed credential resolver (PoC).
 *
 * Reads OneBlink Developer Keys from a gitignored local JSON file, keyed by
 * tenant. Swapped for SecretsManagerCredentialResolver in prod — SAME
 * interface, so getClient() and all workflows are untouched. (Spec:
 * auth-session.md; steering rule 5.)
 *
 * SECURITY: the key file is gitignored; keys are never logged and never
 * returned to the client. The resolver fails closed on an unknown tenant.
 *
 * File shape (oneblink-keys.local.json):
 *   { "<tenant>": { "accessKey": "...", "secretKey": "..." }, ... }
 */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { CredentialResolver } from './types.js'
import type { SdkConstructorOptions } from '../oneblink-client.js'

const KeyEntry = z.object({
  accessKey: z.string().min(1),
  secretKey: z.string().min(1),
})
/**
 * The file is a tenant -> key map. Keys beginning with `_` are treated as
 * comments and ignored (so a documented keys file with a `_comment` field is
 * valid). Every other entry MUST be a well-formed { accessKey, secretKey }.
 */
const KeyFile = z.record(z.unknown()).transform((obj, ctx) => {
  const out: Record<string, z.infer<typeof KeyEntry>> = {}
  for (const [tenant, value] of Object.entries(obj)) {
    if (tenant.startsWith('_')) continue // comment field
    const parsed = KeyEntry.safeParse(value)
    if (!parsed.success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `entry '${tenant}' is malformed` })
      return z.NEVER
    }
    out[tenant] = parsed.data
  }
  return out
})

export class FileCredentialResolver implements CredentialResolver {
  private cache: z.infer<typeof KeyFile> | undefined

  constructor(private readonly filePath: string) {}

  async resolve(tenant: string): Promise<SdkConstructorOptions> {
    const map = await this.load()
    const entry = map[tenant]
    if (!entry) {
      // Fail closed. Name the tenant (non-sensitive) but never the key.
      throw new Error(`no OneBlink key configured for tenant '${tenant}'`)
    }
    return { accessKey: entry.accessKey, secretKey: entry.secretKey }
  }

  private async load(): Promise<z.infer<typeof KeyFile>> {
    if (this.cache) return this.cache
    let raw: string
    try {
      raw = await readFile(this.filePath, 'utf8')
    } catch {
      // Do not echo the OS error (may contain the path repeatedly / fs detail).
      throw new Error(`credential file not readable: ${this.filePath}`)
    }
    const parsed = KeyFile.safeParse(JSON.parse(raw))
    if (!parsed.success) {
      throw new Error('credential file is malformed (expected { tenant: { accessKey, secretKey } })')
    }
    this.cache = parsed.data
    return this.cache
  }
}
