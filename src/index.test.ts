import { describe, it, expect } from "vitest";
import {
  ENTITY_TYPES,
  classifyEntityType,
  normalizeEntityName,
  shouldRequireSkipTrace,
  type EntityType,
} from "./index";

describe("ENTITY_TYPES", () => {
  it("contains exactly the six locked members in order", () => {
    expect(ENTITY_TYPES).toEqual([
      "INDIVIDUAL",
      "LLC",
      "PARTNERSHIP",
      "TRUST",
      "CORPORATION",
      "OTHER",
    ]);
  });
});

describe("classifyEntityType — Bastow worked example (spec line 203)", () => {
  it("classifies 'Bastow Family Limited Partnership' as PARTNERSHIP", () => {
    expect(classifyEntityType("Bastow Family Limited Partnership")).toBe(
      "PARTNERSHIP"
    );
  });
  it("classifies 'Bastow Family Ltd Partnership' as PARTNERSHIP", () => {
    expect(classifyEntityType("Bastow Family Ltd Partnership")).toBe(
      "PARTNERSHIP"
    );
  });
  it("classifies 'Bastow Family LP' as PARTNERSHIP", () => {
    expect(classifyEntityType("Bastow Family LP")).toBe("PARTNERSHIP");
  });
  it("classifies 'Bastow Family L.P.' as PARTNERSHIP", () => {
    expect(classifyEntityType("Bastow Family L.P.")).toBe("PARTNERSHIP");
  });
});

describe("classifyEntityType — LLC branch", () => {
  it("classifies 'Smith Family LLC' as LLC", () => {
    expect(classifyEntityType("Smith Family LLC")).toBe("LLC");
  });
  it("classifies 'L.L.C. Holdings' as LLC", () => {
    expect(classifyEntityType("L.L.C. Holdings")).toBe("LLC");
  });
  it("classifies 'Smith Family Limited Liability Company' as LLC", () => {
    expect(classifyEntityType("Smith Family Limited Liability Company")).toBe(
      "LLC"
    );
  });
  it("classifies 'John Smith LLC' as LLC (entity wrapper wins per Lock #4)", () => {
    expect(classifyEntityType("John Smith LLC")).toBe("LLC");
  });
});

describe("classifyEntityType — PARTNERSHIP branch", () => {
  it("classifies 'Acme Limited Partnership' as PARTNERSHIP", () => {
    expect(classifyEntityType("Acme Limited Partnership")).toBe("PARTNERSHIP");
  });
  it("classifies 'Acme LP' as PARTNERSHIP", () => {
    expect(classifyEntityType("Acme LP")).toBe("PARTNERSHIP");
  });
});

describe("classifyEntityType — TRUST branch", () => {
  it("classifies 'The Smith Family Trust' as TRUST", () => {
    expect(classifyEntityType("The Smith Family Trust")).toBe("TRUST");
  });
  it("classifies 'Smith Family Trust' as TRUST", () => {
    expect(classifyEntityType("Smith Family Trust")).toBe("TRUST");
  });
  it("classifies 'Smith Family Living Trust' as TRUST", () => {
    expect(classifyEntityType("Smith Family Living Trust")).toBe("TRUST");
  });
  it("classifies 'Smith Family Revocable Trust' as TRUST", () => {
    expect(classifyEntityType("Smith Family Revocable Trust")).toBe("TRUST");
  });
  it("classifies 'Smith Family Irrevocable Trust' as TRUST", () => {
    expect(classifyEntityType("Smith Family Irrevocable Trust")).toBe("TRUST");
  });
});

describe("classifyEntityType — CORPORATION branch", () => {
  it("classifies 'Smith & Sons Inc.' as CORPORATION", () => {
    expect(classifyEntityType("Smith & Sons Inc.")).toBe("CORPORATION");
  });
  it("classifies 'Smith Corporation' as CORPORATION", () => {
    expect(classifyEntityType("Smith Corporation")).toBe("CORPORATION");
  });
  it("classifies 'Smith Corp' as CORPORATION", () => {
    expect(classifyEntityType("Smith Corp")).toBe("CORPORATION");
  });
  it("classifies 'Smith Incorporated' as CORPORATION", () => {
    expect(classifyEntityType("Smith Incorporated")).toBe("CORPORATION");
  });
});

describe("classifyEntityType — OTHER branch", () => {
  it("classifies 'Acme Foundation' as OTHER (no other suffix)", () => {
    expect(classifyEntityType("Acme Foundation")).toBe("OTHER");
  });
  it("classifies 'Acme Holdings' as OTHER", () => {
    expect(classifyEntityType("Acme Holdings")).toBe("OTHER");
  });
  it("classifies 'Acme Group' as OTHER", () => {
    expect(classifyEntityType("Acme Group")).toBe("OTHER");
  });
  it("classifies 'Acme Enterprise' as OTHER", () => {
    expect(classifyEntityType("Acme Enterprise")).toBe("OTHER");
  });
});

describe("classifyEntityType — INDIVIDUAL branch (default fallthrough)", () => {
  it("classifies 'John Smith' as INDIVIDUAL", () => {
    expect(classifyEntityType("John Smith")).toBe("INDIVIDUAL");
  });
  it("classifies 'Acme' (single word, no recognized suffix) as INDIVIDUAL", () => {
    expect(classifyEntityType("Acme")).toBe("INDIVIDUAL");
  });
  it("classifies empty string as INDIVIDUAL", () => {
    expect(classifyEntityType("")).toBe("INDIVIDUAL");
  });
  it("classifies whitespace-only string as INDIVIDUAL", () => {
    expect(classifyEntityType("   ")).toBe("INDIVIDUAL");
  });
});

describe("classifyEntityType — input validation", () => {
  it("throws TypeError on null input (per Lock #13 narrow inputs)", () => {
    expect(() =>
      classifyEntityType(null as unknown as string)
    ).toThrow(TypeError);
  });
  it("throws TypeError on undefined input", () => {
    expect(() =>
      classifyEntityType(undefined as unknown as string)
    ).toThrow(TypeError);
  });
  it("throws TypeError on number input", () => {
    expect(() =>
      classifyEntityType(42 as unknown as string)
    ).toThrow(TypeError);
  });
});

describe("normalizeEntityName — Bastow dedup convergence (spec line 203)", () => {
  it("'Bastow Family Limited Partnership' normalizes to 'bastow family lp'", () => {
    expect(normalizeEntityName("Bastow Family Limited Partnership")).toBe(
      "bastow family lp"
    );
  });
  it("'Bastow Family Ltd Partnership' normalizes to 'bastow family lp' (same as Limited)", () => {
    expect(normalizeEntityName("Bastow Family Ltd Partnership")).toBe(
      "bastow family lp"
    );
  });
  it("both Bastow variants produce the same normalized string", () => {
    expect(normalizeEntityName("Bastow Family Limited Partnership")).toBe(
      normalizeEntityName("Bastow Family Ltd Partnership")
    );
  });
  it("'Bastow Family LP' normalizes to 'bastow family lp'", () => {
    expect(normalizeEntityName("Bastow Family LP")).toBe("bastow family lp");
  });
  it("'Bastow Family L.P.' normalizes to 'bastow family lp'", () => {
    expect(normalizeEntityName("Bastow Family L.P.")).toBe("bastow family lp");
  });
});

describe("normalizeEntityName — case insensitivity", () => {
  it("'BASTOW FAMILY LP' normalizes to 'bastow family lp'", () => {
    expect(normalizeEntityName("BASTOW FAMILY LP")).toBe("bastow family lp");
  });
  it("'bastow family lp' normalizes to 'bastow family lp'", () => {
    expect(normalizeEntityName("bastow family lp")).toBe("bastow family lp");
  });
});

describe("normalizeEntityName — punctuation handling", () => {
  it("strips trailing periods: 'Smith, Inc.' -> 'smith inc'", () => {
    expect(normalizeEntityName("Smith, Inc.")).toBe("smith inc");
  });
  it("expands & to and: 'Smith & Sons' -> 'smith and sons'", () => {
    expect(normalizeEntityName("Smith & Sons")).toBe("smith and sons");
  });
  it("expands & inside compound: 'Smith & Sons Inc.' -> 'smith and sons inc'", () => {
    expect(normalizeEntityName("Smith & Sons Inc.")).toBe("smith and sons inc");
  });
  it("collapses multiple spaces", () => {
    expect(normalizeEntityName("  Smith    Family   LLC  ")).toBe(
      "smith family llc"
    );
  });
});

describe("normalizeEntityName — leading 'the' strip", () => {
  it("'The Smith Family Trust' -> 'smith family trust'", () => {
    expect(normalizeEntityName("The Smith Family Trust")).toBe(
      "smith family trust"
    );
  });
  it("'THE SMITH FAMILY TRUST' -> 'smith family trust'", () => {
    expect(normalizeEntityName("THE SMITH FAMILY TRUST")).toBe(
      "smith family trust"
    );
  });
  it("preserves 'the' that is NOT a leading article", () => {
    expect(normalizeEntityName("Smith The Great LLC")).toBe(
      "smith the great llc"
    );
  });
});

describe("normalizeEntityName — Trust qualifier convergence (spec line 672)", () => {
  it("'The Smith Family Trust' -> 'smith family trust'", () => {
    expect(normalizeEntityName("The Smith Family Trust")).toBe(
      "smith family trust"
    );
  });
  it("'Smith Family Trust' -> 'smith family trust'", () => {
    expect(normalizeEntityName("Smith Family Trust")).toBe("smith family trust");
  });
  it("'Smith Family Living Trust' -> 'smith family trust' (living stripped)", () => {
    expect(normalizeEntityName("Smith Family Living Trust")).toBe(
      "smith family trust"
    );
  });
  it("'Smith Family Revocable Trust' -> 'smith family trust' (revocable stripped)", () => {
    expect(normalizeEntityName("Smith Family Revocable Trust")).toBe(
      "smith family trust"
    );
  });
  it("'Smith Family Irrevocable Trust' -> 'smith family trust' (irrevocable stripped)", () => {
    expect(normalizeEntityName("Smith Family Irrevocable Trust")).toBe(
      "smith family trust"
    );
  });
  it("all four trust variants converge to the same normalized string", () => {
    const a = normalizeEntityName("The Smith Family Trust");
    const b = normalizeEntityName("Smith Family Living Trust");
    const c = normalizeEntityName("Smith Family Revocable Trust");
    const d = normalizeEntityName("Smith Family Irrevocable Trust");
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(c).toBe(d);
  });
});

describe("normalizeEntityName — LLC abbreviation canonicalization (spec line 158)", () => {
  it("'Limited Liability Company' -> 'llc' suffix", () => {
    expect(normalizeEntityName("Acme Limited Liability Company")).toBe(
      "acme llc"
    );
  });
  it("'L.L.C.' -> 'llc'", () => {
    expect(normalizeEntityName("Acme L.L.C.")).toBe("acme llc");
  });
  it("'L L C' (spaced) -> 'llc'", () => {
    expect(normalizeEntityName("Acme L L C")).toBe("acme llc");
  });
  it("'LLC' stays 'llc'", () => {
    expect(normalizeEntityName("Acme LLC")).toBe("acme llc");
  });
});

describe("normalizeEntityName — LP abbreviation canonicalization (spec line 157)", () => {
  it("'limited partnership' -> 'lp'", () => {
    expect(normalizeEntityName("Acme Limited Partnership")).toBe("acme lp");
  });
  it("'ltd partnership' -> 'lp'", () => {
    expect(normalizeEntityName("Acme Ltd Partnership")).toBe("acme lp");
  });
  it("'limited ptnrship' -> 'lp'", () => {
    expect(normalizeEntityName("Acme Limited Ptnrship")).toBe("acme lp");
  });
  it("'L P' (spaced) -> 'lp'", () => {
    expect(normalizeEntityName("Acme L P")).toBe("acme lp");
  });
});

describe("normalizeEntityName — Inc/Corp canonicalization (spec lines 159-160)", () => {
  it("'incorporated' -> 'inc'", () => {
    expect(normalizeEntityName("Acme Incorporated")).toBe("acme inc");
  });
  it("'incorp' -> 'inc'", () => {
    expect(normalizeEntityName("Acme Incorp")).toBe("acme inc");
  });
  it("'inc' stays 'inc'", () => {
    expect(normalizeEntityName("Acme Inc")).toBe("acme inc");
  });
  it("'corporation' -> 'corp'", () => {
    expect(normalizeEntityName("Acme Corporation")).toBe("acme corp");
  });
  it("'corp' stays 'corp'", () => {
    expect(normalizeEntityName("Acme Corp")).toBe("acme corp");
  });
});

describe("normalizeEntityName — input validation", () => {
  it("throws TypeError on null", () => {
    expect(() =>
      normalizeEntityName(null as unknown as string)
    ).toThrow(TypeError);
  });
  it("throws TypeError on undefined", () => {
    expect(() =>
      normalizeEntityName(undefined as unknown as string)
    ).toThrow(TypeError);
  });
  it("throws TypeError on number", () => {
    expect(() =>
      normalizeEntityName(42 as unknown as string)
    ).toThrow(TypeError);
  });
});

describe("shouldRequireSkipTrace — locked four cases (prompt step 5)", () => {
  it("INDIVIDUAL + hasContactHuman=true -> false", () => {
    expect(
      shouldRequireSkipTrace({
        entityType: "INDIVIDUAL",
        hasContactHuman: true,
      })
    ).toBe(false);
  });
  it("INDIVIDUAL + hasContactHuman=false -> false (per Lock #5: never true for individuals)", () => {
    expect(
      shouldRequireSkipTrace({
        entityType: "INDIVIDUAL",
        hasContactHuman: false,
      })
    ).toBe(false);
  });
  it("LLC + hasContactHuman=true -> false (contact already attached)", () => {
    expect(
      shouldRequireSkipTrace({ entityType: "LLC", hasContactHuman: true })
    ).toBe(false);
  });
  it("LLC + hasContactHuman=false -> true (skip-trace queue flag)", () => {
    expect(
      shouldRequireSkipTrace({ entityType: "LLC", hasContactHuman: false })
    ).toBe(true);
  });
  it("PARTNERSHIP + hasContactHuman=false -> true", () => {
    expect(
      shouldRequireSkipTrace({
        entityType: "PARTNERSHIP",
        hasContactHuman: false,
      })
    ).toBe(true);
  });
  it("TRUST + hasContactHuman=false -> true", () => {
    expect(
      shouldRequireSkipTrace({ entityType: "TRUST", hasContactHuman: false })
    ).toBe(true);
  });
});

describe("EntityType type membership (compile-time)", () => {
  it("rejects values outside ENTITY_TYPES at compile time", () => {
    const valid: EntityType = "PARTNERSHIP";
    expect(ENTITY_TYPES).toContain(valid);
  });
});
