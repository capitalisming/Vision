// AI-assisted (Claude Code), reviewed by a team member.
// Scroll story on the home screen: sets --p on the home section, 0 at the top of the page and 1 at the
// bottom, with light smoothing. All visual changes (zoom, dimming, pupil, ring) are CSS that reads --p.

/** Scroll progress in [0, 1]; 0 when the page does not scroll at all. */
export function progress(scrollY, scrollHeight, viewportHeight) {
  const range = scrollHeight - viewportHeight;
  if (!(range > 0)) return 0;
  return Math.min(1, Math.max(0, scrollY / range));
}

const SMOOTHING = 0.14; // share of the remaining distance covered per frame
const SETTLED = 0.0005;

/**
 * Start driving `--p` on `section`. Returns a function to call when the section is shown, so the value
 * matches the current scroll position. Does nothing (the eye stays still) for reduced-motion users.
 * @param {HTMLElement} section
 * @param {() => boolean} isActive  true while the section is the visible screen
 */
export function initHomeScroll(section, isActive) {
  if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return () => {};
  let target = 0;
  let current = 0;
  let raf = 0;

  function frame() {
    raf = 0;
    current += (target - current) * SMOOTHING;
    if (Math.abs(target - current) < SETTLED) current = target;
    section.style.setProperty('--p', current.toFixed(4));
    if (current !== target) raf = requestAnimationFrame(frame);
  }
  function update() {
    if (!isActive()) return;
    target = progress(window.scrollY, document.documentElement.scrollHeight, window.innerHeight);
    if (!raf) raf = requestAnimationFrame(frame);
  }

  window.addEventListener('scroll', update, { passive: true });
  window.addEventListener('resize', update);
  return update;
}
