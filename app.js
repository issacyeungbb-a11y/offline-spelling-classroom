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
  const appVersion = "v10";
  const learnKey = "offline-speller-learn-v1";
  const learnGroups = Array.isArray(window.LEARN_WORDS) ? window.LEARN_WORDS.filter((group) => group && Array.isArray(group.words) && group.words.length > 0) : [];
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
  let speechWatchdogTimer = null;
  let learning = false;
  let learnGroupIndex = 0;
  let learnWordIndex = 0;
  let attempt = "";
  let learnDone = false;
  let listGroupIndex = 0;
  const finishedWords = new Set();

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
    clearSpeechWatchdog();
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
    speakNow(pending);
  }

  function clearSpeechWatchdog() {
    if (speechWatchdogTimer !== null) {
      window.clearTimeout(speechWatchdogTimer);
      speechWatchdogTimer = null;
    }
  }

  // Start speaking immediately. If the engine never reports that it started, say so on screen.
  function speakNow(pending) {
    currentSpeech = { kind: pending.kind, text: pending.text, token: pending.token };
    clearSpeechWatchdog();
    speechWatchdogTimer = window.setTimeout(() => {
      speechWatchdogTimer = null;
      if (currentSpeech?.token === pending.token) {
        setFeedback("This device did not start speaking. Check volume and Voice Settings.", true);
      }
    }, 1800);
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
    const synth = window.speechSynthesis;
    if (previousToken === null && !synth.speaking && !synth.pending) {
      // Safari on iPhone and iPad only speaks when speak() runs inside the tap itself.
      speechToken = token;
      pendingSpeech = null;
      speakNow({ kind, text: request.text, utterance, token });
      return true;
    }
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
    utterance.onstart = () => {
      if (currentSpeech?.token === token) clearSpeechWatchdog();
    };
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
    if (learning) {
      learnType(letter.toLowerCase());
      return;
    }
    cancelAutoRead();
    text += letter.toLowerCase();
    revision += 1;
    renderText();
    setFeedback("Typing…");
    speakLetter(letter);
    scheduleAutoRead();
  }

  function enterApostrophe() {
    if (learning) {
      learnType("'");
      return;
    }
    if (!text || !/[a-z]$/i.test(text)) return;
    cancelAutoRead();
    text += "'";
    revision += 1;
    renderText();
    setFeedback("Typing…");
    scheduleAutoRead();
  }

  function enterSeparator(separator) {
    if (learning) {
      learnType(separator);
      return;
    }
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
    if (learning) {
      learnDelete();
      return;
    }
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
    if (learning) {
      learnClear();
      return;
    }
    cancelAutoRead();
    cancelSpeech();
    text = "";
    revision += 1;
    lastAutoSpoken = null;
    renderText();
    setFeedback("All text cleared");
  }

  function manualRead() {
    if (learning) {
      learnHear();
      return;
    }
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


  // ----- Learn Words mode -----
  function currentLearnWord() {
    const group = learnGroups[learnGroupIndex];
    return group ? group.words[learnWordIndex] : null;
  }

  function loadLearnState() {
    try {
      const saved = JSON.parse(localStorage.getItem(learnKey) || "null");
      if (saved && typeof saved === "object") {
        const groupIndex = learnGroups.findIndex((group) => group.id === saved.group);
        if (groupIndex >= 0) {
          learnGroupIndex = groupIndex;
          const index = Number(saved.index);
          learnWordIndex = Number.isInteger(index) && index >= 0 && index < learnGroups[groupIndex].words.length ? index : 0;
        }
      }
    } catch {
      learnGroupIndex = 0;
      learnWordIndex = 0;
    }
  }

  function saveLearnState() {
    try {
      localStorage.setItem(learnKey, JSON.stringify({ group: learnGroups[learnGroupIndex]?.id, index: learnWordIndex }));
    } catch {
      // Remembering the position is only a convenience.
    }
  }

  function buildLearnCategories() {
    for (const id of ["learnCategories", "wordListCategories"]) fillCategories(byId(id));
  }

  function fillCategories(container) {
    container.textContent = "";
    learnGroups.forEach((group, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "learn-category";
      button.dataset.group = String(index);
      button.setAttribute("role", "tab");
      const icon = document.createElement("span");
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = group.icon || "";
      const label = document.createElement("span");
      label.textContent = group.label;
      button.append(icon, label);
      container.append(button);
    });
  }

  function renderLearn() {
    const entry = currentLearnWord();
    const group = learnGroups[learnGroupIndex];
    for (const button of byId("learnCategories").children) {
      const selected = Number(button.dataset.group) === learnGroupIndex;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-selected", String(selected));
    }
    if (!entry) return;

    const picture = byId("learnPicture");
    picture.textContent = entry.picture || "";
    picture.classList.toggle("swatch", Boolean(entry.swatch));
    picture.style.background = entry.swatch || "";
    byId("learnWord").textContent = entry.word;
    byId("learnCount").textContent = `${learnWordIndex + 1} / ${group.words.length}`;

    // One slot per letter of the target; typed letters turn green when right and red when wrong.
    const box = byId("learnAttempt");
    box.textContent = "";
    const target = entry.word;
    const length = Math.max(target.length, attempt.length);
    for (let i = 0; i < length; i += 1) {
      const slot = document.createElement("span");
      const typed = attempt[i];
      const expected = target[i];
      if (expected === " " && typed === undefined) {
        slot.className = "slot gap";
      } else if (typed === undefined) {
        slot.className = "slot empty";
        slot.textContent = " ";
      } else {
        slot.className = `slot ${typed === expected ? "right" : "wrong"}${typed === " " ? " gap" : ""}`;
        slot.textContent = typed === " " ? " " : typed;
      }
      box.append(slot);
    }
    box.classList.toggle("done", learnDone);
    byId("learnPanel").classList.toggle("done", learnDone);
  }

  function showLearnWord(groupIndex, wordIndex) {
    cancelSpeech();
    learnGroupIndex = groupIndex;
    const count = learnGroups[groupIndex].words.length;
    learnWordIndex = ((wordIndex % count) + count) % count;
    attempt = "";
    learnDone = false;
    saveLearnState();
    renderLearn();
    setFeedback("Look at the word and type it");
  }

  function learnType(character) {
    const entry = currentLearnWord();
    if (!entry) return;
    if (learnDone) {
      setFeedback("Well done! Tap ▶ for the next word.");
      return;
    }
    if (character === " " && (!attempt || attempt.endsWith(" "))) return;
    attempt += character;
    const target = entry.word;
    if (attempt === target) {
      learnDone = true;
      finishedWords.add(`${learnGroupIndex}:${learnWordIndex}`);
      renderLearn();
      // Read the whole word instead of the last letter, inside the tap so iPad Safari allows it.
      speakText(target);
      setFeedback(`Well done! You typed “${target}”.`);
      return;
    }
    renderLearn();
    if (/^[a-z]$/.test(character)) speakLetter(character);
    else cancelSpeech();
    if (target.startsWith(attempt)) {
      setFeedback("Good. Keep going…");
    } else {
      setFeedback("A red letter is not the same. Tap Delete and try again.", true);
    }
  }

  function learnDelete() {
    if (!attempt) return;
    cancelSpeech();
    attempt = Array.from(attempt).slice(0, -1).join("");
    learnDone = false;
    renderLearn();
    const target = currentLearnWord()?.word || "";
    setFeedback(target.startsWith(attempt) ? "Good. Keep going…" : "A red letter is not the same. Tap Delete and try again.", !target.startsWith(attempt));
  }

  function learnClear() {
    cancelSpeech();
    attempt = "";
    learnDone = false;
    renderLearn();
    setFeedback("Look at the word and type it");
  }

  function learnHear() {
    const entry = currentLearnWord();
    if (entry && speakText(entry.word)) setFeedback(`Listen: ${entry.word}`);
  }

  // ----- Word list: pick any word of a group directly -----
  function renderWordList() {
    const group = learnGroups[listGroupIndex];
    for (const button of byId("wordListCategories").children) {
      const selected = Number(button.dataset.group) === listGroupIndex;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-selected", String(selected));
    }
    byId("wordListTitle").textContent = `${group.label}: choose a word`;
    const grid = byId("wordListGrid");
    grid.textContent = "";
    group.words.forEach((entry, index) => {
      const tile = document.createElement("button");
      tile.type = "button";
      tile.className = "word-tile";
      tile.dataset.index = String(index);
      if (listGroupIndex === learnGroupIndex && index === learnWordIndex) tile.classList.add("current");
      const finished = finishedWords.has(`${listGroupIndex}:${index}`);
      if (finished) tile.classList.add("finished");
      const picture = document.createElement("span");
      picture.className = `word-tile-picture${entry.swatch ? " swatch" : ""}`;
      picture.setAttribute("aria-hidden", "true");
      if (entry.swatch) picture.style.background = entry.swatch;
      else picture.textContent = entry.picture || "";
      const word = document.createElement("span");
      word.className = "word-tile-word";
      word.textContent = entry.word;
      tile.append(picture, word);
      tile.setAttribute("aria-label", finished ? `${entry.word}, done` : entry.word);
      grid.append(tile);
    });
    grid.scrollTop = 0;
  }

  function showWordList(groupIndex) {
    cancelSpeech();
    listGroupIndex = groupIndex;
    renderWordList();
    byId("wordListBackdrop").hidden = false;
    byId("closeWordList").focus();
  }

  function hideWordList() {
    byId("wordListBackdrop").hidden = true;
  }

  function chooseListWord(index) {
    hideWordList();
    showLearnWord(listGroupIndex, index);
  }

  function setLearning(on) {
    if (on && learnGroups.length === 0) {
      setFeedback("The Learn Words list could not be loaded.", true);
      return;
    }
    learning = on;
    cancelAutoRead();
    cancelSpeech();
    document.querySelector(".app-shell").classList.toggle("learning", on);
    display.hidden = on;
    byId("learnPanel").hidden = !on;
    const button = byId("learnButton");
    button.setAttribute("aria-pressed", String(on));
    button.querySelector(".learn-button-icon").textContent = on ? "✍️" : "📖";
    button.querySelector(".learn-button-label").textContent = on ? "Free Typing" : "Learn Words";
    button.title = on ? "Back to free typing" : "Learn Words";
    byId("clearButton").setAttribute("aria-label", on ? "Clear your typing" : "Clear all text");
    if (!on) hideWordList();
    if (on) {
      attempt = "";
      learnDone = false;
      renderLearn();
      setFeedback("Look at the word and type it");
    } else {
      renderText();
      setFeedback(text ? "You can keep typing" : "Ready to type");
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
    byId("learnButton").addEventListener("click", () => setLearning(!learning));
    byId("learnHear").addEventListener("click", learnHear);
    byId("learnPrev").addEventListener("click", () => showLearnWord(learnGroupIndex, learnWordIndex - 1));
    byId("learnNext").addEventListener("click", () => showLearnWord(learnGroupIndex, learnWordIndex + 1));
    byId("learnCategories").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-group]");
      if (button) showWordList(Number(button.dataset.group));
    });
    byId("wordListCategories").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-group]");
      if (!button) return;
      listGroupIndex = Number(button.dataset.group);
      renderWordList();
    });
    byId("wordListGrid").addEventListener("click", (event) => {
      const tile = event.target.closest("button[data-index]");
      if (tile) chooseListWord(Number(tile.dataset.index));
    });
    byId("closeWordList").addEventListener("click", hideWordList);
    byId("wordListBackdrop").addEventListener("click", (event) => {
      if (event.target === byId("wordListBackdrop")) hideWordList();
    });
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
      if (!byId("wordListBackdrop").hidden) {
        if (event.key === "Escape") hideWordList();
        return;
      }
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
    loadLearnState();
    buildLearnCategories();
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
    const note = document.querySelector(".settings-note");
    if (note) note.textContent += ` App version ${appVersion}.`;

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
