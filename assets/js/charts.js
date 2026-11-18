const NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

function fmt(n) {
  return Number(n || 0).toLocaleString("fa-IR");
}

function chartSvg(width, height) {
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, class: "ow-chart-svg", role: "img" });
  svg.setAttribute("preserveAspectRatio", "none");
  return svg;
}

export function lineChart({ labels = [], values = [], color = "#3d6bff", height = 170, width = 520, area = true } = {}) {
  const svg = chartSvg(width, height);
  const pad = { top: 14, right: 10, bottom: 26, left: 44 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...values);
  const stepX = values.length > 1 ? innerW / (values.length - 1) : 0;
  const y = (v) => pad.top + innerH - (innerH * (Number(v) || 0)) / max;

  for (let i = 0; i <= 3; i++) {
    const gy = pad.top + (innerH * i) / 3;
    svg.append(svgEl("line", { x1: pad.left, y1: gy, x2: width - pad.right, y2: gy, class: "ow-grid" }));
    const label = svgEl("text", { x: pad.left - 6, y: gy + 3, class: "ow-axis", "text-anchor": "end" });
    label.textContent = fmt(Math.round((max * (3 - i)) / 3));
    svg.append(label);
  }

  const points = values.map((v, i) => [pad.left + stepX * i, y(v)]);
  if (area && points.length) {
    const areaPath = `M${pad.left},${pad.top + innerH} ` + points.map((p) => `L${p[0]},${p[1]}`).join(" ") + ` L${pad.left + stepX * (values.length - 1)},${pad.top + innerH} Z`;
    svg.append(svgEl("path", { d: areaPath, fill: color, opacity: "0.14" }));
  }
  if (points.length) {
    svg.append(svgEl("path", { d: points.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" "), fill: "none", stroke: color, "stroke-width": 2.4, "stroke-linecap": "round" }));
  }
  points.forEach((p, i) => {
    const dot = svgEl("circle", { cx: p[0], cy: p[1], r: 3, fill: color });
    const t = svgEl("title");
    t.textContent = `${labels[i] || ""}: ${fmt(values[i])}`;
    dot.append(t);
    svg.append(dot);
  });
  labels.forEach((label, i) => {
    const t = svgEl("text", { x: pad.left + stepX * i, y: height - 8, class: "ow-axis", "text-anchor": "middle" });
    t.textContent = label;
    svg.append(t);
  });
  return svg;
}

export function barChart({ labels = [], values = [], color = "#f5b23e", height = 170, width = 520 } = {}) {
  const svg = chartSvg(width, height);
  const pad = { top: 14, right: 10, bottom: 26, left: 44 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...values);
  const slot = innerW / Math.max(1, values.length);
  const bw = Math.min(46, slot * 0.56);
  for (let i = 0; i <= 3; i++) {
    const gy = pad.top + (innerH * i) / 3;
    svg.append(svgEl("line", { x1: pad.left, y1: gy, x2: width - pad.right, y2: gy, class: "ow-grid" }));
    const label = svgEl("text", { x: pad.left - 6, y: gy + 3, class: "ow-axis", "text-anchor": "end" });
    label.textContent = fmt(Math.round((max * (3 - i)) / 3));
    svg.append(label);
  }
  values.forEach((v, i) => {
    const h = (innerH * (Number(v) || 0)) / max;
    const x = pad.left + slot * i + (slot - bw) / 2;
    const rect = svgEl("rect", { x, y: pad.top + innerH - h, width: bw, height: Math.max(1, h), rx: 5, fill: color, opacity: "0.8" });
    const t = svgEl("title");
    t.textContent = `${labels[i] || ""}: ${fmt(v)}`;
    rect.append(t);
    svg.append(rect);
    const label = svgEl("text", { x: pad.left + slot * i + slot / 2, y: height - 8, class: "ow-axis", "text-anchor": "middle" });
    label.textContent = labels[i] || "";
    svg.append(label);
  });
  return svg;
}

export function donut({ items = [], size = 150, thickness = 17 } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "ow-donut";
  const svg = svgEl("svg", { viewBox: `0 0 ${size} ${size}`, class: "ow-chart-svg" });
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const total = items.reduce((s, it) => s + (Number(it.value) || 0), 0);
  const circ = 2 * Math.PI * r;
  svg.append(svgEl("circle", { cx, cy, r, fill: "none", stroke: "rgba(255,255,255,.07)", "stroke-width": thickness }));
  let offset = 0;
  items.forEach((it) => {
    const share = total ? (Number(it.value) || 0) / total : 0;
    if (!share) return;
    const arc = svgEl("circle", {
      cx, cy, r, fill: "none", stroke: it.color || "#3d6bff", "stroke-width": thickness,
      "stroke-dasharray": `${circ * share} ${circ}`,
      "stroke-dashoffset": `${-circ * offset}`,
      transform: `rotate(-90 ${cx} ${cy})`,
      "stroke-linecap": "butt"
    });
    const t = svgEl("title");
    t.textContent = `${it.label}: ${fmt(it.value)}`;
    arc.append(t);
    svg.append(arc);
    offset += share;
  });
  const totalText = svgEl("text", { x: cx, y: cy - 2, "text-anchor": "middle", class: "ow-donut-total" });
  totalText.textContent = fmt(total);
  const totalLbl = svgEl("text", { x: cx, y: cy + 15, "text-anchor": "middle", class: "ow-axis" });
  totalLbl.textContent = "کل";
  svg.append(totalText, totalLbl);
  const legend = document.createElement("div");
  legend.className = "ow-donut-legend";
  if (!items.length) legend.textContent = "دادهای نیست.";
  for (const it of items) {
    const row = document.createElement("span");
    row.className = "ow-donut-key";
    const dot = document.createElement("i");
    dot.style.background = it.color || "#3d6bff";
    row.append(dot, `${it.label} · ${fmt(it.value)}`);
    legend.append(row);
  }
  wrap.append(svg, legend);
  return wrap;
}

export function sparkline(values = [], color = "#3d6bff", width = 120, height = 34) {
  const svg = chartSvg(width, height);
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const pts = values.map((v, i) => `${i ? "L" : "M"}${step * i},${height - (height * (Number(v) || 0)) / max - 2}`).join(" ");
  svg.append(svgEl("path", { d: pts, fill: "none", stroke: color, "stroke-width": 2, "stroke-linecap": "round" }));
  return svg;
}
