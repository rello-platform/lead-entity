"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.PHONE_DIGIT_FLOOR = exports.EMAIL_SHAPE_REGEX = exports.isNeither = exports.isPhoneShaped = exports.isEmailShaped = exports.normalizeContactFields = exports.ENTITY_TYPES = void 0;
exports.normalizeEntityName = normalizeEntityName;
exports.normalizeOwnerGroupKey = normalizeOwnerGroupKey;
exports.classifyEntityType = classifyEntityType;
exports.shouldRequireSkipTrace = shouldRequireSkipTrace;
exports.ENTITY_TYPES = [
    "INDIVIDUAL",
    "LLC",
    "PARTNERSHIP",
    "TRUST",
    "CORPORATION",
    "OTHER",
];
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
function normalizeEntityName(raw) {
    if (typeof raw !== "string") {
        throw new TypeError("normalizeEntityName: input must be a non-null string");
    }
    let s = raw.toLowerCase();
    s = s.replace(/&/g, " and ");
    s = s.replace(/[.,]/g, " ");
    s = s.replace(/\s+/g, " ").trim();
    if (s.startsWith("the ")) {
        s = s.slice(4);
    }
    s = s.replace(/\b(revocable|irrevocable|living|family)?\s*trust\b/g, (_match, qualifier) => {
        return qualifier === "family" ? "family trust" : "trust";
    });
    s = s.replace(/\blimited\s+liability\s+(company|co)\b/g, "llc");
    s = s.replace(/\bl\s+l\s+c\b/g, "llc");
    s = s.replace(/\bl\.l\.c\.?/g, "llc");
    s = s.replace(/\b(limited\s+partnership|ltd\s+partnership|limited\s+ptnrship|ltd\s+ptnrship|l\s+p)\b/g, "lp");
    s = s.replace(/\b(incorporated|incorp)\b/g, "inc");
    s = s.replace(/\bcorporation\b/g, "corp");
    s = s.replace(/\s+/g, " ").trim();
    return s;
}
/**
 * Name suffixes stripped from the LAST name before it enters the owner-group
 * key, so "Dorsey Jr" and "Dorsey" produce the SAME key (a person and their
 * own Jr/Sr/III variant across county records group as one owner). Mirrors the
 * Harvest-Home column-mapper NAME_SUFFIXES set verbatim; kept LOCAL here so the
 * package stays a pure, zero-HH-dependency module that both HH (intake/BYOL
 * dedup) and Rello (the P3 owner-grouping backfill) import as the single source.
 */
const OWNER_GROUP_NAME_SUFFIXES = new Set([
    "jr", "sr", "ii", "iii", "iv", "v",
    "jr.", "sr.", "esq", "esq.", "md", "phd", "dds", "do",
]);
/**
 * Strip trailing name suffixes (Jr/Sr/III/…) from a last-name string, returning
 * the cleaned remainder. Pure + self-contained (no import from HH). Never strips
 * the only token: "Jr" → "Jr" (a row whose last name is literally a suffix is
 * not a real owner name and the caller's blank/initials guard handles it).
 */
function stripOwnerNameSuffix(name) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    while (parts.length > 1 &&
        OWNER_GROUP_NAME_SUFFIXES.has(parts[parts.length - 1].replace(/\.$/, "").toLowerCase())) {
        parts.pop();
    }
    return parts.join(" ");
}
/**
 * Normalize ONE address/name component to a stable token: lowercase, expand
 * `&` → " and ", strip punctuation, collapse internal whitespace, trim. Mirrors
 * the punctuation/case discipline of {@link normalizeEntityName} so the
 * owner-group key sorts in the same canonical space as the entity key.
 */
function normalizeOwnerComponent(raw) {
    return raw
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
/**
 * Returns `true` when a name token is blank or initials-only (a single letter,
 * optionally with a trailing period). Such rows must NOT group — grouping on a
 * blank or single-initial name would collapse unrelated owners into one lead.
 */
function isBlankOrInitial(token) {
    const t = token.trim().replace(/\.$/, "");
    return t.length <= 1;
}
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
function normalizeOwnerGroupKey(firstName, lastName, mailingAddress) {
    const first = typeof firstName === "string" ? firstName.trim() : "";
    const lastRaw = typeof lastName === "string" ? lastName.trim() : "";
    const mailing = typeof mailingAddress === "string" ? mailingAddress.trim() : "";
    if (!first || isBlankOrInitial(first))
        return null;
    if (!lastRaw)
        return null;
    const lastClean = stripOwnerNameSuffix(lastRaw);
    if (!lastClean || isBlankOrInitial(lastClean))
        return null;
    // A last name that is ITSELF nothing but a bare suffix token ("Jr", "III")
    // is not a real owner name — stripOwnerNameSuffix won't strip the sole token,
    // so guard it here so such rows do NOT group.
    if (OWNER_GROUP_NAME_SUFFIXES.has(lastClean.replace(/\.$/, "").toLowerCase())) {
        return null;
    }
    if (!mailing)
        return null;
    const firstNorm = normalizeOwnerComponent(first);
    const lastNorm = normalizeOwnerComponent(lastClean);
    const mailingNorm = normalizeOwnerComponent(mailing);
    if (!firstNorm || !lastNorm || !mailingNorm)
        return null;
    return `${firstNorm}|${lastNorm}|${mailingNorm}`;
}
const CLASSIFIER_RULES = [
    {
        pattern: /\b(llc|l\.l\.c\.?|l\s+l\s+c|limited\s+liability\s+(company|co))\b/,
        type: "LLC",
    },
    {
        pattern: /\b(limited\s+partnership|ltd\s+partnership|limited\s+ptnrship|ltd\s+ptnrship|family\s+limited\s+partnership|l\s+p|lp)\b/,
        type: "PARTNERSHIP",
    },
    {
        pattern: /\btrust\b/,
        type: "TRUST",
    },
    {
        pattern: /\b(incorporated|incorp|inc|corporation|corp|company|co)\b/,
        type: "CORPORATION",
    },
    {
        pattern: /\b(foundation|holdings|group|enterprise|enterprises)\b/,
        type: "OTHER",
    },
];
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
function classifyEntityType(rawName) {
    if (typeof rawName !== "string") {
        throw new TypeError("classifyEntityType: input must be a non-null string");
    }
    const haystack = rawName
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[.,]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (haystack === "") {
        return "INDIVIDUAL";
    }
    for (const rule of CLASSIFIER_RULES) {
        if (rule.pattern.test(haystack)) {
            return rule.type;
        }
    }
    return "INDIVIDUAL";
}
/**
 * Pure function. Returns true when the entity is non-INDIVIDUAL AND no
 * contact human has been attached to the lead. Used to set
 * Lead.requiresSkipTrace at write-time.
 *
 * Inputs intentionally narrow — the function does not consult the DB; the
 * caller passes what they have.
 */
function shouldRequireSkipTrace(input) {
    if (input.entityType === "INDIVIDUAL") {
        return false;
    }
    return !input.hasContactHuman;
}
// Shape-based contact-field normalizer (Self-Healing Import Validation, Layer 2).
// Re-exported from the root for discoverability; the canonical subpath is
// `@rello-platform/lead-entity/normalize` (mirrors `./contracts`). See
// `src/normalize.ts` for the W-01 two-sided safety rule.
var normalize_1 = require("./normalize");
Object.defineProperty(exports, "normalizeContactFields", { enumerable: true, get: function () { return normalize_1.normalizeContactFields; } });
Object.defineProperty(exports, "isEmailShaped", { enumerable: true, get: function () { return normalize_1.isEmailShaped; } });
Object.defineProperty(exports, "isPhoneShaped", { enumerable: true, get: function () { return normalize_1.isPhoneShaped; } });
Object.defineProperty(exports, "isNeither", { enumerable: true, get: function () { return normalize_1.isNeither; } });
Object.defineProperty(exports, "EMAIL_SHAPE_REGEX", { enumerable: true, get: function () { return normalize_1.EMAIL_SHAPE_REGEX; } });
Object.defineProperty(exports, "PHONE_DIGIT_FLOOR", { enumerable: true, get: function () { return normalize_1.PHONE_DIGIT_FLOOR; } });
