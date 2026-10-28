import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_EYES, EXPRESSION_EYES, KINDS, MASCOT_ACCESSORIES, MASCOT_KINDS, Mascot, projectEye, type MascotAccessory, type MascotExpression } from ".";
import { BEANIE, BOWTIE_TOP, CAP, CROWN, EYE_FRAMES, HAT_BRIM, ROUND_GLASSES, SCARF, SUNGLASSES, bowtieFor, eyeBox, eyeFrameFor, eyeLayoutFor, fitEye, headphonesFor, helmetFor, lensGlass, scarfFor, type Box, type LensRect } from "./accessory-geometry";
import { ROUND_FIT, fitOf } from "./kind";
import { WONDER_SHAPE, irisOf, type EyeLayout, type EyeRender, type Gaze } from "./eyes";
import { createManualClock, setMascotClock, type ManualClock } from "./testing";

const ACCESSORIES = MASCOT_ACCESSORIES.map((a) => a.id);
const EXPRESSIONS = Object.keys(EXPRESSION_EYES) as MascotExpression[];
const EPS = 1e-6;
/** The DOM keeps three decimals. */
const DRAWN = 0.005;

const inside = (inner: Box, outer: Box, tolerance = EPS) =>
  inner.x0 >= outer.x0 - tolerance && inner.y0 >= outer.y0 - tolerance && inner.x1 <= outer.x1 + tolerance && inner.y1 <= outer.y1 + tolerance;
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const rectBox = (r: { x: number; y: number; width: number; height: number }): Box => ({ x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height });
/** Inside a rounded rect, or a circle when rx is half the side. */
function inGlass(box: Box, glass: LensRect, tolerance = EPS) {
  if (glass.rx * 2 < glass.width - EPS) return inside(box, rectBox(glass), tolerance);
  const cx = glass.x + glass.rx;
  const cy = glass.y + glass.rx;
  return [[box.x0, box.y0], [box.x1, box.y0], [box.x0, box.y1], [box.x1, box.y1]].every(([x, y]) => Math.hypot(x! - cx, y! - cy) <= glass.rx + tolerance);
}

function everyEye(side: -1 | 1, layout: EyeLayout = DEFAULT_EYES): (EyeRender & { gaze: Gaze })[] {
  const shapes = [...EXPRESSIONS.map((e) => EXPRESSION_EYES[e].shape), WONDER_SHAPE];
  const eyes: (EyeRender & { gaze: Gaze })[] = [];
  for (let yaw = -1.2; yaw <= 1.2 + EPS; yaw += 0.15)
    for (let pitch = -0.6; pitch <= 0.75 + EPS; pitch += 0.15)
      for (const shape of shapes)
        for (const level of [1, 1.15])
          for (const blink of [1, 0.1]) {
            const eye = projectEye(layout, side, { yaw, pitch }, { w: shape.w, h: shape.h * level }, blink);
            if (eye.opacity > 0) eyes.push({ ...eye, gaze: { yaw, pitch } });
          }
  return eyes;
}

describe("eyes and accessories, every pose", () => {
  for (const accessory of ACCESSORIES) {
    it(`keeps every eye inside its frame with ${accessory}`, () => {
      const frame = EYE_FRAMES[accessory];
      for (const side of [-1, 1] as const) {
        for (const eye of everyEye(side).map((e) => fitEye(e, side, frame))) {
          const box = eyeBox(eye);
          if (frame) expect(inside(box, side < 0 ? frame.left : frame.right), JSON.stringify(eye)).toBe(true);
          switch (accessory) {
            case "sunglasses":
              expect(inGlass(box, lensGlass(side < 0 ? SUNGLASSES.left : SUNGLASSES.right))).toBe(true);
              break;
            case "round-glasses":
              expect(inGlass(box, lensGlass(side < 0 ? ROUND_GLASSES.left : ROUND_GLASSES.right, ROUND_GLASSES.stroke))).toBe(true);
              break;
            case "beanie":
              expect(box.y0).toBeGreaterThan(BEANIE.brim.y + BEANIE.brim.height);
              break;
            case "cap":
              expect(box.y0).toBeGreaterThan(CAP.bill);
              break;
            case "crown":
              expect(box.y0).toBeGreaterThan(CROWN.base);
              break;
            case "headphones":
            case "cat-headphones":
              for (const cup of headphonesFor().cups) expect(overlaps(box, rectBox(cup))).toBe(false);
              break;
            case "scarf":
              expect(box.y1).toBeLessThan(SCARF.top);
              break;
            case "bowtie":
              expect(box.y1).toBeLessThan(BOWTIE_TOP);
              break;
          }
        }
      }
    });
  }

  it("still lets the eyes look around inside both kinds of lenses", () => {
    for (const [id, lens] of [["sunglasses", lensGlass(SUNGLASSES.right)], ["round-glasses", lensGlass(ROUND_GLASSES.right, ROUND_GLASSES.stroke)]] as const) {
      const xs = everyEye(1).map((eye) => fitEye(eye, 1, EYE_FRAMES[id]).x);
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(lens.width * 0.3);
    }
  });

  for (const kind of MASCOT_KINDS.filter((k) => KINDS[k].socket)) {
    it(`keeps each of the ${kind}'s eyes in its own patch, never in the other one`, () => {
      const [x0, y0, x1, y1] = KINDS[kind].socket!.box;
      for (const accessory of ACCESSORIES.filter((a) => !EYE_FRAMES[a]?.clip)) {
        const frame = eyeFrameFor(accessory, KINDS[kind]);
        for (const side of [-1, 1] as const) {
          const patch = side < 0 ? { x0, y0, x1, y1 } : { x0: 100 - x1, y0, x1: 100 - x0, y1 };
          for (const raw of everyEye(side, eyeLayoutFor(KINDS[kind]))) {
            const eye = fitEye(raw, side, frame);
            const box = eyeBox(eye);
            expect(inside(box, patch), `${accessory} ${JSON.stringify(eye)}`).toBe(true);
            expect(side < 0 ? box.x1 < 50 : box.x0 > 50).toBe(true);
            const iris = KINDS[kind].iris;
            if (iris) {
              const pupil = irisOf(eye, raw.gaze, iris.pupil, iris.shut);
              expect(inside(eyeBox({ ...eye, ...pupil, rotate: 0 }), eyeBox({ ...eye, rotate: 0 })), `${accessory} pupil ${JSON.stringify(raw.gaze)}`).toBe(true);
            }
          }
        }
      }
    });
  }

  it("fits the frames to the head: the brim rides the hat, the cups the sides, the scarf and the bow tie the chin", () => {
    const { hat, hatScale } = KINDS.mushroom;
    expect(eyeFrameFor("beanie", KINDS.mushroom)!.left.y0).toBeCloseTo(HAT_BRIM + (EYE_FRAMES.beanie!.left.y0 - HAT_BRIM) * hatScale! + hat!, 6);
    const [left, right] = headphonesFor(KINDS.cactus).cups;
    expect(eyeFrameFor("headphones", KINDS.cactus)!.left.x0).toBeGreaterThan(left.x + left.width);
    expect(eyeFrameFor("headphones", KINDS.cactus)!.right.x1).toBeLessThan(right.x);
    expect(eyeFrameFor("scarf", KINDS.octopus)!.left.y1).toBeLessThan(scarfFor(KINDS.octopus).top);
    expect(eyeFrameFor("bowtie", KINDS.strawberry)!.left.y1).toBeLessThan(bowtieFor(KINDS.strawberry).top);
  });

  it("sits the cups on the head's sides and the band over its top", () => {
    for (const kind of MASCOT_KINDS) {
      const fit = fitOf(KINDS[kind]);
      const { cups, apex } = headphonesFor(KINDS[kind]);
      expect(cups[0].x, kind).toBeLessThan(fit.side);
      expect(cups[0].x + cups[0].width, kind).toBeGreaterThan(fit.side);
      expect(cups[0].x + cups[1].x + cups[1].width).toBeCloseTo(100, 6);
      expect(apex, kind).toBeLessThanOrEqual(fit.band ?? fit.top - 1);
    }
  });

  it("ties the bow tie on the chin and centers the helmet on the creature, inside the drawing", () => {
    for (const kind of MASCOT_KINDS) {
      const fit = fitOf(KINDS[kind]);
      expect(bowtieFor(KINDS[kind]).top - fit.chin, kind).toBeCloseTo(BOWTIE_TOP - ROUND_FIT.chin, 6);
      const helmet = helmetFor(KINDS[kind]);
      expect(helmet.cy - helmet.r, kind).toBeGreaterThanOrEqual(6 - EPS);
      expect(helmet.cy + helmet.r, kind).toBeLessThanOrEqual(100 + EPS);
      if (helmet.cy === fit.helmet[0]) expect(helmet.r, kind).toBeGreaterThan(fit.helmet[1]);
    }
  });
});

let clock: ManualClock;
beforeEach(() => {
  clock = createManualClock(0);
  setMascotClock(clock);
});
afterEach(() => setMascotClock(null));

function renderedEye(el: Element): EyeRender {
  const n = (name: string) => Number(el.getAttribute(name));
  const rotate = Number(/rotate\((-?[\d.]+)/.exec(el.getAttribute("transform") ?? "")?.[1] ?? 0);
  return { x: n("x") + n("width") / 2, y: n("y") + n("height") / 2, width: n("width"), height: n("height"), rx: n("rx"), rotate, opacity: n("opacity") };
}

const LOOKS = [null, { x: 1, y: -1 }, { x: -1, y: 1 }];

describe("Mascot draws the eyes inside the accessories", () => {
  for (const kind of MASCOT_KINDS) {
    it(`${kind}: every accessory and expression`, { timeout: 30_000 }, () => {
      for (const accessory of ACCESSORIES) {
        const frame = eyeFrameFor(accessory as MascotAccessory, KINDS[kind]);
        const { container, rerender, unmount } = render(<Mascot kind={kind} expression="idle" accessory={accessory} size={48} />);
        for (const expression of EXPRESSIONS) {
          for (const lookAt of LOOKS) {
            rerender(<Mascot kind={kind} expression={expression} accessory={accessory} size={48} lookAt={lookAt} level={() => 1} />);
            act(() => clock.advance(360));
            for (const side of ["left", "right"] as const) {
              const box = eyeBox(renderedEye(container.querySelector(`[data-eye="${side}"]`)!));
              if (frame) expect(inside(box, side === "left" ? frame.left : frame.right, DRAWN), `${kind} ${accessory} ${expression} ${side}`).toBe(true);
            }
          }
        }
        unmount();
      }
    });
  }
});
