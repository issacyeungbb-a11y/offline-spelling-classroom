(() => {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const keyboard = byId("keyboard");
  const display = byId("displayText");
  const feedback = byId("feedback");
  const offlineState = byId("offlineState");
  const letters = "abcdefghijklmnopqrstuvwxyz".split("");
  const punctuation = [".", ",", "?", "!"];
  // Spoken names of the letters. A bare capital such as "A" is read as "Capital A" by some voices,
  // so the letter name is spelled out the way it sounds.
  const letterSounds = {
    a: "ay", b: "bee", c: "cee", d: "dee", e: "ee", f: "eff", g: "gee", h: "aitch", i: "eye",
    j: "jay", k: "kay", l: "ell", m: "em", n: "en", o: "oh", p: "pee", q: "cue", r: "are",
    s: "ess", t: "tee", u: "you", v: "vee", w: "double you", x: "ex", y: "why", z: "zed"
  };
  const settingsKey = "offline-speller-settings-v1";
  const autoReadMigrationKey = "offline-speller-auto-read-default-v2";
  const defaults = {
    accent: "en-GB",
    rate: 0.8,
    volume: 1,
    readLetters: true,
    autoReadWords: false,
    delay: 1.5
  };

  let settings = { ...defaults };
  let text = "";
  let dictionary = new Set();
  let dictionaryReady = false;
  let revision = 0;
  let autoReadTimer = null;
  let lastAutoSpoken = null;
  let voices = [];
  let currentSpeech = null;
  let speechToken = 0;
  let speechStartTimer = null;
  let speechCancelFallbackTimer = null;
  let pendingSpeech = null;

  function normalizeWord(word) {
    return word.trim().toLocaleLowerCase("en").replace(/[’]/g, "'");
  }

  function setFeedback(message, unknown = false) {
    feedback.textContent = message;
    feedback.classList.toggle("unknown", unknown);
  }

  function renderText() {
    if (text.length === 0) {
      display.textContent = "Start typing in English…";
      display.classList.add("empty");
    } else {
      display.textContent = text;
      display.classList.remove("empty");
    }
    display.scrollTop = display.scrollHeight;
  }

  function latestWord() {
    const match = text.match(/[a-zA-Z']+$/);
    if (!match) return null;
    const word = match[0].replace(/^'+|'+$/g, "");
    return word ? normalizeWord(word) : null;
  }

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(settingsKey) || "null");
      if (saved && typeof saved === "object") settings = { ...defaults, ...saved };
      if (localStorage.getItem(autoReadMigrationKey) !== "done") {
        settings.autoReadWords = false;
        localStorage.setItem(settingsKey, JSON.stringify(settings));
        localStorage.setItem(autoReadMigrationKey, "done");
      }
    } catch {
      settings = { ...defaults };
    }
    settings.accent = settings.accent === "en-US" ? "en-US" : "en-GB";
    settings.rate = clamp(Number(settings.rate), 0.55, 1.1, defaults.rate);
    settings.volume = clamp(Number(settings.volume), 0.2, 1, defaults.volume);
    settings.delay = clamp(Number(settings.delay), 0.8, 3, defaults.delay);
    settings.readLetters = Boolean(settings.readLetters);
    settings.autoReadWords = Boolean(settings.autoReadWords);
    syncSettingsControls();
  }

  function clamp(value, min, max, fallback) {
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  }

  function saveSettings() {
    settings.accent = byId("accentSelect").value;
    settings.rate = Number(byId("rateRange").value);
    settings.volume = Number(byId("volumeRange").value);
    settings.readLetters = byId("lettersToggle").checked;
    settings.autoReadWords = byId("autoToggle").checked;
    settings.delay = Number(byId("delayRange").value);
    try {
      localStorage.setItem(settingsKey, JSON.stringify(settings));
    } catch {
      setFeedback("Could not save settings on this device. Other features are still available.", true);
    }
    syncSettingsControls();
  }

  function syncSettingsControls() {
    byId("accentSelect").value = settings.accent;
    byId("rateRange").value = String(settings.rate);
    byId("volumeRange").value = String(settings.volume);
    byId("lettersToggle").checked = settings.readLetters;
    byId("autoToggle").checked = settings.autoReadWords;
    byId("delayRange").value = String(settings.delay);
    byId("rateOutput").textContent = settings.rate < 0.75 ? "Slower" : settings.rate > 0.95 ? "Faster" : "Normal";
    byId("volumeOutput").textContent = `${Math.round(settings.volume * 100)}%`;
    byId("delayOutput").textContent = `${settings.delay.toFixed(1)} sec`;
    byId("delayRange").disabled = !settings.autoReadWords;
    refreshVoiceStatus();
  }

  function loadVoices() {
    if (!("speechSynthesis" in window)) return;
    const list = window.speechSynthesis.getVoices();
    if (list.length > 0) voices = list;
  }

  // Prefer a voice installed on the device, then any English voice the browser offers.
  function chosenVoice() {
    loadVoices();
    const target = settings.accent.toLowerCase();
    const english = voices.filter((voice) => /^en(-|$)/i.test(voice.lang));
    const rank = (list) => list.find((voice) => voice.lang.toLowerCase().replace("_", "-") === target)
      || list.find((voice) => voice.lang.toLowerCase().startsWith(target.slice(0, 2)))
      || null;
    return rank(english.filter((voice) => voice.localService === true)) || rank(english);
  }

  function refreshVoiceStatus() {
    const status = byId("voiceStatus");
    const voice = chosenVoice();
    if (voice && voice.localService === true) {
      status.textContent = `Available offline: ${voice.name} (${voice.lang})`;
      status.classList.remove("warning");
    } else if (voice) {
      status.textContent = `Using ${voice.name} (${voice.lang}). It may need internet; download an English voice in device settings for offline use.`;
      status.classList.add("warning");
    } else {
      status.textContent = "Using this device's default English voice. Download an English voice in device settings for offline use.";
      status.classList.add("warning");
    }
  }

  function cancelSpeech() {
    speechToken += 1;
    if (speechStartTimer !== null) {
      window.clearTimeout(speechStartTimer);
      speechStartTimer = null;
    }
    if (speechCancelFallbackTimer !== null) {
      window.clearTimeout(speechCancelFallbackTimer);
      speechCancelFallbackTimer = null;
    }
    pendingSpeech = null;
    currentSpeech = null;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    return speechToken;
  }

  function startPendingSpeech(token) {
    const pending = pendingSpeech;
    if (!pending || pending.token !== token || token !== speechToken) return;
    if (speechStartTimer !== null) {
      window.clearTimeout(speechStartTimer);
      speechStartTimer = null;
    }
    if (speechCancelFallbackTimer !== null) {
      window.clearTimeout(speechCancelFallbackTimer);
      speechCancelFallbackTimer = null;
    }
    pendingSpeech = null;
    currentSpeech = { kind: pending.kind, text: pending.text, token: pending.token };
    window.speechSynthesis.speak(pending.utterance);
  }

  function replaceSpeech(request, kind) {
    if (!("speechSynthesis" in window)) return false;
    const token = speechToken + 1;
    const utterance = makeUtterance(request, token);
    if (!utterance) return false;

    if (speechStartTimer !== null) {
      window.clearTimeout(speechStartTimer);
      speechStartTimer = null;
    }
    if (speechCancelFallbackTimer !== null) {
      window.clearTimeout(speechCancelFallbackTimer);
      speechCancelFallbackTimer = null;
    }

    const previousToken = currentSpeech?.token ?? null;
    speechToken = token;
    pendingSpeech = {
      kind,
      text: request.text,
      utterance,
      token,
      waitingForToken: previousToken
    };

    if (previousToken !== null) {
      // Wait for Safari's cancellation callback. The timer covers versions that omit it.
      speechCancelFallbackTimer = window.setTimeout(() => {
        speechCancelFallbackTimer = null;
        startPendingSpeech(token);
      }, 250);
    }

    window.speechSynthesis.cancel();

    if (previousToken === null && pendingSpeech?.token === token) {
      speechStartTimer = window.setTimeout(() => {
        speechStartTimer = null;
        startPendingSpeech(token);
      }, 0);
    }
    return true;
  }

  function makeUtterance(request, token) {
    if (!("speechSynthesis" in window)) {
      setFeedback("This browser cannot read text aloud.", true);
      return null;
    }
    const voice = chosenVoice();
    const utterance = new SpeechSynthesisUtterance(request.text);
    if (voice) utterance.voice = voice;
    utterance.lang = voice ? voice.lang : settings.accent;
    utterance.rate = settings.rate;
    utterance.volume = settings.volume;
    utterance.pitch = 1;
    utterance.onend = () => finishSpeech(token);
    utterance.onerror = (event) => {
      if (event.error && !["canceled", "interrupted"].includes(event.error)) {
        setFeedback(`Could not read aloud (${event.error}). Check device volume and voice settings.`, true);
      }
      finishSpeech(token);
    };
    return utterance;
  }

  function finishSpeech(token) {
    if (currentSpeech?.token === token) currentSpeech = null;

    if (pendingSpeech?.waitingForToken === token) {
      pendingSpeech.waitingForToken = null;
      if (speechCancelFallbackTimer !== null) {
        window.clearTimeout(speechCancelFallbackTimer);
        speechCancelFallbackTimer = null;
      }
      const pendingToken = pendingSpeech.token;
      speechStartTimer = window.setTimeout(() => {
        speechStartTimer = null;
        startPendingSpeech(pendingToken);
      }, 0);
    }
  }

  function speakLetter(letter) {
    if (!settings.readLetters) {
      cancelSpeech();
      return;
    }
    if (!("speechSynthesis" in window)) {
      setFeedback("This browser cannot read text aloud; the letter was added.", true);
      return;
    }
    const name = letter.toLowerCase();
    const zee = name === "z" && /^en-us/i.test(chosenVoice()?.lang || settings.accent);
    replaceSpeech({ text: zee ? "zee" : letterSounds[name] || name }, "letter");
  }

  function speakText(value) {
    if (!("speechSynthesis" in window)) {
      setFeedback("This browser cannot read text aloud.", true);
      return false;
    }
    return replaceSpeech({ text: value }, "word");
  }

  function cancelAutoRead() {
    if (autoReadTimer !== null) {
      window.clearTimeout(autoReadTimer);
      autoReadTimer = null;
    }
  }

  function confirmWord(word, spokenRevision) {
    if (!word || !dictionaryReady) return false;
    if (!dictionary.has(normalizeWord(word))) {
      setFeedback(`Word not found in the local word list: ${word}`, true);
      return false;
    }
    if (lastAutoSpoken?.word === word && lastAutoSpoken.revision === spokenRevision) return true;
    if (speakText(word)) {
      lastAutoSpoken = { word, revision: spokenRevision };
      setFeedback(`Spoken: ${word}`);
    }
    return true;
  }

  function scheduleAutoRead() {
    cancelAutoRead();
    if (!settings.autoReadWords || !latestWord()) return;
    const scheduledRevision = revision;
    autoReadTimer = window.setTimeout(() => {
      autoReadTimer = null;
      if (revision !== scheduledRevision || !settings.autoReadWords) return;
      const word = latestWord();
      if (word) confirmWord(word, scheduledRevision);
    }, settings.delay * 1000);
  }

  function enterLetter(letter) {
    if (!/^[a-z]$/i.test(letter)) return;
    cancelAutoRead();
    text += letter.toLowerCase();
    revision += 1;
    renderText();
    setFeedback("Typing…");
    speakLetter(letter);
    scheduleAutoRead();
  }

  function enterApostrophe() {
    if (!text || !/[a-z]$/i.test(text)) return;
    cancelAutoRead();
    text += "'";
    revision += 1;
    renderText();
    setFeedback("Typing…");
    scheduleAutoRead();
  }

  function enterSeparator(separator) {
    cancelAutoRead();
    const completedWord = latestWord();
    const completedRevision = revision;
    text += separator;
    revision += 1;
    renderText();

    if (!completedWord) {
      setFeedback("You can keep typing");
      return;
    }
    if (!settings.autoReadWords) {
      setFeedback("You can keep typing");
      return;
    }
    if (lastAutoSpoken?.word === completedWord && lastAutoSpoken.revision === completedRevision) {
      setFeedback(`Spoken: ${completedWord}`);
      return;
    }
    confirmWord(completedWord, completedRevision);
  }

  function deleteLast() {
    if (!text) return;
    cancelAutoRead();
    cancelSpeech();
    text = Array.from(text).slice(0, -1).join("");
    revision += 1;
    lastAutoSpoken = null;
    renderText();
    setFeedback(text ? "Deleted. You can keep editing." : "Ready to type");
    scheduleAutoRead();
  }

  function clearAll() {
    cancelAutoRead();
    cancelSpeech();
    text = "";
    revision += 1;
    lastAutoSpoken = null;
    renderText();
    setFeedback("All text cleared");
  }

  function manualRead() {
    cancelAutoRead();
    const value = text.trim();
    if (!value) {
      setFeedback("Type some English first");
      return;
    }
    if (speakText(value)) {
      const word = latestWord();
      if (word) lastAutoSpoken = { word, revision };
      setFeedback("Reading aloud");
    }
  }

  function buildKeyboard() {
    const keys = [
      ...letters.map((value) => ({ value, label: value.toUpperCase(), kind: "letter" })),
      { value: "'", label: "Apostrophe", kind: "punctuation" },
      ...punctuation.map((value) => ({ value, label: ({ ".": "Period", ",": "Comma", "?": "Question mark", "!": "Exclamation mark" })[value], kind: "punctuation" }))
    ];
    const fragment = document.createDocumentFragment();
    for (const key of keys) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `key${key.kind === "punctuation" ? " punctuation" : ""}${key.value === "?" ? " question" : ""}`;
      button.textContent = key.value;
      button.dataset.value = key.value;
      button.dataset.kind = key.kind;
      button.setAttribute("aria-label", key.label);
      fragment.append(button);
    }
    keyboard.append(fragment);
  }

  function showSettings() {
    byId("settingsBackdrop").hidden = false;
    byId("accentSelect").focus();
    refreshVoiceStatus();
  }

  function hideSettings() {
    byId("settingsBackdrop").hidden = true;
    byId("settingsButton").focus();
  }

  function bindEvents() {
    keyboard.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-value]");
      if (!button) return;
      if (button.dataset.kind === "letter") enterLetter(button.dataset.value);
      else if (button.dataset.value === "'") enterApostrophe();
      else enterSeparator(button.dataset.value);
    });

    document.querySelector(".actions").addEventListener("click", (event) => {
      const action = event.target.closest("button[data-action]")?.dataset.action;
      if (action === "space") enterSeparator(" ");
      if (action === "delete") deleteLast();
      if (action === "clear") clearAll();
      if (action === "speak") manualRead();
    });
    byId("clearButton").addEventListener("click", clearAll);
    byId("settingsButton").addEventListener("click", showSettings);
    byId("closeSettings").addEventListener("click", hideSettings);
    byId("settingsBackdrop").addEventListener("click", (event) => {
      if (event.target === byId("settingsBackdrop")) hideSettings();
    });

    for (const control of ["accentSelect", "rateRange", "volumeRange", "lettersToggle", "autoToggle", "delayRange"]) {
      byId(control).addEventListener("input", saveSettings);
      byId(control).addEventListener("change", saveSettings);
    }

    document.addEventListener("keydown", (event) => {
      if (!byId("settingsBackdrop").hidden || event.metaKey || event.ctrlKey || event.altKey) return;
      if (/^[a-z]$/i.test(event.key)) {
        event.preventDefault();
        enterLetter(event.key);
      } else if (event.key === "Backspace") {
        event.preventDefault();
        deleteLast();
      } else if (event.key === " ") {
        event.preventDefault();
        enterSeparator(" ");
      } else if (punctuation.includes(event.key)) {
        event.preventDefault();
        enterSeparator(event.key);
      } else if (event.key === "Enter") {
        event.preventDefault();
        manualRead();
      } else if (event.key === "Escape") {
        hideSettings();
      }
    });
  }

  async function prepareOfflineApp() {
    if (!("serviceWorker" in navigator)) {
      offlineState.textContent = "This browser does not support offline installation";
      offlineState.classList.add("warning");
      return false;
    }
    if (navigator.serviceWorker.controller) {
      // Once controlled by the service worker, avoid waiting on an update check at every offline launch.
      navigator.serviceWorker.register("./service-worker.js", { scope: "./" }).catch(() => {});
      return true;
    }
    try {
      const registration = await navigator.serviceWorker.register("./service-worker.js", { scope: "./" });
      const installing = registration.installing;
      if (installing && installing.state !== "activated") {
        await new Promise((resolve) => {
          const onStateChange = () => {
            if (installing.state === "activated" || installing.state === "redundant") {
              installing.removeEventListener("statechange", onStateChange);
              resolve();
            }
          };
          installing.addEventListener("statechange", onStateChange);
          onStateChange();
        });
      }
      await navigator.serviceWorker.ready;
      return Boolean(registration.active);
    } catch {
      offlineState.textContent = "Offline files could not be saved. Reconnect and try again.";
      offlineState.classList.add("warning");
      return false;
    }
  }

  async function loadDictionary() {
    try {
      const response = await fetch("./words.txt", { cache: "no-store" });
      if (!response.ok) throw new Error("word list unavailable");
      const contents = await response.text();
      dictionary = new Set(contents.split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter((line) => line && !line.startsWith("#")));
      dictionaryReady = dictionary.size > 0;
      return dictionaryReady;
    } catch {
      dictionaryReady = false;
      return false;
    }
  }

  async function initialize() {
    loadSettings();
    buildKeyboard();
    bindEvents();
    renderText();

    if ("speechSynthesis" in window) {
      loadVoices();
      window.speechSynthesis.addEventListener("voiceschanged", () => {
        loadVoices();
        refreshVoiceStatus();
      });
    }
    refreshVoiceStatus();

    const offlineReady = await prepareOfflineApp();
    const wordsReady = await loadDictionary();
    if (offlineReady && wordsReady) {
      offlineState.textContent = "Offline files are ready";
      offlineState.classList.remove("warning");
      offlineState.classList.add("ready");
      setFeedback("Ready to type");
    } else if (wordsReady) {
      offlineState.textContent = "App is available; offline cache is not confirmed";
      offlineState.classList.add("warning");
    } else {
      offlineState.textContent = "Word list could not be loaded. Reconnect and try again.";
      offlineState.classList.add("warning");
    }
  }

  initialize();
})();
