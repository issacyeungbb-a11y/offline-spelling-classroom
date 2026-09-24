(() => {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const keyboard = byId("keyboard");
  const display = byId("displayText");
  const feedback = byId("feedback");
  const offlineState = byId("offlineState");
  const letters = "abcdefghijklmnopqrstuvwxyz".split("");
  const punctuation = [".", ",", "?", "!"];
  const settingsKey = "offline-speller-settings-v1";
  const defaults = {
    accent: "en-GB",
    rate: 0.8,
    volume: 1,
    readLetters: true,
    autoReadWords: true,
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
  let pendingLetters = [];
  let currentSpeech = null;
  let speechToken = 0;

  function normalizeWord(word) {
    return word.trim().toLocaleLowerCase("en").replace(/[’]/g, "'");
  }

  function setFeedback(message, unknown = false) {
    feedback.textContent = message;
    feedback.classList.toggle("unknown", unknown);
  }

  function renderText() {
    if (text.length === 0) {
      display.textContent = "開始輸入英文…";
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
      setFeedback("裝置未能保存設定，其他功能仍可使用", true);
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
    byId("rateOutput").textContent = settings.rate < 0.75 ? "較慢" : settings.rate > 0.95 ? "較快" : "正常";
    byId("volumeOutput").textContent = `${Math.round(settings.volume * 100)}%`;
    byId("delayOutput").textContent = `${settings.delay.toFixed(1)} 秒`;
    byId("delayRange").disabled = !settings.autoReadWords;
    refreshVoiceStatus();
  }

  function localVoices() {
    return voices.filter((voice) => voice.localService === true && /^en(-|$)/i.test(voice.lang));
  }

  function chosenVoice() {
    const target = settings.accent.toLowerCase();
    const available = localVoices();
    return available.find((voice) => voice.lang.toLowerCase() === target)
      || available.find((voice) => voice.lang.toLowerCase().startsWith(target.slice(0, 2)))
      || null;
  }

  function refreshVoiceStatus() {
    const status = byId("voiceStatus");
    const voice = chosenVoice();
    if (voice) {
      status.textContent = `可離線使用：${voice.name}（${voice.lang}）`;
      status.classList.remove("warning");
    } else {
      status.textContent = `${settings.accent === "en-GB" ? "英式" : "美式"}本機語音未找到。請在 iPad 設定下載英文語音，並保持網絡關閉測試。`;
      status.classList.add("warning");
    }
  }

  function cancelSpeech() {
    speechToken += 1;
    pendingLetters = [];
    currentSpeech = null;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }

  function makeUtterance(request, token) {
    const voice = chosenVoice();
    if (!voice || !("speechSynthesis" in window)) {
      setFeedback("未找到可離線使用的英文語音，請檢查語音設定", true);
      return null;
    }
    const utterance = new SpeechSynthesisUtterance(request.text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = settings.rate;
    utterance.volume = settings.volume;
    utterance.pitch = 1;
    utterance.onend = () => finishSpeech(token);
    utterance.onerror = () => finishSpeech(token);
    return utterance;
  }

  function finishSpeech(token) {
    if (token !== speechToken) return;
    currentSpeech = null;
    playNextLetter();
  }

  function playNextLetter() {
    if (currentSpeech || pendingLetters.length === 0) return;
    const request = pendingLetters.shift();
    const token = speechToken;
    const utterance = makeUtterance(request, token);
    if (!utterance) return;
    currentSpeech = { kind: "letter", text: request.text };
    window.speechSynthesis.speak(utterance);
  }

  function speakLetter(letter) {
    if (!settings.readLetters) return;
    if (!("speechSynthesis" in window) || !chosenVoice()) {
      setFeedback("本機英文語音未就緒；字母仍已輸入", true);
      return;
    }
    if (currentSpeech?.kind === "word") cancelSpeech();
    // 最多保留正在讀的字母及四個待讀字母，避免快速連按造成長佇列。
    if (pendingLetters.length >= 4) pendingLetters.shift();
    pendingLetters.push({ text: letter.toUpperCase() });
    playNextLetter();
  }

  function speakText(value) {
    if (!("speechSynthesis" in window) || !chosenVoice()) {
      setFeedback("本機英文語音未就緒；請先下載英文語音", true);
      return false;
    }
    cancelSpeech();
    const token = speechToken;
    const utterance = makeUtterance({ text: value }, token);
    if (!utterance) return false;
    currentSpeech = { kind: "word", text: value };
    window.speechSynthesis.speak(utterance);
    return true;
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
      setFeedback(`未能確認單字：${word}`, true);
      return false;
    }
    if (lastAutoSpoken?.word === word && lastAutoSpoken.revision === spokenRevision) return true;
    if (speakText(word)) {
      lastAutoSpoken = { word, revision: spokenRevision };
      setFeedback(`已朗讀：${word}`);
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
    setFeedback("正在輸入");
    speakLetter(letter);
    scheduleAutoRead();
  }

  function enterApostrophe() {
    if (!text || !/[a-z]$/i.test(text)) return;
    cancelAutoRead();
    text += "'";
    revision += 1;
    renderText();
    setFeedback("正在輸入");
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
      setFeedback("可以繼續輸入");
      return;
    }
    if (lastAutoSpoken?.word === completedWord && lastAutoSpoken.revision === completedRevision) {
      setFeedback(`已朗讀：${completedWord}`);
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
    setFeedback(text ? "已刪除，可以繼續修改" : "可以開始輸入");
    scheduleAutoRead();
  }

  function clearAll() {
    cancelAutoRead();
    cancelSpeech();
    text = "";
    revision += 1;
    lastAutoSpoken = null;
    renderText();
    setFeedback("已清空");
  }

  function manualRead() {
    cancelAutoRead();
    const value = text.trim();
    if (!value) {
      setFeedback("請先輸入英文");
      return;
    }
    if (speakText(value)) {
      const word = latestWord();
      if (word) lastAutoSpoken = { word, revision };
      setFeedback("正在朗讀");
    }
  }

  function buildKeyboard() {
    const keys = [
      ...letters.map((value) => ({ value, label: `英文字母 ${value.toUpperCase()}`, kind: "letter" })),
      { value: "'", label: "撇號", kind: "punctuation" },
      ...punctuation.map((value) => ({ value, label: ({ ".": "句號", ",": "逗號", "?": "問號", "!": "感嘆號" })[value], kind: "punctuation" }))
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
      offlineState.textContent = "此瀏覽器不支援離線安裝";
      offlineState.classList.add("warning");
      return false;
    }
    if (navigator.serviceWorker.controller) {
      // 已由離線工作程序控制時，不要令每次離線開啟都等待一次更新檢查。
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
      offlineState.textContent = "離線資料未能保存，請保持網絡重試";
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
      voices = window.speechSynthesis.getVoices();
      window.speechSynthesis.addEventListener("voiceschanged", () => {
        voices = window.speechSynthesis.getVoices();
        refreshVoiceStatus();
      });
    }
    refreshVoiceStatus();

    const offlineReady = await prepareOfflineApp();
    const wordsReady = await loadDictionary();
    if (offlineReady && wordsReady) {
      offlineState.textContent = "離線資料已準備";
      offlineState.classList.remove("warning");
      offlineState.classList.add("ready");
      setFeedback("可以開始輸入");
    } else if (wordsReady) {
      offlineState.textContent = "目前可用；離線快取未確認";
      offlineState.classList.add("warning");
    } else {
      offlineState.textContent = "詞庫未能載入，請連線重試";
      offlineState.classList.add("warning");
    }
  }

  initialize();
})();
