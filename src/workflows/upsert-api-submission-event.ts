/**
 * Workflow: upsert_api_submission_event
 *
 * Add or update a HOSTED-API webhook submission event (type 'ONEBLINK_API') on
 * a form's workflow, pointing at an EXISTING OneBlink hosted API + route. It
 * does NOT provision a new API — the api must already exist (a separate tool
 * deploys one). Mirrors upsert_email_submission_event exactly: no "add event"
 * SDK API, so getForm -> mutate submissionEvents[] via a pure splice ->
 * updateForm(form, overrideLock).
 *
 * Event shape (verified, @oneblink/types submissionEvents.d.ts
 * `OneBlinkAPISubmissionEvent = FormEventBase & EndpointConfigurationAPI`):
 *   { type:'ONEBLINK_API', configuration:{ apiId, apiEnvironment,
 *     apiEnvironmentRoute[, organisationManagedSecretId] }, ... }
 *
 * SECURITY (see .kiro/steering/security.md):
 *   - safeParse fail-closed (A03): bad input never reaches the SDK.
 *   - FORM LOCK (A01): try updateForm without override; on a lock error with
 *     overrideLock false, STOP and return the same fail-closed permission
 *     message — no change made.
 *   - A09 Logging: we log formId, index, action, apiId/apiEnvironment/route
 *     (not secrets) and NEVER the organisationManagedSecretId value.
 *   - Projection (rule 3): the upserted event + where it landed, never the
 *     whole form.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getClient } from '../lib/oneblink-client.js'
import { logger } from '../lib/logger.js'
import { buildApiSubmissionEvent, spliceEvent, isFormLockedError } from '../lib/submission-event.js'

const baseShape = {
  formId: z.number().int().positive().describe('OneBlink form id to add the webhook event to.'),
  apiId: z.string().min(1).describe('ID of the EXISTING OneBlink hosted API the request is made to.'),
  apiEnvironment: z
    .string()
    .min(1)
    .describe("Environment of the hosted API, e.g. 'dev' | 'test' | 'prod'. Free string (the SDK type is a string)."),
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
    .describe('Replace the event at this index; omit to append. Never guessed (same semantics as the email tool).'),
  overrideLock: z
    .boolean()
    .default(false)
    .describe('Explicit permission to override a form lock. Never set implicitly.'),
  conditionallyExecute: z.boolean().optional(),
  isRetryable: z.boolean().optional(),
} as const

const inputSchema = z.object(baseShape)

/** Exported for unit tests. */
export const upsertApiSubmissionEventInputSchema = inputSchema
export type UpsertApiSubmissionEventInput = z.infer<typeof inputSchema>

/** Minimal Forms service surface this tool depends on (for an injectable fake in tests). */
export interface FormsLike {
  getForm(formId: number, injectForms: boolean): Promise<unknown>
  updateForm(form: unknown, overrideLock?: boolean): Promise<unknown>
}

/** Tool result shape (MCP-compatible: open index signature). */
export type ToolResult = {
  [x: string]: unknown
  isError?: boolean
  content: Array<{ type: 'text'; text: string }>
}

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text }] }
}

/**
 * Core upsert orchestration, isolated from the MCP server wiring so it is unit
 * testable with an injected `forms` service. `forms` defaults to the real
 * `getClient().forms()`; tests pass a fake.
 */
export async function performUpsert(
  input: UpsertApiSubmissionEventInput,
  forms: FormsLike = getClient().forms() as unknown as FormsLike,
): Promise<ToolResult> {
  try {
    const form = (await forms.getForm(input.formId, false)) as Record<string, unknown>

    const event = buildApiSubmissionEvent({
      apiId: input.apiId,
      apiEnvironment: input.apiEnvironment,
      apiEnvironmentRoute: input.apiEnvironmentRoute,
      organisationManagedSecretId: input.organisationManagedSecretId,
      label: input.label,
      conditionallyExecute: input.conditionallyExecute,
      isRetryable: input.isRetryable,
    })

    const currentEvents = (form.submissionEvents as unknown[]) ?? []
    let nextEvents: unknown[]
    try {
      nextEvents = spliceEvent(currentEvents, event, input.replaceIndex)
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'splice failed')
    }

    const updatedForm = { ...form, submissionEvents: nextEvents }

    // Honour the lock. Try without override; on a lock error, STOP and ask for
    // permission unless the caller explicitly passed overrideLock.
    let saved: Record<string, unknown>
    try {
      saved = (await forms.updateForm(updatedForm, input.overrideLock)) as Record<string, unknown>
    } catch (err) {
      if (!input.overrideLock && isFormLockedError(err)) {
        logger.warn('upsert_api_submission_event: form locked', { formId: input.formId })
        return errorResult(
          `Form ${input.formId} is locked in the form builder. No change was made. ` +
            `Re-run with overrideLock: true to override the lock (only with the owner's permission).`,
        )
      }
      const message = err instanceof Error ? err.message : 'updateForm failed'
      logger.error('upsert_api_submission_event: updateForm failed', {
        formId: input.formId,
        message,
      })
      return errorResult(`updateForm failed (no event written): ${message}`)
    }

    const savedEvents = (saved.submissionEvents as unknown[]) ?? []
    const index = input.replaceIndex ?? savedEvents.length - 1
    logger.info('upsert_api_submission_event', {
      formId: input.formId,
      apiId: input.apiId,
      apiEnvironment: input.apiEnvironment,
      apiEnvironmentRoute: input.apiEnvironmentRoute,
      index,
      action: input.replaceIndex === undefined ? 'append' : 'replace',
      totalEvents: savedEvents.length,
      // NOTE: organisationManagedSecretId value is deliberately never logged.
    })

    // Projection (rule 3): the upserted event + where it landed, never the whole form.
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            formId: input.formId,
            action: input.replaceIndex === undefined ? 'appended' : 'replaced',
            index,
            type: 'ONEBLINK_API',
            apiId: input.apiId,
            apiEnvironment: input.apiEnvironment,
            apiEnvironmentRoute: input.apiEnvironmentRoute,
            totalSubmissionEvents: savedEvents.length,
            event: savedEvents[index] ?? event,
          }),
        },
      ],
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    logger.error('upsert_api_submission_event failed', { formId: input.formId, message })
    return errorResult(`upsert_api_submission_event failed: ${message}`)
  }
}

export function registerUpsertApiSubmissionEvent(server: McpServer): void {
  server.tool(
    'upsert_api_submission_event',
    'Add or update a hosted-API webhook submission event (ONEBLINK_API) on a ' +
      'form, pointing at an EXISTING OneBlink hosted API + route. Does not ' +
      'provision a new API. Replace an existing event only via an explicit ' +
      'replaceIndex (never guessed). A locked form stops with a permission ' +
      'request unless overrideLock is explicitly set.',
    baseShape,
    async (rawArgs: Record<string, unknown>) => {
      const parsed = inputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return errorResult(parsed.error.errors.map((e) => e.message).join('; '))
      }
      return performUpsert(parsed.data)
    },
  )
}
