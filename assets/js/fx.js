const fine = matchMedia("(hover: hover) and (pointer: fine)");
const reduce = matchMedia("(prefers-reduced-motion: reduce)");
const SPOT = ".card,.why-card,.audience-card,.how-step,.v8-feature,.price-card,.ocard,.ostat";

if (fine.matches && !reduce.matches) {
  let frame = 0;
  let last = null;
  document.addEventListener("pointermove", (e) => {
    last = e;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const el = last.target instanceof Element ? last.target.closest(SPOT) : null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${last.clientX - r.left}px`);
      el.style.setProperty("--my", `${last.clientY - r.top}px`);
    });
  }, { passive: true });
}
