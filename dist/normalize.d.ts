/**
 * @rello-platform/lead-entity/normalize — shape-based contact-field normalizer.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS (Self-Healing Import Validation — Layer 2, the safety core)
 * ────────────────────────────────────────────────────────────────────────────
 * A source CSV with the email/phone columns SWAPPED ("email" holds a 10-digit
 * phone with no "@"; "phone" holds a city, "Sandy") is silently lost today:
 * Rello's tolerant contract correctly REJECTS a phone-as-email → 400, and
 * Harvest-Home dead-letters the lead after 3 retries — into a graveyard, not a
 * repair queue. The data was perfectly recoverable from the value's SHAPE; the
 * platform threw it away.
 *
 * `normalizeContactFields` routes each contact value to the field its SHAPE
 * belongs to, regardless of the source column header, and BEFORE the contract
 * validates. It is the preventive ("edge self-heal") layer.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TWO DISTINCT OPERATIONS (the safety design — auto-corruption is structurally
 * impossible)
 * ────────────────────────────────────────────────────────────────────────────
 * (1) CLEAR provably-invalid values — ALWAYS SAFE, UNCONDITIONAL.
 *     A value that is shape-INVALID for the field it currently occupies is
 *     definitively NOT a valid value of that field's type, so it is nulled —
 *     regardless of what any other field holds. A phone-shaped or word value in
 *     the `email` field is provably not an email → clear it. A word / 2–3-digit
 *     value in the `phone` field is provably not a phone → clear it. This can
 *     NEVER corrupt data: we only remove a value that was never valid where it
 *     sat. It is also what makes the dual-phone case recoverable — an
 *     email-field-holding-a-phone gets cleared, the genuinely valid `phone`
 *     value is kept, and the row validates.
 *
 * (2) MOVE per the W-01 TWO-SIDED RULE — CONSERVATIVE.
 *     A value is relocated INTO a target field ONLY when ALL THREE hold:
 *       (a) it is shape-POSITIVE for the target field, AND
 *       (b) shape-NEGATIVE for the source field it came from (guaranteed by (1):
 *           only cleared values are move candidates), AND
 *       (c) the target field is NOT already holding a shape-valid value of its
 *           own type AND no OTHER value is also competing for that same target.
 *     If a value is shape-positive for a target that is already taken, or two
 *     values compete for one empty target, or a value is shape-NEITHER (belongs
 *     to no contact field) — it is NOT moved. A NEITHER value is simply gone
 *     after the clear (it was garbage). A real-but-unplaceable value (e.g. an
 *     orphaned second phone) is reported via an `escalate` action so a human can
 *     see what was dropped. We NEVER overwrite a valid value and NEVER guess
 *     between two plausible candidates.
 *
 * ORDER: clear-invalid FIRST, then move-per-rule into the now-empty targets.
 *
 * The confidence boundary (from the spec):
 *   | value sits in | value shape   | other field state        | outcome           |
 *   | email         | PHONE         | phone empty/cleared      | cleared→moved→phone|
 *   | email         | PHONE         | phone already valid PHONE| cleared (escalate: orphan)|
 *   | phone         | EMAIL         | email empty/cleared      | cleared→moved→email|
 *   | phone         | EMAIL         | email already valid EMAIL| cleared (escalate: orphan)|
 *   | email/phone   | NEITHER       | n/a                      | cleared (garbage)  |
 *   | email/phone   | valid-for-own | —                        | no-op (kept)       |
 *
 * PURITY — no I/O, no side effects, deterministic. Re-running on an already-healed
 * result is a no-op (idempotent). Reuses the contract's email regex + ≥7-digit
 * phone floor (Rule E — single source of truth; this module does NOT fork the
 * shape predicates the contract already owns).
 */
/**
 * The exact email-shape regex used by Rello's CSV import (`import.ts:172`) and
 * the regression-lock contract. A value is EMAIL-shaped iff it matches this.
 * Deliberately strict on structure ("@" + a dotted domain), tolerant of the
 * local-part — it is a SHAPE gate (which field does this belong in?), not a
 * deliverability check.
 */
export declare const EMAIL_SHAPE_REGEX: RegExp;
/**
 * The contract's phone floor (`contracts.ts:158-160`): ≥7 digits after stripping
 * every non-digit. Country-agnostic by design — a `+44…` number stripped of
 * non-digits still clears 7 digits → PHONE shape. The W-01 rule additionally
 * requires the absence of "@" so an email is never mis-read as a phone.
 */
export declare const PHONE_DIGIT_FLOOR = 7;
/**
 * EMAIL-shaped iff it matches the email-shape regex. Pure; tolerates any input.
 * An empty / non-string / whitespace-only value is NOT email-shaped.
 */
export declare function isEmailShaped(value: unknown): boolean;
/**
 * PHONE-shaped iff it has ≥{@link PHONE_DIGIT_FLOOR} digits after stripping every
 * non-digit AND contains no "@" (an "@" is an email signal — a phone never has
 * one). Pure; tolerates any input. An empty / non-string value is NOT phone-shaped.
 *
 * The no-"@" clause is load-bearing for the two-sided rule: it guarantees a value
 * cannot be simultaneously EMAIL-shaped and PHONE-shaped via its digits (e.g. an
 * email whose local-part is all digits like `8015551234@x.com` is EMAIL-only, not
 * a phone candidate), so a clean swap is never mistaken for an ambiguous value.
 */
export declare function isPhoneShaped(value: unknown): boolean;
/** NEITHER email- nor phone-shaped (e.g. a city, "Sandy"). A non-contact value. */
export declare function isNeither(value: unknown): boolean;
/** The two contact fields this normalizer routes between. */
export type ContactField = "email" | "phone";
/** The shape a value classifies as (the routing signal). */
export type ValueShape = "EMAIL" | "PHONE" | "NEITHER";
/**
 * What the normalizer did, for the transparency banner / import-results residue.
 * Every change — clear, move, and escalation — is recorded; the normalizer is
 * NEVER silent to the system, even if the UI presentation (W-02) is non-blocking.
 *
 * Discriminated on `action` (the canonical W-01 verbs):
 *
 * - `moved`    — a value relocated to the field its shape belongs to, into a
 *                now-empty target (a clean, two-sided-safe heal). `field` is the
 *                ORIGIN field; `to` is the destination.
 * - `cleared`  — a value removed from `field` because it was shape-INVALID for
 *                that field (provably-not-an-X). Always safe; never invented
 *                elsewhere. The removed text is preserved in `value` for the
 *                banner so a human can see exactly what was dropped.
 * - `escalate` — a real, shape-valid contact value that could NOT be safely
 *                placed (its target field was already occupied by a valid value,
 *                or two values competed for one target). It is reported, never
 *                guessed onto a valid field. `reason` explains why.
 *
 * `kind` mirrors `action` 1:1 (some consumers discriminate on `kind`, the spec's
 * `HealAction` field name); both are always present and equal.
 */
export type HealAction = {
    action: "moved";
    kind: "moved";
    field: ContactField;
    to: ContactField;
    value: string;
    valueShape: ValueShape;
} | {
    action: "cleared";
    kind: "cleared";
    field: ContactField;
    value: string;
    valueShape: ValueShape;
} | {
    action: "escalate";
    kind: "escalate";
    field: ContactField;
    value: string;
    valueShape: ValueShape;
    reason: string;
};
/** Input to {@link normalizeContactFields}. Extra keys are preserved untouched. */
export interface NormalizeContactInput {
    email?: unknown;
    phone?: unknown;
    [key: string]: unknown;
}
/**
 * Result of {@link normalizeContactFields}. `email`/`phone` are the routed values
 * (omitted when absent/cleared). `healActions` describes every move/clear/escalate
 * for the transparency surface. Any non-`email`/`phone` keys on the input are
 * passed through unchanged.
 */
export type NormalizeContactResult<T extends NormalizeContactInput> = Omit<T, "email" | "phone"> & {
    email?: string;
    phone?: string;
    healActions: HealAction[];
};
/**
 * Shape-based contact-field normalizer (Layer 2 of Self-Healing Import Validation).
 *
 * Routes each of `email` / `phone` to the field its SHAPE belongs to, regardless
 * of which source column it arrived in, via two operations applied IN ORDER:
 *
 *   (1) CLEAR every value that is shape-invalid for the field it sits in
 *       (unconditional — always safe; only removes data that was never valid
 *       there). This frees up target fields and is what makes the dual-phone
 *       case recoverable.
 *   (2) MOVE each cleared, shape-valid value into the field its shape belongs to
 *       — but ONLY when that target is now empty AND no other value competes for
 *       it (the W-01 two-sided rule). Otherwise the value is left absent and an
 *       `escalate` action records that a real value could not be safely placed.
 *
 * Auto-corruption is structurally impossible: a value that is shape-VALID for the
 * field it occupies is NEVER cleared, moved, or overwritten; nothing lands in a
 * target unless that target was empty and uncontested.
 *
 * Deterministic and idempotent — re-running on an already-healed result is a
 * no-op. No I/O, no side effects.
 *
 * @example phone-in-email + empty phone → cleared from email, moved to phone
 *   normalizeContactFields({ email: "8015551234", phone: "" })
 *   // → { phone: "8015551234", healActions: [{ action: "cleared", field: "email", … }, { action: "moved", field: "email", to: "phone", … }] }
 *
 * @example both columns swapped → double-swap heal
 *   normalizeContactFields({ email: "8015551234", phone: "jane@x.com" })
 *   // → { email: "jane@x.com", phone: "8015551234", healActions: [2 cleared, 2 moved] }
 *
 * @example dual-phone (phone in email, valid phone in phone) → email cleared, phone kept, VALIDATES
 *   normalizeContactFields({ email: "8015551234", phone: "8015550000" })
 *   // → { phone: "8015550000", healActions: [{ action: "cleared", field: "email", … }, { action: "escalate", field: "email", reason: orphan }] }
 *
 * @example city in phone → cleared, never invented elsewhere
 *   normalizeContactFields({ email: "jane@x.com", phone: "Sandy" })
 *   // → { email: "jane@x.com", healActions: [{ action: "cleared", field: "phone", valueShape: "NEITHER", … }] }
 */
export declare function normalizeContactFields<T extends NormalizeContactInput>(input: T): NormalizeContactResult<T>;
//# sourceMappingURL=normalize.d.ts.map