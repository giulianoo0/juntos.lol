import { describe, expect, it } from "vitest";
import { KINDS, MASCOT_ACCESSORIES, MASCOT_KINDS, parseAvatar, serializeAvatar, type AvatarSpec } from ".";

describe("avatar spec", () => {
  it("writes kind, color and accessory short", () => {
    expect(serializeAvatar({ kind: "fox", accessory: "bowtie" })).toBe("fox.bowtie");
    expect(serializeAvatar({ kind: "cat", color: "preto", accessory: "space-helmet" })).toBe("cat-preto.space-helmet");
    expect(serializeAvatar({ kind: "owl", accessory: "none" })).toBe("owl");
    expect(serializeAvatar({ kind: "owl", color: "nope", accessory: "none" })).toBe("owl");
  });

  it("reads back everything it writes", () => {
    for (const kind of MASCOT_KINDS)
      for (const color of [undefined, ...Object.keys(KINDS[kind].colors ?? {})])
        for (const { id } of MASCOT_ACCESSORIES) {
          const spec: AvatarSpec = color ? { kind, color, accessory: id } : { kind, accessory: id };
          expect(parseAvatar(serializeAvatar(spec))).toEqual(spec);
        }
  });

  it("refuses what it would not write", () => {
    for (const text of ["", "dog", "fox.", "fox.none", "fox.hat", "fox-roxo", "cat-preto-x.bowtie", ".bowtie", "fox.bowtie.x"]) expect(parseAvatar(text), text).toBeNull();
  });
});
