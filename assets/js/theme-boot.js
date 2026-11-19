(function () {
  var d = document.documentElement;
  var me = document.currentScript;
  if (me && me.getAttribute("data-force") === "dark") { d.setAttribute("data-theme", "dark"); return; }
  try {
    var raw = localStorage.getItem("wt.boot");
    if (!raw || raw.length > 6000) return;
    var b = JSON.parse(raw);
    if (!b || (b.theme !== "light" && b.theme !== "dark")) return;
    d.setAttribute("data-theme", b.theme);
    var vars = b.vars || {};
    for (var k in vars) {
      var v = vars[k];
      if (/^--[a-z0-9-]{1,40}$/i.test(k) && typeof v === "string" && v.length < 200 && !/[;{}<>]|url\(/i.test(v)) d.style.setProperty(k, v);
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta && /^#[0-9a-f]{6}$/i.test(b.meta || "")) meta.content = b.meta;
  } catch (e) {}
})();
