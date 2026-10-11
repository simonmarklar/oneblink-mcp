import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  upsertApiSubmissionEventWithApiInputSchema as schema,
  performUpsertWithApi,
  type UpsertApiSubmissionEventWithApiInput,
} from '../src/workflows/upsert-api-submission-event-with-api.ts'
import type { ToolResult } from '../src/workflows/deploy-hosted-api.ts'
import type { FormsLike } from '../src/workflows/upsert-api-submission-event.ts'

// ------------------------------------------------------------------------
// Fakes. We MOCK the deploy core and the Forms SDK — no real CLI, no real API.
// ------------------------------------------------------------------------

/** A recording deploy fn: records inputs, returns a canned ToolResult. */
function recordingDeploy(result: ToolResult = okDeploy()): {
  deploy: (input: any) => Promise<ToolResult>
  calls: any[]
} {
  const calls: any[] = []
  const deploy = async (input: any): Promise<ToolResult> => {
    calls.push(input)
    return result
  }
  return { deploy, calls }
}

function okDeploy(env = 'dev'): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ deployed: true, env, scope: null, url: null }) }],
  }
}
function errDeploy(text = 'deploy failed'): ToolResult {
  return { isError: true, content: [{ type: 'text', text }] }
}

/**
 * Fake Forms service: getForm returns a form with the given events, updateForm
 * records what it was handed and echoes it back.
 */
function fakeForms(events: unknown[] = []): {
  forms: FormsLike
  update: Array<{ form: any; overrideLock?: boolean }>
} {
  const update: Array<{ form: any; overrideLock?: boolean }> = []
  const forms: FormsLike = {
    async getForm() {
      return { id: 1, submissionEvents: events }
    },
    async updateForm(form: unknown, overrideLock?: boolean) {
      update.push({ form, overrideLock })
      return form
    },
  }
  return { forms, update }
}

/** An ordered call log shared across the deploy + forms fakes to assert sequence. */
function orderedFakes(deployResult: ToolResult = okDeploy()) {
  const order: string[] = []
  const deployCalls: any[] = []
  const update: Array<{ form: any; overrideLock?: boolean }> = []
  const deploy = async (input: any): Promise<ToolResult> => {
    order.push('deploy')
    deployCalls.push(input)
    return deployResult
  }
  const forms: FormsLike = {
    async getForm() {
      return { id: 1, submissionEvents: [] }
    },
    async updateForm(form: unknown, overrideLock?: boolean) {
      order.push('updateForm')
      update.push({ form, overrideLock })
      return form
    },
  }
  return { deploy, forms, order, deployCalls, update }
}

const existingInput = (o: Record<string, unknown> = {}): UpsertApiSubmissionEventWithApiInput =>
  schema.parse({
    source: 'existing',
    formId: 1,
    apiId: 'existing-api',
    apiEnvironment: 'test',
    apiEnvironmentRoute: '/my-route',
    ...o,
  })

const deployInput = (o: Record<string, unknown> = {}): UpsertApiSubmissionEventWithApiInput =>
  schema.parse({
    source: 'deploy',
    formId: 1,
    apiId: 'console-api',
    projectDir: 'C:/proj/api',
    apiEnvironmentRoute: '/my-route',
    ...o,
  })

// ========================================================================
// Discriminated input validation — fail closed
// ========================================================================
test('schema rejects a missing/unknown source (discriminator)', () => {
  assert.equal(schema.safeParse({ formId: 1, apiEnvironmentRoute: '/r' }).success, false)
  assert.equal(schema.safeParse({ source: 'nope', formId: 1, apiEnvironmentRoute: '/r' }).success, false)
})

test('existing branch rejects a missing apiEnvironment', () => {
  assert.equal(
    schema.safeParse({ source: 'existing', formId: 1, apiId: 'a', apiEnvironmentRoute: '/r' }).success,
    false,
  )
})

test('existing branch rejects a missing apiId', () => {
  assert.equal(
    schema.safeParse({ source: 'existing', formId: 1, apiEnvironment: 'test', apiEnvironmentRoute: '/r' }).success,
    false,
  )
})

test('deploy branch requires apiId (not recoverable from CLI output)', () => {
  assert.equal(
    schema.safeParse({ source: 'deploy', formId: 1, projectDir: 'x', apiEnvironmentRoute: '/r' }).success,
    false,
  )
})

test('deploy branch requires projectDir', () => {
  assert.equal(
    schema.safeParse({ source: 'deploy', formId: 1, apiId: 'a', apiEnvironmentRoute: '/r' }).success,
    false,
  )
})

test('both branches reject a route not starting with /', () => {
  assert.equal(
    schema.safeParse({ source: 'existing', formId: 1, apiId: 'a', apiEnvironment: 'test', apiEnvironmentRoute: 'x' })
      .success,
    false,
  )
  assert.equal(
    schema.safeParse({ source: 'deploy', formId: 1, apiId: 'a', projectDir: 'x', apiEnvironmentRoute: 'x' }).success,
    false,
  )
})

test('deploy branch defaults env=dev, confirmProduction=false, overrideLock=false', () => {
  const v = deployInput()
  assert.equal(v.source, 'deploy')
  if (v.source === 'deploy') {
    assert.equal(v.env, 'dev')
    assert.equal(v.confirmProduction, false)
  }
  assert.equal(v.overrideLock, false)
})

test('deploy branch rejects an unknown env', () => {
  assert.equal(
    schema.safeParse({ source: 'deploy', formId: 1, apiId: 'a', projectDir: 'x', apiEnvironmentRoute: '/r', env: 'staging' })
      .success,
    false,
  )
})

// ========================================================================
// source=existing — calls performUpsert and NOT deploy
// ========================================================================
test('source=existing writes the event and NEVER calls deploy', async () => {
  const { deploy, calls } = recordingDeploy()
  const { forms, update } = fakeForms([{ type: 'EMAIL' }])
  const res = await performUpsertWithApi(existingInput({ organisationManagedSecretId: 42 }), { deploy, forms })
  assert.notEqual(res.isError, true)
  assert.equal(calls.length, 0) // deploy NOT called
  // event written with the existing api's id + environment
  const written = update[0]!.form.submissionEvents
  assert.equal(written.length, 2)
  assert.deepEqual(written[1], {
    type: 'ONEBLINK_API',
    configuration: {
      apiId: 'existing-api',
      apiEnvironment: 'test',
      apiEnvironmentRoute: '/my-route',
      organisationManagedSecretId: 42,
    },
    conditionallyExecute: false,
    requiresAllConditionallyExecutePredicates: false,
    isRetryable: true,
  })
})

// ========================================================================
// source=deploy — deploys THEN writes (order asserted)
// ========================================================================
test('source=deploy deploys FIRST, then writes the event (order asserted)', async () => {
  const { deploy, forms, order, deployCalls, update } = orderedFakes(okDeploy('test'))
  const res = await performUpsertWithApi(deployInput({ env: 'test', scope: 'c.api.oneblink.io' }), { deploy, forms })
  assert.notEqual(res.isError, true)
  assert.deepEqual(order, ['deploy', 'updateForm']) // deploy strictly before the write
  // deploy got the deploy-shaped input (no event fields leaked into it)
  assert.deepEqual(deployCalls[0], {
    projectDir: 'C:/proj/api',
    scope: 'c.api.oneblink.io',
    env: 'test',
    confirmProduction: false,
  })
  // event uses the supplied apiId and the env just deployed to
  const written = update[0]!.form.submissionEvents[0]
  assert.equal(written.type, 'ONEBLINK_API')
  assert.equal(written.configuration.apiId, 'console-api')
  assert.equal(written.configuration.apiEnvironment, 'test')
  assert.equal(written.configuration.apiEnvironmentRoute, '/my-route')
})

test('source=deploy event apiEnvironment is DERIVED from env, not an input', async () => {
  const { deploy, forms, update } = orderedFakes(okDeploy('dev'))
  await performUpsertWithApi(deployInput({ env: 'dev' }), { deploy, forms })
  assert.equal(update[0]!.form.submissionEvents[0].configuration.apiEnvironment, 'dev')
})

// ========================================================================
// deploy failure stops BEFORE the event is written
// ========================================================================
test('a failed deploy stops the tool and NO event is written', async () => {
  const { deploy, forms, order, update } = orderedFakes(errDeploy('scope rejected'))
  const res = await performUpsertWithApi(deployInput(), { deploy, forms })
  assert.equal(res.isError, true)
  assert.match(res.content[0]!.text, /scope rejected/)
  assert.deepEqual(order, ['deploy']) // updateForm never ran
  assert.equal(update.length, 0)
})

// ========================================================================
// PROD GATE preserved end-to-end — via the REAL deploy core
// ========================================================================
test('prod gate: source=deploy env=prod + confirmProduction=false -> isError, deploy core blocks, NO event', async () => {
  // Use the REAL performDeploy (default deploy dep) so the actual prod gate runs.
  // Inject a Forms fake and assert it is never touched (no event written).
  const { forms, update } = fakeForms([])
  const res = await performUpsertWithApi(deployInput({ env: 'prod', confirmProduction: false }), { forms })
  assert.equal(res.isError, true)
  assert.match(res.content[0]!.text, /confirmProduction/)
  assert.equal(update.length, 0) // event never written — gate fired before the write
})

test('prod gate: source=deploy env=prod + confirmProduction=true -> deploy proceeds then writes', async () => {
  const { deploy, forms, order } = orderedFakes(okDeploy('prod'))
  const res = await performUpsertWithApi(
    deployInput({ env: 'prod', confirmProduction: true }),
    { deploy, forms },
  )
  assert.notEqual(res.isError, true)
  assert.deepEqual(order, ['deploy', 'updateForm'])
})

// ========================================================================
// form lock is honoured end-to-end (via the real performUpsert)
// ========================================================================
test('source=existing on a locked form (overrideLock=false) fails closed with the permission message', async () => {
  const forms: FormsLike = {
    async getForm() {
      return { id: 1, submissionEvents: [] }
    },
    async updateForm() {
      throw { statusCode: 409 }
    },
  }
  const { deploy, calls } = recordingDeploy()
  const res = await performUpsertWithApi(existingInput(), { deploy, forms })
  assert.equal(res.isError, true)
  assert.match(res.content[0]!.text, /locked/)
  assert.equal(calls.length, 0)
})

test('overrideLock=true threads through to updateForm (deploy branch)', async () => {
  const { deploy, forms, update } = orderedFakes(okDeploy('dev'))
  await performUpsertWithApi(deployInput({ overrideLock: true }), { deploy, forms })
  assert.equal(update[0]!.overrideLock, true)
})

// ========================================================================
// secret handling — organisationManagedSecretId written only when provided
// ========================================================================
test('organisationManagedSecretId is omitted from the event when not provided', async () => {
  const { deploy, forms, update } = orderedFakes(okDeploy('dev'))
  await performUpsertWithApi(deployInput(), { deploy, forms })
  const cfg = update[0]!.form.submissionEvents[0].configuration
  assert.equal('organisationManagedSecretId' in cfg, false)
})
