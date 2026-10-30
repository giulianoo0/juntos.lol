import { act, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { KINDS, MASCOT_ACCESSORIES, MASCOT_KINDS, Mascot, type MascotExpression } from ".";
import { createManualClock, setMascotClock } from "./testing";

const eyeHeights = (html: string) => [...html.matchAll(/data-eye="(?:left|right)"[^>]*height="([\d.]+)"/g)].map((m) => Number(m[1]));
const bodyFill = (html: string) => html.match(/data-part="body"[^>]*fill="(#[0-9a-f]+)"/)![1];

afterEach(() => setMascotClock(null));

describe("Mascot", () => {
  it("keeps Nelo's five kinds first and adds at least twenty", () => {
    expect(MASCOT_KINDS.slice(0, 5)).toEqual(["wolf", "cat", "fox", "bunny", "bear"]);
    expect(MASCOT_KINDS.length).toBeGreaterThanOrEqual(25);
    expect(Object.keys(KINDS).sort()).toEqual([...MASCOT_KINDS].sort());
  });

  it("draws every kind with a head, two pill eyes and no mouth", () => {
    for (const kind of MASCOT_KINDS) {
      const html = renderToStaticMarkup(<Mascot kind={kind} expression="idle" size={64} />);
      expect(html).toContain(`data-kind="${kind}"`);
      expect(html).toContain('width="64"');
      expect(html).toContain('data-part="body"');
      expect(eyeHeights(html)).toHaveLength(2);
      expect(html).not.toContain("mouth");
      const ears = html.match(/data-part="ear-/g)?.length ?? 0;
      expect(ears, kind).toBe(KINDS[kind].ear ? (KINDS[kind].rim ? 4 : 2) : 0);
    }
  });

  it("gives each kind its own color and only the rimmed ones a rim", () => {
    const bodies = MASCOT_KINDS.map((kind) => bodyFill(renderToStaticMarkup(<Mascot kind={kind} expression="idle" />)));
    expect(new Set(bodies).size).toBe(MASCOT_KINDS.length);
    expect(renderToStaticMarkup(<Mascot kind="wolf" expression="idle" />)).toContain('data-part="rim"');
    expect(renderToStaticMarkup(<Mascot kind="cat" expression="idle" />)).not.toContain('data-part="rim"');
  });

  it("repaints a kind in one of its colors and ignores unknown ones", () => {
    expect(bodyFill(renderToStaticMarkup(<Mascot kind="cat" color="preto" expression="idle" />))).toBe(KINDS.cat.colors!.preto!.body);
    expect(renderToStaticMarkup(<Mascot kind="cat" color="preto" expression="idle" />)).toContain('data-part="rim"');
    expect(bodyFill(renderToStaticMarkup(<Mascot kind="cat" color="roxo" expression="idle" />))).toBe(KINDS.cat.body);
  });

  it("changes the eyes with the expression", () => {
    const height = (expression: MascotExpression) => eyeHeights(renderToStaticMarkup(<Mascot kind="robot" expression={expression} />))[0]!;
    expect(height("thinking")).toBeLessThan(height("idle") / 2);
    expect(height("happy")).toBeLessThan(height("thinking"));
    expect(Math.abs(height("listening") - height("speaking"))).toBeLessThan(0.5);
  });

  it("gives the owl round eyes whose flat pupil follows them into a happy line", () => {
    const clock = createManualClock(0);
    setMascotClock(clock);
    const size = (el: Element) => [Number(el.getAttribute("width")), Number(el.getAttribute("height"))] as const;
    const { container, rerender } = render(<Mascot kind="owl" expression="idle" still />);
    const eye = () => size(container.querySelector('[data-eye="left"]')!);
    const pupil = () => size(container.querySelector('[data-part="iris-left"] rect')!);
    const [w, h] = eye();
    expect(w / h).toBeGreaterThan(0.85);
    expect(pupil()[0]).toBeGreaterThan(w * 0.45);
    expect(pupil()[0]).toBeLessThan(w * 0.7);
    expect(container.querySelector('[data-part="iris-left"] circle')).toBeNull();
    rerender(<Mascot kind="owl" expression="happy" still />);
    act(() => clock.advance(1500));
    const [hw, hh] = eye();
    expect(hh).toBeLessThan(hw / 4);
    expect(pupil()[0]).toBeCloseTo(hw, 1);
  });

  it("gives the panda plain pill eyes, white on its patches, like the rest of the family", () => {
    const html = renderToStaticMarkup(<Mascot kind="panda" expression="idle" />);
    expect(html).not.toContain("iris-");
    const [height] = eyeHeights(html);
    const width = Number(html.match(/data-eye="left"[^>]*width="([\d.]+)"/)![1]);
    expect(height! / width).toBeGreaterThan(1.8);
  });

  it("wears every accessory on every kind, nothing when asked for none", () => {
    for (const kind of MASCOT_KINDS) {
      for (const { id } of MASCOT_ACCESSORIES) {
        const html = renderToStaticMarkup(<Mascot kind={kind} expression="idle" accessory={id} />);
        expect(html.match(/<g data-accessory=/g)?.length ?? 0).toBe(id === "none" ? 0 : 1);
        expect(eyeHeights(html)).toHaveLength(2);
      }
    }
  });

  it("takes the top off under a hat unless the top is the head (the mushroom's cap)", () => {
    expect(renderToStaticMarkup(<Mascot kind="robot" expression="idle" accessory="bowtie" />)).toContain('data-part="top"');
    expect(renderToStaticMarkup(<Mascot kind="robot" expression="idle" accessory="crown" />)).not.toContain('data-part="top"');
    expect(renderToStaticMarkup(<Mascot kind="mushroom" expression="idle" accessory="beanie" />)).toContain('data-part="top"');
  });

  it("lights both headphones while listening or speaking", () => {
    for (const id of ["headphones", "cat-headphones"] as const) {
      expect(renderToStaticMarkup(<Mascot kind="wolf" expression="listening" accessory={id} />)).toContain("data-live");
      expect(renderToStaticMarkup(<Mascot kind="wolf" expression="idle" accessory={id} />)).not.toContain("data-live");
    }
  });

  it("swings the antenna with the ear spring and holds the robot's side panels still", () => {
    const clock = createManualClock(0);
    setMascotClock(clock);
    const { container, rerender } = render(<Mascot kind="robot" expression="idle" />);
    const top = () => container.querySelector('[data-part="top"]')!.getAttribute("transform");
    const ear = () => container.querySelector('[data-part="ear-left"]')!.getAttribute("transform");
    const before = { top: top(), ear: ear() };
    rerender(<Mascot kind="robot" expression="error" />);
    act(() => clock.advance(800));
    expect(top()).not.toBe(before.top);
    expect(top()).toMatch(/rotate\(-2[78]\.\d+ 50 30\)/);
    expect(ear()).toBe(before.ear);
  });

  it("tucks the alien's and the bee's antennae under a hat and keeps them otherwise", () => {
    for (const kind of ["alien", "bee"] as const) {
      for (const hat of ["beanie", "cap", "crown"] as const) {
        expect(renderToStaticMarkup(<Mascot kind={kind} expression="idle" accessory={hat} />), `${kind}.${hat}`).not.toContain('data-part="ear-');
      }
      expect(renderToStaticMarkup(<Mascot kind={kind} expression="idle" accessory="flower" />)).toContain('data-part="ear-left"');
    }
    expect(renderToStaticMarkup(<Mascot kind="cat" expression="idle" accessory="crown" />)).toContain('data-part="ear-left"');
  });

  it("shrinks a hat onto the mushroom's cap instead of sinking it in", () => {
    const hat = (kind: "mushroom" | "alien") =>
      renderToStaticMarkup(<Mascot kind={kind} expression="idle" accessory="cap" />).match(/<g transform="([^"]+)"><g data-accessory="cap"/)?.[1] ?? "";
    expect(hat("mushroom")).toMatch(/scale\(0\.\d+\)/);
    expect(hat("alien")).not.toContain("scale");
  });
});
