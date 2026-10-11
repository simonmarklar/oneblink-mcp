import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildApprovalSteps, stepLabels } from '../src/lib/approval-flow.ts'
import { setApprovalFlowInputSchema as schema } from '../src/workflows/set-approval-flow.ts'

// --- buildApprovalSteps: happy paths ---
test('STANDARD step is the node inline, type defaulted', () => {
  const steps = buildApprovalSteps([{ label: 'Manager', group: 'managers' }]) as any[]
  assert.equal(steps.length, 1)
  assert.equal(steps[0].type, 'STANDARD')
  assert.equal(steps[0].label, 'Manager')
  assert.equal(steps[0].group, 'managers')
})

test('CONCURRENT step carries nodes[], drops step-level label/group', () => {
  const steps = buildApprovalSteps([
    {
      type: 'CONCURRENT',
      nodes: [
        { label: 'Finance', group: 'finance' },
        { label: 'Legal', group: 'legal' },
      ],
    },
  ]) as any[]
  assert.equal(steps[0].type, 'CONCURRENT')
  assert.equal(steps[0].nodes.length, 2)
  assert.equal(steps[0].nodes[0].label, 'Finance')
  assert.equal('label' in steps[0], false)
})

test('optional node fields pass through, undefined dropped', () => {
  const steps = buildApprovalSteps([
    {
      label: 'Review',
      group: 'g',
      approvalFormId: 42,
      hideApprovalDenyButton: true,
      editableFormElementIds: ['el1'],
    },
  ]) as any[]
  assert.equal(steps[0].approvalFormId, 42)
  assert.equal(steps[0].hideApprovalDenyButton, true)
  assert.deepEqual(steps[0].editableFormElementIds, ['el1'])
})

test('STANDARD conditional-skip fields pass through', () => {
  const steps = buildApprovalSteps([
    { label: 'Maybe', group: 'g', isConditional: true, requiresAllConditionalPredicates: false, conditionalPredicates: [] },
  ]) as any[]
  assert.equal(steps[0].isConditional, true)
  assert.equal(steps[0].requiresAllConditionalPredicates, false)
  assert.deepEqual(steps[0].conditionalPredicates, [])
})

// --- buildApprovalSteps: fail-closed validation (D3) ---
test('rejects empty flow', () => {
  assert.throws(() => buildApprovalSteps([]), /at least one approval step/)
})

test('rejects empty label', () => {
  assert.throws(() => buildApprovalSteps([{ label: '  ', group: 'g' }]), /label is required/)
})

test('rejects empty group', () => {
  assert.throws(() => buildApprovalSteps([{ label: 'A', group: '' }]), /group is required/)
})

test('rejects duplicate label across the flow (incl. concurrent nodes)', () => {
  assert.throws(
    () =>
      buildApprovalSteps([
        { label: 'Dup', group: 'g1' },
        { type: 'CONCURRENT', nodes: [{ label: 'Dup', group: 'g2' }] },
      ]),
    /duplicate label "Dup"/,
  )
})

test('rejects prefill mappings without approvalFormId', () => {
  assert.throws(
    () => buildApprovalSteps([{ label: 'A', group: 'g', approvalFormPrefillMappings: [{}] }]),
    /approvalFormPrefillMappings requires approvalFormId/,
  )
})

test('rejects empty editableFormElementIds when present', () => {
  assert.throws(
    () => buildApprovalSteps([{ label: 'A', group: 'g', editableFormElementIds: [] }]),
    /editableFormElementIds must be non-empty/,
  )
})

test('rejects CONCURRENT step with no nodes', () => {
  assert.throws(() => buildApprovalSteps([{ type: 'CONCURRENT', nodes: [] }]), /at least one node/)
})

// --- stepLabels projection ---
test('stepLabels: STANDARD label, CONCURRENT joined with +', () => {
  const steps = buildApprovalSteps([
    { label: 'First', group: 'g' },
    { type: 'CONCURRENT', nodes: [{ label: 'A', group: 'ga' }, { label: 'B', group: 'gb' }] },
  ])
  assert.deepEqual(stepLabels(steps), ['First', 'A + B'])
})

// --- schema ---
test('schema: formId + >=1 step required', () => {
  assert.equal(schema.safeParse({ formId: 1, steps: [{ label: 'A', group: 'g' }] }).success, true)
  assert.equal(schema.safeParse({ formId: 1, steps: [] }).success, false)
  assert.equal(schema.safeParse({ steps: [{ label: 'A', group: 'g' }] }).success, false)
})

test('schema: overrideLock defaults false, type defaults STANDARD', () => {
  const r = schema.parse({ formId: 1, steps: [{ label: 'A', group: 'g' }] })
  assert.equal(r.overrideLock, false)
  assert.equal(r.steps[0].type, 'STANDARD')
})

test('schema: rejects bad formId', () => {
  assert.equal(schema.safeParse({ formId: -1, steps: [{ label: 'A', group: 'g' }] }).success, false)
  assert.equal(schema.safeParse({ formId: 1.5, steps: [{ label: 'A', group: 'g' }] }).success, false)
})
