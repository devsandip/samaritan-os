/**
 * Money-never-auto enforcement (TECH-SPEC §9).
 *
 * Three independent layers must all agree before anything financial can run
 * unattended, and all three key off the predicate here:
 *
 *   1. Policy Engine    - a matching action type always escalates, and a
 *                         capability's own auto_complete_when cannot override it.
 *   2. Routing Config   - the entry ships locked:true, so PUT /api/routing/:type
 *                         returns 409 on any attempt to change its mode.
 *   3. Execution Registry - register() throws at load time if an adapter claims
 *                         "automated" for a locked namespace, so no such adapter
 *                         is ever allowed to exist.
 *
 * This lives at the root rather than inside any one of those modules so that all
 * three depend on the same definition and none depends on another.
 */

/**
 * Action-type namespaces that can never run automated. Matching is on the
 * leading segment so `payment.make`, `payment.schedule` and any future
 * `payment.*` are covered without needing to be enumerated.
 */
export const LOCKED_ACTION_NAMESPACES = ["payment", "transfer", "trade", "invest"] as const;

/** Exact action types that can never run automated, beyond the namespaces above. */
export const LOCKED_ACTION_TYPES = ["payment.make"] as const;

export function isMoneyLocked(actionType: string): boolean {
  if ((LOCKED_ACTION_TYPES as readonly string[]).includes(actionType)) return true;
  const namespace = actionType.split(".")[0] ?? "";
  return (LOCKED_ACTION_NAMESPACES as readonly string[]).includes(namespace);
}

/**
 * Execution-registry ids are provider-first (`stripe.payment.create`), so the
 * namespace check has to look at every segment rather than just the first.
 */
export function isMoneyLockedExecutionId(executionCapabilityId: string): boolean {
  const segments = executionCapabilityId.split(".");
  return segments.some((s) => (LOCKED_ACTION_NAMESPACES as readonly string[]).includes(s));
}

export class MoneyLockViolation extends Error {
  constructor(subject: string, attempted: string) {
    super(
      `"${subject}" is money-locked and can never run in ${attempted} mode. ` +
        `Money never moves automatically (TECH-SPEC §9).`,
    );
    this.name = "MoneyLockViolation";
  }
}
