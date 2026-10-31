// ChatGPT Voice Player: puts an audio player under every finished assistant reply on chatgpt.com.
// The audio comes from the same endpoint ChatGPT's own Read Aloud uses, /backend-api/synthesize,
// and is fetched only when Play is clicked: requesting every reply in advance ran into ChatGPT's rate limits.

const RATES = [1, 1.25, 1.5, 1.75, 2];
const DEFAULTS = { voice: "", rate: 1 };

const settings = { ...DEFAULTS };
const players = new Map(); // message id -> Player

const ICONS = {
  play: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="16" height="16"><rect fill="currentColor" x="6" y="5" width="4" height="14" rx="1"/><rect fill="currentColor" x="14" y="5" width="4" height="14" rx="1"/></svg>',
  retry: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"/></svg>',
  download: '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 4v11m-5-5 5 5 5-5M5 20h14"/></svg>',
};

// ---------- ChatGPT API ----------

let tokenPromise = null;

function accessToken(renew) {
  if (renew || !tokenPromise) {
    tokenPromise = fetch("/api/auth/session", { credentials: "include", cache: "no-store" })
      .then((r) => r.json())
      .then((session) => {
        if (!session.accessToken) throw new Error("Sign in to ChatGPT first");
        return session.accessToken;
      });
    tokenPromise.catch(() => (tokenPromise = null));
  }
  return tokenPromise;
}

function cookie(name) {
  const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return match ? decodeURIComponent(match[1]) : "";
}

async function api(path) {
  for (let attempt = 0; ; attempt++) {
    const headers = { Authorization: "Bearer " + (await accessToken(attempt > 0)) };
    const device = cookie("oai-did");
    if (device) headers["oai-device-id"] = device;
    const response = await fetch(path, { headers, credentials: "include" });
    if (response.status !== 401 || attempt) return response;
  }
}

let accountVoicePromise = null;

// The voice picked in ChatGPT settings, unless the popup overrides it.
async function voice() {
  if (settings.voice) return settings.voice;
  if (!accountVoicePromise) {
    accountVoicePromise = api("/backend-api/settings/voices")
      .then((r) => (r.ok ? r.json() : {}))
      .then((data) => {
        if (data.voices) {
          const voices = data.voices.map((v) => ({ id: v.voice, name: v.name, description: v.description }));
          chrome.storage.local.set({ voices, accountVoice: data.selected || "" });
        }
        return data.selected || "";
      })
      .catch(() => "");
  }
  return accountVoicePromise;
}

async function synthesize(conversationId, messageId) {
  const params = new URLSearchParams({ message_id: messageId, conversation_id: conversationId, format: "mp3" });
  const v = await voice();
  if (v) params.set("voice", v);
  const response = await api("/backend-api/synthesize?" + params);
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = typeof body.detail === "string" ? body.detail : body.detail?.message || body.error?.message || "";
    } catch {}
    throw new Error(`Read Aloud failed (${response.status})${detail ? ": " + detail : ""}`);
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error("Read Aloud returned no audio");
  return new Blob([blob], { type: "audio/mpeg" });
}

// ---------- player ----------

function clock(seconds) {
  if (!isFinite(seconds)) seconds = 0;
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

class Player {
  constructor(conversationId, messageId) {
    this.conversationId = conversationId;
    this.messageId = messageId;
    this.state = "idle"; // idle, loading, ready, error
    this.wantsPlay = false;
    this.audio = new Audio();
    this.audio.preload = "auto";

    const root = (this.root = document.createElement("div"));
    root.className = "cvp-player";
    root.dataset.messageId = messageId;
    root.innerHTML =
      '<button type="button" class="cvp-play" aria-label="Play"></button>' +
      '<input type="range" class="cvp-seek" min="0" max="1" step="any" value="0" aria-label="Seek">' +
      '<span class="cvp-time">0:00</span>' +
      '<button type="button" class="cvp-rate" aria-label="Playback speed"></button>' +
      '<a class="cvp-download" aria-label="Download audio" title="Download MP3">' + ICONS.download + "</a>";
    this.button = root.querySelector(".cvp-play");
    this.seek = root.querySelector(".cvp-seek");
    this.time = root.querySelector(".cvp-time");
    this.rate = root.querySelector(".cvp-rate");
    this.download = root.querySelector(".cvp-download");

    this.button.addEventListener("click", () => this.toggle());
    this.seek.addEventListener("input", () => {
      if (this.state === "ready") this.audio.currentTime = +this.seek.value;
    });
    this.rate.addEventListener("click", () => {
      const next = RATES[(RATES.indexOf(settings.rate) + 1) % RATES.length] || 1;
      chrome.storage.sync.set({ rate: next });
      applyRate(next);
    });

    const audio = this.audio;
    audio.addEventListener("play", () => {
      for (const other of players.values()) if (other !== this) other.audio.pause();
      this.mediaSession();
      this.render();
    });
    audio.addEventListener("pause", () => this.render());
    audio.addEventListener("loadedmetadata", () => this.render());
    audio.addEventListener("durationchange", () => this.render());
    audio.addEventListener("timeupdate", () => this.render());
    audio.addEventListener("ended", () => {
      audio.currentTime = 0;
      this.render();
    });
    this.setRate(settings.rate);
    this.render();
  }

  async load() {
    this.setState("loading");
    try {
      const blob = await synthesize(this.conversationId, this.messageId);
      if (this.destroyed) return;
      this.url = URL.createObjectURL(blob);
      this.audio.src = this.url;
      this.audio.playbackRate = this.audio.defaultPlaybackRate = settings.rate;
      this.download.href = this.url;
      this.download.download = `chatgpt-${this.messageId.slice(0, 8)}.mp3`;
      this.setState("ready");
      if (this.wantsPlay) this.audio.play().catch(() => {});
    } catch (error) {
      this.error = error.message || String(error);
      this.setState("error");
    }
    this.wantsPlay = false;
  }

  toggle() {
    if (this.state === "ready") {
      this.audio.paused ? this.audio.play().catch(() => {}) : this.audio.pause();
    } else if (this.state === "error" || this.state === "idle") {
      this.wantsPlay = true;
      this.load();
    } else {
      this.wantsPlay = !this.wantsPlay; // a second click while loading cancels the auto-start
      this.render();
    }
  }

  setState(state) {
    this.state = state;
    this.render();
  }

  setRate(rate) {
    this.audio.playbackRate = this.audio.defaultPlaybackRate = rate;
    this.rate.textContent = rate + "×";
  }

  mediaSession() {
    const session = navigator.mediaSession;
    if (!session) return;
    session.metadata = new MediaMetadata({ title: "ChatGPT reply", artist: "ChatGPT Read Aloud" });
    session.setActionHandler("play", () => this.audio.play());
    session.setActionHandler("pause", () => this.audio.pause());
    session.setActionHandler("stop", () => {
      this.audio.pause();
      this.audio.currentTime = 0;
    });
    session.setActionHandler("seekbackward", () => (this.audio.currentTime -= 10));
    session.setActionHandler("seekforward", () => (this.audio.currentTime += 10));
  }

  render() {
    const { audio, state } = this;
    const busy = state === "loading";
    this.root.dataset.state = state;
    this.root.classList.toggle("cvp-wants-play", busy && this.wantsPlay);
    const playing = state === "ready" && !audio.paused;
    this.button.innerHTML = state === "error" ? ICONS.retry : playing ? ICONS.pause : ICONS.play;
    this.button.setAttribute("aria-label", state === "error" ? "Retry" : playing ? "Pause" : "Play");
    this.button.title = state === "error" ? this.error + " — click to retry" : busy ? "Loading audio…" : "";
    this.seek.disabled = state !== "ready";
    if (state === "ready") {
      this.seek.max = audio.duration || 1;
      this.seek.value = audio.currentTime;
      this.time.textContent = `${clock(audio.currentTime)} / ${clock(audio.duration)}`;
    } else {
      this.time.textContent = state === "error" ? "Error" : busy ? "Loading…" : "0:00";
    }
    this.root.style.setProperty("--cvp-progress", state === "ready" && audio.duration ? audio.currentTime / audio.duration : 0);
  }

  destroy() {
    this.destroyed = true;
    this.audio.pause();
    this.audio.removeAttribute("src");
    if (this.url) URL.revokeObjectURL(this.url);
    this.root.remove();
  }
}

function applyRate(rate) {
  settings.rate = rate;
  for (const player of players.values()) player.setRate(rate);
}

// ---------- page scanning ----------

// ChatGPT's markup changes often, so every lookup tries the current layout first and the older one after.
const MESSAGE = "[data-chatgpt-selection-message-id], [data-message-author-role='assistant'][data-message-id]";
const TURN = "[data-talvt-turn-state], article, [data-testid^='conversation-turn']";
const ACTIONS = ".turn-action-controls";
const READ_ALOUD = /^(read aloud|прочитать вслух|озвучить|vorlesen|lire à voix haute|leer en voz alta)$/i;

function messageId(message) {
  return message.dataset.chatgptSelectionMessageId || message.dataset.messageId;
}

function conversationOf(message) {
  if (message.dataset.chatgptSelectionConversationId) return message.dataset.chatgptSelectionConversationId;
  const match = location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
  return match ? match[1] : null;
}

function isAssistant(message) {
  if (message.dataset.messageAuthorRole) return message.dataset.messageAuthorRole === "assistant";
  const unit = message.closest("[data-chatgpt-search-unit-key]");
  return !unit || unit.dataset.chatgptSearchUnitKey.endsWith(":assistant");
}

function isStreaming(turn, message) {
  if (turn.dataset.talvtTurnState) return turn.dataset.talvtTurnState !== "complete";
  if (turn.querySelector(".result-streaming, [data-is-streaming='true']")) return true;
  // While a reply is being written the composer shows a stop button; only the last reply can be streaming.
  if (!document.querySelector('[data-testid="stop-button"]')) return false;
  const all = document.querySelectorAll(MESSAGE);
  return all[all.length - 1] === message;
}

function scan() {
  const seen = new Set();
  const turns = new Map(); // turn element -> its last assistant message
  for (const message of document.querySelectorAll(MESSAGE)) {
    if (isAssistant(message)) turns.set(message.closest(TURN) || message.parentElement, message);
  }
  for (const [turn, message] of turns) {
    const id = messageId(message);
    const cid = conversationOf(message);
    if (!id || !cid || isStreaming(turn, message) || !message.textContent.trim()) continue;
    let player = players.get(id);
    if (!player) {
      player = new Player(cid, id);
      players.set(id, player);
    }
    // Right above the copy / like / read aloud buttons, or right after the text in older layouts.
    // A turn holds the question too, with its own action bar; the reply's bar is the last one.
    const actions = [...turn.querySelectorAll(ACTIONS)].pop();
    const placed = actions ? player.root.nextElementSibling === actions : player.root.previousElementSibling === message;
    if (!placed || !player.root.isConnected) actions ? actions.before(player.root) : message.after(player.root);
    seen.add(id);
  }
  for (const [id, player] of players) {
    if (!seen.has(id)) {
      player.destroy();
      players.delete(id);
    }
  }
}

// ChatGPT's own Read Aloud cannot pause or seek; its button starts this reply's player instead.
document.addEventListener(
  "click",
  (event) => {
    const button = event.target.closest?.("button[aria-label]");
    if (!button || !READ_ALOUD.test(button.getAttribute("aria-label").trim())) return;
    const turn = button.closest(TURN);
    const player = turn && [...players.values()].find((p) => turn.contains(p.root));
    if (!player) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    player.toggle();
  },
  true
);

let scheduled = false;
function scheduleScan() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    scan();
  }, 250);
}

chrome.storage.sync.get(DEFAULTS).then((stored) => {
  Object.assign(settings, stored);
  new MutationObserver((mutations) => {
    // Ignore our own player updates; react to everything else.
    if (mutations.every((m) => (m.target.nodeType === 1 ? m.target : m.target.parentElement)?.closest(".cvp-player"))) return;
    scheduleScan();
  }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-testid", "data-message-id", "data-talvt-turn-state", "data-chatgpt-selection-message-id"] });
  scan();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.rate) applyRate(changes.rate.newValue || 1);
  if (changes.voice) {
    settings.voice = changes.voice.newValue || "";
    accountVoicePromise = null;
    for (const player of players.values()) player.destroy();
    players.clear();
    scan();
  }
});
