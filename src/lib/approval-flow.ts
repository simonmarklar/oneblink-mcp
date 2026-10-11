/**
 * Pure helpers for set_approval_flow - no SDK, no I/O, unit-tested.
 * Spec: docs/requirements/set-approval-flow.md (D1-D5)
 *
 * Builds the `form.approvalSteps` array OneBlink expects and validates its
 * integrity before any write (fail closed). Shapes verified against
 * @oneblink/types approvals.d.ts: FormApprovalFlowStep, FormApprovalFlowNodeBase.
 */

export interface ApprovalNodeInput {
  label: string
  group: string
  approvalFormId?: number
  approvalFormPrefillMappings?: unknown[]
  hideApprovalDenyButton?: boolean
  editableFormElementIds?: string[]
}

export interface ApprovalStepInput extends ApprovalNodeInput {
  /** STANDARD (default) = this step is a single node; CONCURRENT = use `nodes`. */
  type?: 'STANDARD' | 'CONCURRENT'
  nodes?: ApprovalNodeInput[]
  // STANDARD-only conditional-skip fields (pass-through)
  isConditional?: boolean
  requiresAllConditionalPredicates?: boolean
  conditionalPredicates?: unknown[]
}

/** Validate one node's internal consistency (D3). Returns an error string or null. */
function validateNode(node: ApprovalNodeInput, where: string): string | null {
  if (!node || typeof node.label !== 'string' || node.label.trim() === '') {
    return `${where}: label is required and must be non-empty`
  }
  if (typeof node.group !== 'string' || node.group.trim() === '') {
    return `${where} ("${node.label}"): group is required and must be non-empty`
  }
  if (node.approvalFormPrefillMappings !== undefined && node.approvalFormId === undefined) {
    return `${where} ("${node.label}"): approvalFormPrefillMappings requires approvalFormId`
  }
  if (node.editableFormElementIds !== undefined && node.editableFormElementIds.length === 0) {
    return `${where} ("${node.label}"): editableFormElementIds must be non-empty when present (omit it to allow no edits)`
  }
  return null
}

/** Project a node input to the OneBlink node shape, dropping undefined fields. */
function toNode(node: ApprovalNodeInput): Record<string, unknown> {
  const out: Record<string, unknown> = { label: node.label, group: node.group }
  if (node.approvalFormId !== undefined) out.approvalFormId = node.approvalFormId
  if (node.approvalFormPrefillMappings !== undefined) {
    out.approvalFormPrefillMappings = node.approvalFormPrefillMappings
  }
  if (node.hideApprovalDenyButton !== undefined) out.hideApprovalDenyButton = node.hideApprovalDenyButton
  if (node.editableFormElementIds !== undefined) out.editableFormElementIds = node.editableFormElementIds
  return out
}

/**
 * Build and validate the full `approvalSteps` array (D1 replace-whole, D3
 * fail-closed). Throws with a precise message on the first violation so no
 * partial flow is ever written.
 *
 * Rules enforced:
 *  - >= 1 step.
 *  - Every label non-empty and UNIQUE across the whole flow (incl. CONCURRENT nodes).
 *  - Every group non-empty.
 *  - approvalFormPrefillMappings requires approvalFormId.
 *  - editableFormElementIds non-empty when present.
 *  - CONCURRENT step has >= 1 node; STANDARD step is a single node.
 */
export function buildApprovalSteps(steps: readonly ApprovalStepInput[]): unknown[] {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('steps must contain at least one approval step')
  }

  const seenLabels = new Set<string>()
  const assertLabelUnique = (label: string, where: string): void => {
    if (seenLabels.has(label)) {
      throw new Error(`${where}: duplicate label "${label}" - every label must be unique across the flow`)
    }
    seenLabels.add(label)
  }

  const out: unknown[] = steps.map((step, i) => {
    const stepType = step.type ?? 'STANDARD'

    if (stepType === 'CONCURRENT') {
      const nodes = step.nodes ?? []
      if (nodes.length === 0) {
        throw new Error(`step ${i} (CONCURRENT): must have at least one node`)
      }
      const built = nodes.map((n: ApprovalNodeInput, j: number) => {
        const err = validateNode(n, `step ${i} node ${j}`)
        if (err) throw new Error(err)
        assertLabelUnique(n.label, `step ${i} node ${j}`)
        return toNode(n)
      })
      return { type: 'CONCURRENT', nodes: built }
    }

    // STANDARD: the step IS the node (fields inline)
    const err = validateNode(step, `step ${i}`)
    if (err) throw new Error(err)
    assertLabelUnique(step.label, `step ${i}`)
    const node = toNode(step)
    const built: Record<string, unknown> = { type: 'STANDARD', ...node }
    if (step.isConditional !== undefined) built.isConditional = step.isConditional
    if (step.requiresAllConditionalPredicates !== undefined) {
      built.requiresAllConditionalPredicates = step.requiresAllConditionalPredicates
    }
    if (step.conditionalPredicates !== undefined) built.conditionalPredicates = step.conditionalPredicates
    return built
  })

  return out
}

/** Collect the top-level step labels (for the result projection). */
export function stepLabels(builtSteps: readonly unknown[]): string[] {
  return builtSteps.map((s) => {
    const step = s as { type?: string; label?: string; nodes?: Array<{ label?: string }> }
    if (step.type === 'CONCURRENT') {
      return (step.nodes ?? []).map((n) => n.label ?? '').join(' + ')
    }
    return step.label ?? ''
  })
}
