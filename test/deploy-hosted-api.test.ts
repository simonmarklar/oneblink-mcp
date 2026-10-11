import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deployHostedApiInputSchema,
  buildDeployArgvs,
  performDeploy,
  parseDeployedUrl,
  DEPLOY_ENVS,
  type DeployHostedApiInput,
} from '../src/workflows/deploy-hosted-api.ts'
import type { RunCliOptions, RunCliResult } from '../src/lib/cli-runner.ts'

// These tests drive performDeploy WITHOUT a request-credential context, so the
// tool resolves its deploy keys via the stdio-interim env fallback. Provide a
// stable pair for that fallback (the subprocess is mocked, so these are never
// used to authenticate anything real).
process.env.ONEBLINK_ACCESS_KEY ??= 'ak-test'
process.env.ONEBLINK_SECRET_KEY ??= 'sk-test'

/** Fake runCli: records every call, returns canned results per-call (or a default). */
function recordingRun(
  results: RunCliResult[] = [{ exitCode: 0, stdout: '', stderr: '' }],
): {
  run: (opts: RunCliOptions) => Promise<RunCliResult>
  calls: RunCliOptions[]
} {
  const calls: RunCliOptions[] = []
  let i = 0
  const run = async (opts: RunCliOptions): Promise<RunCliResult> => {
    calls.push(opts)
    const r = results[Math.min(i, results.length - 1)]!
    i++
    return r
  }
  return { run, calls }
}

function input(overrides: Partial<DeployHostedApiInput> = {}): DeployHostedApiInput {
  return deployHostedApiInputSchema.parse({ projectDir: 'C:/proj/api', ...overrides })
}

// --- zod validation (fail closed) ---------------------------------------
test('schema rejects a missing projectDir', () => {
  assert.equal(deployHostedApiInputSchema.safeParse({}).success, false)
})

test('schema rejects an empty projectDir', () => {
  assert.equal(deployHostedApiInputSchema.safeParse({ projectDir: '' }).success, false)
})

test('schema rejects an unknown env', () => {
  assert.equal(deployHostedApiInputSchema.safeParse({ projectDir: 'x', env: 'staging' }).success, false)
})

test('schema applies defaults: env=dev, confirmProduction=false', () => {
  const r = deployHostedApiInputSchema.safeParse({ projectDir: 'x' })
  assert.equal(r.success, true)
  if (r.success) {
    assert.equal(r.data.env, 'dev')
    assert.equal(r.data.confirmProduction, false)
    assert.equal(r.data.scope, undefined)
  }
})

test('DEPLOY_ENVS is dev/test/prod', () => {
  assert.deepEqual([...DEPLOY_ENVS], ['dev', 'test', 'prod'])
})

// --- prod gate (security) -----------------------------------------------
test('prod gate: env=prod + confirmProduction=false -> isError, runCli NOT called', async () => {
  const { run, calls } = recordingRun()
  const res = await performDeploy(input({ env: 'prod' }), run)
  assert.equal(res.isError, true)
  assert.match(res.content[0]!.text, /confirmProduction/)
  assert.equal(calls.length, 0) // never spawned
})

test('prod gate: env=prod + confirmProduction=true -> deploy proceeds', async () => {
  const { run, calls } = recordingRun([{ exitCode: 0, stdout: 'https://x.api.oneblink.io', stderr: '' }])
  const res = await performDeploy(input({ env: 'prod', confirmProduction: true }), run)
  assert.notEqual(res.isError, true)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!.args, ['api', 'deploy', '--env', 'prod', '--force'])
})

// --- argv shape, in order ------------------------------------------------
test('buildDeployArgvs: no scope -> single deploy step with --env/--force', () => {
  assert.deepEqual(buildDeployArgvs({ scope: undefined, env: 'dev' }), [
    ['api', 'deploy', '--env', 'dev', '--force'],
  ])
})

test('buildDeployArgvs: scope -> scope step FIRST, then deploy', () => {
  assert.deepEqual(buildDeployArgvs({ scope: 'c.api.oneblink.io', env: 'test' }), [
    ['api', 'scope', 'c.api.oneblink.io'],
    ['api', 'deploy', '--env', 'test', '--force'],
  ])
})

test('performDeploy builds correct argv per env and passes projectDir as cwd', async () => {
  for (const env of ['dev', 'test', 'prod'] as const) {
    const { run, calls } = recordingRun()
    await performDeploy(input({ env, confirmProduction: env === 'prod' }), run)
    assert.deepEqual(calls[0]!.args, ['api', 'deploy', '--env', env, '--force'])
    assert.equal(calls[0]!.cwd, 'C:/proj/api')
  }
})

// --- scope step runs only when scope provided ---------------------------
test('scope step runs only when scope is provided (two calls, scope first)', async () => {
  const { run, calls } = recordingRun()
  await performDeploy(input({ scope: 'c.api.oneblink.io', env: 'dev' }), run)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0]!.args, ['api', 'scope', 'c.api.oneblink.io'])
  assert.deepEqual(calls[1]!.args, ['api', 'deploy', '--env', 'dev', '--force'])
})

test('no scope -> exactly one call (deploy only)', async () => {
  const { run, calls } = recordingRun()
  await performDeploy(input({ env: 'dev' }), run)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!.args, ['api', 'deploy', '--env', 'dev', '--force'])
})

// --- non-zero exit surfaces as isError, no secret in the message --------
test('non-zero exit -> isError with stderr tail, deploy stops', async () => {
  const { run, calls } = recordingRun([{ exitCode: 2, stdout: '', stderr: 'deploy failed: config invalid' }])
  const res = await performDeploy(input({ env: 'dev' }), run)
  assert.equal(res.isError, true)
  assert.match(res.content[0]!.text, /exit 2/)
  assert.match(res.content[0]!.text, /config invalid/)
  assert.equal(calls.length, 1)
})

test('scope-step failure stops before deploy (deploy step never runs)', async () => {
  const { run, calls } = recordingRun([{ exitCode: 1, stdout: '', stderr: 'scope rejected' }])
  const res = await performDeploy(input({ scope: 'bad.api.oneblink.io', env: 'dev' }), run)
  assert.equal(res.isError, true)
  assert.equal(calls.length, 1) // only the scope step ran
  assert.deepEqual(calls[0]!.args, ['api', 'scope', 'bad.api.oneblink.io'])
})

test('error message does not leak injected credentials', async () => {
  // The runner injects creds into env, never argv — assert the surfaced error
  // carries no secret-looking token from a hostile stderr.
  const { run } = recordingRun([{ exitCode: 1, stdout: '', stderr: 'generic failure' }])
  const res = await performDeploy(input({ env: 'dev' }), run)
  assert.doesNotMatch(res.content[0]!.text, /ONEBLINK_(ACCESS|SECRET)_KEY/)
})

// --- runner rejection (spawn/timeout) handled -> isError ----------------
test('a runner rejection (spawn/timeout) is caught and returned as isError', async () => {
  const run = async (): Promise<RunCliResult> => {
    throw new Error('oneblink CLI timed out after 120000ms')
  }
  const res = await performDeploy(input({ env: 'dev' }), run)
  assert.equal(res.isError, true)
  assert.match(res.content[0]!.text, /timed out/)
})

// --- URL parsing ---------------------------------------------------------
test('parseDeployedUrl extracts the first URL from stdout', () => {
  assert.equal(
    parseDeployedUrl('Deploying...\nDone: https://c.api.oneblink.io/ ok'),
    'https://c.api.oneblink.io/',
  )
})

test('parseDeployedUrl returns null when there is no URL', () => {
  assert.equal(parseDeployedUrl('Deployed successfully, no url printed'), null)
})

test('success result includes env and parsed url', async () => {
  const { run } = recordingRun([{ exitCode: 0, stdout: 'URL: https://c.api.oneblink.io', stderr: '' }])
  const res = await performDeploy(input({ env: 'dev' }), run)
  assert.notEqual(res.isError, true)
  const body = JSON.parse(res.content[0]!.text)
  assert.equal(body.deployed, true)
  assert.equal(body.env, 'dev')
  assert.equal(body.url, 'https://c.api.oneblink.io')
})
