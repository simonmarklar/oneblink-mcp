# delete_form

Delete a single OneBlink form by id — the irreversible counterpart to create_form, for cleaning up forms a demo/test run created. One form per call: no bulk, no wildcard, no "delete all". Requires confirm:true (fails closed and deletes nothing otherwise), honours the form-builder lock (stops with a permission request unless overrideLock is explicitly set), and derives authority from the Developer Key — the SDK fails closed if the key may not delete the form. Returns the id deleted, never a form payload.

## Parameters

| Parameter | Type | Required | Description |
|---|---|---|---|
| `formId` | `integer` | Required | Id of the form to delete. One form per call. |
| `confirm` | `boolean` | Required | Must be true to delete. Deletion is irreversible, so this is a required explicit intent; a missing or false value fails closed and deletes nothing. |
| `overrideLock` | `boolean` | Optional | Explicit permission to override a form-builder lock; defaults to false and is never set implicitly. |

## Minimum Developer Key permission

Forms — Manage (delete), with the app association the form requires. The SDK authorizes; the tool surfaces its failure rather than masking it (A01).
