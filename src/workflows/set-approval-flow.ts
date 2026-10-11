/**
 * Workflow: set_approval_flow
 *
 * Set (replace) the approval flow configuration on a form - the ordered
 * `approvalSteps` and optional whole-flow `approvalConfiguration`.
 * Spec: docs/requirements/set-approval-flow.md (D1-D5).
 * Follows: steering tool-design (rules 1,3,6), security (A01/A08/A09), meta-files.
 *
 * SDK facts (verified against @oneblink/types; live probe pending): no "set
 * approval flow" API - getForm -> mutate form.approvalSteps -> updateForm(form,
 * overrideLock). Same mutate-in-place + lock pattern as submission events.
 *
 * This configures WHO approves a submission and in what order. It does NOT
 * create/approve/deny an actual submission approval - the SDK Approvals class
 * is read-only; decisioning is Approvals-app operator action.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getClient } from '../lib/oneblink-client.js'
import { logger } from '../lib/logger.js'
import { isFormLockedError } from '../lib/submission-event.js'
import { buildApprovalSteps, stepLabels, type ApprovalStepInput } from '../lib/approval-flow.js'

const nodeShape = z.object({
  label: z.string().min(1),
  group: z.string().min(1),
  approvalFormId: z.number().int().positive().optional(),
  approvalFormPrefillMappings: z.array(z.unknown()).optional(),
  hideApprovalDenyButton: z.boolean().optional(),
  editableFormElementIds: z.array(z.string()).optional(),
})

const stepShape = nodeShape.extend({
  type: z.enum(['STANDARD', 'CONCURRENT']).default('STANDARD'),
  nodes: z.array(nodeShape).optional().describe('Required for CONCURRENT steps; >= 1 node.'),
  isConditional: z.boolean().optional(),
  requiresAllConditionalPredicates: z.boolean().optional(),
  conditionalPredicates: z.array(z.unknown()).optional(),
})

// For a CONCURRENT step the step-level label/group are placeholders; the real
// approvers live in nodes[]. zod requires label/group on every step via
// nodeShape, so CONCURRENT callers pass a step label and the nodes carry theirs.
// buildApprovalSteps ignores the step-level label/group for CONCURRENT.
const concurrentFriendlyStep = stepShape.partial({ label: true, group: true })

const baseShape = {
  formId: z.number().int().positive(),
  steps: z
    .array(concurrentFriendlyStep)
    .nonempty('at least one approval step is required')
    .describe('The full ordered approval flow. REPLACES the existing flow (D1).'),
  approvalConfiguration: z
    .record(z.unknown())
    .optional()
    .describe('Whole-flow config written verbatim when supplied; left untouched otherwise (D5).'),
  overrideLock: z
    .boolean()
    .default(false)
    .describe('Explicit permission to override a form lock (D2). Never set implicitly.'),
} as const

const inputSchema = z.object(baseShape)
export const setApprovalFlowInputSchema = inputSchema
type Input = z.infer<typeof inputSchema>

function errorResult(text: string) {
  return { isError: true, content: [{ type: 'text' as const, text }] }
}

export function registerSetApprovalFlow(server: McpServer): void {
  server.tool(
    'set_approval_flow',
    'Set (replace) the approval flow on a form: the ordered approvalSteps that ' +
      'decide which group approves a submission and in what order (STANDARD = ' +
      'sequential, CONCURRENT = parallel groups). Replaces the whole flow (not ' +
      'additive). A locked form stops with a permission request unless ' +
      'overrideLock is explicitly set. Does NOT approve/deny submissions - that ' +
      'is not in the SDK.',
    baseShape,
    async (rawArgs: Record<string, unknown>) => {
      const parsed = inputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return errorResult(parsed.error.errors.map((e) => e.message).join('; '))
      }
      const input: Input = parsed.data
      const forms = getClient().forms()

      // D3: build + validate the flow BEFORE any read/write (fail closed).
      let builtSteps: unknown[]
      try {
        builtSteps = buildApprovalSteps(input.steps as unknown as ApprovalStepInput[])
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'approval step validation failed')
      }

      try {
        const form = (await forms.getForm(input.formId, false)) as unknown as Record<string, unknown>

        const updatedForm: Record<string, unknown> = { ...form, approvalSteps: builtSteps }
        if (input.approvalConfiguration !== undefined) {
          updatedForm.approvalConfiguration = input.approvalConfiguration
        }

        // D2: honour the lock. Try without override; on a lock error STOP and
        // ask for permission unless the caller explicitly passed overrideLock.
        let saved: Record<string, unknown>
        try {
          saved = (await forms.updateForm(updatedForm as never, input.overrideLock)) as unknown as Record<
            string,
            unknown
          >
        } catch (err) {
          if (!input.overrideLock && isFormLockedError(err)) {
            logger.warn('set_approval_flow: form locked', { formId: input.formId })
            return errorResult(
              `Form ${input.formId} is locked in the form builder. No change was made. ` +
                `Re-run with overrideLock: true to override the lock (only with the owner's permission).`,
            )
          }
          const message = err instanceof Error ? err.message : 'updateForm failed'
          logger.error('set_approval_flow: updateForm failed', { formId: input.formId, message })
          return errorResult(`updateForm failed (no change written): ${message}`)
        }

        const savedSteps = (saved.approvalSteps as unknown[]) ?? builtSteps
        const labels = stepLabels(savedSteps)
        logger.info('set_approval_flow', {
          formId: input.formId,
          stepCount: savedSteps.length,
          approvalConfigurationWritten: input.approvalConfiguration !== undefined,
        })

        // Projection (rule 3): what landed, never the whole form.
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                formId: input.formId,
                action: 'replaced',
                stepCount: savedSteps.length,
                labels,
                approvalConfigurationWritten: input.approvalConfiguration !== undefined,
              }),
            },
          ],
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        logger.error('set_approval_flow failed', { formId: input.formId, message })
        return errorResult(`set_approval_flow failed: ${message}`)
      }
    },
  )
}
