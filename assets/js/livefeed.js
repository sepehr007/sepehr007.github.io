/* Smart transient feed: one message at a time with fade + a quiet gap. */
export class LiveFeed {
  constructor(host, { gap = 1500, hold = 4600, max = 6 } = {}) {
    this.host = host;
    this.gap = gap;
    this.hold = Math.max(1200, hold);
    this.max = max;
    this.queue = [];
    this.busy = false;
    this.paused = false;
    this.timer = 0;
    this.node = null;
  }

  setPaused(on) {
    this.paused = !!on;
    if (this.paused) {
      this.clear();
    } else {
      this.#next();
    }
  }

  push(item) {
    if (!this.host || !item) return;
    const name = String(item.name || "").slice(0, 24);
    const text = String(item.text || "").slice(0, 280);
    if (!text) return;
    this.queue.push({ name, text, mine: !!item.mine });
    if (this.queue.length > this.max) this.queue.splice(0, this.queue.length - this.max);
    this.#next();
  }

  clear() {
    this.queue.length = 0;
    clearTimeout(this.timer);
    if (this.node) {
      this.node.remove();
      this.node = null;
    }
    this.busy = false;
    this.host?.classList.remove("show");
  }

  #next() {
    if (this.busy || this.paused || !this.queue.length || !this.host) return;
    const item = this.queue.shift();
    this.busy = true;
    const row = document.createElement("div");
    row.className = `feed-item${item.mine ? " mine" : ""}`;
    const name = document.createElement("b");
    name.className = "feed-name";
    name.textContent = item.name || "?";
    const sep = document.createElement("span");
    sep.className = "feed-sep";
    sep.textContent = ":";
    const text = document.createElement("span");
    text.className = "feed-text";
    text.textContent = item.text;
    row.append(name, sep, text);
    this.host.append(row);
    this.host.classList.add("show");
    this.node = row;
    requestAnimationFrame(() => row.classList.add("on"));
    this.timer = setTimeout(() => {
      row.classList.remove("on");
      row.classList.add("out");
      this.timer = setTimeout(() => {
        row.remove();
        if (this.node === row) this.node = null;
        if (!this.host.children.length) this.host.classList.remove("show");
        this.busy = false;
        this.timer = setTimeout(() => this.#next(), this.gap);
      }, 480);
    }, this.hold);
  }
}
