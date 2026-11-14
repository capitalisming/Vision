import type { Orientation } from '../core/types';

const ANGLE: Record<Orientation, number> = { right: 0, down: Math.PI / 2, left: Math.PI, up: (3 * Math.PI) / 2 };

/**
 * Draw a tumbling E (5×5 strokes, Sloan-like proportions) of stroke `s` DEVICE pixels,
 * centred at (cx, cy) in device pixels. "right" = the open side points right.
 *
 * The canvas backing store must be exactly cssSize × devicePixelRatio so that one canvas
 * unit = one physical pixel (no browser resampling). Fractional strokes are drawn with
 * the browser's coverage anti-aliasing (cf. Bach 1997, anti-aliasing in FrACT); the
 * realised stroke width is the requested value, verified in tests/render.spec.mjs.
 */
export function drawE(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, o: Orientation) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(ANGLE[o]);
  ctx.fillStyle = '#000';
  const h = 2.5 * s;
  ctx.fillRect(-h, -h, s, 5 * s); // spine (left side, so the opening faces right)
  ctx.fillRect(-h, -h, 5 * s, s); // top arm
  ctx.fillRect(-h, -0.5 * s, 5 * s, s); // middle arm
  ctx.fillRect(-h, h - s, 5 * s, s); // bottom arm
  ctx.restore();
}
