// AI-assisted (Claude Code), reviewed by a team member.
// Landolt C optotype: physical size model (module contract formulas) and canvas rendering.

export const ARCMIN = Math.PI / (180 * 60);
export const MIN_GAP_DEVICE_PX = 1;     // below this the level is not drawn
export const NEAR_FLOOR_DEVICE_PX = 2;  // below this the result is flagged near_floor

export const ORIENTATIONS = Object.freeze(['up', 'down', 'left', 'right']);

function currentDpr() {
  const dpr = globalThis.devicePixelRatio;
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

/**
 * Size of a Landolt C whose gap subtends 10^logMAR arcminutes at distanceMm.
 * Formulas are copied from the module contract; do not change them here.
 * @returns {{gapMm:number, sizeMm:number, sizeCssPx:number, gapDevicePx:number, drawable:boolean, nearFloor:boolean}}
 */
export function sizeFor(logMAR, distanceMm, pxPerMm) {
  if (!Number.isFinite(logMAR)) throw new TypeError('sizeFor: logMAR must be a finite number');
  if (!(distanceMm > 0)) throw new RangeError('sizeFor: distanceMm must be > 0');
  if (!(pxPerMm > 0)) throw new RangeError('sizeFor: pxPerMm must be > 0');

  const gapMm = distanceMm * Math.tan(Math.pow(10, logMAR) * ARCMIN);
  const sizeMm = 5 * gapMm;
  const sizeCssPx = sizeMm * pxPerMm;
  const gapDevicePx = gapMm * pxPerMm * currentDpr();
  const drawable = gapDevicePx >= MIN_GAP_DEVICE_PX;
  const nearFloor = gapDevicePx < NEAR_FLOOR_DEVICE_PX;
  return { gapMm, sizeMm, sizeCssPx, gapDevicePx, drawable, nearFloor };
}

/**
 * Draw a black Landolt C on a white field.
 * Outer diameter = sizeCssPx, stroke = size/5, gap = size/5.
 * The canvas is resized so that one CSS pixel maps to devicePixelRatio backing pixels.
 */
export function drawLandoltC(canvas, sizeCssPx, orientation) {
  if (!ORIENTATIONS.includes(orientation)) {
    throw new RangeError(`drawLandoltC: orientation must be one of ${ORIENTATIONS.join(', ')}`);
  }
  if (!(sizeCssPx > 0)) throw new RangeError('drawLandoltC: sizeCssPx must be > 0');

  const dpr = currentDpr();
  // White margin around the ring: half a diameter on each side, at least 24 CSS px.
  const boxCss = Math.ceil(sizeCssPx + Math.max(sizeCssPx, 48));
  canvas.style.width = `${boxCss}px`;
  canvas.style.height = `${boxCss}px`;
  canvas.width = Math.round(boxCss * dpr);
  canvas.height = Math.round(boxCss * dpr);

  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Work in CSS pixels from here on.
  ctx.setTransform(canvas.width / boxCss, 0, 0, canvas.height / boxCss, 0, 0);
  const c = boxCss / 2;
  const rOuter = sizeCssPx / 2;
  const stroke = sizeCssPx / 5;
  const rInner = rOuter - stroke;
  const gap = sizeCssPx / 5;

  ctx.fillStyle = '#000000';
  ctx.beginPath();
  ctx.arc(c, c, rOuter, 0, 2 * Math.PI);
  ctx.arc(c, c, rInner, 0, 2 * Math.PI, true);
  ctx.fill('evenodd');

  // Gap: a white bar of width size/5 from the centre outwards, edges parallel.
  ctx.fillStyle = '#ffffff';
  const reach = rOuter + 2; // overshoot past the outer edge so no sliver remains
  switch (orientation) {
    case 'right': ctx.fillRect(c, c - gap / 2, reach, gap); break;
    case 'left':  ctx.fillRect(c - reach, c - gap / 2, reach, gap); break;
    case 'up':    ctx.fillRect(c - gap / 2, c - reach, gap, reach); break;
    case 'down':  ctx.fillRect(c - gap / 2, c, gap, reach); break;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** Smallest logMAR on the 0.1 grid that is still drawable at distanceMm (null if even 1.3 is not). */
export function screenFloorLogmar(distanceMm, pxPerMm) {
  for (let t = 13; t >= -10; t--) {
    if (!sizeFor(t / 10, distanceMm, pxPerMm).drawable) {
      return t === 13 ? null : (t + 1) / 10;
    }
  }
  return -1.0;
}
