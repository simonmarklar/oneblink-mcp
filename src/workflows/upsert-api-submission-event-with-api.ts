/**
 * Workflow: upsert_api_submission_event_with_deploy
 *
 * The EITHER/OR hosted-API submission-event tool. In ONE call the caller can
 * EITHER wire an EXISTING hosted API as a form's ONEBLINK_API submission-event
 * webhook, OR provision/deploy a NEW hosted API from a project directory and
 * wire THAT as the webhook.
 *
 * This tool is a COMPOSITION, not a reimplementation:
 *   - deploy is `performDeploy` from deploy-hosted-api.ts (prod gate, per-caller
 *     CLI creds, scope+deploy argv, URL parse — all reused as-is).
 *   - the event write is `performUpsert` from upsert-api-submission-event.ts
 *     (getForm -> buildApiSubmissionEvent -> spliceEvent -> updateForm with the
 *     form-lock honoured) — reused as-is.
 *
 * apiId DERIVATION (recorded decision): `performDeploy`'s result is
 * `{deployed, env, scope, url}` — it carries NO apiId. `oneblink api deploy`
 * deploys to an EXISTING API scope whose apiId/subdomain is created in the
 * OneBlink Console, and the CLI output does not reliably echo the apiId. So on
 * the `source:'deploy'` branch, `apiId` is a REQUIRED input (the caller supplies
 * the Console-created id). The event's `apiEnvironment` IS derived — it is the
 * `env` just deployed to.
 *
 * SECURITY (see .kiro/steering/security.md):
 *   - safeParse fail-closed (A03): a discriminated union; bad/ambiguous input
 *     never reaches deploy or the SDK.
 *   - PROD GATE preserved end-to-end: the deploy branch runs `performDeploy`
 *     FIRST, so env=prod + confirmProduction=false fails closed BEFORE any
 *     subprocess AND before any event is written. We do not duplicate a weaker
 *     gate.
 *   - Deploy-before-write ordering: a deploy that returns isError STOPS the tool
 *     — no event is written against an API that failed to deploy.
 *   - A09 Logging: the organisationManagedSecretId value and CLI creds are never
 *     logged (both reused cores already guarantee this).
 *   - Projection (rule 3): returns the upsert projection, never the whole form.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { performDeploy, DEPLOY_ENVS, type ToolResult } from './deploy-hosted-api.js'
import { performUpsert, type FormsLike } from './upsert-api-submission-event.js'

// --- shared form-event fields (both branches carry these) ----------------
const formEventShape = {
  formId: z.number().int().positive().describe('OneBlink form id to add the webhook event to.'),
  apiEnvironmentRoute: z
    .string()
    .min(1)
    .refine((s) => s.startsWith('/'), { message: "apiEnvironmentRoute should start with '/' (e.g. '/my-route')" })
    .describe("The route of the API+environment, e.g. '/my-route'."),
  organisationManagedSecretId: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Optional organisation managed secret id used to verify request authenticity. Only its id is handled; never logged.'),
  label: z.string().min(1).optional().describe('Optional label to identify the event.'),
  replaceIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Replace the event at this index; omit to append. Never guessed.'),
  overrideLock: z
    .boolean()
    .default(false)
    .describe('Explicit permission to override a form lock. Never set implicitly.'),
  conditionallyExecute: z.boolean().optional(),
  isRetryable: z.boolean().optional(),
} as const

// --- source:'existing' — point at an already-deployed hosted API ---------
const existingSchema = z.object({
  source: z.literal('existing'),
  apiId: z.string().min(1).describe('ID of the EXISTING OneBlink hosted API the request is made to.'),
  apiEnvironment: z
    .string()
    .min(1)
    .describe("Environment of the EXISTING hosted API, e.g. 'dev' | 'test' | 'prod'. Free string."),
  ...formEventShape,
})

// --- source:'deploy' — provision/deploy a NEW hosted API then wire it ----
// apiId is REQUIRED here too (see apiId DERIVATION note above). apiEnvironment
// is NOT an input: it is derived from `env` (the environment just deployed to).
const deploySchema = z.object({
  source: z.literal('deploy'),
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
    .describe('Target deploy environment. Also becomes the event\'s apiEnvironment.'),
  confirmProduction: z
    .boolean()
    .default(false)
    .describe('Required true to deploy to prod. Without it a prod deploy fails closed before any subprocess runs.'),
  apiId: z
    .string()
    .min(1)
    .describe(
      'ID of the hosted API being deployed to. REQUIRED: `oneblink api deploy` targets an EXISTING Console-created ' +
        'API scope and does not return the apiId, so the caller must supply it to wire the submission event.',
    ),
  ...formEventShape,
})

const inputSchema = z.discriminatedUnion('source', [existingSchema, deploySchema])

/** Exported for unit tests. */
export const upsertApiSubmissionEventWithApiInputSchema = inputSchema
export type UpsertApiSubmissionEventWithApiInput = z.infer<typeof inputSchema>

/** Deploy core seam (injectable in tests). */
type DeployFn = typeof performDeploy
/** Upsert core seam (injectable in tests). */
type UpsertFn = typeof performUpsert

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text }] }
}

/**
 * Core orchestration, isolated from MCP wiring and injectable for tests.
 *   - `deploy` defaults to the real {@link performDeploy}; tests pass a fake
 *     (with its OWN injected runCli) so no real CLI runs.
 *   - `upsert` defaults to the real {@link performUpsert}; tests pass a fake
 *     Forms service via the 2nd arg of performUpsert, OR a fake upsert fn here.
 */
export async function performUpsertWithApi(
  input: UpsertApiSubmissionEventWithApiInput,
  deps: {
    deploy?: DeployFn
    upsert?: UpsertFn
    forms?: FormsLike
  } = {},
): Promise<ToolResult> {
  const deploy = deps.deploy ?? performDeploy
  const upsert = deps.upsert ?? performUpsert

  // Resolve the apiId + apiEnvironment the event will point at.
  let apiId: string
  let apiEnvironment: string

  if (input.source === 'deploy') {
    // Deploy FIRST — this is also where the prod gate fires (inside performDeploy),
    // BEFORE any event is written.
    const deployResult = await deploy({
      projectDir: input.projectDir,
      scope: input.scope,
      env: input.env,
      confirmProduction: input.confirmProduction,
    })
    if (deployResult.isError) {
      // Surface the deploy failure verbatim; NO event is written.
      return deployResult
    }
    apiId = input.apiId
    apiEnvironment = input.env // the environment just deployed to
  } else {
    apiId = input.apiId
    apiEnvironment = input.apiEnvironment
  }

  // Write the ONEBLINK_API submission event via the shipped upsert core.
  return upsert(
    {
      formId: input.formId,
      apiId,
      apiEnvironment,
      apiEnvironmentRoute: input.apiEnvironmentRoute,
      organisationManagedSecretId: input.organisationManagedSecretId,
      label: input.label,
      replaceIndex: input.replaceIndex,
      overrideLock: input.overrideLock,
      conditionallyExecute: input.conditionallyExecute,
      isRetryable: input.isRetryable,
    },
    deps.forms,
  )
}

/**
 * Flat raw shape advertised to the model. A ZodRawShape (not a union) is what
 * `server.tool` turns into the tool's JSON schema, so every field across BOTH
 * branches is listed here, with branch-specific ones OPTIONAL at this layer.
 * The real XOR contract is enforced by `inputSchema.safeParse` (the strict
 * discriminated union) inside the handler — bad/ambiguous input fails closed
 * there, so this flat shape never weakens validation.
 */
const registrationShape = {
  source: z
    .enum(['existing', 'deploy'])
    .describe('"existing" = wire an already-deployed API; "deploy" = provision/deploy a NEW API first, then wire it.'),
  // event fields (both branches)
  formId: formEventShape.formId,
  apiEnvironmentRoute: formEventShape.apiEnvironmentRoute,
  organisationManagedSecretId: formEventShape.organisationManagedSecretId,
  label: formEventShape.label,
  replaceIndex: formEventShape.replaceIndex,
  overrideLock: formEventShape.overrideLock,
  conditionallyExecute: formEventShape.conditionallyExecute,
  isRetryable: formEventShape.isRetryable,
  // apiId: required on BOTH branches (deploy does not return it) — optional here
  // only so the flat shape is branch-agnostic; the union makes it required.
  apiId: z.string().min(1).optional().describe('Hosted API id. Required on both branches.'),
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
    .describe('source="deploy" only: target deploy environment (default dev). Also becomes the event apiEnvironment.'),
  confirmProduction: z
    .boolean()
    .optional()
    .describe('source="deploy" only: required true to deploy to prod. Without it a prod deploy fails closed.'),
} as const

export function registerUpsertApiSubmissionEventWithApi(server: McpServer): void {
  server.tool(
    'upsert_api_submission_event_with_deploy',
    'Wire a hosted-API webhook submission event (ONEBLINK_API) onto a form, ' +
      'EITHER pointing at an EXISTING hosted API (source: "existing") OR ' +
      'provisioning/deploying a NEW hosted API from a project directory first ' +
      '(source: "deploy") and wiring that. The deploy branch deploys THEN writes ' +
      'the event; a failed deploy writes no event. Deploying to prod requires ' +
      'confirmProduction: true (fails closed otherwise). A locked form stops with ' +
      'a permission request unless overrideLock is explicitly set.',
    registrationShape,
    async (rawArgs: Record<string, unknown>) => {
      const parsed = inputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return errorResult(parsed.error.errors.map((e) => e.message).join('; '))
      }
      return performUpsertWithApi(parsed.data)
    },
  )
}
