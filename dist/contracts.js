"use strict";
/**
 * @rello-platform/lead-entity/contracts — the shared inter-app `createLead`
 * CONTACT-shape contract (SOT for the contact-less-lead acceptance behavior).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS LIVES HERE (Pillar 5 — inter-app contract tests, regression-lock)
 * ────────────────────────────────────────────────────────────────────────────
 * The CONTACT-LESS-LEAD-CREATE-400 fix is ALREADY SHIPPED + LIVE in Rello
 * (`src/lib/leads/validation.ts` — `tolerantOptionalEmail` / `tolerantOptionalPhone`
 * on `createLeadSchema`). It made contact-less leads (cold / Flueid leads awaiting
 * skip-trace: no email AND no phone yet) createable, after a literal `null` on the
 * wire produced a production 400 (`INVALID_DATA / invalid_union / "expected
 * string, received null"`) that bounced EVERY contact-less push (28 HOT IDG leads
 * + the BYOL non-IDG path) for the entire incident window.
 *
 * This module is the REGRESSION-LOCK on that shipped fix — NOT a forward-fix
 * (Kelly LOCKED 2026-06-19, ANSWERS D2). It promotes the load-bearing acceptance
 * primitives (the tolerant email/phone preprocessors) out of Rello-local into the
 * canonical owner of the Lead-shape (`@rello-platform/lead-entity`), so:
 *
 *   - Rello imports the preprocessors FROM this package and composes them into its
 *     full `createLeadSchema` (Rule E — no local redeclare; the tolerant shape is
 *     no longer duplicated in Rello-local source).
 *   - Both Rello and Harvest-Home run a `*.contract.test.ts` that round-trips the
 *     producer's representative payloads (incl. the contact-less entity lead) through
 *     this contract's `safeParse` and asserts they PASS, AND asserts genuinely-invalid
 *     input still REJECTS — so a future edit that re-breaks the contact-less case
 *     (or one that loosens away real validation) fails the push in BOTH repos.
 *
 * SCOPE — deliberately the CONTACT shape, not the whole Rello create payload. The
 * full Rello `createLeadSchema` carries ~40 Rello-app-specific fields wired to
 * Rello-local modules (`@rello-platform/slugs`, the Prisma `LicenseType` enum, the
 * attribution-channel + tag-category vocabularies). Dragging those into a pure,
 * dependency-light shared package would invert the dependency graph and break the
 * package's "pure functions, no app coupling" charter. The regression-lock target
 * is the contact-less / entity-lead acceptance behavior, and THAT is fully
 * expressible from primitives this package already owns (`ENTITY_TYPES`) plus zod.
 * Rello's full schema continues to own its app-specific fields and COMPOSES the
 * shared contact primitives exported here.
 *
 * PURITY — zod is a `peerDependency` (every consumer already pins zod ^4); this
 * module imports `zod` only, no Rello/HH app modules, no I/O, no side effects.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createLeadContactContract = exports.tolerantOptionalPhone = exports.tolerantOptionalEmail = exports.emptyToUndefined = void 0;
const zod_1 = require("zod");
const index_1 = require("./index");
// ── Tolerant "no value" sentinels ────────────────────────────────────────────
/**
 * Treat `""` / `null` as "field not provided" (`undefined`) before an inner parse.
 *
 * Spoke writers (Harvest-Home BYOL + IDG, and any spoke that maps a nullable DB
 * column straight onto the payload) serialize a literal `null` for an absent
 * contact field. `JSON.stringify` PRESERVES `null` (only `undefined` keys are
 * dropped), so a `null` reaches the schema on the wire. This normalizer collapses
 * both "no value" sentinels to `undefined` BEFORE the inner parse so an absent
 * value is simply omitted — never a 400 — while a genuinely-malformed value still
 * falls through to the inner validator and is rejected.
 */
const emptyToUndefined = (v) => v === "" || v === null ? undefined : v;
exports.emptyToUndefined = emptyToUndefined;
/**
 * Optional email that tolerates `null` / `""` (→ omitted) while STILL rejecting a
 * non-empty non-email string. The exact shape shipped in Rello's
 * `validation.ts` (`tolerantOptionalEmail`), promoted here as the SOT.
 *
 * Locked behavior (the regression-lock surface):
 *   - `undefined` / `null` / `""`        → omitted (no `email` key), PASS
 *   - a valid email (`a@b.com`)          → kept, PASS
 *   - a non-empty non-email (`"nope"`)   → REJECT (we do NOT loosen real validation)
 */
exports.tolerantOptionalEmail = zod_1.z.preprocess(exports.emptyToUndefined, zod_1.z.string().email("Invalid email").optional());
/**
 * Optional ≤20-char phone that tolerates `null` / `""` (→ omitted) while STILL
 * rejecting an over-long value. The exact shape shipped in Rello's
 * `validation.ts` (`tolerantOptionalPhone`), promoted here as the SOT.
 *
 * Locked behavior:
 *   - `undefined` / `null` / `""`        → omitted, PASS
 *   - a ≤20-char string (`"8015550142"`) → kept, PASS
 *   - a >20-char string                  → REJECT
 */
exports.tolerantOptionalPhone = zod_1.z.preprocess(exports.emptyToUndefined, zod_1.z.string().max(20).optional());
// ── The contact-shape contract ───────────────────────────────────────────────
const entityTypeEnum = zod_1.z.enum(index_1.ENTITY_TYPES);
/**
 * `createLeadContactContract` — the shared, inter-app contract for the CONTACT +
 * entity-shape subset of a `createLead` payload. This is the slice of the full
 * Rello `createLeadSchema` that the CONTACT-LESS-LEAD-CREATE-400 fix governs, and
 * the slice every producer (HH BYOL/IDG, and future spokes) must satisfy.
 *
 * It is `.passthrough()` (NOT `.strict()`): a producer payload carries many more
 * fields than the contact shape (HH sends `source`, `score`, `customFields`, …),
 * and the contract's job is to lock the CONTACT-shape acceptance behavior, not to
 * police the full field set — that is Rello's full `createLeadSchema`'s job. A
 * contract that rejected unknown keys would fail every real producer fixture for
 * the wrong reason.
 *
 * Fields:
 *   - firstName / lastName : optional ≤100 (entity creates carry `entityName` instead;
 *                            INDIVIDUAL person-shape requireds enforced by the refine).
 *   - email / phone        : the tolerant preprocessors above — the regression-lock core.
 *   - entityType           : optional `EntityType` (absent ⇒ INDIVIDUAL semantics).
 *   - entityName           : optional ≤200 (raw entity display string).
 *
 * Cross-field invariants (mirrors Rello `createLeadSchema`'s entity refines — the
 * person-shape vs entity-shape category rules that bound the contact fix):
 *   1. INDIVIDUAL (or absent entityType): valid with BOTH names, OR a phone with
 *      ≥7 digits, OR a non-empty first name (the NEW-LEAD-CALL-RE-INTAKE call-mode
 *      minimum-to-save). A truly empty INDIVIDUAL create is still rejected.
 *   2. non-INDIVIDUAL entityType: `entityName` must be non-empty.
 *   3. INDIVIDUAL (or absent): `entityName` must be omitted (entity-name on a
 *      person-shaped lead is a write-time category error).
 */
exports.createLeadContactContract = zod_1.z
    .object({
    firstName: zod_1.z.string().max(100).optional(),
    lastName: zod_1.z.string().max(100).optional(),
    email: exports.tolerantOptionalEmail,
    phone: exports.tolerantOptionalPhone,
    entityType: entityTypeEnum.optional(),
    entityName: zod_1.z.string().max(200).optional(),
})
    .passthrough()
    // 1. INDIVIDUAL (or absent) — both names, OR phone ≥7 digits, OR a first name.
    .refine((data) => {
    if (data.entityType && data.entityType !== "INDIVIDUAL")
        return true;
    const hasFirst = typeof data.firstName === "string" && data.firstName.trim().length > 0;
    const hasLast = typeof data.lastName === "string" && data.lastName.trim().length > 0;
    if (hasFirst && hasLast)
        return true;
    const phoneDigits = typeof data.phone === "string" ? data.phone.replace(/\D/g, "") : "";
    if (phoneDigits.length >= 7)
        return true;
    if (hasFirst)
        return true;
    return false;
}, {
    message: "Provide a first and last name, or at least a phone number or first name, for INDIVIDUAL leads.",
    path: ["firstName"],
})
    // 2. non-INDIVIDUAL requires a non-empty entityName.
    .refine((data) => {
    if (!data.entityType || data.entityType === "INDIVIDUAL")
        return true;
    return (typeof data.entityName === "string" && data.entityName.trim().length > 0);
}, {
    message: "entityName is required when entityType is not INDIVIDUAL.",
    path: ["entityName"],
})
    // 3. INDIVIDUAL (or absent) must omit entityName.
    .refine((data) => {
    if (data.entityType && data.entityType !== "INDIVIDUAL")
        return true;
    return data.entityName === undefined || data.entityName === null;
}, {
    message: "entityName must be omitted for INDIVIDUAL leads.",
    path: ["entityName"],
});
