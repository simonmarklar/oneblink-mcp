/**
 * Workflow: set_form_server_validation
 *
 * Set `form.serverValidation` to a ONEBLINK_API EndpointConfiguration on an
 * existing form - the SERVER VALIDATION callback that runs on the server when a
 * submission is made (distinct from `personalisation`, which runs BEFORE the
 * user fills the form, and from `submissionEvents`, which fire AFTER a valid
 * submit). This is the serverValidation twin of set_form_personalisation and the
 * EITHER/OR composition twin of upsert_api_submission_event_with_deploy.
 *
 * SDK facts (verified against @oneblink/types):
 *   - `form.serverValidation?: FormServerValidation` in forms.d.ts.
 *   - `type FormServerValidation = EndpointConfiguration` - the SAME shape
 *     set_form_personalisation writes: { type: 'ONEBLINK_API', configuration: {
 *     apiId, apiEnvironment, apiEnvironmentRoute } }.
 *   - `apiId` is the FULL scope domain string, e.g.
 *     'oneblink-mcp-test.api.oneblink.io' (NOT a short id).
 *   - No "set serverValidation" API - getForm -> mutate form.serverValidation ->
 *     updateForm(form, overrideLock), with the form lock honoured.
 *
 * This tool is a COMPOSITION, not a reimplementation:
 *   - deploy is `performDeploy` from deploy-hosted-api.ts (prod gate, per-caller
 *     CLI creds, scope+deploy argv, URL parse - all reused as-is).
 *   - the field write is `performSetServerValidation` below (getForm -> mutate
 *     form.serverValidation -> updateForm with the lock honoured) - mirrors
 *     set-form-personalisation's write; the deploy branch reuses it.
 *
 * apiId DERIVATION (recorded decision, same as upsert-with-deploy): `oneblink
 * api deploy` targets an EXISTING Console-created API scope and does NOT return
 * the apiId, so on the `source:'deploy'` branch `apiId` is a REQUIRED input. The
 * `apiEnvironment` IS derived - it is the `env` just deployed to.
 *
 * SECURITY (see .kiro/steering/security.md):
 *   - safeParse fail-closed (A03): a discriminated union; bad/ambiguous input
 *     never reaches deploy or the SDK.
 *   - PROD GATE preserved end-to-end: the deploy branch runs `performDeploy`
 *     FIRST, so env=prod + confirmProduction=false fails closed BEFORE any
 *     subprocess AND before any field is written.
 *   - Deploy-before-write ordering: a deploy that returns isError STOPS the tool
 *     - serverValidation is never pointed at an API that failed to deploy.
 *   - A01/A08 form lock: honoured; a locked form stops unless overrideLock is
 *     explicitly set.
 *   - A09 Logging: CLI creds never logged (reused core guarantees this); this
 *     core logs only ids + the non-secret config written.
 *   - Projection (rule 3): returns the id touched + the config written, never
 *     the whole form.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getClient } from '../lib/oneblink-client.js'
import { logger } from '../lib/logger.js'
import { isFormLockedError } from '../lib/submission-event.js'
import { performDeploy, DEPLOY_ENVS, type ToolResult } from './deploy-hosted-api.js'

/** Minimal Forms seam so the field-write core is unit testable without the SDK. */
export type FormsLike = {
  getForm(formId: number, injectForms: boolean): Promise<unknown>
  updateForm(form: never, overrideLock?: boolean): Promise<unknown>
}

/** The ONEBLINK_API EndpointConfiguration this tool writes to form.serverValidation. */
type EndpointConfiguration = {
  type: 'ONEBLINK_API'
  configuration: {
    apiId: string
    apiEnvironment: string
    apiEnvironmentRoute: string
  }
}

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text }] }
}

// --- source:'existing' - point at an already-deployed hosted API ---------
const existingSchema = z.object({
  source: z.literal('existing'),
  formId: z.number().int().positive().describe('OneBlink form id whose serverValidation to set.'),
  apiId: z
    .string()
    .min(1, 'apiId is required')
    .describe('Full scope domain string of the EXISTING hosted API, e.g. "oneblink-mcp-test.api.oneblink.io" (not a short id).'),
  apiEnvironment: z
    .string()
    .min(1, 'apiEnvironment is required')
    .describe("Environment of the EXISTING hosted API, e.g. 'dev' | 'test' | 'prod'. Free string."),
  apiEnvironmentRoute: z
    .string()
    .min(1, 'apiEnvironmentRoute is required')
    .startsWith('/', 'apiEnvironmentRoute must start with "/"')
    .describe('Validation route on the hosted API, e.g. "/validate".'),
  overrideLock: z
    .boolean()
    .default(false)
    .describe('Explicit permission to override a form lock. Never set implicitly.'),
})

// --- source:'deploy' - provision/deploy a NEW/updated hosted API then wire it -
// apiId is REQUIRED here too (deploy does not return it). apiEnvironment is NOT
// an input: it is derived from `env` (the environment just deployed to). This
// single branch covers "create new API", "add a new endpoint", and "update
// existing endpoint code": in every case the route handler code is in
// projectDir and a deploy pushes it.
const deploySchema = z.object({
  source: z.literal('deploy'),
  formId: z.number().int().positive().describe('OneBlink form id whose serverValidation to set.'),
  projectDir: z
    .string()
    .min(1)
    .describe('Absolute path to the API codebase (contains .blinkmrc.json). Used as the deploy CLI cwd.'),
  scope: z
    .string()
    .min(1)
    .optional()
    .describe('API scope domain e.g. "customer-project.api.oneblink.io". When set, `oneblink api scope <scope>` runs before deploy.'),
  env: z
    .enum(DEPLOY_ENVS)
    .default('dev')
    .describe("Target deploy environment. Also becomes the serverValidation's apiEnvironment."),
  confirmProduction: z
    .boolean()
    .default(false)
    .describe('Required true to deploy to prod. Without it a prod deploy fails closed before any subprocess runs.'),
  apiId: z
    .string()
    .min(1, 'apiId is required')
    .describe(
      'ID of the hosted API being deployed to. REQUIRED: `oneblink api deploy` targets an EXISTING Console-created ' +
        'API scope and does not return the apiId, so the caller must supply it to wire serverValidation.',
    ),
  apiEnvironmentRoute: z
    .string()
    .min(1, 'apiEnvironmentRoute is required')
    .startsWith('/', 'apiEnvironmentRoute must start with "/"')
    .describe('Validation route on the hosted API, e.g. "/validate".'),
  overrideLock: z
    .boolean()
    .default(false)
    .describe('Explicit permission to override a form lock. Never set implicitly.'),
})

const inputSchema = z.discriminatedUnion('source', [existingSchema, deploySchema])

/** Exported for unit tests. */
export const setFormServerValidationInputSchema = inputSchema
export type SetFormServerValidationInput = z.infer<typeof inputSchema>

/** Deploy core seam (injectable in tests). */
type DeployFn = typeof performDeploy

/**
 * Field-write core: getForm -> mutate form.serverValidation -> updateForm, with
 * the form lock honoured. Mirrors set-form-personalisation's write. `forms`
 * defaults to the live SDK Forms service; tests inject a fake.
 */
export async function performSetServerValidation(
  input: {
    formId: number
    apiId: string
    apiEnvironment: string
    apiEnvironmentRoute: string
    overrideLock: boolean
  },
  forms: FormsLike = getClient().forms() as unknown as FormsLike,
): Promise<ToolResult> {
  // Build the EndpointConfiguration before any read/write (fail closed).
  const serverValidation: EndpointConfiguration = {
    type: 'ONEBLINK_API',
    configuration: {
      apiId: input.apiId,
      apiEnvironment: input.apiEnvironment,
      apiEnvironmentRoute: input.apiEnvironmentRoute,
    },
  }

  try {
    const form = (await forms.getForm(input.formId, false)) as unknown as Record<string, unknown>
    const updatedForm = { ...form, serverValidation }

    // Honour the lock. Try without override; on a lock error STOP and ask for
    // permission unless the caller explicitly passed overrideLock.
    let saved: Record<string, unknown>
    try {
      saved = (await forms.updateForm(updatedForm as never, input.overrideLock)) as unknown as Record<
        string,
        unknown
      >
    } catch (err) {
      if (!input.overrideLock && isFormLockedError(err)) {
        logger.warn('set_form_server_validation: form locked', { formId: input.formId })
        return errorResult(
          `Form ${input.formId} is locked in the form builder. No change was made. ` +
            `Re-run with overrideLock: true to override the lock (only with the owner's permission).`,
        )
      }
      const message = err instanceof Error ? err.message : 'updateForm failed'
      logger.error('set_form_server_validation: updateForm failed', { formId: input.formId, message })
      return errorResult(`updateForm failed (no change written): ${message}`)
    }

    const savedServerValidation =
      (saved.serverValidation as Record<string, unknown> | undefined) ?? serverValidation
    logger.info('set_form_server_validation', {
      formId: input.formId,
      apiId: input.apiId,
      apiEnvironment: input.apiEnvironment,
      apiEnvironmentRoute: input.apiEnvironmentRoute,
    })

    // Projection (rule 3): the id touched + the config written, never the whole form.
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            formId: input.formId,
            action: 'set',
            serverValidation: savedServerValidation,
          }),
        },
      ],
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    logger.error('set_form_server_validation failed', { formId: input.formId, message })
    return errorResult(`set_form_server_validation failed: ${message}`)
  }
}

/**
 * Orchestration core, isolated from MCP wiring and injectable for tests.
 *   - `deploy` defaults to the real {@link performDeploy}; tests pass a fake
 *     (with its OWN injected runCli) so no real CLI runs.
 *   - `forms` is passed through to {@link performSetServerValidation}; tests
 *     inject a fake Forms service.
 */
export async function performSetFormServerValidation(
  input: SetFormServerValidationInput,
  deps: {
    deploy?: DeployFn
    forms?: FormsLike
  } = {},
): Promise<ToolResult> {
  const deploy = deps.deploy ?? performDeploy

  // Resolve the apiId + apiEnvironment the serverValidation will point at.
  let apiEnvironment: string

  if (input.source === 'deploy') {
    // Deploy FIRST - this is also where the prod gate fires (inside performDeploy),
    // BEFORE anything is written.
    const deployResult = await deploy({
      projectDir: input.projectDir,
      scope: input.scope,
      env: input.env,
      confirmProduction: input.confirmProduction,
    })
    if (deployResult.isError) {
      // Surface the deploy failure verbatim; NOTHING is written.
      return deployResult
    }
    apiEnvironment = input.env // the environment just deployed to
  } else {
    apiEnvironment = input.apiEnvironment
  }

  return performSetServerValidation(
    {
      formId: input.formId,
      apiId: input.apiId,
      apiEnvironment,
      apiEnvironmentRoute: input.apiEnvironmentRoute,
      overrideLock: input.overrideLock,
    },
    deps.forms,
  )
}

/**
 * Flat raw shape advertised to the model. A ZodRawShape (not a union) is what
 * `server.tool` turns into the tool's JSON schema, so every field across BOTH
 * branches is listed here, with branch-specific ones OPTIONAL at this layer.
 * The real XOR contract is enforced by `inputSchema.safeParse` (the strict
 * discriminated union) inside the handler - bad/ambiguous input fails closed
 * there, so this flat shape never weakens validation.
 */
const registrationShape = {
  source: z
    .enum(['existing', 'deploy'])
    .describe('"existing" = wire an already-deployed API; "deploy" = provision/deploy an API first (new API, new endpoint, or updated endpoint code), then wire it.'),
  formId: z.number().int().positive().describe('OneBlink form id whose serverValidation to set.'),
  apiEnvironmentRoute: z
    .string()
    .min(1)
    .refine((s) => s.startsWith('/'), { message: 'apiEnvironmentRoute must start with "/" (e.g. "/validate")' })
    .describe('Validation route on the hosted API, e.g. "/validate".'),
  overrideLock: z
    .boolean()
    .optional()
    .describe('Explicit permission to override a form lock. Never set implicitly.'),
  // apiId: required on BOTH branches (deploy does not return it) - optional here
  // only so the flat shape is branch-agnostic; the union makes it required.
  apiId: z.string().min(1).optional().describe('Hosted API id (full scope domain). Required on both branches.'),
  // existing-branch only
  apiEnvironment: z
    .string()
    .min(1)
    .optional()
    .describe('source="existing" only: environment of the existing hosted API. On source="deploy" it is derived from `env`.'),
  // deploy-branch only
  projectDir: z
    .string()
    .min(1)
    .optional()
    .describe('source="deploy" only: absolute path to the API codebase (contains .blinkmrc.json).'),
  scope: z
    .string()
    .min(1)
    .optional()
    .describe('source="deploy" only: API scope domain; when set, `oneblink api scope <scope>` runs before deploy.'),
  env: z
    .enum(DEPLOY_ENVS)
    .optional()
    .describe('source="deploy" only: target deploy environment (default dev). Also becomes the serverValidation apiEnvironment.'),
  confirmProduction: z
    .boolean()
    .optional()
    .describe('source="deploy" only: required true to deploy to prod. Without it a prod deploy fails closed.'),
} as const

export function registerSetFormServerValidation(server: McpServer): void {
  server.tool(
    'set_form_server_validation',
    "Set a form's server validation endpoint: a ONEBLINK_API callback that runs " +
      'on the server when a submission is made (distinct from personalisation, ' +
      'which runs before the user fills the form). EITHER point at an EXISTING ' +
      'hosted API (source: "existing") OR provision/deploy an API first (source: ' +
      '"deploy" - new API, new endpoint, or updated endpoint code) and wire that. ' +
      'The deploy branch deploys THEN writes; a failed deploy writes nothing. ' +
      'Deploying to prod requires confirmProduction: true (fails closed otherwise). ' +
      'A locked form stops with a permission request unless overrideLock is explicitly set.',
    registrationShape,
    async (rawArgs: Record<string, unknown>) => {
      const parsed = inputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return errorResult(parsed.error.errors.map((e) => e.message).join('; '))
      }
      return performSetFormServerValidation(parsed.data)
    },
  )
}
