/**
 * Env-backed credential resolver (stdio interim).
 *
 * On stdio there is one process = one identity, so there is no per-token
 * tenant. This resolver returns the single key from the process env
 * (loadConfig) for the synthesized stdio tenant. Keeps the existing stdio path
 * and its tests working unchanged while the HTTP path uses real per-tenant
 * resolution. (Spec: auth-session.md "Interim: local stdio".)
 */
import { loadConfig } from '../config.js'
import type { CredentialResolver } from './types.js'
import type { SdkConstructorOptions } from '../oneblink-client.js'

/** The single tenant key used for the stdio process-identity path. */
export const STDIO_TENANT = 'stdio'

export class EnvCredentialResolver implements CredentialResolver {
  async resolve(_tenant: string): Promise<SdkConstructorOptions> {
    const config = loadConfig()
    return { accessKey: config.accessKey, secretKey: config.secretKey }
  }
}
