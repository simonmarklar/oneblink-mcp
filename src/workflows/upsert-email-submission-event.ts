/**
 * Workflow: upsert_email_submission_event
 *
 * Add or update an email / PDF submission event on a form's workflow, creating
 * or reusing the Email Template and writing the Custom PDF (PDFConfiguration).
 * Spec: docs/requirements/upsert-email-submission-event.md (decisions D1-D5).
 * Follows: steering tool-design (rules 1,3,6), security (A01/A08/A09), meta-files.
 *
 * SDK facts (verified): no "add event" API — getForm -> mutate
 * form.submissionEvents -> updateForm(form, overrideLock). Email Template is a
 * separate resource linked by configuration.emailTemplate.id.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getClient } from '../lib/oneblink-client.js'
import { logger } from '../lib/logger.js'
import { buildSubmissionEvent, spliceEvent, isFormLockedError } from '../lib/submission-event.js'

const emailShape = z.object({
  toEmail: z.array(z.string().email()).nonempty('at least one toEmail is required'),
  ccEmail: z.array(z.string().email()).optional(),
  bccEmail: z.array(z.string().email()).optional(),
  subjectLine: z.string().min(1).optional(),
})

const pdfShape = z
  .object({
    fileName: z.string().min(1).optional(),
    includeSubmissionId: z.boolean().optional(),
    includeExternalId: z.boolean().optional(),
    excludedElementIds: z.array(z.string()).optional(),
    excludedCSSClasses: z.array(z.string()).optional(),
  })
  .optional()

// Email template: link an existing one by id, OR create/update by name+body.
const emailTemplateShape = z
  .union([
    z.object({ id: z.number().int().positive() }),
    z.object({
      name: z.string().min(1),
      bodyHtml: z.string().min(1),
      type: z.string().min(1).default('FORM_SUBMISSION_EVENT_PDF'),
    }),
  ])
  .optional()

const baseShape = {
  formId: z.number().int().positive(),
  eventType: z.enum(['EMAIL', 'PDF']).default('PDF'),
  email: emailShape,
  pdf: pdfShape,
  emailTemplate: emailTemplateShape,
  replaceIndex: z.number().int().min(0).optional().describe('Replace the event at this index; omit to append. Never guessed (D1).'),
  overrideLock: z.boolean().default(false).describe('Explicit permission to override a form lock (D2). Never set implicitly.'),
  conditionallyExecute: z.boolean().optional(),
  isRetryable: z.boolean().optional(),
} as const

const inputSchema = z.object(baseShape)
export const upsertEmailSubmissionEventInputSchema = inputSchema
type Input = z.infer<typeof inputSchema>

function errorResult(text: string) {
  return { isError: true, content: [{ type: 'text' as const, text }] }
}

/**
 * Resolve the email template id (D3 reuse-by-name, D4 same-env, D5 converge).
 * - {id}            -> use as-is.
 * - {name,bodyHtml} -> search by name in the form's environment; update if found
 *                      (converge), else create. Returns the template id.
 */
async function resolveEmailTemplateId(
  tmpl: Input['emailTemplate'],
  formEnvId: number,
  orgId: string,
  workspaceIds: number[],
): Promise<number | undefined> {
  if (!tmpl) return undefined
  const svc = getClient().emailTemplates()
  if ('id' in tmpl) return tmpl.id

  // find existing by name (reuse-by-name, idempotent)
  const found = await svc.searchEmailTemplates({ limit: 200, offset: 0 })
  const existing = (found.emailTemplates as Array<{ id: number; name: string }>).find(
    (t) => t.name === tmpl.name,
  )
  const environments = [{ template: tmpl.bodyHtml, formsAppEnvironmentId: formEnvId }] // D4: form's env

  if (existing) {
    const current = (await svc.getEmailTemplate(existing.id)) as unknown as Record<string, unknown>
    const updated = { ...current, name: tmpl.name, environments, type: tmpl.type, workspaceIds }
    const saved = (await svc.updateEmailTemplate(updated as never)) as { id: number }
    return saved.id
  }
  const created = (await svc.createEmailTemplate({
    name: tmpl.name,
    organisationId: orgId,
    workspaceIds,
    environments,
    type: tmpl.type,
  } as never)) as { id: number }
  return created.id
}

export function registerUpsertEmailSubmissionEvent(server: McpServer): void {
  server.tool(
    'upsert_email_submission_event',
    'Add or update an email/PDF submission event on a form, creating or reusing ' +
      'its Email Template and Custom PDF config. Replace an existing event only via ' +
      'an explicit replaceIndex (never guessed). A locked form stops with a ' +
      'permission request unless overrideLock is explicitly set.',
    baseShape,
    async (rawArgs: Record<string, unknown>) => {
      const parsed = inputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return errorResult(parsed.error.errors.map((e) => e.message).join('; '))
      }
      const input = parsed.data
      const forms = getClient().forms()

      try {
        const form = (await forms.getForm(input.formId, false)) as unknown as Record<string, unknown>
        const formEnvId = form.formsAppEnvironmentId as number
        const orgId = form.organisationId as string

        // D3/D4/D5: resolve (reuse/create) the email template in the form's env.
        // A created template needs workspaceIds; the form's workspace comes from
        // its environment (forms in env 380 have workspaceId null, but the
        // environment carries the real workspaceId). Only looked up when we may
        // create — i.e. the caller passed template content, not an id.
        let emailTemplateId: number | undefined
        try {
          let workspaceIds: number[] = []
          if (input.emailTemplate && !('id' in input.emailTemplate)) {
            const env = (await getClient()
              .formsAppEnvironments()
              .getFormsAppEnvironment(formEnvId)) as unknown as { workspaceId?: number }
            workspaceIds = typeof env.workspaceId === 'number' ? [env.workspaceId] : []
          }
          emailTemplateId = await resolveEmailTemplateId(input.emailTemplate, formEnvId, orgId, workspaceIds)
        } catch (err) {
          const message = err instanceof Error ? err.message : 'template resolution failed'
          logger.error('upsert_email_submission_event: template step failed', {
            formId: input.formId,
            message,
          })
          return errorResult(`email template step failed (no event written): ${message}`)
        }

        const event = buildSubmissionEvent({
          eventType: input.eventType,
          email: input.email,
          pdf: input.pdf,
          emailTemplateId,
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

        // D2: honour the lock. Try without override; on a lock error, STOP and
        // ask for permission unless the caller explicitly passed overrideLock.
        let saved: Record<string, unknown>
        try {
          saved = (await forms.updateForm(updatedForm as never, input.overrideLock)) as unknown as Record<
            string,
            unknown
          >
        } catch (err) {
          if (!input.overrideLock && isFormLockedError(err)) {
            logger.warn('upsert_email_submission_event: form locked', { formId: input.formId })
            return errorResult(
              `Form ${input.formId} is locked in the form builder. No change was made. ` +
                `Re-run with overrideLock: true to override the lock (only with the owner's permission).`,
            )
          }
          const message = err instanceof Error ? err.message : 'updateForm failed'
          logger.error('upsert_email_submission_event: updateForm failed', {
            formId: input.formId,
            message,
          })
          return errorResult(`updateForm failed (no event written): ${message}`)
        }

        const savedEvents = (saved.submissionEvents as unknown[]) ?? []
        const index = input.replaceIndex ?? savedEvents.length - 1
        logger.info('upsert_email_submission_event', {
          formId: input.formId,
          eventType: input.eventType,
          index,
          ...(emailTemplateId !== undefined ? { emailTemplateId } : {}),
          action: input.replaceIndex === undefined ? 'append' : 'replace',
          totalEvents: savedEvents.length,
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
                eventType: input.eventType,
                emailTemplateId: emailTemplateId ?? null,
                totalSubmissionEvents: savedEvents.length,
                event: savedEvents[index] ?? event,
              }),
            },
          ],
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        logger.error('upsert_email_submission_event failed', { formId: input.formId, message })
        return errorResult(`upsert_email_submission_event failed: ${message}`)
      }
    },
  )
}
