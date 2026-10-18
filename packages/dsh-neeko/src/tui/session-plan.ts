/**
 * TUI runner session resolution: decide whether to resume a persisted session
 * or create a fresh one, mirroring the bridge's `doActivate` decision tree but
 * as a pure, testable function.
 *
 * The decision shape (from the bridge, already validated on dsh 0.2.0-rc.2):
 * - `--session <id>` given  → try resume; on failure fall back to create with
 *   a fresh id (the requested id may not exist), recording the failure so the
 *   UI can tell the user.
 * - no id                   → create directly.
 *
 * @module dsh-neeko/tui/session-plan
 */

/** What the runner should do, resolved from the startup config. */
export type SessionPlan =
  | { readonly kind: 'resume'; readonly sessionId: string }
  | { readonly kind: 'create' }
  | /** `--session` was given but resume failed; create fresh and surface why. */
    { readonly kind: 'create-after-failed-resume'; readonly requestedId: string; readonly reason: string }

/**
 * Plan the session lifecycle for one invocation.
 * @param requestedId - the `--session` value, if any (trimmed, non-empty).
 * @returns the plan; never throws.
 */
export function planSession(requestedId: string | undefined): SessionPlan {
  const id = requestedId?.trim()
  return id === undefined || id === '' ? { kind: 'create' } : { kind: 'resume', sessionId: id }
}

/**
 * Downgrade a failed resume to a fresh create.
 * @param plan - the plan that attempted the resume.
 * @param reason - the resume failure, for the UI.
 * @returns the replacement plan.
 */
export function failResume(plan: Extract<SessionPlan, { kind: 'resume' }>, reason: string): SessionPlan {
  return { kind: 'create-after-failed-resume', requestedId: plan.sessionId, reason }
}
