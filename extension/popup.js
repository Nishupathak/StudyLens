const API = "http://127.0.0.1:8000";
const $ = (id) => document.getElementById(id);

// ---------- Shared helpers ----------
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getPageText() {
  const tab = await getActiveTab();
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const el = document.querySelector("article") || document.querySelector("main");
      const mainText = el ? el.innerText : "";
      return mainText.length > 1500 ? mainText : document.body.innerText;
    },
  });
  const text = (results[0].result || "").slice(0, 300000);
  return { text, url: tab.url, title: tab.title || "" };
}

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function setMessage(box, text, isError = false) {
  box.innerHTML = "";
  const div = document.createElement("div");
  div.textContent = text;
  if (isError) div.className = "error";
  box.appendChild(div);
}

// ---------- Dates and streak ----------
function today() {
  const d = new Date();
  return (
    d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

function dayDiff(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function renderStreak(s) {
  let count = 0;
  if (s && s.last && dayDiff(s.last, today()) <= 1) count = s.count;
  $("streak").textContent = count > 0 ? `${count}-day streak` : "No streak yet";
}

async function loadStreak() {
  const { streak } = await chrome.storage.local.get("streak");
  renderStreak(streak);
}

async function recordActivity() {
  const { streak } = await chrome.storage.local.get("streak");
  const t = today();
  const s = streak || { count: 0, last: null };
  if (s.last === t) return;
  s.count = s.last && dayDiff(s.last, t) === 1 ? s.count + 1 : 1;
  s.last = t;
  await chrome.storage.local.set({ streak: s });
  renderStreak(s);
}

// ---------- Tabs ----------
const tabs = {
  ask: [$("tabAsk"), $("askView")],
  quiz: [$("tabQuiz"), $("quizView")],
  cards: [$("tabCards"), $("cardsView")],
  library: [$("tabLib"), $("libView")],
  check: [$("tabCheck"), $("checkView")],
};

function switchTab(name) {
  for (const key in tabs) {
    tabs[key][0].classList.toggle("active", key === name);
    tabs[key][1].classList.toggle("hidden", key !== name);
  }
  if (name === "cards") updateReviewButton();
  if (name === "library") loadLibrary();
  if (name === "check") prefillClaim();
}
for (const key in tabs) tabs[key][0].addEventListener("click", () => switchTab(key));

// ---------- Ask tab (with citations) ----------
const askBtn = $("askBtn");
const answerBox = $("answer");
const sourcesBox = $("sources");
const questionBox = $("question");

function show(text, isError = false) {
  answerBox.textContent = text;
  answerBox.className = isError ? "error" : "";
  sourcesBox.innerHTML = "";
}

function highlightOnPage(quote) {
  window.getSelection().removeAllRanges();
  const words = quote.split(/\s+/);
  const sizes = [words.length, 20, 12, 8].filter((n) => n <= words.length);
  for (const n of sizes) {
    if (window.find(words.slice(0, n).join(" "), false, false, true)) return true;
  }
  return false;
}

async function jumpToQuote(quote) {
  const tab = await getActiveTab();
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: highlightOnPage,
    args: [quote],
  });
}

function showSources(quotes) {
  if (!quotes || quotes.length === 0) return;
  const title = document.createElement("div");
  title.className = "quotes-title";
  title.textContent = "Sources from this page · click to jump";
  sourcesBox.appendChild(title);
  quotes.forEach((q) => {
    const btn = document.createElement("button");
    btn.className = "quote";
    btn.textContent = "“" + q + "”";
    btn.addEventListener("click", () => jumpToQuote(q));
    sourcesBox.appendChild(btn);
  });
}

askBtn.addEventListener("click", async () => {
  const question = questionBox.value.trim();
  if (!question) return show("Please type a question first.", true);
  askBtn.disabled = true;
  show("Thinking...");
  try {
    const { text, url } = await getPageText();
    const data = await post("/ask", { question, page_text: text, url });
    if (data.error) show("Error: " + data.error, true);
    else {
      show(data.answer);
      showSources(data.quotes);
    }
  } catch (err) {
    show("Could not reach the backend. Is the server running on port 8000?", true);
  } finally {
    askBtn.disabled = false;
  }
});

// ---------- Quiz tab ----------
const quizBtn = $("quizBtn");
const quizBox = $("quizBox");
let questions = [];
let current = 0;
let score = 0;
let quizMeta = { url: "", title: "" };

// Save a missed question as a flashcard
async function saveMissed(q) {
  try {
    const deck = await getDeck();
    if (deck.some((c) => c.front === q.question)) return false;
    const answer = q.options[q.answer_index];
    deck.push({
      id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      front: q.question,
      back: answer + (q.explanation ? " — " + q.explanation : ""),
      title: quizMeta.title,
      url: quizMeta.url,
      box: 0,
      due: today(),
    });
    await saveDeck(deck);
    return true;
  } catch (err) {
    return false;
  }
}

function renderQuestion() {
  const q = questions[current];
  quizBox.innerHTML = "";

  const progress = document.createElement("div");
  progress.className = "progress";
  progress.textContent = `Question ${current + 1} of ${questions.length}  ·  Score ${score}`;
  quizBox.appendChild(progress);

  const qtext = document.createElement("div");
  qtext.className = "qtext";
  qtext.textContent = q.question;
  quizBox.appendChild(qtext);

  const explain = document.createElement("div");
  explain.className = "explain";

  const nextBtn = document.createElement("button");
  nextBtn.className = "primary hidden";
  nextBtn.textContent = current === questions.length - 1 ? "See score" : "Next";
  nextBtn.addEventListener("click", () => {
    current++;
    if (current < questions.length) renderQuestion();
    else renderScore();
  });

  const optionButtons = [];
  q.options.forEach((text, i) => {
    const btn = document.createElement("button");
    btn.className = "opt";
    btn.textContent = text;
    btn.addEventListener("click", () => {
      optionButtons.forEach((b) => (b.disabled = true));
      explain.textContent = q.explanation;
      if (i === q.answer_index) {
        btn.classList.add("correct");
        score++;
      } else {
        btn.classList.add("wrong");
        optionButtons[q.answer_index].classList.add("correct");
        saveMissed(q).then((added) => {
          if (added) explain.textContent += "\n\nAdded to your flashcards for revision.";
        });
      }
      nextBtn.classList.remove("hidden");
    });
    optionButtons.push(btn);
    quizBox.appendChild(btn);
  });

  quizBox.appendChild(explain);
  quizBox.appendChild(nextBtn);
}

function renderScore() {
  quizBox.innerHTML = "";
  const div = document.createElement("div");
  div.className = "score";
  div.textContent = `You scored ${score} / ${questions.length}`;
  quizBox.appendChild(div);
  recordActivity();
}

quizBtn.addEventListener("click", async () => {
  quizBtn.disabled = true;
  setMessage(quizBox, "Generating your quiz...");
  try {
    const { text, url, title } = await getPageText();
    const data = await post("/quiz", {
      page_text: text,
      count: parseInt($("quizCount").value, 10),
      language: $("quizLang").value,
    });
    if (data.error) setMessage(quizBox, data.error, true);
    else {
      questions = data.questions;
      current = 0;
      score = 0;
      quizMeta = { url, title };
      renderQuestion();
    }
  } catch (err) {
    setMessage(quizBox, "Could not reach the backend. Is the server running on port 8000?", true);
  } finally {
    quizBtn.disabled = false;
  }
});

// ---------- Cards tab: deck + spaced repetition ----------
const cardsBtn = $("cardsBtn");
const reviewBtn = $("reviewBtn");
const cardsBox = $("cardsBox");

// Days until a card is shown again, by box number
const INTERVALS = [0, 1, 3, 7, 14, 30];

async function getDeck() {
  const { deck } = await chrome.storage.local.get("deck");
  return deck || [];
}

async function saveDeck(deck) {
  await chrome.storage.local.set({ deck });
}

async function updateReviewButton() {
  const deck = await getDeck();
  const due = deck.filter((c) => c.due <= today()).length;
  reviewBtn.textContent = `Review deck  ·  ${due} due  ·  ${deck.length} total`;
}

let generated = [];

function renderGenerated() {
  cardsBox.innerHTML = "";
  generated.forEach((c) => {
    const div = document.createElement("div");
    div.className = "card-preview";
    const front = document.createElement("b");
    front.textContent = c.front;
    const back = document.createElement("span");
    back.textContent = c.back;
    div.appendChild(front);
    div.appendChild(back);
    cardsBox.appendChild(div);
  });

  const saveAllBtn = document.createElement("button");
  saveAllBtn.className = "primary";
  saveAllBtn.textContent = "Save all to deck";
  saveAllBtn.addEventListener("click", async () => {
    try {
      const deck = await getDeck();
      const known = new Set(deck.map((c) => c.front));
      let added = 0;
      generated.forEach((c) => {
        if (known.has(c.front)) return;
        deck.push({
          id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
          front: c.front,
          back: c.back,
          title: c.title,
          url: c.url,
          box: 0,
          due: today(),
        });
        added++;
      });
      await saveDeck(deck);
      await updateReviewButton();
      setMessage(cardsBox, `Saved ${added} new card(s) to your deck. Ready to review.`);
    } catch (err) {
      setMessage(cardsBox, "Could not save: " + err.message, true);
    }
  });
  cardsBox.appendChild(saveAllBtn);
}

cardsBtn.addEventListener("click", async () => {
  cardsBtn.disabled = true;
  setMessage(cardsBox, "Making your flashcards...");
  try {
    const { text, url, title } = await getPageText();
    const data = await post("/flashcards", {
      page_text: text,
      count: parseInt($("cardsCount").value, 10),
      language: $("cardsLang").value,
    });
    if (data.error) setMessage(cardsBox, data.error, true);
    else {
      generated = data.cards.map((c) => ({ ...c, url, title }));
      renderGenerated();
    }
  } catch (err) {
    setMessage(cardsBox, "Could not reach the backend. Is the server running on port 8000?", true);
  } finally {
    cardsBtn.disabled = false;
  }
});

// ----- Review session -----
let queue = [];

async function startReview() {
  const deck = await getDeck();
  queue = deck.filter((c) => c.due <= today());
  if (queue.length === 0) {
    setMessage(cardsBox, "Nothing due right now. Come back later, or make new cards from a page.");
    return;
  }
  renderReviewCard();
}

function renderReviewCard() {
  if (queue.length === 0) {
    cardsBox.innerHTML = "";
    const div = document.createElement("div");
    div.className = "score";
    div.textContent = "Review complete";
    cardsBox.appendChild(div);
    updateReviewButton();
    return;
  }

  const card = queue[0];
  cardsBox.innerHTML = "";

  const progress = document.createElement("div");
  progress.className = "progress";
  progress.textContent = `${queue.length} card(s) left`;
  cardsBox.appendChild(progress);

  const flip = document.createElement("div");
  flip.className = "flipcard";
  flip.textContent = card.front;
  cardsBox.appendChild(flip);

  const back = document.createElement("div");
  back.className = "flipback hidden";
  back.textContent = card.back;
  flip.appendChild(back);

  const showBtn = document.createElement("button");
  showBtn.className = "primary";
  showBtn.textContent = "Show answer";

  const grades = document.createElement("div");
  grades.className = "btnrow hidden";

  const againBtn = document.createElement("button");
  againBtn.className = "secondary again";
  againBtn.textContent = "Again";
  const goodBtn = document.createElement("button");
  goodBtn.className = "secondary good";
  goodBtn.textContent = "Got it";
  grades.appendChild(againBtn);
  grades.appendChild(goodBtn);

  showBtn.addEventListener("click", () => {
    back.classList.remove("hidden");
    showBtn.classList.add("hidden");
    grades.classList.remove("hidden");
  });
  againBtn.addEventListener("click", () => grade(card, false));
  goodBtn.addEventListener("click", () => grade(card, true));

  cardsBox.appendChild(showBtn);
  cardsBox.appendChild(grades);
}

async function grade(card, gotIt) {
  const deck = await getDeck();
  const stored = deck.find((c) => c.id === card.id);
  if (stored) {
    if (gotIt) {
      stored.box = Math.min(stored.box + 1, INTERVALS.length - 1);
      stored.due = addDays(today(), INTERVALS[stored.box]);
    } else {
      stored.box = 0;
      stored.due = today();
    }
    await saveDeck(deck);
  }
  if (gotIt) queue.shift();
  else queue.push(queue.shift()); // missed cards come back at the end of this session
  await recordActivity();
  renderReviewCard();
}

reviewBtn.addEventListener("click", startReview);

// ---------- Library (stored in the browser) ----------
const STOPWORDS = new Set(
  ("a an the and or but if of to in on at by for with from as is are was were be been being " +
    "this that these those it its into about what which who whom how why when where do does " +
    "did can could should would will shall may might not no yes you your me my we our they " +
    "them their he she his her than then so such also any all some more most other over " +
    "under again very just page article tell explain summarize summary main read saved").split(" ")
);

function stem(w) {
  return w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w;
}

function tokenize(s) {
  const words = s.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) || [];
  return words.filter((w) => w.length > 2 && !STOPWORDS.has(w)).map(stem);
}

function countTokens(text) {
  const m = new Map();
  tokenize(text).forEach((t) => m.set(t, (m.get(t) || 0) + 1));
  return m;
}

function chunkText(text, size = 1200) {
  const paras = text.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let buf = "";
  for (let p of paras) {
    if (buf.length + p.length + 1 <= size) {
      buf = buf ? buf + "\n" + p : p;
    } else {
      if (buf) chunks.push(buf);
      while (p.length > size) {
        chunks.push(p.slice(0, size));
        p = p.slice(size - 150);
      }
      buf = p;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

async function getLibrary() {
  const { library } = await chrome.storage.local.get("library");
  return library || [];
}

async function setLibrary(library) {
  await chrome.storage.local.set({ library });
}

function inRange(page, days) {
  if (!days) return true;
  return Date.now() - new Date(page.saved_at).getTime() <= days * 86400000;
}

// Rank every saved chunk against the question (TF-IDF style)
function searchChunks(pages, question, topK = 8) {
  const q = [...new Set(tokenize(question))];
  if (q.length === 0) return [];

  const all = [];
  pages.forEach((p) =>
    p.chunks.forEach((c) => all.push({ page: p, text: c, tf: countTokens(c) }))
  );
  const n = all.length;
  if (n === 0) return [];

  const df = {};
  q.forEach((t) => {
    df[t] = all.filter((c) => c.tf.has(t)).length;
  });

  const scored = all.map((c) => {
    let s = 0;
    q.forEach((t) => {
      const f = c.tf.get(t);
      if (f) s += Math.log(1 + n / df[t]) * (1 + Math.log(f));
    });
    return { ...c, score: s };
  });

  return scored.filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ----- Library tab -----
const saveBtn = $("saveBtn");
const libAskBtn = $("libAskBtn");
const libAnswer = $("libAnswer");
const libSources = $("libSources");

async function loadLibrary() {
  const list = $("libList");
  const pages = (await getLibrary()).slice().sort((a, b) => b.saved_at.localeCompare(a.saved_at));
  list.innerHTML = "";
  $("libTitle").textContent = pages.length
    ? `Saved pages (${pages.length})`
    : "No saved pages yet. Open an article and press Save.";

  pages.forEach((p) => {
    const item = document.createElement("div");
    item.className = "lib-item";

    const link = document.createElement("a");
    link.textContent = p.title || p.url;
    const small = document.createElement("small");
    small.textContent = p.saved_at.slice(0, 10);
    link.appendChild(small);
    link.addEventListener("click", () => chrome.tabs.create({ url: p.url }));

    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "Remove";
    del.title = "Remove from library";
    del.addEventListener("click", async () => {
      const lib = await getLibrary();
      await setLibrary(lib.filter((x) => x.url !== p.url));
      loadLibrary();
    });

    item.appendChild(link);
    item.appendChild(del);
    list.appendChild(item);
  });
}

saveBtn.addEventListener("click", async () => {
  saveBtn.disabled = true;
  $("saveMsg").textContent = "Saving...";
  try {
    const { text, url, title } = await getPageText();
    if (text.trim().length < 200) {
      $("saveMsg").textContent = "This page has too little text to save.";
      return;
    }
    const lib = await getLibrary();
    const existing = lib.findIndex((p) => p.url === url);
    const entry = {
      url,
      title,
      saved_at: new Date().toISOString(),
      chunks: chunkText(text),
    };
    if (existing >= 0) lib[existing] = entry;
    else lib.push(entry);
    await setLibrary(lib);
    $("saveMsg").textContent =
      existing >= 0 ? "Page updated in your library." : "Saved to your library.";
    loadLibrary();
  } catch (err) {
    $("saveMsg").textContent = "Could not save. Use a normal website page.";
  } finally {
    saveBtn.disabled = false;
  }
});

libAskBtn.addEventListener("click", async () => {
  const question = $("libQuestion").value.trim();
  libSources.innerHTML = "";
  libAnswer.className = "";
  if (!question) {
    libAnswer.textContent = "Type a question first.";
    return;
  }

  libAskBtn.disabled = true;
  libAnswer.textContent = "Searching your library...";
  try {
    const days = parseInt($("libRange").value, 10);
    const pages = (await getLibrary()).filter((p) => inRange(p, days));
    if (pages.length === 0) {
      libAnswer.textContent = "You have no saved pages in this time range.";
      return;
    }

    const hits = searchChunks(pages, question, 8);
    if (hits.length === 0) {
      libAnswer.textContent = "I couldn't find anything about that in your saved pages.";
      return;
    }

    const numbers = new Map();
    const sources = [];
    const notes = hits.map((h) => {
      if (!numbers.has(h.page.url)) {
        numbers.set(h.page.url, numbers.size + 1);
        sources.push({ n: numbers.size, page: h.page });
      }
      return { n: numbers.get(h.page.url), title: h.page.title || h.page.url, content: h.text };
    });

    const data = await post("/library/ask", { question, notes });
    if (data.error) {
      libAnswer.textContent = data.error;
      libAnswer.className = "error";
      return;
    }

    libAnswer.textContent = data.answer;
    sources.forEach((s) => {
      const btn = document.createElement("button");
      btn.className = "src";
      btn.textContent = `[${s.n}] ${s.page.title || s.page.url}`;
      const small = document.createElement("small");
      small.textContent = "Saved " + s.page.saved_at.slice(0, 10) + " · click to open";
      btn.appendChild(small);
      btn.addEventListener("click", () => chrome.tabs.create({ url: s.page.url }));
      libSources.appendChild(btn);
    });
  } catch (err) {
    libAnswer.textContent = "Could not reach the backend. Is the server running on port 8000?";
    libAnswer.className = "error";
  } finally {
    libAskBtn.disabled = false;
  }
});

// ----- Quiz from library -----
$("libQuizBtn").addEventListener("click", async () => {
  const btn = $("libQuizBtn");
  const msg = $("libQuizMsg");
  btn.disabled = true;
  msg.className = "progress";
  msg.textContent = "Building your quiz from saved pages...";
  try {
    const days = parseInt($("libRange").value, 10);
    const pages = (await getLibrary()).filter((p) => inRange(p, days));
    if (pages.length === 0) {
      msg.className = "progress error";
      msg.textContent = "No saved pages in this time range. Save some pages first.";
      return;
    }

    const topic = $("libTopic").value.trim();
    let picks;
    if (topic) {
      picks = searchChunks(pages, topic, 8);
    } else {
      const pool = [];
      pages.forEach((p) => p.chunks.forEach((c) => pool.push({ page: p, text: c })));
      picks = shuffle(pool).slice(0, 8);
    }
    if (picks.length === 0) {
      msg.className = "progress error";
      msg.textContent = "Nothing matches that topic in your saved pages.";
      return;
    }

    const context = picks
      .map((h) => `From: ${h.page.title || h.page.url}\n${h.text}`)
      .join("\n\n")
      .slice(0, 10000);

    const data = await post("/quiz", {
      page_text: context,
      count: parseInt($("libQuizCount").value, 10),
      language: $("libQuizLang").value,
    });
    if (data.error) {
      msg.className = "progress error";
      msg.textContent = data.error;
      return;
    }

    questions = data.questions;
    current = 0;
    score = 0;
    quizMeta = { url: "", title: "Library quiz" };
    msg.textContent = "";
    switchTab("quiz");
    renderQuestion();
  } catch (err) {
    msg.className = "progress error";
    msg.textContent = "Could not reach the backend. Is the server running on port 8000?";
  } finally {
    btn.disabled = false;
  }
});

// ---------- Check tab (fact-check) ----------
async function getSelectedText() {
  try {
    const tab = await getActiveTab();
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection().toString(),
    });
    return (results[0].result || "").trim();
  } catch (err) {
    return "";
  }
}

async function prefillClaim() {
  const selected = await getSelectedText();
  if (selected) $("claimBox").value = selected.slice(0, 380);
}

$("checkBtn").addEventListener("click", async () => {
  const claim = $("claimBox").value.trim();
  const box = $("checkResult");
  box.innerHTML = "";
  if (!claim) {
    setMessage(box, "Select a sentence on the page, or type a claim first.", true);
    return;
  }

  const btn = $("checkBtn");
  btn.disabled = true;
  setMessage(box, "Searching the web and checking the claim...");
  try {
    const data = await post("/factcheck", { claim });
    box.innerHTML = "";
    if (data.error) {
      setMessage(box, data.error, true);
      return;
    }

    const cls =
      { Supported: "v-supported", Disputed: "v-disputed", Mixed: "v-mixed" }[data.verdict] ||
      "v-unclear";
    const badge = document.createElement("span");
    badge.className = "verdict " + cls;
    badge.textContent = data.verdict;
    box.appendChild(badge);

    const summary = document.createElement("div");
    summary.className = "summary";
    summary.textContent = data.summary;
    box.appendChild(summary);

    if (data.sources.length) {
      const title = document.createElement("div");
      title.className = "quotes-title";
      title.textContent = "Sources · click to open";
      box.appendChild(title);
    }

    const labels = { supports: "Supports", disputes: "Disputes", neutral: "Neutral" };
    data.sources.forEach((s) => {
      const link = document.createElement("button");
      link.className = "src";

      const tag = document.createElement("span");
      tag.className = "tag tag-" + s.stance;
      tag.textContent = labels[s.stance] || "Neutral";
      link.appendChild(tag);
      link.appendChild(document.createTextNode(s.title));

      const small = document.createElement("small");
      small.textContent = s.note;
      link.appendChild(small);

      link.addEventListener("click", () => chrome.tabs.create({ url: s.url }));
      box.appendChild(link);
    });

    const note = document.createElement("div");
    note.className = "note";
    note.textContent = "AI summary of web search results. Open the sources to confirm.";
    box.appendChild(note);
  } catch (err) {
    setMessage(box, "Could not reach the backend. Is the server running on port 8000?", true);
  } finally {
    btn.disabled = false;
  }
});

// ---------- Theme (dark / light) ----------
const ICON_SUN =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
const ICON_MOON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  $("themeBtn").innerHTML = theme === "dark" ? ICON_SUN : ICON_MOON;
  $("themeBtn").title = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
}

async function loadTheme() {
  const { theme } = await chrome.storage.local.get("theme");
  applyTheme(theme || "dark");
}

$("themeBtn").addEventListener("click", async () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  applyTheme(next);
  await chrome.storage.local.set({ theme: next });
});

// ---------- Start ----------
loadTheme();
loadStreak();
updateReviewButton();