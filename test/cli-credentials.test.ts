import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getCliCredentials,
  getCliCredentialsFor,
  _resetCliCredentials,
  type CliCredentials,
} from '../src/lib/cli-credentials.ts'
import { runWithCliCredentials } from '../src/lib/request-context.ts'
import type { AuthContext, CredentialResolver } from '../src/lib/auth/types.ts'
import type { SdkConstructorOptions } from '../src/lib/oneblink-client.ts'
import { performDeploy } from '../src/workflows/deploy-hosted-api.ts'
import { deployCdnHandler } from '../src/workflows/deploy-cdn.ts'
import type { RunCliOptions, RunCliResult, runCli } from '../src/lib/cli-runner.ts'

/** A keyed, fail-closed resolver standing in for the file/secrets resolver. */
function mapResolver(map: Record<string, SdkConstructorOptions>): CredentialResolver {
  return {
    async resolve(tenant: string): Promise<SdkConstructorOptions> {
      const entry = map[tenant]
      if (!entry) throw new Error(`no OneBlink key configured for tenant '${tenant}'`)
      return entry
    },
  }
}

function auth(tenant: string): AuthContext {
  return { tenant, subject: `sub-${tenant}`, scopes: [] }
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k]
    if (vars[k] === undefined) delete process.env[k]
    else process.env[k] = vars[k]
  }
  try {
    fn()
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

// --- stdio-interim fallback: no context -> env key pair ---------------------
test('getCliCredentials falls back to the env key pair when no context', () => {
  withEnv({ ONEBLINK_ACCESS_KEY: 'ak-env', ONEBLINK_SECRET_KEY: 'sk-env' }, () => {
    const c = getCliCredentials()
    assert.equal(c.accessKey, 'ak-env')
    assert.equal(c.secretKey, 'sk-env')
  })
})

test('getCliCredentials fails closed when no context AND no env fallback', () => {
  withEnv({ ONEBLINK_ACCESS_KEY: undefined, ONEBLINK_SECRET_KEY: undefined }, () => {
    assert.throws(() => getCliCredentials(), /ONEBLINK_ACCESS_KEY|ONEBLINK_SECRET_KEY/)
  })
})

// --- request context wins over env -----------------------------------------
test('getCliCredentials returns the request-context pair over the env pair', async () => {
  await withEnvAsync({ ONEBLINK_ACCESS_KEY: 'ak-env', ONEBLINK_SECRET_KEY: 'sk-env' }, async () => {
    const ctxCreds: CliCredentials = { accessKey: 'ak-ctx', secretKey: 'sk-ctx' }
    await runWithCliCredentials(ctxCreds, async () => {
      const c = getCliCredentials()
      assert.equal(c.accessKey, 'ak-ctx')
      assert.equal(c.secretKey, 'sk-ctx')
    })
  })
})

// --- per-tenant resolution + cache -----------------------------------------
test('getCliCredentialsFor resolves per tenant and caches', async () => {
  _resetCliCredentials()
  let calls = 0
  const resolver: CredentialResolver = {
    async resolve(tenant) {
      calls++
      return { accessKey: `ak-${tenant}`, secretKey: `sk-${tenant}` }
    },
  }
  const a = await getCliCredentialsFor(auth('acme'), resolver)
  const a2 = await getCliCredentialsFor(auth('acme'), resolver)
  assert.equal(a.accessKey, 'ak-acme')
  assert.equal(a2.secretKey, 'sk-acme')
  assert.equal(calls, 1) // cached on the second call
})

test('getCliCredentialsFor fails closed on an unknown tenant (names tenant, not key)', async () => {
  _resetCliCredentials()
  const resolver = mapResolver({ acme: { accessKey: 'ak', secretKey: 'sk' } })
  await assert.rejects(() => getCliCredentialsFor(auth('ghost'), resolver), /tenant 'ghost'/)
})

// --- END TO END: two callers -> two key sets into the deploy TOOLS ----------
// Mock the subprocess (via the runCli seam) and prove that running each tool
// inside a different caller's credential context injects THAT caller's keys,
// and caller A never gets caller B's key.

function recordingRun(result: RunCliResult = { exitCode: 0, stdout: '', stderr: '' }): {
  run: (opts: RunCliOptions) => Promise<RunCliResult>
  calls: RunCliOptions[]
} {
  const calls: RunCliOptions[] = []
  const run = async (opts: RunCliOptions) => {
    calls.push(opts)
    return result
  }
  return { run, calls }
}

test('deploy_hosted_api: two callers resolve to two different key sets, no cross-leak', async () => {
  _resetCliCredentials()
  const resolver = mapResolver({
    acme: { accessKey: 'ak-acme', secretKey: 'sk-acme' },
    globex: { accessKey: 'ak-globex', secretKey: 'sk-globex' },
  })

  // Caller A (acme)
  const a = recordingRun()
  const credsA = await getCliCredentialsFor(auth('acme'), resolver)
  await runWithCliCredentials(credsA, async () => {
    await performDeploy({ projectDir: 'C:/p', env: 'dev', confirmProduction: false }, a.run)
  })

  // Caller B (globex)
  const b = recordingRun()
  const credsB = await getCliCredentialsFor(auth('globex'), resolver)
  await runWithCliCredentials(credsB, async () => {
    await performDeploy({ projectDir: 'C:/p', env: 'dev', confirmProduction: false }, b.run)
  })

  assert.equal(a.calls[0]!.credentials!.accessKey, 'ak-acme')
  assert.equal(a.calls[0]!.credentials!.secretKey, 'sk-acme')
  assert.equal(b.calls[0]!.credentials!.accessKey, 'ak-globex')
  assert.equal(b.calls[0]!.credentials!.secretKey, 'sk-globex')
  // Caller A's key never reached caller B.
  assert.notEqual(a.calls[0]!.credentials!.secretKey, b.calls[0]!.credentials!.secretKey)
})

test('deploy_cdn: two callers resolve to two different key sets, no cross-leak', async () => {
  _resetCliCredentials()
  const resolver = mapResolver({
    acme: { accessKey: 'ak-acme', secretKey: 'sk-acme' },
    globex: { accessKey: 'ak-globex', secretKey: 'sk-globex' },
  })

  const a = recordingRun()
  const credsA = await getCliCredentialsFor(auth('acme'), resolver)
  await runWithCliCredentials(credsA, async () => {
    await deployCdnHandler({ projectDir: 'C:/p', deployDir: 'public', env: 'dev' }, { _runCli: a.run as typeof runCli })
  })

  const b = recordingRun()
  const credsB = await getCliCredentialsFor(auth('globex'), resolver)
  await runWithCliCredentials(credsB, async () => {
    await deployCdnHandler({ projectDir: 'C:/p', deployDir: 'public', env: 'dev' }, { _runCli: b.run as typeof runCli })
  })

  assert.equal(a.calls[0]!.credentials!.secretKey, 'sk-acme')
  assert.equal(b.calls[0]!.credentials!.secretKey, 'sk-globex')
  assert.notEqual(a.calls[0]!.credentials!.secretKey, b.calls[0]!.credentials!.secretKey)
})

// --- stdio fallback still works end-to-end through a deploy tool ------------
test('deploy_hosted_api uses the env key pair when there is no context (stdio)', async () => {
  await withEnvAsync({ ONEBLINK_ACCESS_KEY: 'ak-stdio', ONEBLINK_SECRET_KEY: 'sk-stdio' }, async () => {
    const r = recordingRun()
    // No runWithCliCredentials wrapper -> stdio fallback.
    await performDeploy({ projectDir: 'C:/p', env: 'dev', confirmProduction: false }, r.run)
    assert.equal(r.calls[0]!.credentials!.accessKey, 'ak-stdio')
    assert.equal(r.calls[0]!.credentials!.secretKey, 'sk-stdio')
  })
})

/** Async variant of withEnv for the context tests. */
async function withEnvAsync(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k]
    if (vars[k] === undefined) delete process.env[k]
    else process.env[k] = vars[k]
  }
  try {
    await fn()
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}
