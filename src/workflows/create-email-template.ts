/**
 * Workflow: create_email_template
 *
 * Create a reusable OneBlink email template so a PDF/email submission event can
 * reference it by `templateId`. Closes the create->reference loop for
 * `upsert_email_submission_event`.
 * Spec: docs/requirements/create-email-template.md.
 * Follows: steering tool-design (rules 1, 3, 6), security (A01/A03/A09).
 *
 * SDK facts (verified): EmailTemplates.createEmailTemplate(data: NewEmailTemplate):
 * Promise<EmailTemplate> (@oneblink/sdk tenants/classes/EmailTemplates.d.ts:70).
 * NewEmailTemplate.type is a 7-value string union pinned verbatim from
 * @oneblink/types typescript/emailTemplates.ts:17-24. organisationId is DERIVED
 * from the Developer Key (rule 1), never a tool arg. EmailTemplate extends
 * NewEmailTemplate with { id: number; createdAt; updatedAt } (emailTemplates.ts:27).
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getClient } from '../lib/oneblink-client.js'
import { logger } from '../lib/logger.js'

// SDK-authoritative enum. Pinned verbatim from the installed SDK types:
// node_modules/@oneblink/types/typescript/emailTemplates.ts lines 17-24
// (NewEmailTemplate.type union). Do NOT guess — steering rule 6.
const EMAIL_TEMPLATE_TYPES = [
  'FORM_SUBMISSION_EVENT_PDF',
  'FORMS_APP_WELCOME_EMAIL',
  'APPROVAL_CLARIFICATION_REQUEST',
  'APPROVAL_APPROVED',
  'APPROVAL_DENIED',
  'TO_APPROVER_APPROVAL_CREATED',
  'FORM_SUBMISSION_EVENT_EMAIL',
] as const

const environmentSchema = z.object({
  formsAppEnvironmentId: z
    .number()
    .int()
    .positive()
    .describe('The forms app environment this template body applies to. Discover ids with list_forms_app_environments.'),
  template: z
    .string()
    .min(1)
    .describe('The email template body for this environment. Supports {{custom:tag}} tokens (stored verbatim, resolved by the OneBlink platform).'),
})

const baseShape = {
  name: z.string().min(1).describe('Email template name.'),
  workspaceIds: z
    .array(z.number().int().positive())
    .nonempty()
    .describe('Workspace id(s) this template belongs to (at least one). Discover ids with list_workspaces. REQUIRED by the API — omitting it is a 400 and an empty list is a 500.'),
  type: z
    .enum(EMAIL_TEMPLATE_TYPES)
    .describe(`The template type (SDK-authoritative). One of: ${EMAIL_TEMPLATE_TYPES.join(', ')}.`),
  environments: z
    .array(environmentSchema)
    .min(1)
    .describe('Per-environment template bodies; at least one. Each formsAppEnvironmentId must be unique.'),
} as const

const inputSchema = z.object(baseShape)
export const createEmailTemplateInputSchema = inputSchema
type Input = z.infer<typeof inputSchema>

function errorResult(text: string) {
  return { isError: true as const, content: [{ type: 'text' as const, text }] }
}

export function registerCreateEmailTemplate(server: McpServer): void {
  server.tool(
    'create_email_template',
    'Create a reusable OneBlink email template that a PDF/email submission event ' +
      'can reference by templateId. Supply a name, an SDK-authoritative type, and ' +
      'one or more per-environment template bodies (each formsAppEnvironmentId must ' +
      'be unique). The organisation is derived from the Developer Key, never a tool ' +
      'input. Input is validated fail-fast before any API call; returns the new ' +
      'template id for use as a submission-event templateId.',
    baseShape,
    async (rawArgs: Record<string, unknown>) => {
      const parsed = inputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return errorResult(parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '))
      }
      const input: Input = parsed.data

      // Fail-fast: duplicate formsAppEnvironmentId across environments (spec).
      const envIds = input.environments.map((e) => e.formsAppEnvironmentId)
      const dupes = envIds.filter((id, i) => envIds.indexOf(id) !== i)
      if (dupes.length > 0) {
        return errorResult(
          `Duplicate formsAppEnvironmentId in environments: ${[...new Set(dupes)].join(', ')}. Each environment may appear at most once.`,
        )
      }

      // Derive organisationId server-side (steering rule 1 — never a model
      // input). Read it from one existing form the authenticated key can see.
      const client = getClient()
      let organisationId: string
      try {
        const probe = (await client.forms().searchForms({ limit: 1, offset: 0 } as never)) as unknown as {
          forms?: Array<{ organisationId?: string }>
        }
        const org = probe.forms?.[0]?.organisationId
        if (typeof org !== 'string' || org.length === 0) {
          return errorResult(
            'Could not derive organisationId from the credential (no existing form to read it from). ' +
              'Create at least one form in the console first, or supply a tenant with existing forms.',
          )
        }
        organisationId = org
      } catch (err) {
        const message = err instanceof Error ? err.message : 'org derivation failed'
        return errorResult(`Could not resolve organisationId (no template created): ${message}`)
      }

      // Scaffold NewEmailTemplate and create. organisationId is DERIVED (rule 1);
      // workspaceIds is a REQUIRED non-empty input (WithWorkspacesAssociation,
      // misc.d.ts:275) — a missing field 400s and an empty [] 500s (verified live).
      const newTemplate: Record<string, unknown> = {
        name: input.name,
        organisationId,
        workspaceIds: input.workspaceIds,
        type: input.type,
        environments: input.environments.map((e) => ({
          formsAppEnvironmentId: e.formsAppEnvironmentId,
          template: e.template,
        })),
      }

      try {
        const created = (await client.emailTemplates().createEmailTemplate(newTemplate as never)) as unknown as Record<
          string,
          unknown
        >
        const createdEnvs = (created.environments as unknown[]) ?? []
        const environmentCount = createdEnvs.length || input.environments.length
        // A09: log only {id, type, environmentCount} — never template bodies.
        logger.info('create_email_template', {
          ...(typeof created.id === 'number' ? { id: created.id } : {}),
          type: input.type,
          environmentCount,
        })
        // Projection (rule 3): id used as a submission-event templateId + counts.
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                id: created.id ?? null,
                name: created.name ?? input.name,
                type: created.type ?? input.type,
                environmentCount,
              }),
            },
          ],
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'createEmailTemplate failed'
        logger.error('create_email_template failed', { type: input.type, message })
        return errorResult(`create_email_template failed (no template created): ${message}`)
      }
    },
  )
}
