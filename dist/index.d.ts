/**
 * @rello-platform/lead-entity — entity-shape classifier + normalizer for
 * Rello Lead identity. Pure functions, no side effects, no I/O. Consumed by
 * Harvest-Home write paths (BYOL commit, universal intake, merge-apply),
 * Rello write paths (createLead validation + write-time fill), and the
 * Phase 7 backfill script. Single source of truth for entity-name
 * normalization across the platform.
 *
 * See LEAD-ENTITY-TYPE.md (RELLO TO BE BUILT) for the full design rationale,
 * locked decisions, and the worked-example trace through the Bastow Family
 * Limited Partnership case.
 */
export declare const ENTITY_TYPES: readonly ["INDIVIDUAL", "LLC", "PARTNERSHIP", "TRUST", "CORPORATION", "OTHER"];
export type EntityType = (typeof ENTITY_TYPES)[number];
/**
 * Pure function. Lowercases, strips punctuation, trims whitespace, and
 * canonicalizes common entity-suffix abbreviations:
 *   "limited partnership" / "lp" / "ltd partnership" / "limited ptnrship" → "lp"
 *   "limited liability company" / "llc" / "l.l.c." / "l l c" → "llc"
 *   "incorporated" / "inc" / "incorp" → "inc"
 *   "corporation" / "corp" → "corp"
 *   "trust" → "trust"
 *   "family trust" / "living trust" / "revocable trust" / "irrevocable trust" → "trust"
 *
 * Punctuation: strip `.`, `,`; expand `&` to " and ".
 * The "&" → "and" expansion canonicalizes "Smith & Sons" → "smith and sons".
 *
 * Trailing/leading "the " is stripped ("The Smith Family Trust" → "smith family trust").
 *
 * Used as the dedup key for non-INDIVIDUAL leads. Tenant-scoped.
 *
 * @throws TypeError when raw is not a string.
 */
export declare function normalizeEntityName(raw: string): string;
/**
 * Pure function. Computes the address-independent INDIVIDUAL-owner grouping key
 * used to collapse one person's N county parcels onto a single owner-lead
 * (mirroring how the entity key at {@link normalizeEntityName} collapses
 * "X Investments LLC"). The key is:
 *
 *   normalize(firstName) | normalize(stripSuffix(lastName)) | normalize(mailingAddress)
 *
 * keyed on NAME + NORMALIZED MAILING ADDRESS (W-01 lock 2026-06-24) — NOT the
 * property address (property address IN the key was the split cause), NOT name
 * alone (name-alone over-merges different people).
 *
 * Returns `null` — meaning "this row does NOT group, treat as its own lead" —
 * when ANY of:
 *   - firstName is blank or initials-only (single letter ± trailing dot),
 *   - lastName (after suffix strip) is blank or initials-only,
 *   - mailingAddress is absent / blank / normalizes to empty.
 *
 * Guarding all three prevents collapsing no-name or no-mailing rows into one
 * lead. Null/undefined/non-string inputs are treated as absent (no throw — this
 * runs on the write path for every individual lead; a malformed value must
 * degrade to "ungroupable", never abort the create).
 *
 * @param firstName      owner first name (from the split person name)
 * @param lastName       owner last name (suffix stripped internally)
 * @param mailingAddress the owner's mailing address — pre-formatted single
 *                       string (street + city/state/zip), e.g. the
 *                       column-mapper's mailAddress/mailCity/mailState/mailZip
 *                       joined. Callers MUST source this from the same mapping
 *                       seam (no hardcoded header names).
 */
export declare function normalizeOwnerGroupKey(firstName: string | null | undefined, lastName: string | null | undefined, mailingAddress: string | null | undefined): string | null;
/**
 * Pure function. Inspects the raw name and returns the EntityType.
 * Order of checks (first match wins):
 *   1. LLC suffix variants → LLC
 *   2. Limited Partnership / LP / Family Limited Partnership → PARTNERSHIP
 *   3. Trust / Family Trust / Living Trust / Revocable Trust / Irrevocable Trust → TRUST
 *   4. Inc / Incorporated / Corporation / Corp / Co. → CORPORATION
 *   5. Foundation / Holdings / Group / Enterprise (no other suffix) → OTHER
 *   6. None of the above → INDIVIDUAL
 *
 * Locked: "John Smith LLC" classifies as LLC (not INDIVIDUAL with a side note).
 * The "human inside the entity wrapper" is downstream skip-trace work.
 *
 * @throws TypeError when rawName is not a string.
 */
export declare function classifyEntityType(rawName: string): EntityType;
/**
 * Pure function. Returns true when the entity is non-INDIVIDUAL AND no
 * contact human has been attached to the lead. Used to set
 * Lead.requiresSkipTrace at write-time.
 *
 * Inputs intentionally narrow — the function does not consult the DB; the
 * caller passes what they have.
 */
export declare function shouldRequireSkipTrace(input: {
    entityType: EntityType;
    hasContactHuman: boolean;
}): boolean;
export { normalizeContactFields, isEmailShaped, isPhoneShaped, isNeither, EMAIL_SHAPE_REGEX, PHONE_DIGIT_FLOOR, type HealAction, type ContactField, type ValueShape, type NormalizeContactInput, type NormalizeContactResult, } from "./normalize";
//# sourceMappingURL=index.d.ts.map