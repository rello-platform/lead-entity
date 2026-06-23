// ============================================================================
// @rello-platform/lead-entity/normalize — shape normalizer contract test.
//
// Self-Healing Import Validation, Layer 2 (the safety core). Locks the W-01
// TWO-SIDED SAFETY RULE: a value moves into a target field ONLY when it is
// shape-positive for the target AND shape-negative for its source AND the target
// is not already holding a shape-valid value. Everything else escalates (never
// guesses) or drops (NEITHER), and a shape-valid value is NEVER overwritten or
// dropped.
//
// The load-bearing test in this file is the PROPERTY test ("the safety property")
// at the bottom: across an exhaustive cartesian product of representative shape
// values in both fields, auto-corruption is structurally impossible.
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

// ── The healing cases (the confidence boundary, row by row) ──────────────────

describe("normalizeContactFields — heal cases", () => {
  it("phone-in-email + empty phone → moves to phone (THE incident, half of it)", () => {
    const r = normalizeContactFields({ email: "8015551234", phone: "" });
    expect(r.email).toBeUndefined();
    expect(r.phone).toBe("8015551234");
    expect(r.healActions).toEqual<HealAction[]>([
      {
        kind: "move",
        from: "email",
        to: "phone",
        value: "8015551234",
        valueShape: "PHONE",
      },
    ]);
  });

  it("phone-in-email + absent phone key → moves to phone", () => {
    const r = normalizeContactFields({ email: "8015551234" });
    expect(r.phone).toBe("8015551234");
    expect(r.email).toBeUndefined();
    expect(r.healActions).toHaveLength(1);
    expect(r.healActions[0].kind).toBe("move");
  });

  it("email-in-phone + empty email → moves to email", () => {
    const r = normalizeContactFields({ email: "", phone: "jane@example.com" });
    expect(r.email).toBe("jane@example.com");
    expect(r.phone).toBeUndefined();
    expect(r.healActions).toEqual<HealAction[]>([
      {
        kind: "move",
        from: "phone",
        to: "email",
        value: "jane@example.com",
        valueShape: "EMAIL",
      },
    ]);
  });

  it("BOTH columns swapped, both valid → double-swap heal", () => {
    const r = normalizeContactFields({
      email: "8015551234",
      phone: "jane@example.com",
    });
    expect(r.email).toBe("jane@example.com");
    expect(r.phone).toBe("8015551234");
    expect(r.healActions).toHaveLength(2);
    expect(r.healActions).toContainEqual({
      kind: "move",
      from: "email",
      to: "phone",
      value: "8015551234",
      valueShape: "PHONE",
    });
    expect(r.healActions).toContainEqual({
      kind: "move",
      from: "phone",
      to: "email",
      value: "jane@example.com",
      valueShape: "EMAIL",
    });
  });

  it("phone-in-email + city-in-phone → phone healed, city dropped (THE full incident)", () => {
    // source: email = "8015551234" (Utah phone), phone = "Sandy" (a city)
    const r = normalizeContactFields({ email: "8015551234", phone: "Sandy" });
    expect(r.email).toBeUndefined();
    expect(r.phone).toBe("8015551234");
    expect(r.healActions).toHaveLength(2);
    expect(r.healActions).toContainEqual({
      kind: "move",
      from: "email",
      to: "phone",
      value: "8015551234",
      valueShape: "PHONE",
    });
    expect(r.healActions).toContainEqual({
      kind: "drop",
      from: "phone",
      value: "Sandy",
      valueShape: "NEITHER",
    });
  });
});

// ── The drop cases (NEITHER → clear, never invent) ───────────────────────────

describe("normalizeContactFields — drop cases", () => {
  it("city-in-phone (valid email present) → drop phone, keep email", () => {
    const r = normalizeContactFields({
      email: "jane@example.com",
      phone: "Sandy",
    });
    expect(r.email).toBe("jane@example.com");
    expect(r.phone).toBeUndefined();
    expect(r.healActions).toEqual<HealAction[]>([
      { kind: "drop", from: "phone", value: "Sandy", valueShape: "NEITHER" },
    ]);
  });

  it("garbage-in-email (valid phone present) → drop email, keep phone", () => {
    const r = normalizeContactFields({
      email: "Salt Lake City",
      phone: "8015551234",
    });
    expect(r.phone).toBe("8015551234");
    expect(r.email).toBeUndefined();
    expect(r.healActions).toEqual<HealAction[]>([
      {
        kind: "drop",
        from: "email",
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
      { kind: "drop", from: "email", value: "Sandy", valueShape: "NEITHER" },
    ]);
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

// ── The escalate cases (the two-sided rule REFUSES — never overwrite/guess) ──

describe("normalizeContactFields — escalate cases (W-01 two-sided rule)", () => {
  it("phone-in-email but phone field ALREADY holds a valid phone → escalate, never overwrite", () => {
    const r = normalizeContactFields({
      email: "8015551234",
      phone: "8015550000",
    });
    // The valid phone is UNTOUCHED; the email-column phone is left AS-IS in the
    // email field (no data loss) and flagged for a human — never moved on top of
    // the valid phone, never silently dropped.
    expect(r.phone).toBe("8015550000");
    expect(r.email).toBe("8015551234"); // preserved in place for review (NOT moved, NOT dropped)
    const esc = r.healActions.find((a) => a.kind === "escalate");
    expect(esc).toBeDefined();
    expect(esc).toMatchObject({
      kind: "escalate",
      field: "email",
      value: "8015551234",
      valueShape: "PHONE",
    });
  });

  it("email-in-phone but email field ALREADY holds a valid email → escalate, never overwrite", () => {
    const r = normalizeContactFields({
      email: "jane@example.com",
      phone: "bob@example.com",
    });
    expect(r.email).toBe("jane@example.com"); // untouched
    expect(r.phone).toBe("bob@example.com"); // preserved in place for review (NOT moved onto the valid email)
    const esc = r.healActions.find((a) => a.kind === "escalate");
    expect(esc).toMatchObject({
      kind: "escalate",
      field: "phone",
      value: "bob@example.com",
      valueShape: "EMAIL",
    });
  });

  it("two phones, one in each column → escalate the misplaced one, keep the valid phone", () => {
    // email holds a phone, phone holds a phone → cannot pick a winner for the
    // phone slot. Keep the in-place phone; escalate the email-column phone.
    const r = normalizeContactFields({
      email: "8015551234",
      phone: "8015550000",
    });
    expect(r.phone).toBe("8015550000");
    expect(r.healActions.some((a) => a.kind === "escalate")).toBe(true);
    expect(r.healActions.some((a) => a.kind === "move")).toBe(false);
  });
});

// ── International / extension / short-digit edges (don't false-heal) ─────────

describe("normalizeContactFields — international / edge digits", () => {
  it("international phone in email column heals to phone (country-agnostic floor)", () => {
    const r = normalizeContactFields({ email: "+44 20 7946 0958", phone: "" });
    expect(r.phone).toBe("+44 20 7946 0958");
    expect(r.healActions[0]).toMatchObject({ kind: "move", to: "phone" });
  });

  it("phone with extension still heals (digits clear the floor)", () => {
    const r = normalizeContactFields({ email: "801-555-1234 x42", phone: "" });
    expect(r.phone).toBe("801-555-1234 x42");
    expect(r.healActions[0]).toMatchObject({ kind: "move", to: "phone" });
  });

  it("a SHORT digit string (<7 digits) is NEITHER → dropped, never false-healed to phone", () => {
    // "12345" is 5 digits — below the floor. It is NOT a phone, so it must not
    // be moved into the phone field; it is a non-contact value → drop.
    const r = normalizeContactFields({ email: "12345", phone: "" });
    expect(r.phone).toBeUndefined();
    expect(r.email).toBeUndefined();
    expect(r.healActions).toEqual<HealAction[]>([
      { kind: "drop", from: "email", value: "12345", valueShape: "NEITHER" },
    ]);
  });

  it("ambiguous 'email with trailing phone' is NEITHER (has whitespace) → not split, not false-healed", () => {
    // "a@b.com / 8015551234" — contains both signals but is a single malformed
    // value. It is neither a clean email (whitespace) nor a phone (has @) →
    // NEITHER. Per the spec we do NOT split it; here it sits in email → drop.
    const v = "a@b.com / 8015551234";
    expect(isEmailShaped(v)).toBe(false);
    expect(isPhoneShaped(v)).toBe(false);
    const r = normalizeContactFields({ email: v, phone: "" });
    expect(r.email).toBeUndefined();
    expect(r.phone).toBeUndefined();
    expect(r.healActions).toEqual<HealAction[]>([
      { kind: "drop", from: "email", value: v, valueShape: "NEITHER" },
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
//   (1) A value that is shape-VALID for the field it sits in is NEVER moved,
//       overwritten, or dropped — it always survives in its own field.
//   (2) Nothing lands in a target field unless a `move` action that put it there
//       passes the two-sided rule (shape-positive for target, shape-negative for
//       source, target not already valid).
//   (3) Every output contact value is shape-valid for the field it occupies
//       (we never leave a phone in `email` or an email in `phone` as a SUCCESS —
//       a value that can't be placed is dropped or escalated, never silently
//       mis-filed as the output).
//   (4) No value is ever fabricated — every output value traces to an input value.
// ============================================================================

describe("THE SAFETY PROPERTY — no auto-corruption (exhaustive cartesian)", () => {
  // Representative values spanning every shape + the absence sentinels.
  const EMAILS = ["jane@example.com", "bob@sub.domain.co.uk", "x@y.io"];
  const PHONES = ["8015551234", "(801) 555-1234", "+44 20 7946 0958"];
  const NEITHERS = ["Sandy", "Salt Lake City", "12345", "a@b.com / 555-1234"];
  const ABSENT: (string | undefined)[] = ["", "   ", undefined];

  const ALL = [...EMAILS, ...PHONES, ...NEITHERS, ...ABSENT];

  const shapeOf = (v: string | undefined): "EMAIL" | "PHONE" | "NEITHER" | "ABSENT" => {
    if (v === undefined) return "ABSENT";
    if (isEmailShaped(v)) return "EMAIL";
    if (isPhoneShaped(v)) return "PHONE";
    if (isNeither(v)) return "NEITHER";
    return "ABSENT"; // "" / whitespace
  };

  it(`holds the invariant across all ${ALL.length}×${ALL.length} shape combinations`, () => {
    let movesSeen = 0;
    let escalatesSeen = 0;
    let dropsSeen = 0;

    for (const emailIn of ALL) {
      for (const phoneIn of ALL) {
        const input = { email: emailIn, phone: phoneIn };
        const r = normalizeContactFields(input);

        const emailInShape = shapeOf(emailIn);
        const phoneInShape = shapeOf(phoneIn);

        // ── (1) A shape-VALID-in-place value is NEVER lost or moved. ──────────
        if (emailInShape === "EMAIL") {
          expect(r.email).toBe((emailIn as string).trim());
          // it must NOT have been moved into phone
          expect(
            r.healActions.some(
              (a) => a.kind === "move" && a.from === "email",
            ),
          ).toBe(false);
        }
        if (phoneInShape === "PHONE") {
          expect(r.phone).toBe((phoneIn as string).trim());
          expect(
            r.healActions.some(
              (a) => a.kind === "move" && a.from === "phone",
            ),
          ).toBe(false);
        }

        // ── (3) Every emitted output value is EITHER shape-valid for its
        //        field, OR an escalated value preserved IN PLACE (a value the
        //        two-sided rule refused to move — left exactly where it arrived,
        //        no data loss, flagged for a human). It is NEVER a silently
        //        mis-filed move. ──────────────────────────────────────────────
        const escalatedInEmail = r.healActions.some(
          (a) => a.kind === "escalate" && a.field === "email",
        );
        const escalatedInPhone = r.healActions.some(
          (a) => a.kind === "escalate" && a.field === "phone",
        );
        if (r.email !== undefined && !escalatedInEmail) {
          expect(isEmailShaped(r.email)).toBe(true);
        }
        if (r.phone !== undefined && !escalatedInPhone) {
          expect(isPhoneShaped(r.phone)).toBe(true);
        }
        // An escalated-in-place value equals the ORIGINAL input for that field
        // (preserved verbatim, never moved/overwritten).
        if (escalatedInEmail) {
          expect(r.email).toBe((emailIn as string).trim());
        }
        if (escalatedInPhone) {
          expect(r.phone).toBe((phoneIn as string).trim());
        }

        // ── (2) Anything in a target field that was MOVED there came via a
        //        legitimate two-sided move (positive-for-target,
        //        negative-for-source). Verify each move's geometry. ──────────
        for (const a of r.healActions) {
          if (a.kind === "move") {
            movesSeen++;
            // source value was shape-NEGATIVE for its source field …
            if (a.from === "email") {
              expect(isEmailShaped(a.value)).toBe(false);
            } else {
              expect(isPhoneShaped(a.value)).toBe(false);
            }
            // … and shape-POSITIVE for its target field …
            if (a.to === "phone") {
              expect(isPhoneShaped(a.value)).toBe(true);
              expect(r.phone).toBe(a.value);
            } else {
              expect(isEmailShaped(a.value)).toBe(true);
              expect(r.email).toBe(a.value);
            }
          } else if (a.kind === "escalate") {
            escalatesSeen++;
          } else if (a.kind === "drop") {
            dropsSeen++;
            // a drop is always a NEITHER value
            expect(isNeither(a.value)).toBe(true);
          }
        }

        // ── (4) No fabrication: every output value is one of the two inputs. ─
        const inputs = [
          typeof emailIn === "string" ? emailIn.trim() : undefined,
          typeof phoneIn === "string" ? phoneIn.trim() : undefined,
        ];
        if (r.email !== undefined) expect(inputs).toContain(r.email);
        if (r.phone !== undefined) expect(inputs).toContain(r.phone);

        // ── (5) Never overwrite: if BOTH fields held a valid value of their
        //        own type, the output equals the input exactly, no actions. ──
        if (emailInShape === "EMAIL" && phoneInShape === "PHONE") {
          expect(r.email).toBe((emailIn as string).trim());
          expect(r.phone).toBe((phoneIn as string).trim());
          expect(r.healActions).toEqual([]);
        }
      }
    }

    // Sanity: the product actually exercised each branch.
    expect(movesSeen).toBeGreaterThan(0);
    expect(escalatesSeen).toBeGreaterThan(0);
    expect(dropsSeen).toBeGreaterThan(0);
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
