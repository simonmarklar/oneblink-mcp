import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  setFormServerValidationInputSchema as schema,
  performSetFormServerValidation,
  performSetServerValidation,
  type FormsLike,
  type SetFormServerValidationInput,
} from '../src/workflows/set-form-server-validation.ts'
import type { ToolResult } from '../src/workflows/deploy-hosted-api.ts'

// ------------------------------------------------------------------------
// Fakes. We MOCK the deploy core and the Forms SDK - no real CLI, no network.
// ------------------------------------------------------------------------

function okDeploy(env = 'dev'): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ deployed: true, env, scope: null, url: null }) }],
  }
}
function errDeploy(text = 'deploy failed'): ToolResult {
  return { isError: true, content: [{ type: 'text', text }] }
}

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

/**
 * Fake Forms service: getForm returns a form carrying the given extra fields,
 * updateForm records what it was handed and echoes it back.
 */
function fakeForms(extra: Record<string, unknown> = {}): {
  forms: FormsLike
  update: Array<{ form: any; overrideLock?: boolean }>
} {
  const update: Array<{ form: any; overrideLock?: boolean }> = []
  const forms: FormsLike = {
    async getForm() {
      return { id: 1, name: 'f', ...extra }
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
      return { id: 1 }
    },
    async updateForm(form: unknown, overrideLock?: boolean) {
      order.push('updateForm')
      update.push({ form, overrideLock })
      return form
    },
  }
  return { deploy, forms, order, deployCalls, update }
}

const existingInput = (o: Record<string, unknown> = {}): SetFormServerValidationInput =>
  schema.parse({
    source: 'existing',
    formId: 1,
    apiId: 'oneblink-mcp-test.api.oneblink.io',
    apiEnvironment: 'test',
    apiEnvironmentRoute: '/validate',
    ...o,
  })

const deployInput = (o: Record<string, unknown> = {}): SetFormServerValidationInput =>
  schema.parse({
    source: 'deploy',
    formId: 1,
    apiId: 'console-api',
    projectDir: 'C:/proj/api',
    apiEnvironmentRoute: '/validate',
    ...o,
  })

// ========================================================================
// Discriminated input validation - fail closed
// ========================================================================
test('schema rejects a missing/unknown source (discriminator)', () => {
  assert.equal(schema.safeParse({ formId: 1, apiEnvironmentRoute: '/r' }).success, false)
  assert.equal(schema.safeParse({ source: 'nope', formId: 1, apiEnvironmentRoute: '/r' }).success, false)
})

test('existing branch accepts valid input and defaults overrideLock=false', () => {
  const v = existingInput()
  assert.equal(v.source, 'existing')
  assert.equal(v.formId, 1)
  assert.equal(v.apiId, 'oneblink-mcp-test.api.oneblink.io')
  assert.equal(v.overrideLock, false)
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

test('existing branch rejects a non-positive formId', () => {
  assert.equal(schema.safeParse({ ...existingInput(), formId: 0 }).success, false)
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
    schema.safeParse({
      source: 'deploy',
      formId: 1,
      apiId: 'a',
      projectDir: 'x',
      apiEnvironmentRoute: '/r',
      env: 'staging',
    }).success,
    false,
  )
})

// ========================================================================
// source=existing - writes serverValidation and NEVER calls deploy
// ========================================================================
test('source=existing writes serverValidation and NEVER calls deploy', async () => {
  const { deploy, calls } = recordingDeploy()
  const { forms, update } = fakeForms({ serverValidation: { type: 'OLD' } })
  const res = await performSetFormServerValidation(existingInput(), { deploy, forms })
  assert.notEqual(res.isError, true)
  assert.equal(calls.length, 0) // deploy NOT called
  const written = update[0]!.form.serverValidation
  assert.deepEqual(written, {
    type: 'ONEBLINK_API',
    configuration: {
      apiId: 'oneblink-mcp-test.api.oneblink.io',
      apiEnvironment: 'test',
      apiEnvironmentRoute: '/validate',
    },
  })
})

test('source=existing result projection reports formId + serverValidation only (no whole form)', async () => {
  const { deploy } = recordingDeploy()
  const { forms } = fakeForms()
  const res = await performSetFormServerValidation(existingInput(), { deploy, forms })
  const payload = JSON.parse(res.content[0]!.text)
  assert.deepEqual(Object.keys(payload).sort(), ['action', 'formId', 'serverValidation'])
  assert.equal(payload.formId, 1)
  assert.equal(payload.action, 'set')
})

// ========================================================================
// source=deploy - deploys THEN writes (order asserted)
// ========================================================================
test('source=deploy deploys FIRST, then writes serverValidation (order asserted)', async () => {
  const { deploy, forms, order, deployCalls, update } = orderedFakes(okDeploy('test'))
  const res = await performSetFormServerValidation(
    deployInput({ env: 'test', scope: 'c.api.oneblink.io' }),
    { deploy, forms },
  )
  assert.notEqual(res.isError, true)
  assert.deepEqual(order, ['deploy', 'updateForm']) // deploy strictly before the write
  // deploy got the deploy-shaped input (no field-write args leaked into it)
  assert.deepEqual(deployCalls[0], {
    projectDir: 'C:/proj/api',
    scope: 'c.api.oneblink.io',
    env: 'test',
    confirmProduction: false,
  })
  const written = update[0]!.form.serverValidation
  assert.equal(written.type, 'ONEBLINK_API')
  assert.equal(written.configuration.apiId, 'console-api')
  assert.equal(written.configuration.apiEnvironment, 'test')
  assert.equal(written.configuration.apiEnvironmentRoute, '/validate')
})

test('source=deploy apiEnvironment is DERIVED from env, not an input', async () => {
  const { deploy, forms, update } = orderedFakes(okDeploy('dev'))
  await performSetFormServerValidation(deployInput({ env: 'dev' }), { deploy, forms })
  assert.equal(update[0]!.form.serverValidation.configuration.apiEnvironment, 'dev')
})

// ========================================================================
// deploy failure stops BEFORE anything is written
// ========================================================================
test('a failed deploy stops the tool and NOTHING is written', async () => {
  const { deploy, forms, order, update } = orderedFakes(errDeploy('scope rejected'))
  const res = await performSetFormServerValidation(deployInput(), { deploy, forms })
  assert.equal(res.isError, true)
  assert.match(res.content[0]!.text, /scope rejected/)
  assert.deepEqual(order, ['deploy']) // updateForm never ran
  assert.equal(update.length, 0)
})

// ========================================================================
// PROD GATE preserved end-to-end - via the REAL deploy core
// ========================================================================
test('prod gate: deploy env=prod + confirmProduction=false -> isError, NOTHING written', async () => {
  // Real performDeploy (default deploy dep) so the actual prod gate runs.
  const { forms, update } = fakeForms()
  const res = await performSetFormServerValidation(
    deployInput({ env: 'prod', confirmProduction: false }),
    { forms },
  )
  assert.equal(res.isError, true)
  assert.match(res.content[0]!.text, /confirmProduction/)
  assert.equal(update.length, 0) // gate fired before any write
})

test('prod gate: deploy env=prod + confirmProduction=true -> deploy proceeds then writes', async () => {
  const { deploy, forms, order } = orderedFakes(okDeploy('prod'))
  const res = await performSetFormServerValidation(
    deployInput({ env: 'prod', confirmProduction: true }),
    { deploy, forms },
  )
  assert.notEqual(res.isError, true)
  assert.deepEqual(order, ['deploy', 'updateForm'])
})

// ========================================================================
// form lock is honoured (via the field-write core)
// ========================================================================
test('a locked form (overrideLock=false) fails closed with the permission message, no deploy', async () => {
  const forms: FormsLike = {
    async getForm() {
      return { id: 1 }
    },
    async updateForm() {
      throw { statusCode: 409 }
    },
  }
  const { deploy, calls } = recordingDeploy()
  const res = await performSetFormServerValidation(existingInput(), { deploy, forms })
  assert.equal(res.isError, true)
  assert.match(res.content[0]!.text, /locked/)
  assert.equal(calls.length, 0)
})

test('overrideLock=true threads through to updateForm (deploy branch)', async () => {
  const { deploy, forms, update } = orderedFakes(okDeploy('dev'))
  await performSetFormServerValidation(deployInput({ overrideLock: true }), { deploy, forms })
  assert.equal(update[0]!.overrideLock, true)
})

// ========================================================================
// field-write core directly
// ========================================================================
test('performSetServerValidation preserves other form fields and overwrites serverValidation', async () => {
  const { forms, update } = fakeForms({ name: 'keep-me', serverValidation: { type: 'OLD' } })
  const res = await performSetServerValidation(
    {
      formId: 7,
      apiId: 'a.api.oneblink.io',
      apiEnvironment: 'dev',
      apiEnvironmentRoute: '/v',
      overrideLock: false,
    },
    forms,
  )
  assert.notEqual(res.isError, true)
  assert.equal(update[0]!.form.name, 'keep-me')
  assert.equal(update[0]!.form.serverValidation.type, 'ONEBLINK_API')
  assert.equal(update[0]!.form.serverValidation.configuration.apiId, 'a.api.oneblink.io')
})
