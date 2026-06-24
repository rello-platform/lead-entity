"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.PHONE_DIGIT_FLOOR = exports.EMAIL_SHAPE_REGEX = void 0;
exports.isEmailShaped = isEmailShaped;
exports.isPhoneShaped = isPhoneShaped;
exports.isNeither = isNeither;
exports.normalizeContactFields = normalizeContactFields;
// ── Shape predicates (the SAME predicates the contract uses — Rule E) ────────
/**
 * The exact email-shape regex used by Rello's CSV import (`import.ts:172`) and
 * the regression-lock contract. A value is EMAIL-shaped iff it matches this.
 * Deliberately strict on structure ("@" + a dotted domain), tolerant of the
 * local-part — it is a SHAPE gate (which field does this belong in?), not a
 * deliverability check.
 */
exports.EMAIL_SHAPE_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * The contract's phone floor (`contracts.ts:158-160`): ≥7 digits after stripping
 * every non-digit. Country-agnostic by design — a `+44…` number stripped of
 * non-digits still clears 7 digits → PHONE shape. The W-01 rule additionally
 * requires the absence of "@" so an email is never mis-read as a phone.
 */
exports.PHONE_DIGIT_FLOOR = 7;
/** Normalize an input contact value to a trimmed string, or `undefined`. */
function toStr(v) {
    if (v === undefined || v === null)
        return undefined;
    if (typeof v !== "string")
        return undefined;
    const t = v.trim();
    return t.length === 0 ? undefined : t;
}
/**
 * EMAIL-shaped iff it matches the email-shape regex. Pure; tolerates any input.
 * An empty / non-string / whitespace-only value is NOT email-shaped.
 */
function isEmailShaped(value) {
    const s = toStr(value);
    if (s === undefined)
        return false;
    return exports.EMAIL_SHAPE_REGEX.test(s);
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
function isPhoneShaped(value) {
    const s = toStr(value);
    if (s === undefined)
        return false;
    if (s.includes("@"))
        return false;
    const digits = s.replace(/\D/g, "");
    return digits.length >= exports.PHONE_DIGIT_FLOOR;
}
/** NEITHER email- nor phone-shaped (e.g. a city, "Sandy"). A non-contact value. */
function isNeither(value) {
    const s = toStr(value);
    if (s === undefined)
        return false; // empty is "absent", not "neither/garbage"
    return !isEmailShaped(s) && !isPhoneShaped(s);
}
// ── The normalizer ───────────────────────────────────────────────────────────
/** Classify a present (trimmed-non-empty) value's shape. */
function classifyShape(s) {
    // EMAIL and PHONE are mutually exclusive by construction: `isPhoneShaped`
    // rejects any value containing "@", and `isEmailShaped` requires an "@". So a
    // value is at most one of EMAIL / PHONE — never both.
    if (isEmailShaped(s))
        return "EMAIL";
    if (isPhoneShaped(s))
        return "PHONE";
    return "NEITHER";
}
/** The shape a given field legitimately holds. */
const VALID_SHAPE_FOR = {
    email: "EMAIL",
    phone: "PHONE",
};
/** The field a given shape legitimately belongs to (NEITHER → none). */
function targetFieldFor(shape) {
    if (shape === "EMAIL")
        return "email";
    if (shape === "PHONE")
        return "phone";
    return undefined;
}
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
function normalizeContactFields(input) {
    // Defensive: a non-object input cannot be normalized. Return an empty, safe
    // result rather than throwing into a hot import path.
    const src = input && typeof input === "object" ? input : {};
    // Pass through every key that is NOT email/phone, untouched.
    const passthrough = {};
    for (const key of Object.keys(src)) {
        if (key !== "email" && key !== "phone") {
            passthrough[key] = src[key];
        }
    }
    const fields = ["email", "phone"];
    // Per-field current value (trimmed-non-empty string or undefined) + shape.
    const raw = {
        email: toStr(src.email),
        phone: toStr(src.phone),
    };
    const shape = {
        email: raw.email === undefined ? "ABSENT" : classifyShape(raw.email),
        phone: raw.phone === undefined ? "ABSENT" : classifyShape(raw.phone),
    };
    const healActions = [];
    // Resolved output values; start with "kept iff shape-valid-in-place".
    const out = {
        email: shape.email === VALID_SHAPE_FOR.email ? raw.email : undefined,
        phone: shape.phone === VALID_SHAPE_FOR.phone ? raw.phone : undefined,
    };
    const moveCandidates = [];
    for (const field of fields) {
        const s = shape[field];
        if (s === "ABSENT")
            continue; // nothing present in this field
        if (s === VALID_SHAPE_FOR[field])
            continue; // shape-valid in place → KEEP
        // Shape-INVALID for the field it occupies → provably not a valid value of
        // this field's type → clear (always correct).
        const value = raw[field];
        healActions.push({
            action: "cleared",
            kind: "cleared",
            field,
            value,
            valueShape: s,
        });
        // out[field] is already undefined (only shape-valid values seeded it).
        // A cleared value that is a real contact value of the OTHER field's shape is
        // a move candidate. (A NEITHER value belongs to no field → discarded.)
        if (s === "EMAIL" || s === "PHONE") {
            moveCandidates.push({ value, shape: s, from: field });
        }
    }
    // ── OPERATION (2): MOVE each candidate into the field its shape belongs to,
    // under the W-01 two-sided rule. A target accepts a move ONLY when it is empty
    // (after the clear) AND exactly ONE candidate wants it. Competing candidates,
    // or a target still holding a shape-valid value, → escalate (never overwrite,
    // never guess).
    for (const target of fields) {
        const wanting = moveCandidates.filter((c) => targetFieldFor(c.shape) === target);
        if (wanting.length === 0)
            continue;
        if (out[target] !== undefined) {
            // Target already holds a shape-valid value of its own type → NEVER
            // overwrite. Every candidate for it is a real-but-unplaceable orphan.
            for (const c of wanting) {
                healActions.push({
                    action: "escalate",
                    kind: "escalate",
                    field: c.from,
                    value: c.value,
                    valueShape: c.shape,
                    reason: `${c.shape.toLowerCase()}-shaped value found in the ${c.from} column, but the ${target} field already holds a valid ${target} — refusing to overwrite (orphaned ${target} candidate, needs human review)`,
                });
            }
            continue;
        }
        if (wanting.length > 1) {
            // Two+ candidates compete for one empty target → ambiguous; never guess
            // which wins. Escalate all of them; leave the target empty.
            for (const c of wanting) {
                healActions.push({
                    action: "escalate",
                    kind: "escalate",
                    field: c.from,
                    value: c.value,
                    valueShape: c.shape,
                    reason: `multiple ${c.shape.toLowerCase()}-shaped values compete for the single ${target} field — refusing to guess which is correct (needs human review)`,
                });
            }
            continue;
        }
        // Exactly one candidate, target empty → safe two-sided move.
        const c = wanting[0];
        out[target] = c.value;
        healActions.push({
            action: "moved",
            kind: "moved",
            field: c.from,
            to: target,
            value: c.value,
            valueShape: c.shape,
        });
    }
    // ── Build the result. Omit absent fields (never emit empty strings). ───────
    const result = { ...passthrough, healActions };
    if (out.email !== undefined)
        result.email = out.email;
    if (out.phone !== undefined)
        result.phone = out.phone;
    return result;
}
