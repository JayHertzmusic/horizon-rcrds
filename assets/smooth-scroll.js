'use strict';
/* Smooth wheel scrolling with self-hosted Lenis (MIT, see vendor/LENIS-LICENSE.txt), desktop mouse/trackpad only.
   Lenis only takes wheel input it can fully own, so it never moves the page at the same time as the browser:
   touch, keyboard, inner scroll panels and every scroll requested by page code stay native.
   Overlays that scroll on their own ([data-lenis-panel]) get their own instance while open,
   with the same glide; the page's instance is stopped meanwhile. */
(() => {
  if (!window.Lenis) return;
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const desktop = matchMedia('(hover: hover) and (pointer: fine)');
  const LERP = 0.085; // glide length: lower = longer inertia (Lenis default 0.1)
  // The final stretch brakes with constant deceleration from the point where the glide drops below one pixel per
  // 60 Hz frame (SETTLE_SPEED), i.e. where the hops started; everything before it is Lenis's own glide.
  const SETTLE_SPEED = 60; // px/s
  let lenis = null, internal = false;
  const panels = new Map(); // overlay scroller → its own Lenis

  // The sites lock the page themselves (modal <dialog>, or body overflow:hidden for the main site's overlays).
  function pageLocked() {
    let modal;
    try { modal = document.querySelector('dialog:modal'); } catch { modal = document.querySelector('dialog[open]'); }
    const body = document.body.style;
    return !!modal || body.overflow === 'hidden' || body.position === 'fixed';
  }
  const wanted = () => desktop.matches && !reduced.matches;
  const shown = el => el.isConnected && el.getClientRects().length > 0 && (!el.closest('dialog') || el.closest('dialog').open);
  function sync() {
    if (lenis) {
      if (pageLocked()) { if (!lenis.isStopped) lenis.stop(); }
      else if (lenis.isStopped) lenis.start();
    }
    // One instance per visible overlay scroller: created when its dialog opens, destroyed when it closes.
    for (const [el, inst] of panels) if (!wanted() || !shown(el)) { inst.destroy(); panels.delete(el); }
    if (wanted()) document.querySelectorAll('[data-lenis-panel]').forEach(el => { if (!panels.has(el) && shown(el)) panels.set(el, create(el)); });
  }
  // Stop smooth inertia before anything else scrolls, so two animations never compete.
  function settle() {
    if (internal) return;
    for (const inst of [lenis, ...panels.values()]) if (inst && inst.isScrolling === 'smooth') inst.reset();
  }
  // Inner panels keep native scrolling while they can still move in that direction. <body> and <html> (and the
  // overlay's own scroller) are skipped on purpose: overflow-x:hidden makes body report overflow-y:auto, and
  // treating it as a nested scroller hands part of the wheel events back to the browser (mixed, flickering scroll).
  function innerScroll(target, dx, dy, scroller) {
    const vertical = Math.abs(dy) >= Math.abs(dx), delta = vertical ? dy : dx;
    for (let el = target instanceof Element ? target : target?.parentElement; el && el !== document.body && el !== root && el !== scroller; el = el.parentElement) {
      // Firefox reports overflow:visible for <textarea> even though it scrolls its own text.
      const overflow = el.tagName === 'TEXTAREA' ? 'auto' : getComputedStyle(el)[vertical ? 'overflowY' : 'overflowX'];
      if (!/auto|scroll|overlay/.test(overflow)) continue;
      const max = vertical ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
      if (max <= 1) continue;
      const position = vertical ? el.scrollTop : el.scrollLeft;
      if (delta > 0 ? position < max - 1 : position > 1) return true;
    }
    return false;
  }
  /** scroller: undefined = the page; an element = an overlay that scrolls on its own. */
  function create(scroller) {
    const inst = new Lenis({
      ...(scroller && { wrapper: scroller, content: scroller }),
      autoRaf: true, lerp: LERP, smoothWheel: true, syncTouch: false, anchors: false,
      allowNestedScroll: false, stopInertiaOnNavigate: true,
      // No Lenis "prevent" list: an element it skips (e.g. a form textarea or select) would let the browser
      // scroll while the inertia keeps running. Every hand-over to the browser goes through settle().
      virtualScroll({ deltaX, deltaY, event }) {
        if (event.type !== 'wheel') return true; // touch stays native (syncTouch:false)
        if (!scroller) { sync(); if (inst.isStopped) return false; } // overlay open: the page stays locked
        // Chrome makes the rest of a wheel sequence non-cancelable when its first event was not handled;
        // those, zoom gestures, opted-out areas and inner panels that can still move belong to the browser.
        const optOut = event.target instanceof Element && event.target.closest('[data-lenis-prevent]');
        if (!event.cancelable || event.ctrlKey || optOut || innerScroll(event.target, deltaX, deltaY, scroller)) { settle(); return false; }
        const height = scroller ? scroller.scrollHeight : root.scrollHeight;
        if (inst.dimensions.scrollHeight !== height) inst.dimensions.resize(); // content changed (SPA, releases, new product)
        return true;
      },
    });
    const setScroll = inst.setScroll;
    inst.setScroll = function (value) { internal = true; try { return setScroll.call(this, value); } finally { internal = false; } };
    // Lenis's damping never reaches zero: over the last ~10 px it moves less than a pixel per frame, the browser
    // paints whole pixels, and the glide ended in 1 px hops with growing pauses (85 and ~180 ms). A steady
    // minimum speed fixed that but stopped dead. Now only the last few px brake with constant deceleration
    // (like friction), matched to Lenis's speed at that point: same glide, speed eases to zero without hops.
    const animate = inst.animate;
    if (animate && typeof animate.advance === 'function') {
      const advance = animate.advance;
      animate.advance = function (dt) {
        if (!this.isRunning || !this.lerp || (this.duration && this.easing)) return advance.call(this, dt);
        const lambda = this.lerp * 60, settle = SETTLE_SPEED / lambda, gap = this.to - this.value, dist = Math.abs(gap);
        let rest;
        if (dist > settle) rest = dist * Math.exp(-lambda * dt); // Lenis's own damping
        else {
          const decel = lambda * lambda * settle / 2, left = Math.sqrt(2 * dist / decel); // v = λ·√(settle·dist)
          rest = dt >= left ? 0 : decel * (left - dt) ** 2 / 2;
        }
        this.value = this.to - Math.sign(gap) * rest;
        const done = Math.round(this.value) === Math.round(this.to);
        if (done) { this.value = this.to; this.stop(); }
        this.onUpdate?.(this.value, done);
      };
    }
    // The page swaps the overlay's content and resets its scroll (next/previous product): drop any glide in
    // progress so it never drags the new content, and measure the new height.
    const swap = scroller && new MutationObserver(() => { if (inst.isScrolling === 'smooth') inst.reset(); inst.dimensions.resize(); });
    swap?.observe(scroller, { childList: true });
    // Lenis leaves its 400 ms velocity timer running on destroy; it would put the "lenis" class back afterwards.
    const destroy = inst.destroy.bind(inst);
    inst.destroy = () => { swap?.disconnect(); clearTimeout(inst._resetVelocityTimeout); destroy(); };
    return inst;
  }
  function setup() {
    if (wanted() && !lenis) lenis = create();
    else if (!wanted() && lenis) { lenis.destroy(); lenis = null; }
    sync();
  }
  for (const [owner, name] of [[window, 'scrollTo'], [window, 'scroll'], [window, 'scrollBy'], [Element.prototype, 'scrollIntoView']]) {
    const original = owner[name];
    if (typeof original === 'function') owner[name] = function (...args) { settle(); return original.apply(this, args); };
  }
  addEventListener('keydown', event => {
    if (/^(Arrow(Up|Down)|Page(Up|Down)|Home|End| )$/.test(event.key) && !event.target.closest?.('input,textarea,select,[contenteditable]')) settle();
  }, true);
  document.addEventListener('click', event => { const link = event.target.closest?.('a[href*="#"]'); if (link?.pathname === location.pathname) settle(); }, true);
  addEventListener('pointerdown', event => { if (event.target === root || panels.has(event.target)) settle(); }, true); // scrollbar drag
  addEventListener('popstate', settle);
  addEventListener('pageshow', () => { lenis?.resize(); sync(); });
  const observer = new MutationObserver(sync);
  observer.observe(document.body, { attributes: true, attributeFilter: ['style'] });
  observer.observe(root, { subtree: true, attributes: true, attributeFilter: ['open'] });
  document.addEventListener('close', sync, true);
  reduced.addEventListener('change', setup);
  desktop.addEventListener('change', setup);
  setup();
  window.HZScroll = { get active() { return !!lenis && !lenis.isStopped; }, get lenis() { return lenis; }, get panels() { return panels; } };
})();
