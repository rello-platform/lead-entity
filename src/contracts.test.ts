// ============================================================================
// @rello-platform/lead-entity/contracts — SOT-side contract test.
//
// REGRESSION-LOCK (Pillar 5, Kelly LOCKED 2026-06-19 ANSWERS D2) on the
// already-shipped Rello CONTACT-LESS-LEAD-CREATE-400 fix. This is the
// package-side half of the cross-repo contract: it pins the shared
// `createLeadContactContract` + the tolerant email/phone preprocessors that
// Rello composes and HH constructs payloads against. Both consumer repos run
// their own `*.contract.test.ts` against this same SOT.
//
// Two assertion directions, both required:
//   (A) Every legitimate fixture PASSES `safeParse` — incl. the contact-less
//       entity lead that caused the original production 400. Locks the fix in.
//   (B) Genuinely-invalid input still REJECTS — the schema did NOT go permissive
//       (a non-empty non-email still fails; an over-long phone still fails; an
//       empty INDIVIDUAL still fails; entity-shape category errors still fail).
// ============================================================================

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  createLeadContactContract,
  tolerantOptionalEmail,
  tolerantOptionalPhone,
  emptyToUndefined,
} from "./contracts";

describe("emptyToUndefined", () => {
  it("collapses '' and null to undefined, passes everything else through", () => {
    expect(emptyToUndefined("")).toBeUndefined();
    expect(emptyToUndefined(null)).toBeUndefined();
    expect(emptyToUndefined(undefined)).toBeUndefined();
    expect(emptyToUndefined("a@b.com")).toBe("a@b.com");
    expect(emptyToUndefined("0")).toBe("0");
    expect(emptyToUndefined(0)).toBe(0); // not "" / null — passes through
  });
});

describe("tolerantOptionalEmail — the regression-lock core", () => {
  it("ACCEPTS the 'no value' sentinels by omitting (null / '' / undefined)", () => {
    // The exact production-400 trigger: a literal `null` on the wire.
    expect(tolerantOptionalEmail.safeParse(null).success).toBe(true);
    expect(tolerantOptionalEmail.safeParse("").success).toBe(true);
    expect(tolerantOptionalEmail.safeParse(undefined).success).toBe(true);
    // null/"" normalize to undefined (omitted), never a stored empty string.
    expect(tolerantOptionalEmail.parse(null)).toBeUndefined();
    expect(tolerantOptionalEmail.parse("")).toBeUndefined();
  });

  it("ACCEPTS a real email", () => {
    expect(tolerantOptionalEmail.parse("jane@example.com")).toBe(
      "jane@example.com",
    );
  });

  it("REJECTS a non-empty non-email (real validation NOT loosened)", () => {
    expect(tolerantOptionalEmail.safeParse("not-an-email").success).toBe(false);
    expect(tolerantOptionalEmail.safeParse("nope@").success).toBe(false);
  });
});

describe("tolerantOptionalPhone — the regression-lock core", () => {
  it("ACCEPTS the 'no value' sentinels by omitting (null / '' / undefined)", () => {
    expect(tolerantOptionalPhone.safeParse(null).success).toBe(true);
    expect(tolerantOptionalPhone.safeParse("").success).toBe(true);
    expect(tolerantOptionalPhone.safeParse(undefined).success).toBe(true);
    expect(tolerantOptionalPhone.parse(null)).toBeUndefined();
  });

  it("ACCEPTS a normal phone", () => {
    expect(tolerantOptionalPhone.parse("8015550142")).toBe("8015550142");
  });

  it("ACCEPTS an ABSENT key inside a z.object (cross-zod-minor robustness)", () => {
    // zod 4.4.x regressed `z.preprocess(fn, inner.optional())` to reject an
    // absent key in a z.object; the outer `.optional()` keeps it passing on
    // every zod 4.x. Lock that here at the primitive level.
    const obj = z.object({ phone: tolerantOptionalPhone });
    expect(obj.safeParse({}).success).toBe(true);
    const objE = z.object({ email: tolerantOptionalEmail });
    expect(objE.safeParse({}).success).toBe(true);
  });

  it("REJECTS an over-long phone (>20 chars)", () => {
    expect(
      tolerantOptionalPhone.safeParse("1".repeat(21)).success,
    ).toBe(false);
  });
});

describe("createLeadContactContract — (A) legitimate payloads PASS", () => {
  it("contact-less entity lead (THE original-400 case): no names, null email+phone, entityName set", () => {
    // Wire shape: entity leads omit firstName/lastName (HH's createLead chokepoint
    // drops null/"" names) and carry the entityName; email+phone arrive as the
    // literal `null` that JSON.stringify preserves — the exact production-400
    // trigger the shipped fix made acceptable.
    const r = createLeadContactContract.safeParse({
      entityType: "PARTNERSHIP",
      entityName: "Bastow Family Limited Partnership",
      email: null,
      phone: null,
    });
    expect(r.success).toBe(true);
  });

  it("contact-less INDIVIDUAL lead: names present, null email+phone (cold/skip-trace)", () => {
    const r = createLeadContactContract.safeParse({
      firstName: "Jane",
      lastName: "Doe",
      email: null,
      phone: null,
    });
    expect(r.success).toBe(true);
  });

  it("normal contactable INDIVIDUAL lead", () => {
    const r = createLeadContactContract.safeParse({
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      phone: "8015550142",
    });
    expect(r.success).toBe(true);
  });

  it("LLC entity lead with a contact human attached", () => {
    const r = createLeadContactContract.safeParse({
      entityType: "LLC",
      entityName: "Smith Holdings LLC",
      email: "manager@smithholdings.com",
    });
    expect(r.success).toBe(true);
  });

  it("call-mode minimum-to-save: phone only (≥7 digits), no names", () => {
    const r = createLeadContactContract.safeParse({ phone: "8015550142" });
    expect(r.success).toBe(true);
  });

  it("call-mode minimum-to-save: first name only", () => {
    const r = createLeadContactContract.safeParse({ firstName: "Jane" });
    expect(r.success).toBe(true);
  });

  it("empty-string email/phone (dropdown defaults) PASS by omission", () => {
    const r = createLeadContactContract.safeParse({
      firstName: "Jane",
      lastName: "Doe",
      email: "",
      phone: "",
    });
    expect(r.success).toBe(true);
  });

  it("passthrough: a producer payload with extra (non-contact) fields still PASSES", () => {
    const r = createLeadContactContract.safeParse({
      firstName: "Jane",
      lastName: "Doe",
      email: null,
      phone: null,
      source: "harvest-home",
      score: 85,
      customFields: { hh_source_app: "harvest_home" },
    });
    expect(r.success).toBe(true);
  });
});

describe("createLeadContactContract — (B) invalid payloads still REJECT", () => {
  it("non-empty non-email email REJECTS", () => {
    const r = createLeadContactContract.safeParse({
      firstName: "Jane",
      lastName: "Doe",
      email: "not-an-email",
    });
    expect(r.success).toBe(false);
  });

  it("over-long phone REJECTS", () => {
    const r = createLeadContactContract.safeParse({
      firstName: "Jane",
      lastName: "Doe",
      phone: "1".repeat(21),
    });
    expect(r.success).toBe(false);
  });

  it("truly-empty INDIVIDUAL (no names, no phone, no contact) REJECTS", () => {
    const r = createLeadContactContract.safeParse({
      email: null,
      phone: null,
    });
    expect(r.success).toBe(false);
  });

  it("non-INDIVIDUAL entityType WITHOUT entityName REJECTS", () => {
    const r = createLeadContactContract.safeParse({
      entityType: "LLC",
      email: "x@y.com",
    });
    expect(r.success).toBe(false);
  });

  it("INDIVIDUAL lead carrying an entityName REJECTS (category error)", () => {
    const r = createLeadContactContract.safeParse({
      firstName: "Jane",
      lastName: "Doe",
      entityName: "Should Not Be Here LLC",
    });
    expect(r.success).toBe(false);
  });

  it("unknown entityType value REJECTS", () => {
    const r = createLeadContactContract.safeParse({
      entityType: "SOLE_PROP",
      entityName: "X",
    });
    expect(r.success).toBe(false);
  });

  it("a literal null firstName REJECTS — names are NOT tolerant (only email/phone are)", () => {
    // Deliberate asymmetry locked to Rello's shipped createLeadSchema: the
    // contact fix made EMAIL/PHONE tolerant of null (cold leads), NOT the name
    // fields. The producer chokepoint (HH rello-client normalizeStr) is
    // responsible for omitting null/"" names BEFORE the wire; the contract holds
    // Rello's exact shipped name behavior so a future "make names tolerant too"
    // drift is a deliberate, reviewed change, not an accident.
    const r = createLeadContactContract.safeParse({
      firstName: null,
      lastName: "Doe",
      email: "jane@example.com",
    });
    expect(r.success).toBe(false);
  });
});
