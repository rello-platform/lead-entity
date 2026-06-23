# @rello-platform/lead-entity

Pure-function entity-shape classifier and name normalizer for Rello `Lead` identity. Single source of truth consumed by Harvest-Home write paths (BYOL commit, universal intake, merge-apply), Rello write paths (`createLead` validation + write-time fill), and the Phase 7 backfill script.

No runtime dependencies. No I/O. No LLM calls. Lock #13 from `LEAD-ENTITY-TYPE.md` requires the classifier to remain a pure function — Anthropic-driven classification, if ever needed, lives in a separate package.

## What lives here

- **`EntityType`** — the six-value union identifying a Lead's structural identity shape (`INDIVIDUAL`, `LLC`, `PARTNERSHIP`, `TRUST`, `CORPORATION`, `OTHER`). Mirrored to a Prisma enum on Rello and a `String` column on Harvest-Home.
- **`ENTITY_TYPES`** — the same union as a `readonly` tuple, for runtime iteration (Zod enum, dropdown values, etc.).
- **`classifyEntityType(rawName)`** — first-match-wins dispatch over an ordered ruleset (LLC → PARTNERSHIP → TRUST → CORPORATION → OTHER → INDIVIDUAL fallthrough). The `INDIVIDUAL` default is what every empty/unrecognized input collapses to.
- **`normalizeEntityName(raw)`** — case-folds, strips punctuation, expands `&` to `and`, drops a leading `the `, canonicalizes abbreviation drift (`Limited Partnership` / `Ltd Partnership` / `LP` / `L.P.` all → `lp`; `Limited Liability Company` / `LLC` / `L.L.C.` / `L L C` all → `llc`; `Incorporated` / `Incorp` → `inc`; `Corporation` → `corp`; `Living` / `Revocable` / `Irrevocable` qualifiers on `Trust` are stripped while `Family Trust` is preserved). Used as the dedup key for non-`INDIVIDUAL` leads, scoped per-tenant.
- **`shouldRequireSkipTrace({ entityType, hasContactHuman })`** — pure boolean for the `Lead.requiresSkipTrace` write-time queue flag. Returns `true` only when the entity is non-`INDIVIDUAL` and no contact human has been attached. The actual skip-trace workflow (BatchData call, contact-person linkage, billing) is downstream scope; this package only computes the queue flag.

## Worked example — the Bastow case

Two CSV rows arrive at Harvest-Home BYOL upload:

```
firstName: "Bastow Family Limited Partnership", lastName: "", email: "<MLO-attached>"
firstName: "Bastow Family Ltd Partnership",     lastName: "", email: "<MLO-attached>"
```

Both classify and normalize to the same dedup key, so a single `Lead` row gets written for the partnership instead of two fragmented rows:

```ts
import {
  classifyEntityType,
  normalizeEntityName,
} from "@rello-platform/lead-entity";

classifyEntityType("Bastow Family Limited Partnership"); // "PARTNERSHIP"
classifyEntityType("Bastow Family Ltd Partnership");     // "PARTNERSHIP"

normalizeEntityName("Bastow Family Limited Partnership"); // "bastow family lp"
normalizeEntityName("Bastow Family Ltd Partnership");     // "bastow family lp"
```

The HH BYOL commit transactional path uses the normalized name as the advisory-lock key (per `LEAD-ENTITY-TYPE.md` Phase 4) and as the `(tenantId, entityNameNormalized)` dedup lookup key, ensuring concurrent uploads of the same partnership across name variants resolve to one Rello `Lead`.

## The `createLead` contact contract (`/contracts` subpath, v0.2.0+)

`@rello-platform/lead-entity/contracts` is the **shared inter-app SOT for the `createLead` CONTACT-shape contract** — the regression-lock for the already-shipped Rello `CONTACT-LESS-LEAD-CREATE-400` fix (Pillar 5 of `PLATFORM-DURABLE-BULK-OPERATION-FRAMEWORK`; Kelly LOCKED 2026-06-19, ANSWERS D2). It is a regression-lock on live behavior, **not** a forward-fix.

```ts
import {
  createLeadContactContract, // zod schema: contact + entity-shape slice of createLead
  tolerantOptionalEmail,     // null/"" → omitted; non-empty non-email → reject
  tolerantOptionalPhone,     // null/"" → omitted; >20 chars → reject
  emptyToUndefined,          // the "no value" sentinel collapse
} from "@rello-platform/lead-entity/contracts";
```

- **Rello** imports `tolerantOptionalEmail` / `tolerantOptionalPhone` from here and composes them into its full `createLeadSchema` (Rule E — no local redeclare); its `createLead.contract.test.ts` round-trips fixtures through the full schema.
- **Harvest-Home** constructs `createLead` payloads to this contract and runs a `createLead.contract.test.ts` against a production-anchored fixture corpus (incl. the contact-less entity lead that caused the original 400).
- Both repos assert: **legitimate fixtures PASS** (the fix stays live) AND **genuinely-invalid input still REJECTS** (the schema didn't go permissive).

`zod` is a `peerDependency` (`^4.0.0`) — consumers already pin zod ^4; the package adds no zod runtime weight of its own. The pure classifier/normalizer surface (above) carries no runtime deps and is unaffected.

## The shape-based contact-field normalizer (`/normalize` subpath, v0.3.0+)

`@rello-platform/lead-entity/normalize` is **Layer 2 of Self-Healing Import Validation** — a pure, deterministic function that routes each contact value to the field its *shape* belongs to, regardless of which source column it arrived in, BEFORE the contract validates. It is the fix for the ClearPath 300-lead import incident: a source CSV with the `email`/`phone` columns swapped (email column held a Utah phone, phone column held the city "Sandy") was silently dead-lettered. The shape makes the correct field unambiguous, so the platform repairs it instead of throwing it away.

```ts
import {
  normalizeContactFields, // ({ email?, phone?, ...rest }) → { email?, phone?, healActions }
  isEmailShaped,          // matches /^[^\s@]+@[^\s@]+\.[^\s@]+$/ (the import.ts / contract regex)
  isPhoneShaped,          // ≥7 digits after stripping non-digits AND no "@" (the contract floor)
  isNeither,              // present, non-contact value (e.g. a city)
  type HealAction,        // { kind: "move" | "drop" | "escalate", ... } — for the transparency banner
} from "@rello-platform/lead-entity/normalize";

normalizeContactFields({ email: "8015551234", phone: "Sandy" });
// → { phone: "8015551234", healActions: [
//      { kind: "move", from: "email", to: "phone", value: "8015551234", valueShape: "PHONE" },
//      { kind: "drop", from: "phone", value: "Sandy", valueShape: "NEITHER" },
//    ] }   (email column's phone healed to phone; the city dropped; email omitted)
```

### The W-01 two-sided safety rule (auto-corruption is structurally impossible)

A value moves into a target field **only when ALL three hold**: (a) it is shape-**positive** for the target, AND (b) shape-**negative** for the field it currently occupies, AND (c) the target field is **not** already holding a shape-valid value of its own type. If any clause is false, or two candidates compete for one field, the value is **left as-is in its original field** (no data loss, never overwritten, never dropped) and an `escalate` action is emitted for a human to resolve. A `NEITHER` value (a city / garbage) is **dropped** — never promoted to the other field, never invented. A value already shape-valid in its own field is a **no-op**.

This is enforced and exhaustively locked by `src/normalize.test.ts`, including a **property test** that asserts — across the full cartesian product of representative shape values in both columns — that a shape-valid value is never overwritten or dropped, nothing is moved unless the two-sided rule passes, and every output value traces to an input (no fabrication).

Both ingress paths call this SAME function (Rule E — single SOT): Rello's CSV `validateRow` and Harvest-Home's BYOL/intake/retry-cron Rello POST. The Layer-3 DLQ reconciler re-runs it on dead-lettered validation-400 rows.

## Versioning

- `0.3.0` — (2026-06-23) add the `/normalize` subpath: `normalizeContactFields` + the shape predicates (`isEmailShaped` / `isPhoneShaped` / `isNeither`) — Self-Healing Import Validation Layer 2. Routes swapped email/phone values to the field their shape belongs to under the W-01 two-sided safety rule (heal only on an unambiguous two-sided mismatch; escalate-in-place on ambiguity / would-overwrite; drop `NEITHER`; no-op when correct). Pure, deterministic, idempotent; reuses the `/contracts` email regex + ≥7-digit phone floor (Rule E, no fork). Additive — the classifier/normalizer/contract surfaces are unchanged. 35 new tests incl. an exhaustive cartesian-product property test proving auto-corruption is structurally impossible.
- `0.2.1` — (2026-06-23) robustness patch on the contact preprocessors: `tolerantOptionalEmail` / `tolerantOptionalPhone` gain an OUTER `.optional()`. zod 4.4.x regressed `z.preprocess(fn, inner.optional())` inside a `z.object` to reject an ABSENT key (`expected nonoptional, received undefined`); the outer optional keeps an absent key passing on every zod 4.x consumers run (Rello 4.3.5, HH 4.4.1). Behavior otherwise identical (null/"" → omitted; invalid still rejects) — makes the contact-less-fix invariant version-proof against a future consumer zod bump. Surfaced by HH's producer-side contract test.
- `0.2.0` — (2026-06-23) add the `/contracts` subpath: shared `createLead` contact contract (`createLeadContactContract` + `tolerantOptionalEmail` / `tolerantOptionalPhone` / `emptyToUndefined`), the regression-lock SOT for the shipped contact-less-lead fix. Adds `zod ^4` as a `peerDependency`. Additive — the pure classifier/normalizer surface is unchanged. 22 new contract fixtures (pass-legit + reject-invalid, both directions).
- `0.1.0` — initial publish (2026-04-26). Six-member `EntityType`, ordered classifier, normalizer covering LLC / LP / Trust / Inc / Corp suffixes plus `&`/`the`/punctuation rules. 30+ vitest fixtures including the explicit Bastow worked-example.

Future classifier expansions (new suffix patterns, e.g., `B Corp` / `S Corp` / `Foundation` granularity, or non-English entity suffixes) bump minor. Breaking changes to function signatures bump major.

Follow the same `github:rello-platform/lead-entity#vX.Y.Z` tag-based consumption model as `@rello-platform/slugs` and `@rello-platform/nurture-goals`.

## Coordination across the platform

- The `EntityType` union is mirrored to a Prisma `enum EntityType` on Rello (`Rello/prisma/schema.prisma`) and a `String?` column on Harvest-Home (`EnrichedLead.derivedEntityType`). Changing the union here is a coordinated cross-repo migration — bump this package, update Rello's Prisma enum, redeploy both services in lockstep.
- `@rello-platform/api-client` v2.1.0+ widens `CreateLeadInput` to accept optional `entityType` + `entityName`. Calls passing those fields require both repos pinned at api-client ≥ v2.1.0 to compile.
- The Phase 7 backfill script (`Rello/scripts/backfill-lead-entity-type.ts`) imports the same `classifyEntityType` and `normalizeEntityName`. A bump to this package's classifier affects new writes immediately; to re-classify existing rows under the new logic, re-run the backfill (idempotent skip-if-classified guard).
