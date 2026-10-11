/**
 * Workflow: set_form_personalisation
 *
 * Set `form.personalisation` to a ONEBLINK_API EndpointConfiguration on an
 * existing form - the PREFILL endpoint that populates a form BEFORE the user
 * fills it (distinct from `submissionEvents`, which fire AFTER submit).
 * Follows: steering tool-design (rules 1,3,6), security (A01/A08/A09).
 *
 * SDK facts (verified live last session against @oneblink/types + the tenant):
 *   - Field is `form.personalisation?: EndpointConfiguration` in forms.d.ts.
 *   - Working shape: { type: 'ONEBLINK_API', configuration: { apiId,
 *     apiEnvironment, apiEnvironmentRoute } }.
 *   - `apiId` is the FULL scope domain string, e.g.
 *     'oneblink-mcp-test.api.oneblink.io' (NOT a short id).
 *   - No "set personalisation" API - getForm -> mutate form.personalisation ->
 *     updateForm(form, overrideLock). Same mutate-in-place + lock pattern as the
 *     submission-event / approval-flow workflows.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getClient } from '../lib/oneblink-client.js'
import { logger } from '../lib/logger.js'
import { isFormLockedError } from '../lib/submission-event.js'

const baseShape = {
  formId: z.number().int().positive(),
  apiId: z
    .string()
    .min(1, 'apiId is required')
    .describe('Full scope domain string, e.g. "oneblink-mcp-test.api.oneblink.io" (not a short id).'),
  apiEnvironment: z
    .string()
    .min(1, 'apiEnvironment is required')
    .describe('Hosted API environment, e.g. "dev" / "test" / "prod".'),
  apiEnvironmentRoute: z
    .string()
    .min(1, 'apiEnvironmentRoute is required')
    .startsWith('/', 'apiEnvironmentRoute must start with "/"')
    .describe('Route on the hosted API, e.g. "/test".'),
  overrideLock: z
    .boolean()
    .default(false)
    .describe('Explicit permission to override a form lock. Never set implicitly.'),
} as const

const inputSchema = z.object(baseShape)
export const setFormPersonalisationInputSchema = inputSchema
type Input = z.infer<typeof inputSchema>

function errorResult(text: string) {
  return { isError: true, content: [{ type: 'text' as const, text }] }
}

export function registerSetFormPersonalisation(server: McpServer): void {
  server.tool(
    'set_form_personalisation',
    'Set a form\'s personalisation (prefill) endpoint: a ONEBLINK_API that ' +
      'populates the form BEFORE the user fills it (distinct from submission ' +
      'events, which fire after submit). Points form.personalisation at a hosted ' +
      'OneBlink API by apiId + environment + route. A locked form stops with a ' +
      'permission request unless overrideLock is explicitly set.',
    baseShape,
    async (rawArgs: Record<string, unknown>) => {
      const parsed = inputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return errorResult(parsed.error.errors.map((e) => e.message).join('; '))
      }
      const input: Input = parsed.data
      const forms = getClient().forms()

      // Build the EndpointConfiguration before any read/write (fail closed).
      const personalisation = {
        type: 'ONEBLINK_API' as const,
        configuration: {
          apiId: input.apiId,
          apiEnvironment: input.apiEnvironment,
          apiEnvironmentRoute: input.apiEnvironmentRoute,
        },
      }

      try {
        const form = (await forms.getForm(input.formId, false)) as unknown as Record<string, unknown>
        const updatedForm = { ...form, personalisation }

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
            logger.warn('set_form_personalisation: form locked', { formId: input.formId })
            return errorResult(
              `Form ${input.formId} is locked in the form builder. No change was made. ` +
                `Re-run with overrideLock: true to override the lock (only with the owner's permission).`,
            )
          }
          const message = err instanceof Error ? err.message : 'updateForm failed'
          logger.error('set_form_personalisation: updateForm failed', { formId: input.formId, message })
          return errorResult(`updateForm failed (no change written): ${message}`)
        }

        const savedPersonalisation =
          (saved.personalisation as Record<string, unknown> | undefined) ?? personalisation
        logger.info('set_form_personalisation', {
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
                personalisation: savedPersonalisation,
              }),
            },
          ],
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        logger.error('set_form_personalisation failed', { formId: input.formId, message })
        return errorResult(`set_form_personalisation failed: ${message}`)
      }
    },
  )
}
