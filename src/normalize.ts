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
 * THE W-01 TWO-SIDED SAFETY RULE — auto-corruption must be STRUCTURALLY impossible
 * ────────────────────────────────────────────────────────────────────────────
 * A value moves into a target field ONLY when ALL THREE hold:
 *   (a) the value is shape-POSITIVE for the target field, AND
 *   (b) shape-NEGATIVE for the source field it currently occupies, AND
 *   (c) the target field is NOT already holding a shape-valid value of its own type.
 * If ANY of (a)/(b)/(c) is false, OR there are multiple candidates competing for
 * one field, OR the shape is ambiguous (positive for both fields) → the value is
 * LEFT AS-IS and an `escalate` action is emitted. We never overwrite a valid
 * value, and we never guess between two plausible candidates.
 *
 * The confidence boundary (from the spec):
 *   | source shape           | sits in | target state              | action   |
 *   | PHONE (≥7 digits, no @) | email   | phone empty / non-phone   | heal→phone |
 *   | EMAIL (matches regex)  | phone   | email empty / non-email   | heal→email |
 *   | NEITHER ("Sandy")      | phone   | n/a                       | drop      |
 *   | NEITHER ("Sandy")      | email   | n/a                       | drop      |
 *   | shape-valid for its own field | —  | —                         | no-op    |
 *   | ambiguous / both-valid-for-both | — | —                        | escalate |
 *
 * PURITY — no I/O, no side effects, deterministic. Re-running on an already-healed
 * input is a no-op (idempotent). Reuses the contract's email regex + ≥7-digit
 * phone floor (Rule E — single source of truth; this module does NOT fork the
 * shape predicates the contract already owns).
 */

// ── Shape predicates (the SAME predicates the contract uses — Rule E) ────────

/**
 * The exact email-shape regex used by Rello's CSV import (`import.ts:172`) and
 * the regression-lock contract. A value is EMAIL-shaped iff it matches this.
 * Deliberately strict on structure ("@" + a dotted domain), tolerant of the
 * local-part — it is a SHAPE gate (which field does this belong in?), not a
 * deliverability check.
 */
export const EMAIL_SHAPE_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The contract's phone floor (`contracts.ts:153-156`): ≥7 digits after stripping
 * every non-digit. Country-agnostic by design — a `+44…` number stripped of
 * non-digits still clears 7 digits → PHONE shape. The W-01 rule additionally
 * requires the absence of "@" so an email is never mis-read as a phone.
 */
export const PHONE_DIGIT_FLOOR = 7;

/** Normalize an input contact value to a trimmed string, or `undefined`. */
function toStr(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length === 0 ? undefined : t;
}

/**
 * EMAIL-shaped iff it matches the email-shape regex. Pure; tolerates any input.
 * An empty / non-string / whitespace-only value is NOT email-shaped.
 */
export function isEmailShaped(value: unknown): boolean {
  const s = toStr(value);
  if (s === undefined) return false;
  return EMAIL_SHAPE_REGEX.test(s);
}

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
export function isPhoneShaped(value: unknown): boolean {
  const s = toStr(value);
  if (s === undefined) return false;
  if (s.includes("@")) return false;
  const digits = s.replace(/\D/g, "");
  return digits.length >= PHONE_DIGIT_FLOOR;
}

/** NEITHER email- nor phone-shaped (e.g. a city, "Sandy"). A non-contact value. */
export function isNeither(value: unknown): boolean {
  const s = toStr(value);
  if (s === undefined) return false; // empty is "absent", not "neither/garbage"
  return !isEmailShaped(s) && !isPhoneShaped(s);
}

// ── Public types ─────────────────────────────────────────────────────────────

/** The two contact fields this normalizer routes between. */
export type ContactField = "email" | "phone";

/** The shape a value classifies as (the routing signal). */
export type ValueShape = "EMAIL" | "PHONE" | "NEITHER";

/**
 * What the normalizer did (or refused to do), for the transparency banner /
 * import-results residue. Every move, drop, and escalation is recorded — the
 * normalizer is NEVER silent to the system, even if the UI presentation (W-02)
 * is non-blocking.
 *
 * - `move`     — value relocated to the field its shape belongs to (a clean,
 *                two-sided-safe heal). Carries `from`/`to`/`value`/`valueShape`.
 * - `drop`     — a NEITHER value (city/garbage) cleared from a contact field;
 *                never promoted to the other field, never invented.
 * - `escalate` — the two-sided rule did NOT pass (would overwrite a valid value,
 *                ambiguous shape, or competing candidates). The value is LEFT
 *                AS-IS **in its original field** (preserved verbatim — no data
 *                loss, never moved on top of a valid value, never dropped) and
 *                flagged for a human to resolve in review. Carries a `reason`.
 *                NOTE: the field still holds a shape-invalid value after an
 *                escalate, so a downstream contract validate may still reject it
 *                — that rejection is the human-escalation signal, by design.
 */
export type HealAction =
  | {
      kind: "move";
      from: ContactField;
      to: ContactField;
      value: string;
      valueShape: ValueShape;
    }
  | {
      kind: "drop";
      from: ContactField;
      value: string;
      valueShape: "NEITHER";
    }
  | {
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
 * (omitted when absent/dropped). `healActions` describes every move/drop/escalate
 * for the transparency surface. Any non-`email`/`phone` keys on the input are
 * passed through unchanged.
 */
export type NormalizeContactResult<T extends NormalizeContactInput> = Omit<
  T,
  "email" | "phone"
> & {
  email?: string;
  phone?: string;
  healActions: HealAction[];
};

// ── The normalizer ───────────────────────────────────────────────────────────

/** Classify a present (trimmed-non-empty) value's shape. */
function classifyShape(s: string): ValueShape {
  // EMAIL and PHONE are mutually exclusive by construction: `isPhoneShaped`
  // rejects any value containing "@", and `isEmailShaped` requires an "@". So a
  // value is at most one of EMAIL / PHONE — never ambiguous *across the two
  // shapes*. (Ambiguity in the ROUTING sense — a value that could legitimately
  // belong to either field — is handled by the two-sided rule below, not here.)
  if (isEmailShaped(s)) return "EMAIL";
  if (isPhoneShaped(s)) return "PHONE";
  return "NEITHER";
}

/**
 * Shape-based contact-field normalizer (Layer 2 of Self-Healing Import Validation).
 *
 * Routes each of `email` / `phone` to the field its SHAPE belongs to, regardless
 * of which source column it arrived in — but ONLY when the W-01 two-sided safety
 * rule makes the destination UNAMBIGUOUS. Auto-corruption is structurally
 * impossible: a shape-valid value is never overwritten or dropped, and nothing is
 * moved unless it is shape-positive for the target AND shape-negative for its
 * source AND the target is not already holding a valid value of its own type.
 *
 * Deterministic and idempotent — re-running on an already-healed result is a
 * no-op. No I/O, no side effects.
 *
 * @example phone-in-email + empty phone → heals to phone
 *   normalizeContactFields({ email: "8015551234", phone: "" })
 *   // → { phone: "8015551234", healActions: [{ kind: "move", from: "email", to: "phone", … }] }
 *
 * @example both columns swapped → double-swap heal
 *   normalizeContactFields({ email: "8015551234", phone: "jane@x.com" })
 *   // → { email: "jane@x.com", phone: "8015551234", healActions: [2 moves] }
 *
 * @example target already valid → NEVER overwrite; escalate
 *   normalizeContactFields({ email: "8015551234", phone: "8015550000" })
 *   // → left as-is (email field still holds the phone-shaped value), 1 escalate
 *
 * @example city in phone → drop, never invent
 *   normalizeContactFields({ email: "jane@x.com", phone: "Sandy" })
 *   // → { email: "jane@x.com", healActions: [{ kind: "drop", from: "phone", … }] }
 */
export function normalizeContactFields<T extends NormalizeContactInput>(
  input: T,
): NormalizeContactResult<T> {
  // Defensive: a non-object input cannot be normalized. Return an empty,
  // safe result rather than throwing into a hot import path.
  const src: NormalizeContactInput =
    input && typeof input === "object" ? input : {};

  // Pass through every key that is NOT email/phone, untouched.
  const passthrough: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    if (key !== "email" && key !== "phone") {
      passthrough[key] = src[key];
    }
  }

  const emailRaw = toStr(src.email); // present, trimmed, non-empty — or undefined
  const phoneRaw = toStr(src.phone);

  const emailShape: ValueShape | "ABSENT" =
    emailRaw === undefined ? "ABSENT" : classifyShape(emailRaw);
  const phoneShape: ValueShape | "ABSENT" =
    phoneRaw === undefined ? "ABSENT" : classifyShape(phoneRaw);

  const healActions: HealAction[] = [];

  // Resolved outputs. We build them up by routing; default = leave where it is.
  let outEmail: string | undefined =
    emailShape === "EMAIL" ? emailRaw : undefined;
  let outPhone: string | undefined =
    phoneShape === "PHONE" ? phoneRaw : undefined;

  // ── Decide the fate of the value sitting in the EMAIL column ───────────────
  // It is only a HEAL CANDIDATE for `phone` if it is shape-NEGATIVE for email
  // (clause b) and shape-POSITIVE for phone (clause a).
  if (emailShape === "PHONE") {
    // Phone-shaped value in the email column. Wants to move to `phone`.
    // Clause (c): phone must NOT already hold a shape-valid (PHONE) value, and
    // there must be exactly ONE candidate for the phone slot.
    const phoneSlotHasValid = phoneShape === "PHONE";
    if (phoneSlotHasValid) {
      // Two-sided rule fails clause (c): would overwrite a valid phone. NEVER
      // overwrite — and we now have two phone-shaped candidates for one slot.
      healActions.push({
        kind: "escalate",
        field: "email",
        value: emailRaw as string,
        valueShape: "PHONE",
        reason:
          "phone-shaped value in email column, but phone field already holds a valid phone — refusing to overwrite (two competing phone candidates)",
      });
      // Leave the email-column value AS-IS (do not move, do not drop).
      outEmail = emailRaw;
    } else {
      // Clause (c) holds (phone slot empty or non-phone). Safe to move.
      // If the phone slot held a NEITHER value it will be dropped below; if it
      // held an EMAIL value, that email moves to the email slot below. Either
      // way the phone slot is free for this move.
      outPhone = emailRaw;
      healActions.push({
        kind: "move",
        from: "email",
        to: "phone",
        value: emailRaw as string,
        valueShape: "PHONE",
      });
    }
  } else if (emailShape === "NEITHER") {
    // A non-contact value (city/garbage) in the email column. Drop it — never
    // promote a non-contact string into another field.
    healActions.push({
      kind: "drop",
      from: "email",
      value: emailRaw as string,
      valueShape: "NEITHER",
    });
    // outEmail stays undefined.
  }
  // emailShape === "EMAIL" → stays in email (no-op, outEmail already set).
  // emailShape === "ABSENT" → nothing to do.

  // ── Decide the fate of the value sitting in the PHONE column ───────────────
  if (phoneShape === "EMAIL") {
    // Email-shaped value in the phone column. Wants to move to `email`.
    // Clause (c): email must NOT already hold a shape-valid (EMAIL) value.
    const emailSlotHasValid = emailShape === "EMAIL";
    if (emailSlotHasValid) {
      healActions.push({
        kind: "escalate",
        field: "phone",
        value: phoneRaw as string,
        valueShape: "EMAIL",
        reason:
          "email-shaped value in phone column, but email field already holds a valid email — refusing to overwrite (two competing email candidates)",
      });
      // Leave the phone-column value AS-IS.
      outPhone = phoneRaw;
    } else {
      outEmail = phoneRaw;
      healActions.push({
        kind: "move",
        from: "phone",
        to: "email",
        value: phoneRaw as string,
        valueShape: "EMAIL",
      });
    }
  } else if (phoneShape === "NEITHER") {
    healActions.push({
      kind: "drop",
      from: "phone",
      value: phoneRaw as string,
      valueShape: "NEITHER",
    });
    // outPhone stays undefined.
  }
  // phoneShape === "PHONE" → stays in phone (no-op, outPhone already set).
  // phoneShape === "ABSENT" → nothing to do.

  // ── Build the result. Omit absent fields (never emit empty strings). ───────
  const result = { ...passthrough, healActions } as NormalizeContactResult<T>;
  if (outEmail !== undefined) result.email = outEmail;
  if (outPhone !== undefined) result.phone = outPhone;

  return result;
}
