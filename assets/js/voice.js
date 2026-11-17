export class Voice {
  constructor({ net, selfId, onSpeaking, onPeers, onError }) {
    this.net = net;
    this.selfId = selfId;
    this.onSpeaking = onSpeaking || (() => {});
    this.onPeers = onPeers || (() => {});
    this.onError = onError || (() => {});

    this.stream = null;
    this.joined = false;
    this.muted = false;
    this.deafened = false;
    this.calls = new Map();      // peerId -> MediaConnection
    this.audios = new Map();     // peerId -> HTMLAudioElement
    this.analysers = new Map();  // peerId -> {analyser, data, timer}
    this.volumes = new Map();
    this.ctx = null;
    this.loop = null;
    this.speaking = new Map();
  }

  async join() {
    if (this.joined) return true;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.onError("mic-insecure");
      return false;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
    } catch (err) {
      const name = err?.name || "";
      this.onError(
        name === "NotAllowedError" || name === "SecurityError" ? "mic-denied"
          : name === "NotFoundError" || name === "OverconstrainedError" ? "mic-missing"
            : "mic"
      );
      return false;
    }
    this.stream = stream;
    this.joined = true;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    await this.ctx.resume().catch(() => {});
    this.#attachAnalyser("self", stream);
    this.#startLoop();
    this.#syncVoicePeers();
    return true;
  }

  leave() {
    this.joined = false;
    for (const [, call] of this.calls) { try { call.close(); } catch {} }
    this.calls.clear();
    for (const [, audio] of this.audios) { audio.srcObject = null; audio.remove(); }
    this.audios.clear();
    this.#stopAnalysers();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    try { this.ctx?.close(); } catch {}
    this.ctx = null;
    this.muted = false;
    this.deafened = false;
  }

  setMuted(muted) {
    this.muted = !!muted;
    this.stream?.getAudioTracks().forEach((t) => { t.enabled = !this.muted; });
    if (this.muted) this.#reportSpeaking("self", false);
    return this.muted;
  }

  setDeafened(deaf) {
    this.deafened = !!deaf;
    for (const [, audio] of this.audios) audio.muted = this.deafened;
  }

  setVolume(peerId, value) {
    const v = Math.max(0, Math.min(1, Number(value)));
    this.volumes.set(peerId, v);
    const audio = this.audios.get(peerId);
    if (audio) audio.volume = v;
  }

  /* other side turned voice on/off */
  peerVoice(peerId, on) {
    if (!this.joined || peerId === this.selfId) return;
    if (!on) return this.removePeer(peerId);
    if (this.calls.has(peerId) || this.audios.has(peerId)) return;
    if (this.selfId.localeCompare(peerId) > 0) this.#call(peerId);
  }

  #call(peerId) {
    if (!this.stream || !this.joined || this.calls.has(peerId)) return;
    try {
      const call = this.net.call(peerId, this.stream);
      if (!call) return;
      this.calls.set(peerId, call);
      call.on("stream", (remote) => this.#attachRemote(peerId, remote));
      call.on("close", () => this.removePeer(peerId));
      call.on("error", () => this.removePeer(peerId));
    } catch {}
  }

  handleCall(call) {
    if (!this.joined || !this.stream) {
      try { call.close(); } catch {}
      return;
    }
    const peerId = call.peer;
    if (this.calls.has(peerId)) { try { call.close(); } catch {} return; }
    this.calls.set(peerId, call);
    call.answer(this.stream);
    call.on("stream", (remote) => this.#attachRemote(peerId, remote));
    call.on("close", () => this.removePeer(peerId));
    call.on("error", () => this.removePeer(peerId));
  }

  removePeer(peerId) {
    const call = this.calls.get(peerId);
    if (call) { try { call.close(); } catch {} this.calls.delete(peerId); }
    const audio = this.audios.get(peerId);
    if (audio) { audio.srcObject = null; audio.remove(); this.audios.delete(peerId); }
    this.#detachAnalyser(peerId);
    this.speaking.delete(peerId);
    this.onPeers?.([...this.audios.keys()]);
  }

  #attachRemote(peerId, stream) {
    let audio = this.audios.get(peerId);
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      audio.playsInline = true;
      document.body.append(audio);
      this.audios.set(peerId, audio);
    }
    audio.srcObject = stream;
    audio.muted = this.deafened;
    audio.volume = this.volumes.get(peerId) ?? 1;
    audio.play?.().catch(() => {});
    this.#attachAnalyser(peerId, stream);
    this.onPeers?.([...this.audios.keys()]);
  }

  /* ---------- speaking detection ---------- */
  #attachAnalyser(id, stream) {
    if (!this.ctx) return;
    this.#detachAnalyser(id);
    try {
      const src = this.ctx.createMediaStreamSource(stream);
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.75;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      this.analysers.set(id, { analyser, data, src });
    } catch {}
  }
  #detachAnalyser(id) {
    const entry = this.analysers.get(id);
    if (entry) {
      try { entry.src.disconnect(); } catch {}
      this.analysers.delete(id);
    }
  }
  #stopAnalysers() {
    for (const id of [...this.analysers.keys()]) this.#detachAnalyser(id);
    clearInterval(this.loop);
    this.loop = null;
  }

  #startLoop() {
    clearInterval(this.loop);
    this.loop = setInterval(() => {
      for (const [id, { analyser, data }] of this.analysers) {
        if (id === "self" && (this.muted || !this.stream)) { this.#reportSpeaking(id, false); continue; }
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const level = sum / data.length;
        this.#reportSpeaking(id, level > 12);
      }
    }, 160);
  }

  #reportSpeaking(id, active) {
    if (this.speaking.get(id) === active) return;
    this.speaking.set(id, active);
    this.onSpeaking(id, active);
  }

  #syncVoicePeers() {
    this.onPeers?.([...this.audios.keys()]);
  }
}
