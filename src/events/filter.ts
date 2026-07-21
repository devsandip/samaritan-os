/**
 * The `trigger.filter` matcher (TECH-SPEC §4.1, §4.6).
 *
 * A manifest may narrow an event subscription with a filter: `newsletter-digest`
 * takes `email.received` but only `filter: { from_in: ["@newsletters"] }`. This
 * evaluates that filter against a `SamaritanEvent`'s payload, so two capabilities
 * on the same event type diverge — `email-triage` (no filter) sees every mail,
 * `newsletter-digest` only the newsletters.
 *
 * The DSL is a small, mechanical thing, deliberately not a predicate language:
 * the field is the key (minus a recognised operator suffix) and the term is the
 * value. Three operators, combined with AND:
 *
 *   from_in: ["a", "b"]        payload.from is one of, or intersects if it is a list
 *   subject_contains: "invoice" payload.subject includes it (substring, or list membership)
 *   from: "x"  /  from_eq: "x"  payload.from equals it
 *
 * It fails closed, exactly as the Policy Engine's predicates do (DECISIONS.md):
 * a filter that references a field the payload does not carry does not match, so
 * a capability is never fired on an event it could not actually have evaluated.
 * The alternative — treating a missing field as a pass — would fire
 * `newsletter-digest` on a payload with no `from` at all, which is the silent
 * wrong answer the fail-closed rule exists to avoid.
 */

interface Term {
  field: string;
  op: "in" | "contains" | "eq";
}

/** Splits a filter key into its field and operator. `from_in` → {from, in}. */
function parseKey(key: string): Term {
  if (key.endsWith("_in")) return { field: key.slice(0, -"_in".length), op: "in" };
  if (key.endsWith("_contains")) return { field: key.slice(0, -"_contains".length), op: "contains" };
  if (key.endsWith("_eq")) return { field: key.slice(0, -"_eq".length), op: "eq" };
  return { field: key, op: "eq" };
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function matchesTerm(term: Term, expected: unknown, actual: unknown): boolean {
  // Missing field: fail closed. A term that names a field not on the payload
  // cannot be satisfied, and pretending it can is where a wrong fire comes from.
  if (actual === undefined) return false;

  switch (term.op) {
    case "in": {
      // The event value is one of the expected, or (if it is a list itself, e.g.
      // Gmail labels) shares a member with them.
      const wanted = new Set(toArray(expected));
      return toArray(actual).some((v) => wanted.has(v));
    }
    case "contains": {
      const needle = expected;
      if (typeof actual === "string" && typeof needle === "string") {
        return actual.includes(needle);
      }
      return toArray(actual).some((v) => v === needle);
    }
    case "eq":
      return actual === expected;
  }
}

/** True if every term in `filter` holds against `payload`. An absent/empty filter matches everything. */
export function matchesFilter(
  filter: Record<string, unknown> | undefined,
  payload: Record<string, unknown>,
): boolean {
  if (!filter) return true;
  for (const [key, expected] of Object.entries(filter)) {
    const term = parseKey(key);
    if (!matchesTerm(term, expected, payload[term.field])) return false;
  }
  return true;
}
