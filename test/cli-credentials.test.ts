import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getCliCredentials, type CliCredentials } from '../src/lib/cli-credentials.ts'
import { runWithCliCredentials } from '../src/lib/request-context.ts'
import { performDeploy } from '../src/workflows/deploy-hosted-api.ts'
import { deployCdnHandler } from '../src/workflows/deploy-cdn.ts'
import type { RunCliOptions, RunCliResult, runCli } from '../src/lib/cli-runner.ts'

// --- HTTP-only: credentials come from the request context, nothing else ----
test('getCliCredentials throws when called outside a request context', () => {
  assert.throws(() => getCliCredentials(), /outside an authenticated HTTP request/)
})

test('getCliCredentials returns the request-context pair', async () => {
  const ctxCreds: CliCredentials = { accessKey: 'ak-ctx', secretKey: 'sk-ctx' }
  await runWithCliCredentials(ctxCreds, async () => {
    const c = getCliCredentials()
    assert.equal(c.accessKey, 'ak-ctx')
    assert.equal(c.secretKey, 'sk-ctx')
  })
})

// --- END TO END: two sessions -> two key sets into the deploy TOOLS ---------
// Each HTTP session binds ITS OWN header key pair via runWithCliCredentials
// (exactly what http.ts does). Prove that running each tool inside a different
// session's credential context injects THAT session's keys, and session A
// never gets session B's key.

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

test('deploy_hosted_api: two sessions carry two different key sets, no cross-leak', async () => {
  const credsA: CliCredentials = { accessKey: 'ak-acme', secretKey: 'sk-acme' }
  const credsB: CliCredentials = { accessKey: 'ak-globex', secretKey: 'sk-globex' }

  const a = recordingRun()
  await runWithCliCredentials(credsA, async () => {
    await performDeploy({ projectDir: 'C:/p', env: 'dev', confirmProduction: false }, a.run)
  })

  const b = recordingRun()
  await runWithCliCredentials(credsB, async () => {
    await performDeploy({ projectDir: 'C:/p', env: 'dev', confirmProduction: false }, b.run)
  })

  assert.equal(a.calls[0]!.credentials!.accessKey, 'ak-acme')
  assert.equal(a.calls[0]!.credentials!.secretKey, 'sk-acme')
  assert.equal(b.calls[0]!.credentials!.accessKey, 'ak-globex')
  assert.equal(b.calls[0]!.credentials!.secretKey, 'sk-globex')
  // Session A's key never reached session B.
  assert.notEqual(a.calls[0]!.credentials!.secretKey, b.calls[0]!.credentials!.secretKey)
})

test('deploy_cdn: two sessions carry two different key sets, no cross-leak', async () => {
  const credsA: CliCredentials = { accessKey: 'ak-acme', secretKey: 'sk-acme' }
  const credsB: CliCredentials = { accessKey: 'ak-globex', secretKey: 'sk-globex' }

  const a = recordingRun()
  await runWithCliCredentials(credsA, async () => {
    await deployCdnHandler({ projectDir: 'C:/p', deployDir: 'public', env: 'dev' }, { _runCli: a.run as typeof runCli })
  })

  const b = recordingRun()
  await runWithCliCredentials(credsB, async () => {
    await deployCdnHandler({ projectDir: 'C:/p', deployDir: 'public', env: 'dev' }, { _runCli: b.run as typeof runCli })
  })

  assert.equal(a.calls[0]!.credentials!.secretKey, 'sk-acme')
  assert.equal(b.calls[0]!.credentials!.secretKey, 'sk-globex')
  assert.notEqual(a.calls[0]!.credentials!.secretKey, b.calls[0]!.credentials!.secretKey)
})

// --- a deploy tool outside any request context fails closed -----------------
test('deploy_hosted_api outside a request context fails closed (no credentials)', async () => {
  const r = recordingRun()
  // No runWithCliCredentials wrapper -> getCliCredentials throws -> isError,
  // and the subprocess is NEVER invoked.
  const res = await performDeploy({ projectDir: 'C:/p', env: 'dev', confirmProduction: false }, r.run)
  assert.equal(res.isError, true)
  assert.equal(r.calls.length, 0)
})
