import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  redactArgs,
  resolveCliInvocation,
  runCli,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_BUFFER,
  type SpawnExecutor,
  type ExecOptions,
} from '../src/lib/cli-runner.ts'
import type { CliCredentials } from '../src/lib/cli-credentials.ts'

/** A per-caller deploy key pair for the runner. */
function creds(extra: Partial<CliCredentials> = {}): CliCredentials {
  return { accessKey: 'ak-123', secretKey: 'sk-top-secret', ...extra }
}

/** Capture what the runner handed the spawn primitive, then return canned output. */
function recordingExec(result = { stdout: 'ok', stderr: '' }): {
  exec: SpawnExecutor
  calls: Array<{ file: string; argv: string[]; options: ExecOptions }>
} {
  const calls: Array<{ file: string; argv: string[]; options: ExecOptions }> = []
  const exec: SpawnExecutor = async (file, argv, options) => {
    calls.push({ file, argv, options })
    return result
  }
  return { exec, calls }
}

// --- redactArgs ---
test('redactArgs: separated secret flag redacts the following value', () => {
  const out = redactArgs(['api', 'deploy', '--secret-key', 'sk-abc', '--env', 'prod'], {} as NodeJS.ProcessEnv)
  assert.deepEqual(out, ['api', 'deploy', '--secret-key', '***REDACTED***', '--env', 'prod'])
})

test('redactArgs: inline secret flag redacts the value after =', () => {
  const out = redactArgs(['--token=abc123', 'deploy'], {} as NodeJS.ProcessEnv)
  assert.deepEqual(out, ['--token=***REDACTED***', 'deploy'])
})

test('redactArgs: a bare arg equal to a known secret env value is redacted', () => {
  const out = redactArgs(['deploy', 'sk-top-secret'], { ONEBLINK_SECRET_KEY: 'sk-top-secret' } as NodeJS.ProcessEnv)
  assert.deepEqual(out, ['deploy', '***REDACTED***'])
})

test('redactArgs: leaves non-secret args untouched and does not mutate input', () => {
  const input = ['cdn', 'deploy', 'public', '--env', 'prod', '--prune']
  const out = redactArgs(input, {} as NodeJS.ProcessEnv)
  assert.deepEqual(out, input)
  assert.deepEqual(input, ['cdn', 'deploy', 'public', '--env', 'prod', '--prune'])
})

// --- resolveCliInvocation ---
test('resolveCliInvocation: non-Windows uses the bare binary, no prefix', () => {
  const r = resolveCliInvocation(undefined, 'linux')
  assert.equal(r.file, 'oneblink')
  assert.deepEqual(r.prefixArgs, [])
})

test('resolveCliInvocation: Windows runs oneblink.cmd through cmd.exe without a shell string', () => {
  const r = resolveCliInvocation(undefined, 'win32')
  assert.match(r.file, /cmd\.exe$|cmd$/i)
  // shim is a DISTINCT argv element after /d /s /c — never interpolated.
  assert.deepEqual(r.prefixArgs.slice(0, 3), ['/d', '/s', '/c'])
  assert.equal(r.prefixArgs[3], 'oneblink.cmd')
})

test('resolveCliInvocation: explicit cliBin overrides the default name', () => {
  assert.equal(resolveCliInvocation('/opt/ob/oneblink', 'linux').file, '/opt/ob/oneblink')
  // On Windows the override still runs through cmd.exe as the shim arg.
  const w = resolveCliInvocation('C:/tools/oneblink.cmd', 'win32')
  assert.equal(w.prefixArgs[3], 'C:/tools/oneblink.cmd')
})

// --- runCli: fail closed when there is NO per-caller credential AND no env ---
test('runCli fails closed (rejects) when no credentials and no env fallback', async () => {
  const { exec, calls } = recordingExec()
  const savedAk = process.env.ONEBLINK_ACCESS_KEY
  const savedSk = process.env.ONEBLINK_SECRET_KEY
  delete process.env.ONEBLINK_ACCESS_KEY
  delete process.env.ONEBLINK_SECRET_KEY
  try {
    await assert.rejects(
      // No `credentials`, no request context, no env pair -> getCliCredentials
      // throws via loadCliConfig BEFORE any spawn.
      () => runCli({ args: ['api', 'deploy'], cwd: process.cwd(), _exec: exec }),
      /ONEBLINK_ACCESS_KEY|ONEBLINK_SECRET_KEY/,
    )
    assert.equal(calls.length, 0)
  } finally {
    if (savedAk !== undefined) process.env.ONEBLINK_ACCESS_KEY = savedAk
    if (savedSk !== undefined) process.env.ONEBLINK_SECRET_KEY = savedSk
  }
})

// --- runCli: argv-array contract (no shell) + env injection ---
test('runCli passes the caller args verbatim as a discrete argv array', async () => {
  const { exec, calls } = recordingExec()
  await runCli({ args: ['api', 'deploy', 'arg with spaces', '--env', 'prod'], cwd: process.cwd(), credentials: creds(), _exec: exec })
  assert.equal(calls.length, 1)
  const argv = calls[0]!.argv
  // Our args appear as the trailing elements, each a single element (a
  // space-containing arg is NOT split — proof there is no shell parsing).
  assert.deepEqual(argv.slice(-5), ['api', 'deploy', 'arg with spaces', '--env', 'prod'])
})

test('runCli injects the PASSED-IN deploy key pair into the child env, never argv', async () => {
  const { exec, calls } = recordingExec()
  await runCli({ args: ['api', 'deploy'], cwd: process.cwd(), credentials: creds(), _exec: exec })
  const { argv, options } = calls[0]!
  assert.equal(options.env.ONEBLINK_ACCESS_KEY, 'ak-123')
  assert.equal(options.env.ONEBLINK_SECRET_KEY, 'sk-top-secret')
  // The secret must NOT appear anywhere in argv.
  assert.ok(!argv.some((a) => a.includes('sk-top-secret') || a.includes('ak-123')))
})

test('runCli injects the per-caller creds, NOT process.env, into the child env', async () => {
  const { exec, calls } = recordingExec()
  const savedAk = process.env.ONEBLINK_ACCESS_KEY
  const savedSk = process.env.ONEBLINK_SECRET_KEY
  // A different (hostile) pair in process.env must NOT win over opts.credentials.
  process.env.ONEBLINK_ACCESS_KEY = 'ak-ENV-WRONG'
  process.env.ONEBLINK_SECRET_KEY = 'sk-ENV-WRONG'
  try {
    await runCli({ args: ['api', 'deploy'], cwd: process.cwd(), credentials: creds(), _exec: exec })
    const env = calls[0]!.options.env
    assert.equal(env.ONEBLINK_ACCESS_KEY, 'ak-123')
    assert.equal(env.ONEBLINK_SECRET_KEY, 'sk-top-secret')
  } finally {
    if (savedAk !== undefined) process.env.ONEBLINK_ACCESS_KEY = savedAk
    else delete process.env.ONEBLINK_ACCESS_KEY
    if (savedSk !== undefined) process.env.ONEBLINK_SECRET_KEY = savedSk
    else delete process.env.ONEBLINK_SECRET_KEY
  }
})

test('two different credential pairs produce two different child envs', async () => {
  const { exec, calls } = recordingExec()
  await runCli({ args: ['api', 'deploy'], cwd: process.cwd(), credentials: creds({ accessKey: 'ak-A', secretKey: 'sk-A' }), _exec: exec })
  await runCli({ args: ['api', 'deploy'], cwd: process.cwd(), credentials: creds({ accessKey: 'ak-B', secretKey: 'sk-B' }), _exec: exec })
  assert.equal(calls[0]!.options.env.ONEBLINK_ACCESS_KEY, 'ak-A')
  assert.equal(calls[0]!.options.env.ONEBLINK_SECRET_KEY, 'sk-A')
  assert.equal(calls[1]!.options.env.ONEBLINK_ACCESS_KEY, 'ak-B')
  assert.equal(calls[1]!.options.env.ONEBLINK_SECRET_KEY, 'sk-B')
  // caller A's key never leaked into caller B's env.
  assert.notEqual(calls[0]!.options.env.ONEBLINK_SECRET_KEY, calls[1]!.options.env.ONEBLINK_SECRET_KEY)
})

test('runCli merges caller env over the injected/inherited env', async () => {
  const { exec, calls } = recordingExec()
  await runCli({ args: ['x'], cwd: process.cwd(), env: { MOCK_EXTRA: 'hello' }, credentials: creds(), _exec: exec })
  assert.equal(calls[0]!.options.env.MOCK_EXTRA, 'hello')
})

test('runCli passes cwd and the timeout default through to the executor', async () => {
  const { exec, calls } = recordingExec()
  await runCli({ args: ['x'], cwd: 'C:/some/project', credentials: creds(), _exec: exec })
  assert.equal(calls[0]!.options.cwd, 'C:/some/project')
  assert.equal(calls[0]!.options.timeout, DEFAULT_TIMEOUT_MS)
  assert.equal(calls[0]!.options.maxBuffer, DEFAULT_MAX_BUFFER)
})

// --- runCli: a non-zero exit is DATA, not a throw ---
test('runCli returns a non-zero exit code as data (not a rejection)', async () => {
  const exec: SpawnExecutor = async () => {
    // Shape an execFile-style error: numeric `code` == a real process exit.
    throw Object.assign(new Error('Command failed'), { code: 3, stdout: 'out', stderr: 'boom' })
  }
  const res = await runCli({ args: ['api', 'deploy'], cwd: process.cwd(), credentials: creds(), _exec: exec })
  assert.equal(res.exitCode, 3)
  assert.equal(res.stdout, 'out')
  assert.equal(res.stderr, 'boom')
})

test('runCli returns exitCode 0 and the captured streams on success', async () => {
  const { exec } = recordingExec({ stdout: 'deployed', stderr: '' })
  const res = await runCli({ args: ['cdn', 'deploy'], cwd: process.cwd(), credentials: creds(), _exec: exec })
  assert.equal(res.exitCode, 0)
  assert.equal(res.stdout, 'deployed')
})

// --- runCli: spawn failures / timeout reject with a non-secret message ---
test('runCli rejects (non-secret) on a timeout', async () => {
  const exec: SpawnExecutor = async () => {
    throw Object.assign(new Error('killed'), { killed: true, code: 'ETIMEDOUT' })
  }
  await assert.rejects(
    () => runCli({ args: ['x'], cwd: process.cwd(), timeoutMs: 150, credentials: creds(), _exec: exec }),
    /timed out after 150ms/,
  )
})

test('runCli rejects on a spawn failure (binary not found) without leaking argv', async () => {
  const exec: SpawnExecutor = async () => {
    throw Object.assign(new Error('spawn oneblink ENOENT'), { code: 'ENOENT' })
  }
  await assert.rejects(async () => {
    try {
      await runCli({ args: ['api', 'deploy', 'sk-top-secret'], cwd: process.cwd(), credentials: creds(), _exec: exec })
    } catch (e) {
      assert.doesNotMatch((e as Error).message, /sk-top-secret/)
      throw e
    }
  }, /failed to run oneblink CLI/)
})

test('runner exposes sane timeout and buffer defaults', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 120_000)
  assert.ok(DEFAULT_MAX_BUFFER >= 1024 * 1024)
})
