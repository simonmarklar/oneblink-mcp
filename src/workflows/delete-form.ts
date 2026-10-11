/**
 * Workflow: delete_form
 *
 * Delete a single OneBlink form by id — the irreversible counterpart to
 * create_form, so a demo/test run can clean up the forms it created. One form
 * per call, by id: no bulk, no wildcard, no "delete all" (bounded + fail-closed,
 * steering tool-design rule 2).
 *
 * SDK fact (verified against @oneblink/sdk Forms.d.ts):
 *   Forms.deleteForm(formId: number, overrideLock?: boolean): Promise<void>
 *
 * SECURITY (.kiro/steering/security.md):
 *   - A01 Broken Access Control: authority derives from the Developer Key. The
 *     SDK fails closed when the key's role permissions / app associations do not
 *     allow deleting this form — we do NOT echo an org id (tool-design rule 1).
 *   - Irreversible action guard: `confirm` MUST be true. Without it the tool
 *     fails closed and deletes nothing — the model cannot delete a form by
 *     drifting onto an id; it must also assert intent.
 *   - A01/A08 form lock: honoured. A locked form stops with a permission request
 *     unless `overrideLock` is explicitly set (never implicitly) — same contract
 *     as the set_* / upsert_* tools.
 *   - A03: zod safeParse fail-closed at the boundary.
 *   - A09: logs the form id only, never the form body.
 *   - Projection (rule 3): returns the id deleted + action, never a payload.
 *
 * Minimum Developer Key permission: Forms — Manage (delete). App association as
 * the form requires. The SDK authorizes; we surface its failure, never mask it.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { getClient } from '../lib/oneblink-client.js'
import { logger } from '../lib/logger.js'
import { isFormLockedError } from '../lib/submission-event.js'

/** Minimal Forms seam so the delete core is unit testable without the SDK. */
export type DeleteFormsLike = {
  deleteForm(formId: number, overrideLock?: boolean): Promise<void>
}

const baseShape = {
  formId: z.number().int().positive().describe('Id of the form to delete. One form per call.'),
  confirm: z
    .boolean()
    .describe(
      'Must be true to delete. Deletion is irreversible, so this is a required explicit intent — a missing or false value fails closed and deletes nothing.',
    ),
  overrideLock: z
    .boolean()
    .default(false)
    .describe('Explicit permission to override a form-builder lock. Never set implicitly.'),
} as const

const inputSchema = z.object(baseShape)
export const deleteFormInputSchema = inputSchema
type Input = z.infer<typeof inputSchema>

type ToolResult = {
  isError?: boolean
  content: Array<{ type: 'text'; text: string }>
}

function errorResult(text: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text }] }
}

/**
 * Delete core: honours the lock, fails closed without confirm. `forms` defaults
 * to the live SDK Forms service; tests inject a fake. Exported for unit tests.
 */
export async function performDeleteForm(
  input: Input,
  forms: DeleteFormsLike = getClient().forms() as unknown as DeleteFormsLike,
): Promise<ToolResult> {
  // Irreversible-action guard (fail closed): the model must assert intent, not
  // just land on an id.
  if (input.confirm !== true) {
    return errorResult(
      `Refusing to delete form ${input.formId}: pass confirm: true to perform this irreversible deletion. Nothing was deleted.`,
    )
  }

  try {
    try {
      await forms.deleteForm(input.formId, input.overrideLock)
    } catch (err) {
      if (!input.overrideLock && isFormLockedError(err)) {
        logger.warn('delete_form: form locked', { formId: input.formId })
        return errorResult(
          `Form ${input.formId} is locked in the form builder. No change was made. ` +
            `Re-run with overrideLock: true to override the lock (only with the owner's permission).`,
        )
      }
      const message = err instanceof Error ? err.message : 'deleteForm failed'
      logger.error('delete_form: deleteForm failed', { formId: input.formId, message })
      return errorResult(`delete_form failed (nothing deleted): ${message}`)
    }

    logger.info('delete_form', { formId: input.formId, overrideLock: input.overrideLock })
    // Projection (rule 3): the id touched + the action, never a form payload.
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ formId: input.formId, action: 'deleted' }),
        },
      ],
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    logger.error('delete_form failed', { formId: input.formId, message })
    return errorResult(`delete_form failed: ${message}`)
  }
}

export function registerDeleteForm(server: McpServer): void {
  server.tool(
    'delete_form',
    'Delete a single OneBlink form by id — the irreversible counterpart to ' +
      'create_form, for cleaning up forms a run created. One form per call (no ' +
      'bulk/wildcard). Requires confirm: true (fails closed otherwise and deletes ' +
      'nothing). A locked form stops with a permission request unless overrideLock ' +
      'is explicitly set. Authority is the Developer Key: the SDK fails closed if ' +
      'the key may not delete this form.',
    baseShape,
    async (rawArgs: Record<string, unknown>) => {
      const parsed = inputSchema.safeParse(rawArgs)
      if (!parsed.success) {
        return errorResult(parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '))
      }
      return performDeleteForm(parsed.data)
    },
  )
}
