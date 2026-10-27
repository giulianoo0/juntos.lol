import { useEffect, useId, useRef, useState, type Ref } from "react";
import { Accessory } from "./accessories";
import { earTuckFor, eyeFrameFor, fitEye, showsEars, showsTop, type EyeFrame } from "./accessory-geometry";
import { getMascotClock } from "./clock";
import { EAR_POSES, earPoseFor, earTransform, type EarPose } from "./ears";
import {
  BLINK_MS,
  DEFAULT_EYES,
  DOUBLE_BLINK_CHANCE,
  DOUBLE_BLINK_GAP_MS,
  EXPRESSION_EYES,
  FRONT_GAZE,
  WONDER_MS,
  WONDER_SHAPE,
  blinkFactor,
  levelScale,
  lookAtGaze,
  nextBlinkDelay,
  nextGlance,
  nextGlanceDelay,
  projectEye,
  type EyeRender,
  type Gaze,
  type EyeShape,
} from "./eyes";
import { BODY, EYE_WHITE, paint, withColor, type KindArt, type Part } from "./kind";
import { KINDS } from "./kinds";
import { settled, snap, spring, stepSpring, type Spring } from "./spring";
import type { MascotAccessory, MascotExpression, MascotKind, MascotProps } from "./types";

export type MascotPose = { gaze: Gaze; shape: EyeShape; ear: EarPose; blink: number };

export function poseFor(expression: MascotExpression, lookAt: { x: number; y: number } | null = null): MascotPose {
  const eyes = EXPRESSION_EYES[expression];
  return {
    gaze: lookAt && eyes.gaze === null ? lookAtGaze(lookAt) : (eyes.gaze ?? FRONT_GAZE),
    shape: eyes.shape,
    ear: EAR_POSES[earPoseFor(expression)],
    blink: 1,
  };
}

const RIM = "var(--mascot-rim, #54555c)";

function eyeAttrs(eye: EyeRender) {
  return {
    x: (eye.x - eye.width / 2).toFixed(3),
    y: (eye.y - eye.height / 2).toFixed(3),
    width: eye.width.toFixed(3),
    height: eye.height.toFixed(3),
    rx: eye.rx.toFixed(3),
    transform: `rotate(${eye.rotate.toFixed(3)} ${eye.x.toFixed(3)} ${eye.y.toFixed(3)})`,
    opacity: eye.opacity.toFixed(3),
  };
}

function write(el: Element, name: string, value: string) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function applyEye(el: SVGRectElement | null, eye: EyeRender) {
  if (!el) return;
  for (const [name, value] of Object.entries(eyeAttrs(eye))) write(el, name, value);
}

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

type Swinging = { pivot: readonly [number, number]; sway?: number };

function swing(piece: Swinging, pose: EarPose, tuck: number, part: string) {
  const sway = piece.sway ?? 1;
  return {
    "data-ear-transform": "",
    "data-part": part,
    "data-pivot": piece.pivot.join(" "),
    "data-sway": String(sway),
    transform: earTransform({ angle: pose.angle * sway, lift: pose.lift * sway }, piece.pivot, tuck),
  };
}

function Parts({ art, parts }: { art: KindArt; parts?: readonly Part[] }) {
  if (!parts) return null;
  return parts.map((part, i) => (
    <path
      key={i}
      d={part.d}
      fill={part.fill ? paint(art, part.fill) : part.stroke ? "none" : art.inner}
      stroke={paint(art, part.stroke)}
      strokeWidth={part.stroke ? (part.width ?? 1.6) : undefined}
      strokeLinecap={part.stroke ? "round" : undefined}
      strokeLinejoin="round"
      opacity={part.opacity}
    />
  ));
}

function RimLine({ d }: { d: string }) {
  return <path d={d} fill="none" stroke={RIM} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />;
}

function Ear({ art, pose, layer, tuck, side }: { art: KindArt; pose: EarPose; layer: "rim" | "fill"; tuck: number; side: "left" | "right" }) {
  const ear = art.ear!;
  const marks = swing(ear, pose, tuck, `ear-${side}`);
  if (layer === "rim") {
    return (
      <g {...marks}>
        <RimLine d={ear.path} />
      </g>
    );
  }
  return (
    <g {...marks}>
      <path d={ear.path} fill={paint(art, ear.fill ?? "body")} />
      {ear.inner ? <path d={ear.inner} fill={art.inner} /> : null}
      {ear.tip && art.tip ? <path d={ear.tip} fill={art.tip} /> : null}
    </g>
  );
}

function Top({ art, pose, layer, tuck }: { art: KindArt; pose: EarPose; layer: "rim" | "fill"; tuck: number }) {
  const top = art.top!;
  const marks = swing(top, pose, tuck, "top");
  return (
    <g {...marks}>
      {layer === "rim" ? (
        <RimLine d={top.path} />
      ) : (
        <>
          <path d={top.path} fill={paint(art, top.fill ?? "body")} />
          <Parts art={art} parts={top.parts} />
        </>
      )}
    </g>
  );
}

const MIRROR = "translate(100 0) scale(-1 1)";
/** Wings, rings and tentacles pull in to fit the helmet. */
const SHRINK = `translate(${BODY.cx} ${BODY.cy}) scale(0.84) translate(${-BODY.cx} ${-BODY.cy})`;

/** Both eyes for a pose, kept inside the accessory's frame (lenses, under the brim, between the ear cups). */
function eyesFor(gaze: Gaze, shape: EyeShape, frame: EyeFrame | null, blink = 1) {
  return {
    left: fitEye(projectEye(DEFAULT_EYES, -1, gaze, shape, blink), -1, frame),
    right: fitEye(projectEye(DEFAULT_EYES, 1, gaze, shape, blink), 1, frame),
  };
}

/** `still` holds the idle blinks and glances, for a face resting among others; letting go blinks at once. */
export function Mascot({ kind, expression, color, level, size = 96, lookAt = null, className, title, accessory = "bowtie", still = false }: MascotProps) {
  const rawId = useId();
  const clipId = `mascot-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const svgRef = useRef<SVGSVGElement>(null);
  const eyeLRef = useRef<SVGRectElement>(null);
  const eyeRRef = useRef<SVGRectElement>(null);
  const props = useRef({ expression, lookAt, level, accessory, still });
  props.current = { expression, lookAt, level, accessory, still };
  const wakeRef = useRef<(() => void) | null>(null);
  const [initial] = useState(() => poseFor(expression, lookAt));

  const staticPose = poseFor(expression, lookAt);
  const mounted = useRef(false);
  const shownPose = mounted.current ? initial : staticPose;

  useEffect(() => {
    mounted.current = true;
    const svg = svgRef.current;
    if (!svg) return;
    const clock = getMascotClock();
    const media = typeof matchMedia === "function" ? matchMedia(REDUCED_MOTION) : null;
    let reduced = media?.matches ?? false;
    let visible = true;
    const random = Math.random;
    const start = poseFor(props.current.expression, props.current.lookAt);
    const s = {
      yaw: spring(start.gaze.yaw),
      pitch: spring(start.gaze.pitch),
      w: spring(start.shape.w),
      h: spring(start.shape.h),
      level: spring(1),
      angle: spring(start.ear.angle),
      lift: spring(start.ear.lift),
    } satisfies Record<string, Spring>;
    let last = clock.now();
    let blinkAt = last + nextBlinkDelay(random);
    let blinkStart = -Infinity;
    let doubleAt = Infinity;
    let glanceAt = last + nextGlanceDelay(random);
    let glance: Gaze | null = null;
    let wonderUntil = -Infinity;
    let cancelFrame: () => void = () => {};
    let cancelTimer: () => void = () => {};
    let framePending = false;
    let stopped = false;
    let held = props.current.still;
    const earGroups = () => svg.querySelectorAll<SVGGElement>("[data-ear-transform]");

    const requestFrame = () => {
      if (framePending) return;
      framePending = true;
      cancelFrame = clock.frame(tick);
    };

    const sleep = () => {
      framePending = false;
      cancelFrame();
      cancelTimer();
    };

    const wake = () => {
      if (stopped || !visible) return;
      cancelTimer();
      if (!framePending) last = clock.now() - 16;
      requestFrame();
    };

    function tick(time: number) {
      framePending = false;
      if (stopped || !visible) return;
      const dt = Math.max(0, time - last);
      last = time;
      const { expression: expr, lookAt: look, level: getLevel, accessory: worn, still: hold } = props.current;
      const spec = EXPRESSION_EYES[expr];
      const idleMotion = !reduced && !hold;
      if (held && !hold) {
        blinkAt = time;
        glanceAt = time + nextGlanceDelay(random);
      }
      held = hold;

      if (idleMotion && spec.glances && !look) {
        if (time >= glanceAt) {
          const next = nextGlance(random);
          glance = next.gaze;
          if (next.wonder) wonderUntil = time + WONDER_MS;
          glanceAt = time + nextGlanceDelay(random);
        }
      } else {
        glance = null;
        wonderUntil = -Infinity;
      }
      if (idleMotion && spec.blinks) {
        if (time >= blinkAt) {
          blinkStart = time;
          blinkAt = time + nextBlinkDelay(random);
          doubleAt = random() < DOUBLE_BLINK_CHANCE ? time + DOUBLE_BLINK_GAP_MS : Infinity;
        } else if (time >= doubleAt) {
          blinkStart = time;
          doubleAt = Infinity;
        }
      }

      const gaze = look && spec.gaze === null ? lookAtGaze(look) : spec.gaze ?? glance ?? FRONT_GAZE;
      const wondering = time < wonderUntil && expr === "idle";
      const shape = wondering ? WONDER_SHAPE : spec.shape;
      const ear = EAR_POSES[earPoseFor(expr)];
      const streaming = idleMotion && spec.followsLevel && Boolean(getLevel);
      const levelTarget = streaming && getLevel ? levelScale(getLevel()) : 1;

      s.yaw.target = gaze.yaw;
      s.pitch.target = gaze.pitch;
      s.w.target = shape.w;
      s.h.target = shape.h;
      s.level.target = levelTarget;
      s.angle.target = ear.angle;
      s.lift.target = ear.lift;
      for (const value of Object.values(s)) {
        if (reduced) snap(value);
        else stepSpring(value, dt);
      }

      const blink = idleMotion ? blinkFactor(time - blinkStart) : 1;
      const current: Gaze = { yaw: s.yaw.value, pitch: s.pitch.value };
      const currentShape: EyeShape = { w: s.w.value, h: s.h.value * s.level.value };
      const eyes = eyesFor(current, currentShape, eyeFrameFor(worn, KINDS[svg!.dataset.kind as MascotKind]), blink);
      applyEye(eyeLRef.current, eyes.left);
      applyEye(eyeRRef.current, eyes.right);
      const earPose = { angle: s.angle.value, lift: s.lift.value };
      const tuck = earTuckFor(worn);
      earGroups().forEach((g) => {
        const sway = Number(g.dataset.sway ?? 1);
        const pivot = (g.dataset.pivot ?? "50 50").split(" ").map(Number) as [number, number];
        write(g, "transform", earTransform({ angle: earPose.angle * sway, lift: earPose.lift * sway }, pivot, tuck));
      });

      const busy = Object.values(s).some((value) => !settled(value)) || time - blinkStart < BLINK_MS;
      if (busy || streaming) {
        requestFrame();
        return;
      }
      if (!idleMotion) return;
      const events = [wonderUntil > time ? wonderUntil : Infinity];
      if (spec.blinks) events.push(blinkAt, doubleAt);
      if (spec.glances && !look) events.push(glanceAt);
      const next = Math.min(...events);
      if (Number.isFinite(next)) {
        cancelTimer();
        cancelTimer = clock.after(Math.max(0, next - clock.now()), wake);
      }
    }

    const onMotionPreference = () => {
      reduced = media?.matches ?? false;
      wake();
    };
    media?.addEventListener("change", onMotionPreference);

    const visibility =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver((entries) => {
            const entry = entries[entries.length - 1];
            if (!entry) return;
            visible = entry.isIntersecting;
            if (!visible) return sleep();
            const now = clock.now();
            if (blinkAt < now) blinkAt = now + nextBlinkDelay(random);
            if (glanceAt < now) glanceAt = now + nextGlanceDelay(random);
            wake();
          })
        : null;
    visibility?.observe(svg);

    wakeRef.current = wake;
    wake();
    return () => {
      stopped = true;
      wakeRef.current = null;
      sleep();
      visibility?.disconnect();
      media?.removeEventListener("change", onMotionPreference);
    };
  }, []);

  const lookKey = lookAt ? `${lookAt.x},${lookAt.y}` : "";
  useEffect(() => {
    wakeRef.current?.();
  }, [kind, expression, lookKey, level, accessory, still]);

  return (
    <MascotFigure
      kind={kind}
      color={color}
      expression={expression}
      accessory={accessory}
      pose={shownPose}
      clipId={clipId}
      size={size}
      className={className}
      title={title}
      lookAt={lookAt}
      svgRef={svgRef}
      eyeRefs={[eyeLRef, eyeRRef]}
    />
  );
}

type FigureProps = Pick<MascotProps, "kind" | "color" | "expression" | "className" | "title" | "lookAt"> & {
  accessory: MascotAccessory;
  pose: MascotPose;
  clipId: string;
  /** Without a size the svg fills its container (the served avatar). */
  size?: number;
  xmlns?: string;
  svgRef?: Ref<SVGSVGElement>;
  eyeRefs?: readonly [Ref<SVGRectElement>, Ref<SVGRectElement>];
};

/** The drawing at one pose: the React Mascot animates it in place, renderMascotSvg serves it as markup. */
export function MascotFigure({ kind, color, expression, accessory, pose, clipId, size, className, title, lookAt = null, xmlns, svgRef, eyeRefs }: FigureProps) {
  const art = withColor(KINDS[kind], color);
  const frame = eyeFrameFor(accessory, art);
  const tuck = earTuckFor(accessory);
  const eyes = eyesFor(pose.gaze, pose.shape, frame);
  const top = showsTop(art, accessory) ? art.top! : null;
  const head = art.shape ? <path d={art.shape} /> : <circle cx={BODY.cx} cy={BODY.cy} r={BODY.r - 0.5} />;
  const eyeClip = frame?.clip ? frame.clip.map((glass, i) => <rect key={i} {...glass} />) : art.eyeClip ? <path d={art.eyeClip} /> : head;
  const ears = (layer: "rim" | "fill") =>
    showsEars(art, accessory) ? (
      <>
        <Ear art={art} pose={pose.ear} layer={layer} tuck={tuck} side="left" />
        <g transform={MIRROR}>
          <Ear art={art} pose={pose.ear} layer={layer} tuck={tuck} side="right" />
        </g>
      </>
    ) : null;
  return (
    <svg
      xmlns={xmlns}
      ref={svgRef}
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      data-kind={kind}
      data-color={color && art.colors?.[color] ? color : undefined}
      data-expression={expression}
      data-accessory={accessory}
      data-look={lookAt ? `${lookAt.x.toFixed(2)},${lookAt.y.toFixed(2)}` : ""}
      overflow="visible"
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <clipPath id={`${clipId}-eyes`}>{eyeClip}</clipPath>
        <clipPath id={`${clipId}-head`}>{head}</clipPath>
      </defs>
      {art.rim ? (
        <g data-part="rim">
          {art.back?.map((part, i) => (part.fill ? <RimLine key={i} d={part.d} /> : null))}
          {ears("rim")}
          {top ? <Top art={art} pose={pose.ear} layer="rim" tuck={tuck} /> : null}
          {art.shape ? <RimLine d={art.shape} /> : <circle cx={BODY.cx} cy={BODY.cy} r={BODY.r} fill="none" stroke={RIM} strokeWidth={2} vectorEffect="non-scaling-stroke" />}
        </g>
      ) : null}
      <g data-part="back" transform={tuck < 1 ? SHRINK : undefined}>
        <Parts art={art} parts={art.back} />
      </g>
      <g data-part="ears">{ears("fill")}</g>
      {top && !top.front ? <Top art={art} pose={pose.ear} layer="fill" tuck={tuck} /> : null}
      {art.shape ? <path data-part="body" d={art.shape} fill={art.body} /> : <circle data-part="body" cx={BODY.cx} cy={BODY.cy} r={BODY.r} fill={art.body} />}
      {art.marks ? (
        <g data-part="marks" clipPath={`url(#${clipId}-head)`}>
          <Parts art={art} parts={art.marks} />
        </g>
      ) : null}
      <g data-part="eyes" clipPath={`url(#${clipId}-eyes)`} fill={accessory === "sunglasses" ? EYE_WHITE : art.eye}>
        <rect ref={eyeRefs?.[0]} data-eye="left" data-part="eye-left" {...eyeAttrs(eyes.left)} />
        <rect ref={eyeRefs?.[1]} data-eye="right" data-part="eye-right" {...eyeAttrs(eyes.right)} />
      </g>
      {art.front ? (
        <g data-part="front" transform={tuck < 1 ? SHRINK : undefined}>
          <Parts art={art} parts={art.front} />
        </g>
      ) : null}
      {top?.front ? <Top art={art} pose={pose.ear} layer="fill" tuck={tuck} /> : null}
      <Accessory id={accessory} art={art} expression={expression} />
    </svg>
  );
}
