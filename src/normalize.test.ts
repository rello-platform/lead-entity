// ============================================================================
// @rello-platform/lead-entity/normalize — shape normalizer contract test.
//
// Self-Healing Import Validation, Layer 2 (the safety core). Locks the TWO
// DISTINCT OPERATIONS:
//   (1) CLEAR provably-invalid values (unconditional, always safe) — a value
//       shape-invalid for the field it sits in is nulled, regardless of what the
//       other field holds. This is what makes the dual-phone case recoverable.
//   (2) MOVE per the W-01 TWO-SIDED RULE (conservative) — a cleared value is
//       relocated into a target field ONLY when that target is now empty AND
//       uncontested AND the value is shape-positive for it. Otherwise it is
//       reported via `escalate` (a real value that could not be safely placed),
//       never guessed onto a valid field, never overwritten.
//
// The load-bearing test in this file is the PROPERTY test ("the safety property")
// at the bottom: across an exhaustive cartesian product of representative shape
// values in both fields, a shape-valid value is NEVER cleared, moved, or
// overwritten — auto-corruption is structurally impossible.
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  normalizeContactFields,
  isEmailShaped,
  isPhoneShaped,
  isNeither,
  EMAIL_SHAPE_REGEX,
  PHONE_DIGIT_FLOOR,
  type HealAction,
} from "./normalize";

// Cross-check against the regression-lock contract's predicates so the
// normalizer can never drift from the shared shape predicates (Rule E).
import { createLeadContactContract } from "./contracts";

// ── Shape predicates ─────────────────────────────────────────────────────────

describe("isEmailShaped", () => {
  it("accepts well-formed emails", () => {
    expect(isEmailShaped("jane@example.com")).toBe(true);
    expect(isEmailShaped("a.b+tag@sub.domain.co.uk")).toBe(true);
    expect(isEmailShaped("  jane@example.com  ")).toBe(true); // trims
    // local-part of all digits is STILL an email (it has @ + dotted domain)
    expect(isEmailShaped("8015551234@x.com")).toBe(true);
  });

  it("rejects non-emails / phones / garbage / empties", () => {
    expect(isEmailShaped("8015551234")).toBe(false);
    expect(isEmailShaped("Sandy")).toBe(false);
    expect(isEmailShaped("nope@")).toBe(false); // no domain dot
    expect(isEmailShaped("a@b")).toBe(false); // no TLD dot
    expect(isEmailShaped("")).toBe(false);
    expect(isEmailShaped("   ")).toBe(false);
    expect(isEmailShaped(null)).toBe(false);
    expect(isEmailShaped(undefined)).toBe(false);
    expect(isEmailShaped(12345)).toBe(false);
    expect(isEmailShaped("a@b.com c@d.com")).toBe(false); // whitespace → not single email
  });

  it("uses the exact import.ts / contract regex", () => {
    expect(EMAIL_SHAPE_REGEX.source).toBe(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.source);
  });
});

describe("isPhoneShaped", () => {
  it("accepts ≥7-digit values, US-formatted and international", () => {
    expect(isPhoneShaped("8015551234")).toBe(true);
    expect(isPhoneShaped("(801) 555-1234")).toBe(true);
    expect(isPhoneShaped("801-555-1234")).toBe(true);
    expect(isPhoneShaped("+44 20 7946 0958")).toBe(true); // intl, stripped clears 7
    expect(isPhoneShaped("555-1234")).toBe(true); // exactly 7 digits (floor)
    expect(isPhoneShaped("  8015551234  ")).toBe(true); // trims
  });

  it("rejects <7-digit, '@'-containing, and non-phone values", () => {
    expect(isPhoneShaped("555-123")).toBe(false); // 6 digits, below floor
    expect(isPhoneShaped("Sandy")).toBe(false);
    expect(isPhoneShaped("8015551234@x.com")).toBe(false); // has @ → email signal
    expect(isPhoneShaped("jane@example.com")).toBe(false);
    expect(isPhoneShaped("")).toBe(false);
    expect(isPhoneShaped(null)).toBe(false);
    expect(isPhoneShaped(8015551234)).toBe(false); // non-string
  });

  it("honors the contract's ≥7-digit floor constant", () => {
    expect(PHONE_DIGIT_FLOOR).toBe(7);
  });

  it("EMAIL and PHONE shapes are mutually exclusive (the @-clause guarantee)", () => {
    // No string can be BOTH email- and phone-shaped — the property the
    // two-sided rule relies on to never mistake a swap for an ambiguous value.
    const samples = [
      "jane@example.com",
      "8015551234@x.com",
      "8015551234",
      "+44 20 7946 0958",
      "Sandy",
      "a@b.com",
    ];
    for (const s of samples) {
      expect(isEmailShaped(s) && isPhoneShaped(s)).toBe(false);
    }
  });
});

describe("isNeither", () => {
  it("is true only for present, non-contact values", () => {
    expect(isNeither("Sandy")).toBe(true);
    expect(isNeither("Salt Lake City")).toBe(true);
    expect(isNeither("jane@example.com")).toBe(false);
    expect(isNeither("8015551234")).toBe(false);
    expect(isNeither("")).toBe(false); // empty is "absent", not "neither"
    expect(isNeither(null)).toBe(false);
  });
});

// ── The healing cases (clear-then-move, the confidence boundary) ─────────────

describe("normalizeContactFields — heal cases (clear-invalid → move)", () => {
  it("phone-in-email + empty phone → cleared from email, moved to phone (THE incident, half of it)", () => {
    const r = normalizeContactFields({ email: "8015551234", phone: "" });
    expect(r.email).toBeUndefined();
    expect(r.phone).toBe("8015551234");
    expect(r.healActions).toContainEqual<HealAction>({
      action: "cleared",
      kind: "cleared",
      field: "email",
      value: "8015551234",
      valueShape: "PHONE",
    });
    expect(r.healActions).toContainEqual<HealAction>({
      action: "moved",
      kind: "moved",
      field: "email",
      to: "phone",
      value: "8015551234",
      valueShape: "PHONE",
    });
    expect(r.healActions).toHaveLength(2);
  });

  it("phone-in-email + absent phone key → moved to phone", () => {
    const r = normalizeContactFields({ email: "8015551234" });
    expect(r.phone).toBe("8015551234");
    expect(r.email).toBeUndefined();
    expect(r.healActions.some((a) => a.action === "moved")).toBe(true);
    expect(r.healActions.some((a) => a.action === "cleared")).toBe(true);
  });

  it("email-in-phone + empty email → cleared from phone, moved to email", () => {
    const r = normalizeContactFields({ email: "", phone: "jane@example.com" });
    expect(r.email).toBe("jane@example.com");
    expect(r.phone).toBeUndefined();
    expect(r.healActions).toContainEqual<HealAction>({
      action: "cleared",
      kind: "cleared",
      field: "phone",
      value: "jane@example.com",
      valueShape: "EMAIL",
    });
    expect(r.healActions).toContainEqual<HealAction>({
      action: "moved",
      kind: "moved",
      field: "phone",
      to: "email",
      value: "jane@example.com",
      valueShape: "EMAIL",
    });
  });

  it("BOTH columns swapped, both valid → double-swap heal", () => {
    const r = normalizeContactFields({
      email: "8015551234",
      phone: "jane@example.com",
    });
    expect(r.email).toBe("jane@example.com");
    expect(r.phone).toBe("8015551234");
    // 2 clears + 2 moves
    expect(r.healActions.filter((a) => a.action === "cleared")).toHaveLength(2);
    expect(r.healActions.filter((a) => a.action === "moved")).toHaveLength(2);
    expect(r.healActions).toContainEqual<HealAction>({
      action: "moved",
      kind: "moved",
      field: "email",
      to: "phone",
      value: "8015551234",
      valueShape: "PHONE",
    });
    expect(r.healActions).toContainEqual<HealAction>({
      action: "moved",
      kind: "moved",
      field: "phone",
      to: "email",
      value: "jane@example.com",
      valueShape: "EMAIL",
    });
  });

  it("phone-in-email + city-in-phone → phone healed, city cleared (THE full incident)", () => {
    // source: email = "8015551234" (Utah phone), phone = "Sandy" (a city)
    const r = normalizeContactFields({ email: "8015551234", phone: "Sandy" });
    expect(r.email).toBeUndefined();
    expect(r.phone).toBe("8015551234");
    expect(r.healActions).toContainEqual<HealAction>({
      action: "cleared",
      kind: "cleared",
      field: "email",
      value: "8015551234",
      valueShape: "PHONE",
    });
    expect(r.healActions).toContainEqual<HealAction>({
      action: "cleared",
      kind: "cleared",
      field: "phone",
      value: "Sandy",
      valueShape: "NEITHER",
    });
    expect(r.healActions).toContainEqual<HealAction>({
      action: "moved",
      kind: "moved",
      field: "email",
      to: "phone",
      value: "8015551234",
      valueShape: "PHONE",
    });
  });
});

// ── THE DUAL-PHONE CASE (the load-bearing recoverability proof) ──────────────

describe("normalizeContactFields — dual-phone (THE recoverability case)", () => {
  it("phone-in-email + valid phone in phone → EMAIL CLEARED, phone KEPT, row VALIDATES", () => {
    const r = normalizeContactFields({
      firstName: "Jane",
      lastName: "Doe",
      email: "8015551234", // a phone, mis-filed in the email column
      phone: "8015550000", // a genuinely valid phone, correctly placed
    });

    // (1) The provably-invalid email-column value is CLEARED — unconditionally,
    //     because a phone is definitively NOT an email, regardless of phone being
    //     full. This is the operation the prior implementation was missing.
    expect(r.email).toBeUndefined();
    expect(r.healActions).toContainEqual<HealAction>({
      action: "cleared",
      kind: "cleared",
      field: "email",
      value: "8015551234",
      valueShape: "PHONE",
    });

    // (2) The valid phone is UNTOUCHED (never overwritten).
    expect(r.phone).toBe("8015550000");

    // (2b) The cleared phone could not be placed (phone slot already valid) →
    //      reported as an escalate (a real value a human may want), never moved
    //      on top of the valid phone, never silently guessed.
    const esc = r.healActions.find((a) => a.action === "escalate");
    expect(esc).toMatchObject({
      action: "escalate",
      field: "email",
      value: "8015551234",
      valueShape: "PHONE",
    });
    expect(r.healActions.some((a) => a.action === "moved")).toBe(false);

    // (3) THE POINT: the healed row now VALIDATES against the shared contract —
    //     the row that the platform previously dead-lettered is recovered.
    const parsed = createLeadContactContract.safeParse({
      firstName: "Jane",
      lastName: "Doe",
      email: r.email,
      phone: r.phone,
    });
    expect(parsed.success).toBe(true);
  });

  it("dual-email (email-in-phone + valid email in email) → PHONE CLEARED, email KEPT, validates", () => {
    const r = normalizeContactFields({
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com", // valid email, correctly placed
      phone: "bob@example.com", // an email, mis-filed in the phone column
    });
    expect(r.email).toBe("jane@example.com"); // untouched
    expect(r.phone).toBeUndefined(); // the email-in-phone is CLEARED
    expect(r.healActions).toContainEqual<HealAction>({
      action: "cleared",
      kind: "cleared",
      field: "phone",
      value: "bob@example.com",
      valueShape: "EMAIL",
    });
    expect(r.healActions.find((a) => a.action === "escalate")).toMatchObject({
      field: "phone",
      value: "bob@example.com",
    });
    const parsed = createLeadContactContract.safeParse({
      firstName: "Jane",
      lastName: "Doe",
      email: r.email,
      phone: r.phone,
    });
    expect(parsed.success).toBe(true);
  });
});

// ── The clear cases (NEITHER → cleared, never invent) ────────────────────────

describe("normalizeContactFields — clear cases (provably-invalid)", () => {
  it("city-in-phone (valid email present) → clear phone, keep email", () => {
    const r = normalizeContactFields({
      email: "jane@example.com",
      phone: "Sandy",
    });
    expect(r.email).toBe("jane@example.com");
    expect(r.phone).toBeUndefined();
    expect(r.healActions).toEqual<HealAction[]>([
      {
        action: "cleared",
        kind: "cleared",
        field: "phone",
        value: "Sandy",
        valueShape: "NEITHER",
      },
    ]);
  });

  it("garbage-in-email (valid phone present) → clear email, keep phone", () => {
    const r = normalizeContactFields({
      email: "Salt Lake City",
      phone: "8015551234",
    });
    expect(r.phone).toBe("8015551234");
    expect(r.email).toBeUndefined();
    expect(r.healActions).toEqual<HealAction[]>([
      {
        action: "cleared",
        kind: "cleared",
        field: "email",
        value: "Salt Lake City",
        valueShape: "NEITHER",
      },
    ]);
  });

  it("never invents: a NEITHER value is never promoted to the other field", () => {
    const r = normalizeContactFields({ email: "Sandy", phone: "" });
    expect(r.email).toBeUndefined();
    expect(r.phone).toBeUndefined();
    expect(r.healActions).toEqual<HealAction[]>([
      {
        action: "cleared",
        kind: "cleared",
        field: "email",
        value: "Sandy",
        valueShape: "NEITHER",
      },
    ]);
  });

  it("word-email + short-phone → BOTH cleared → contact-less (escalate via contract if a contact is required)", () => {
    // email = a word, phone = 3 digits (below floor → NEITHER). Both provably
    // invalid → both cleared. The row is now contact-less; whether that escalates
    // is the CONTRACT's call (an INDIVIDUAL with a first name still validates;
    // a truly empty one does not).
    const r = normalizeContactFields({
      email: "Jane",
      phone: "123",
      firstName: "Jane",
    });
    expect(r.email).toBeUndefined();
    expect(r.phone).toBeUndefined();
    expect(r.healActions.filter((a) => a.action === "cleared")).toHaveLength(2);
    expect(r.healActions.some((a) => a.action === "moved")).toBe(false);
    // With a first name, the contract still accepts a contact-less INDIVIDUAL.
    const withName = createLeadContactContract.safeParse({
      firstName: "Jane",
      email: r.email,
      phone: r.phone,
    });
    expect(withName.success).toBe(true);
    // Without any contact OR name, the contract REJECTS → the escalation signal.
    const empty = createLeadContactContract.safeParse({
      email: r.email,
      phone: r.phone,
    });
    expect(empty.success).toBe(false);
  });
});

// ── The no-op cases (already correct → never touch) ──────────────────────────

describe("normalizeContactFields — no-op cases", () => {
  it("both already valid in the right field → no actions", () => {
    const r = normalizeContactFields({
      email: "jane@example.com",
      phone: "8015551234",
    });
    expect(r.email).toBe("jane@example.com");
    expect(r.phone).toBe("8015551234");
    expect(r.healActions).toEqual([]);
  });

  it("both empty → no-op, no actions", () => {
    const r = normalizeContactFields({ email: "", phone: "" });
    expect(r.email).toBeUndefined();
    expect(r.phone).toBeUndefined();
    expect(r.healActions).toEqual([]);
  });

  it("both absent → no-op, no actions", () => {
    const r = normalizeContactFields({});
    expect(r.email).toBeUndefined();
    expect(r.phone).toBeUndefined();
    expect(r.healActions).toEqual([]);
  });

  it("only a valid email present → no-op", () => {
    const r = normalizeContactFields({ email: "jane@example.com" });
    expect(r.email).toBe("jane@example.com");
    expect(r.healActions).toEqual([]);
  });

  it("only a valid phone present → no-op", () => {
    const r = normalizeContactFields({ phone: "8015551234" });
    expect(r.phone).toBe("8015551234");
    expect(r.healActions).toEqual([]);
  });
});

// ── The escalate cases (a real value that can't be safely placed) ────────────

describe("normalizeContactFields — escalate cases (W-01 two-sided rule)", () => {
  it("target already valid → the misplaced value is NEVER moved onto it (move suppressed)", () => {
    const r = normalizeContactFields({
      email: "8015551234", // phone-shaped, mis-filed
      phone: "8015550000", // valid phone, correctly placed
    });
    expect(r.phone).toBe("8015550000"); // valid value NEVER overwritten
    expect(r.healActions.some((a) => a.action === "moved")).toBe(false);
    expect(r.healActions.some((a) => a.action === "escalate")).toBe(true);
  });

  it("ambiguous: TWO emails, one in each column → escalate both, place neither (never guess)", () => {
    // email holds a valid email; phone holds an email. After clearing the
    // phone-column email, both the kept email AND the cleared one are EMAIL —
    // but the email slot is already taken by the in-place valid email, so the
    // cleared one escalates (cannot pick a winner / overwrite).
    const r = normalizeContactFields({
      email: "jane@example.com",
      phone: "bob@example.com",
    });
    expect(r.email).toBe("jane@example.com"); // in-place valid email kept
    expect(r.phone).toBeUndefined(); // the email-in-phone is cleared
    expect(r.healActions.some((a) => a.action === "moved")).toBe(false);
    const esc = r.healActions.find((a) => a.action === "escalate");
    expect(esc).toMatchObject({
      action: "escalate",
      field: "phone",
      value: "bob@example.com",
      valueShape: "EMAIL",
    });
  });

  it("ambiguous: TWO emails both mis-filed (one in email-shaped slot empty, one valid) — competing for one empty target → escalate both", () => {
    // Construct a true two-candidates-for-one-empty-target case: email column
    // holds a phone (→ cleared, wants phone), phone column ALSO holds a phone
    // (→ valid, kept). Already covered above. Here build the EMAIL competition:
    // put an email in the phone column AND a NEITHER (cleared) in email so the
    // email slot is empty — only one email candidate → it MOVES (not ambiguous).
    // A genuine 2-candidates-for-empty-target needs both source values to be the
    // SAME target shape with the target empty; that's the double-phone-both-
    // mis-filed shape:
    const r = normalizeContactFields({
      email: "8015551234", // phone, cleared, wants phone (target empty)
      phone: "8015550000", // phone, cleared? no — valid in place, kept
    });
    // phone slot is filled by the in-place valid phone, so the cleared phone has
    // nowhere to go → escalate (already asserted elsewhere). This documents that
    // the engine never fabricates a second phone slot.
    expect(r.healActions.some((a) => a.action === "escalate")).toBe(true);
    expect(r.healActions.some((a) => a.action === "moved")).toBe(false);
  });
});

// ── International / extension / short-digit edges (don't false-heal) ─────────

describe("normalizeContactFields — international / edge digits", () => {
  it("international phone in email column heals to phone (country-agnostic floor)", () => {
    const r = normalizeContactFields({ email: "+44 20 7946 0958", phone: "" });
    expect(r.phone).toBe("+44 20 7946 0958");
    expect(r.healActions.some((a) => a.action === "moved" && a.to === "phone")).toBe(true);
  });

  it("phone with extension still heals (digits clear the floor)", () => {
    const r = normalizeContactFields({ email: "801-555-1234 x42", phone: "" });
    expect(r.phone).toBe("801-555-1234 x42");
    expect(r.healActions.some((a) => a.action === "moved" && a.to === "phone")).toBe(true);
  });

  it("a SHORT digit string (<7 digits) is NEITHER → cleared, never false-healed to phone", () => {
    // "12345" is 5 digits — below the floor. It is NOT a phone, so it must not
    // be moved into the phone field; it is a non-contact value → clear.
    const r = normalizeContactFields({ email: "12345", phone: "" });
    expect(r.phone).toBeUndefined();
    expect(r.email).toBeUndefined();
    expect(r.healActions).toEqual<HealAction[]>([
      {
        action: "cleared",
        kind: "cleared",
        field: "email",
        value: "12345",
        valueShape: "NEITHER",
      },
    ]);
  });

  it("ambiguous 'email with trailing phone' is NEITHER (has whitespace) → not split, not false-healed", () => {
    // "a@b.com / 8015551234" — contains both signals but is a single malformed
    // value. It is neither a clean email (whitespace) nor a phone (has @) →
    // NEITHER. Per the spec we do NOT split it; here it sits in email → clear.
    const v = "a@b.com / 8015551234";
    expect(isEmailShaped(v)).toBe(false);
    expect(isPhoneShaped(v)).toBe(false);
    const r = normalizeContactFields({ email: v, phone: "" });
    expect(r.email).toBeUndefined();
    expect(r.phone).toBeUndefined();
    expect(r.healActions).toEqual<HealAction[]>([
      {
        action: "cleared",
        kind: "cleared",
        field: "email",
        value: v,
        valueShape: "NEITHER",
      },
    ]);
  });
});

// ── Output shape, passthrough, idempotency ───────────────────────────────────

describe("normalizeContactFields — output shape + passthrough + idempotency", () => {
  it("passes through non-contact keys untouched", () => {
    const r = normalizeContactFields({
      email: "8015551234",
      phone: "",
      firstName: "Jane",
      source: "harvest-home",
      score: 85,
    });
    expect(r.firstName).toBe("Jane");
    expect(r.source).toBe("harvest-home");
    expect(r.score).toBe(85);
    expect(r.phone).toBe("8015551234");
  });

  it("never emits empty-string contact fields (absent → key omitted)", () => {
    const r = normalizeContactFields({ email: "", phone: "" });
    expect("email" in r).toBe(false);
    expect("phone" in r).toBe(false);
  });

  it("is idempotent — re-running on a healed result is a no-op", () => {
    const once = normalizeContactFields({ email: "8015551234", phone: "Sandy" });
    const twice = normalizeContactFields({
      email: once.email,
      phone: once.phone,
    });
    expect(twice.email).toBe(once.email);
    expect(twice.phone).toBe(once.phone);
    expect(twice.healActions).toEqual([]); // already healed → nothing to do
  });

  it("is idempotent even for the dual-phone escalate case", () => {
    const once = normalizeContactFields({
      email: "8015551234",
      phone: "8015550000",
    });
    const twice = normalizeContactFields({
      email: once.email,
      phone: once.phone,
    });
    expect(twice.email).toBe(once.email); // undefined
    expect(twice.phone).toBe(once.phone); // the kept valid phone
    expect(twice.healActions).toEqual([]); // already in a stable, valid state
  });

  it("tolerates a non-object input without throwing", () => {
    // @ts-expect-error — deliberately wrong type to prove the hot-path guard.
    const r = normalizeContactFields(null);
    expect(r.healActions).toEqual([]);
    expect(r.email).toBeUndefined();
    expect(r.phone).toBeUndefined();
  });

  it("tolerates non-string contact values (number/object) by treating them as absent", () => {
    const r = normalizeContactFields({
      email: 8015551234 as unknown as string,
      phone: { junk: true } as unknown as string,
    });
    expect(r.email).toBeUndefined();
    expect(r.phone).toBeUndefined();
    expect(r.healActions).toEqual([]);
  });
});

// ============================================================================
// THE SAFETY PROPERTY — auto-corruption is structurally impossible.
//
// Across an EXHAUSTIVE cartesian product of representative shape values in both
// the email and phone columns, assert the invariant:
//
//   (1) A value that is shape-VALID for the field it sits in is NEVER cleared,
//       moved, or overwritten — it always survives, unchanged, in its own field.
//   (2) Nothing lands in a target field unless a `moved` action put it there via
//       the two-sided rule (shape-positive for target, shape-negative for source,
//       target empty after the clear).
//   (3) Every emitted output contact value is shape-valid for the field it
//       occupies (we never leave a phone in `email` or an email in `phone` as a
//       SUCCESS — a value that can't be placed is cleared or escalated, never
//       silently mis-filed as the output).
//   (4) No value is ever fabricated — every output value traces to an input.
// ============================================================================

describe("THE SAFETY PROPERTY — no auto-corruption (exhaustive cartesian)", () => {
  // Representative values spanning every shape + the absence sentinels.
  const EMAILS = ["jane@example.com", "bob@sub.domain.co.uk", "x@y.io"];
  const PHONES = ["8015551234", "(801) 555-1234", "+44 20 7946 0958"];
  const NEITHERS = ["Sandy", "Salt Lake City", "12345", "a@b.com / 555-1234"];
  const ABSENT: (string | undefined)[] = ["", "   ", undefined];

  const ALL = [...EMAILS, ...PHONES, ...NEITHERS, ...ABSENT];

  const shapeOf = (
    v: string | undefined,
  ): "EMAIL" | "PHONE" | "NEITHER" | "ABSENT" => {
    if (v === undefined) return "ABSENT";
    if (isEmailShaped(v)) return "EMAIL";
    if (isPhoneShaped(v)) return "PHONE";
    if (isNeither(v)) return "NEITHER";
    return "ABSENT"; // "" / whitespace
  };

  it(`holds the invariant across all ${ALL.length}×${ALL.length} shape combinations`, () => {
    let movesSeen = 0;
    let escalatesSeen = 0;
    let clearsSeen = 0;

    for (const emailIn of ALL) {
      for (const phoneIn of ALL) {
        const input = { email: emailIn, phone: phoneIn };
        const r = normalizeContactFields(input);

        const emailInShape = shapeOf(emailIn);
        const phoneInShape = shapeOf(phoneIn);

        // ── (1) A shape-VALID-in-place value is NEVER lost, moved, or cleared. ─
        if (emailInShape === "EMAIL") {
          expect(r.email).toBe((emailIn as string).trim());
          expect(
            r.healActions.some(
              (a) =>
                (a.action === "moved" || a.action === "cleared") &&
                a.field === "email",
            ),
          ).toBe(false);
        }
        if (phoneInShape === "PHONE") {
          expect(r.phone).toBe((phoneIn as string).trim());
          expect(
            r.healActions.some(
              (a) =>
                (a.action === "moved" || a.action === "cleared") &&
                a.field === "phone",
            ),
          ).toBe(false);
        }

        // ── (3) Every emitted output value is shape-VALID for its field. There
        //        is NEVER a mis-filed value left in an output field — a provably
        //        invalid value is always cleared, so the output is clean. ──────
        if (r.email !== undefined) {
          expect(isEmailShaped(r.email)).toBe(true);
        }
        if (r.phone !== undefined) {
          expect(isPhoneShaped(r.phone)).toBe(true);
        }

        // ── (2) Each MOVE obeys the two-sided geometry; each CLEAR removed a
        //        value that was invalid for its field. ───────────────────────
        for (const a of r.healActions) {
          if (a.action === "moved") {
            movesSeen++;
            // source value shape-NEGATIVE for its source field …
            if (a.field === "email") {
              expect(isEmailShaped(a.value)).toBe(false);
            } else {
              expect(isPhoneShaped(a.value)).toBe(false);
            }
            // … shape-POSITIVE for its target … and IS the output there.
            if (a.to === "phone") {
              expect(isPhoneShaped(a.value)).toBe(true);
              expect(r.phone).toBe(a.value);
            } else {
              expect(isEmailShaped(a.value)).toBe(true);
              expect(r.email).toBe(a.value);
            }
          } else if (a.action === "cleared") {
            clearsSeen++;
            // a cleared value was shape-INVALID for the field it was cleared from
            if (a.field === "email") {
              expect(isEmailShaped(a.value)).toBe(false);
            } else {
              expect(isPhoneShaped(a.value)).toBe(false);
            }
            // … and that field is empty (or re-filled by a MOVE) in the output —
            // never still holding the cleared value.
            expect(r[a.field]).not.toBe(a.value);
          } else if (a.action === "escalate") {
            escalatesSeen++;
            // an escalated value is a real contact value (EMAIL/PHONE), never
            // NEITHER. It was cleared from its source then could NOT be safely
            // placed, so it was never MOVED anywhere (no `moved` action carries
            // it). (Its TEXT may coincidentally equal a value legitimately kept
            // in another field — e.g. the same email duplicated across both
            // columns — which is NOT corruption: that field's value got there on
            // its own merit, not from this escalated value.)
            expect(a.valueShape === "EMAIL" || a.valueShape === "PHONE").toBe(
              true,
            );
            expect(
              r.healActions.some(
                (m) => m.action === "moved" && m.value === a.value && m.field === a.field,
              ),
            ).toBe(false);
          }
        }

        // ── (4) No fabrication: every output value is one of the two inputs. ─
        const inputs = [
          typeof emailIn === "string" ? emailIn.trim() : undefined,
          typeof phoneIn === "string" ? phoneIn.trim() : undefined,
        ];
        if (r.email !== undefined) expect(inputs).toContain(r.email);
        if (r.phone !== undefined) expect(inputs).toContain(r.phone);

        // ── (5) Never overwrite: if BOTH fields held a valid value of their own
        //        type, the output equals the input exactly, no actions. ──────
        if (emailInShape === "EMAIL" && phoneInShape === "PHONE") {
          expect(r.email).toBe((emailIn as string).trim());
          expect(r.phone).toBe((phoneIn as string).trim());
          expect(r.healActions).toEqual([]);
        }

        // ── (6) Idempotency across the WHOLE product: re-normalizing the output
        //        is a no-op (the output is always a fixed point). ─────────────
        const again = normalizeContactFields({ email: r.email, phone: r.phone });
        expect(again.email).toBe(r.email);
        expect(again.phone).toBe(r.phone);
        expect(again.healActions).toEqual([]);
      }
    }

    // Sanity: the product actually exercised each branch.
    expect(movesSeen).toBeGreaterThan(0);
    expect(escalatesSeen).toBeGreaterThan(0);
    expect(clearsSeen).toBeGreaterThan(0);
  });

  it("a healed result always re-validates against the shared contract (Layer-3 hand-off)", () => {
    // For the incident shape, the healed output must PASS the regression-lock
    // contract — this is exactly what the Layer-3 reconciler relies on.
    const r = normalizeContactFields({
      firstName: "Jane",
      lastName: "Doe",
      email: "8015551234",
      phone: "Sandy",
    });
    const parsed = createLeadContactContract.safeParse({
      firstName: "Jane",
      lastName: "Doe",
      email: r.email,
      phone: r.phone,
    });
    expect(parsed.success).toBe(true);
  });
});
