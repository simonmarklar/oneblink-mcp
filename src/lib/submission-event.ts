/**
 * Pure helpers for upsert_email_submission_event — no SDK, no I/O, unit-tested.
 * Spec: docs/requirements/upsert-email-submission-event.md
 */

export interface EmailInput {
  toEmail: string[]
  ccEmail?: string[]
  bccEmail?: string[]
  subjectLine?: string
}

export interface PdfInput {
  fileName?: string
  includeSubmissionId?: boolean
  includeExternalId?: boolean
  excludedElementIds?: string[]
  excludedCSSClasses?: string[]
}

/**
 * Build the submission-event object the SDK expects.
 * - 'PDF'   -> PDFConfiguration & EmailConfiguration (email WITH a submission PDF)
 * - 'EMAIL' -> EmailConfiguration (+ optional pdfConfigurations[])
 * `emailTemplateId` links an Email Template; omitted leaves it unset.
 * Only `toEmail` is required by the caller; we never write the deprecated
 * `email` scalar.
 */
export function buildSubmissionEvent(params: {
  eventType: 'EMAIL' | 'PDF'
  email: EmailInput
  pdf?: PdfInput
  emailTemplateId?: number
  conditionallyExecute?: boolean
  isRetryable?: boolean
}): Record<string, unknown> {
  const { eventType, email, pdf, emailTemplateId } = params

  const emailConfig: Record<string, unknown> = { toEmail: email.toEmail }
  if (email.ccEmail?.length) emailConfig.ccEmail = email.ccEmail
  if (email.bccEmail?.length) emailConfig.bccEmail = email.bccEmail
  if (email.subjectLine) emailConfig.emailSubjectLine = email.subjectLine
  if (emailTemplateId !== undefined) emailConfig.emailTemplate = { id: emailTemplateId, mapping: [] }

  const pdfConfig: Record<string, unknown> = {}
  if (pdf?.fileName) pdfConfig.pdfFileName = pdf.fileName
  if (pdf?.includeSubmissionId !== undefined) pdfConfig.includeSubmissionIdInPdf = pdf.includeSubmissionId
  if (pdf?.includeExternalId !== undefined) pdfConfig.includeExternalIdInPdf = pdf.includeExternalId
  pdfConfig.excludedElementIds = pdf?.excludedElementIds ?? []
  pdfConfig.excludedCSSClasses = pdf?.excludedCSSClasses ?? []

  const configuration =
    eventType === 'PDF'
      ? { ...pdfConfig, ...emailConfig } // PDF event = PDFConfiguration & EmailConfiguration
      : {
          ...emailConfig,
          // EMAIL event carries PDFs under pdfConfigurations[] (only if any pdf fields given)
          ...(pdf ? { pdfConfigurations: [pdfConfig] } : {}),
        }

  return {
    type: eventType,
    configuration,
    conditionallyExecute: params.conditionallyExecute ?? false,
    requiresAllConditionallyExecutePredicates: false,
    isRetryable: params.isRetryable ?? true,
  }
}

/**
 * Build an ONEBLINK_API submission-event object (hosted-API webhook) the SDK
 * expects. Shape is `FormEventBase & EndpointConfigurationAPI` (verified against
 * @oneblink/types submissionEvents.d.ts `OneBlinkAPISubmissionEvent`):
 *   { type:'ONEBLINK_API', configuration:{ apiId, apiEnvironment,
 *     apiEnvironmentRoute[, organisationManagedSecretId] }, label?,
 *     conditionallyExecute, requiresAllConditionallyExecutePredicates,
 *     isRetryable }
 * The optional `organisationManagedSecretId` is written ONLY when provided (it
 * references a secret; never fabricated). FormEventBase defaults mirror
 * buildSubmissionEvent: conditionallyExecute false, isRetryable true.
 */
export function buildApiSubmissionEvent(params: {
  apiId: string
  apiEnvironment: string
  apiEnvironmentRoute: string
  organisationManagedSecretId?: number
  label?: string
  conditionallyExecute?: boolean
  isRetryable?: boolean
}): Record<string, unknown> {
  const configuration: Record<string, unknown> = {
    apiId: params.apiId,
    apiEnvironment: params.apiEnvironment,
    apiEnvironmentRoute: params.apiEnvironmentRoute,
  }
  if (params.organisationManagedSecretId !== undefined) {
    configuration.organisationManagedSecretId = params.organisationManagedSecretId
  }

  const event: Record<string, unknown> = {
    type: 'ONEBLINK_API',
    configuration,
    conditionallyExecute: params.conditionallyExecute ?? false,
    requiresAllConditionallyExecutePredicates: false,
    isRetryable: params.isRetryable ?? true,
  }
  if (params.label !== undefined) event.label = params.label
  return event
}

/**
 * Splice an event into a form's submissionEvents (D1): replace at an explicit
 * index, or append when `replaceIndex` is undefined. NEVER guesses a match.
 * Returns a NEW array (pure). Throws on an out-of-range replaceIndex (fail closed).
 */
export function spliceEvent(
  events: readonly unknown[],
  event: unknown,
  replaceIndex?: number,
): unknown[] {
  const next = [...events]
  if (replaceIndex === undefined) {
    next.push(event)
    return next
  }
  if (!Number.isInteger(replaceIndex) || replaceIndex < 0 || replaceIndex >= next.length) {
    throw new Error(
      `replaceIndex ${String(replaceIndex)} is out of range (form has ${next.length} submission event(s))`,
    )
  }
  next[replaceIndex] = event
  return next
}

/**
 * Decide whether a lock error from updateForm means "locked, need permission".
 * OneBlink surfaces a locked form as an error when overrideLock is false. We key
 * off status 409/423 or a message mentioning lock — conservative, fail closed.
 */
export function isFormLockedError(err: unknown): boolean {
  const status = (err as { statusCode?: number; status?: number })?.statusCode ??
    (err as { status?: number })?.status
  if (status === 409 || status === 423) return true
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return msg.includes('lock')
}
