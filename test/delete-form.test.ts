import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  deleteFormInputSchema,
  performDeleteForm,
  type DeleteFormsLike,
} from '../src/workflows/delete-form.ts'

/** A fake Forms service recording deleteForm calls, optionally throwing. */
function fakeForms(opts: { throwErr?: unknown } = {}): DeleteFormsLike & {
  calls: Array<{ formId: number; overrideLock?: boolean }>
} {
  const calls: Array<{ formId: number; overrideLock?: boolean }> = []
  return {
    calls,
    async deleteForm(formId: number, overrideLock?: boolean): Promise<void> {
      calls.push({ formId, overrideLock })
      if (opts.throwErr) throw opts.throwErr
    },
  }
}

describe('delete_form schema', () => {
  it('requires a positive formId', () => {
    assert.equal(deleteFormInputSchema.safeParse({ formId: 0, confirm: true }).success, false)
    assert.equal(deleteFormInputSchema.safeParse({ formId: -1, confirm: true }).success, false)
  })

  it('requires confirm (boolean, no default)', () => {
    assert.equal(deleteFormInputSchema.safeParse({ formId: 1 }).success, false)
  })

  it('defaults overrideLock to false', () => {
    const parsed = deleteFormInputSchema.parse({ formId: 1, confirm: true })
    assert.equal(parsed.overrideLock, false)
  })
})

describe('delete_form behaviour', () => {
  it('deletes the form when confirm is true', async () => {
    const forms = fakeForms()
    const res = await performDeleteForm({ formId: 42, confirm: true, overrideLock: false }, forms)
    assert.equal(res.isError, undefined)
    assert.deepEqual(forms.calls, [{ formId: 42, overrideLock: false }])
    assert.deepEqual(JSON.parse(res.content[0]!.text), { formId: 42, action: 'deleted' })
  })

  it('fails closed and does NOT call the SDK when confirm is false', async () => {
    const forms = fakeForms()
    const res = await performDeleteForm({ formId: 42, confirm: false, overrideLock: false }, forms)
    assert.equal(res.isError, true)
    assert.match(res.content[0]!.text, /confirm: true/)
    assert.equal(forms.calls.length, 0)
  })

  it('threads overrideLock through to deleteForm', async () => {
    const forms = fakeForms()
    await performDeleteForm({ formId: 7, confirm: true, overrideLock: true }, forms)
    assert.deepEqual(forms.calls, [{ formId: 7, overrideLock: true }])
  })

  it('a locked form (overrideLock=false) fails closed with the permission message', async () => {
    const lockErr = Object.assign(new Error('Form is locked'), { statusCode: 423 })
    const forms = fakeForms({ throwErr: lockErr })
    const res = await performDeleteForm({ formId: 9, confirm: true, overrideLock: false }, forms)
    assert.equal(res.isError, true)
    assert.match(res.content[0]!.text, /locked/)
    assert.match(res.content[0]!.text, /overrideLock: true/)
  })

  it('a non-lock SDK error surfaces as isError (nothing claimed deleted)', async () => {
    const forms = fakeForms({ throwErr: new Error('permission denied') })
    const res = await performDeleteForm({ formId: 9, confirm: true, overrideLock: false }, forms)
    assert.equal(res.isError, true)
    assert.match(res.content[0]!.text, /nothing deleted/)
    assert.match(res.content[0]!.text, /permission denied/)
  })
})
