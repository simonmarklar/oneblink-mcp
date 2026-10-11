import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deployCdnInputSchema, deployCdnHandler, parsePublicUrl } from '../src/workflows/deploy-cdn.ts'
import type { runCli, RunCliResult } from '../src/lib/cli-runner.ts'

// deployCdnHandler is driven here WITHOUT a request-credential context, so it
// resolves deploy keys via the stdio-interim env fallback. Provide a stable
// pair (subprocess is mocked; never used to authenticate anything real).
process.env.ONEBLINK_ACCESS_KEY ??= 'ak-test'
process.env.ONEBLINK_SECRET_KEY ??= 'sk-test'

type RunCli = typeof runCli
type Call = { args: string[]; cwd: string }

/** A recording mock of runCli that never spawns a process. */
function mockRunCli(result: RunCliResult = { exitCode: 0, stdout: '', stderr: '' }): {
  run: RunCli
  calls: Call[]
} {
  const calls: Call[] = []
  const run = (async (opts) => {
    calls.push({ args: opts.args, cwd: opts.cwd })
    return result
  }) as RunCli
  return { run, calls }
}

const BASE = { projectDir: 'C:/proj', deployDir: 'public' } as const

// --- zod validation (fail closed) ---
test('schema rejects missing projectDir/deployDir', () => {
  assert.equal(deployCdnInputSchema.safeParse({}).success, false)
  assert.equal(deployCdnInputSchema.safeParse({ projectDir: 'C:/p' }).success, false)
  assert.equal(deployCdnInputSchema.safeParse({ deployDir: 'public' }).success, false)
})

test('schema applies defaults env=dev prune=false confirmProduction=false', () => {
  const r = deployCdnInputSchema.safeParse(BASE)
  assert.equal(r.success, true)
  if (r.success) {
    assert.equal(r.data.env, 'dev')
    assert.equal(r.data.prune, false)
    assert.equal(r.data.confirmProduction, false)
  }
})

test('schema rejects an unknown env', () => {
  assert.equal(deployCdnInputSchema.safeParse({ ...BASE, env: 'staging' }).success, false)
})

test('handler fails closed on invalid input and does NOT call runCli', async () => {
  const { run, calls } = mockRunCli()
  const res = await deployCdnHandler({}, { _runCli: run })
  assert.equal(res.isError, true)
  assert.equal(calls.length, 0)
})

// --- PROD GATE ---
test('prod without confirmProduction is isError and runCli NOT called', async () => {
  const { run, calls } = mockRunCli()
  const res = await deployCdnHandler({ ...BASE, env: 'prod' }, { _runCli: run })
  assert.equal(res.isError, true)
  assert.equal(calls.length, 0)
  assert.match(res.content[0]!.text, /confirmProduction/)
})

test('prod WITH confirmProduction proceeds to deploy', async () => {
  const { run, calls } = mockRunCli({ exitCode: 0, stdout: 'https://x.cdn.oneblink.io', stderr: '' })
  const res = await deployCdnHandler(
    { ...BASE, env: 'prod', confirmProduction: true },
    { _runCli: run },
  )
  assert.equal(res.isError, undefined)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!.args, ['cdn', 'deploy', 'public', '--env', 'prod'])
})

// --- argv correctness: dev/test/prod, with/without --prune ---
test('dev deploy argv, no prune, no scope step', async () => {
  const { run, calls } = mockRunCli()
  await deployCdnHandler({ ...BASE, env: 'dev' }, { _runCli: run })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!.args, ['cdn', 'deploy', 'public', '--env', 'dev'])
  assert.equal(calls[0]!.cwd, 'C:/proj')
})

test('test deploy argv with --prune', async () => {
  const { run, calls } = mockRunCli()
  await deployCdnHandler({ ...BASE, env: 'test', prune: true }, { _runCli: run })
  assert.deepEqual(calls[0]!.args, ['cdn', 'deploy', 'public', '--env', 'test', '--prune'])
})

test('prod deploy argv with --prune (confirmed)', async () => {
  const { run, calls } = mockRunCli()
  await deployCdnHandler(
    { ...BASE, env: 'prod', prune: true, confirmProduction: true },
    { _runCli: run },
  )
  assert.deepEqual(calls[0]!.args, ['cdn', 'deploy', 'public', '--env', 'prod', '--prune'])
})

// --- scope step only when scope provided ---
test('scope step runs first, then deploy, when scope is provided', async () => {
  const { run, calls } = mockRunCli()
  await deployCdnHandler(
    { ...BASE, scope: 'cust-proj.cdn.oneblink.io', env: 'dev' },
    { _runCli: run },
  )
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0]!.args, ['cdn', 'scope', 'cust-proj.cdn.oneblink.io'])
  assert.deepEqual(calls[1]!.args, ['cdn', 'deploy', 'public', '--env', 'dev'])
})

test('no scope step when scope omitted', async () => {
  const { run, calls } = mockRunCli()
  await deployCdnHandler(BASE, { _runCli: run })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.args[1], 'deploy')
})

test('a failing scope step stops before deploy', async () => {
  const { run, calls } = mockRunCli({ exitCode: 1, stdout: '', stderr: 'bad scope' })
  const res = await deployCdnHandler({ ...BASE, scope: 's.cdn.oneblink.io' }, { _runCli: run })
  assert.equal(res.isError, true)
  assert.equal(calls.length, 1) // only the scope call ran
  assert.match(res.content[0]!.text, /scope failed/)
})

// --- non-zero exit -> isError, no secret leak ---
test('non-zero deploy exit -> isError with stderr tail and no secret', async () => {
  const { run } = mockRunCli({ exitCode: 2, stdout: '', stderr: 'line1\nsk-top-secret-should-not-be-here-anyway\ndeploy error: denied' })
  const res = await deployCdnHandler(BASE, { _runCli: run })
  assert.equal(res.isError, true)
  assert.match(res.content[0]!.text, /exit 2/)
  // The handler only echoes CLI stderr it was given; it must not fabricate or
  // inject the deploy key pair. Prove no env-key names appear in the message.
  assert.doesNotMatch(res.content[0]!.text, /ONEBLINK_ACCESS_KEY|ONEBLINK_SECRET_KEY/)
})

test('a rejected runCli (spawn/timeout) is caught -> isError', async () => {
  const run = (async () => {
    throw new Error('oneblink CLI timed out after 120000ms')
  }) as RunCli
  const res = await deployCdnHandler(BASE, { _runCli: run })
  assert.equal(res.isError, true)
  assert.match(res.content[0]!.text, /timed out/)
})

// --- success projection ---
test('success returns a projection with env, pruned, and parsed publicUrl', async () => {
  const { run } = mockRunCli({
    exitCode: 0,
    stdout: 'Deploy complete. Origin: https://cust.cdn.oneblink.io/ ready',
    stderr: '',
  })
  const res = await deployCdnHandler({ ...BASE, prune: true }, { _runCli: run })
  assert.equal(res.isError, undefined)
  const body = JSON.parse(res.content[0]!.text) as Record<string, unknown>
  assert.equal(body.deployed, true)
  assert.equal(body.env, 'dev')
  assert.equal(body.pruned, true)
  assert.equal(body.publicUrl, 'https://cust.cdn.oneblink.io/')
})

// --- parsePublicUrl helper ---
test('parsePublicUrl extracts the first URL, else null', () => {
  assert.equal(parsePublicUrl('see https://a.cdn.oneblink.io now'), 'https://a.cdn.oneblink.io')
  assert.equal(parsePublicUrl('no url here'), null)
})
