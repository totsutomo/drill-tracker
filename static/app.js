// ---------- tab switching ----------

const tabButtons = document.querySelectorAll(".tab-btn");
const tabPanels = document.querySelectorAll(".tab-panel");

function switchTab(tabId) {
  tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === tabId));
  tabPanels.forEach((p) => p.classList.toggle("active", p.id === tabId));
  if (tabId === "tab-bookshelf") loadBookshelf();
  if (tabId === "tab-notes") loadNotes();
  if (tabId === "tab-stats") loadStats();
}
tabButtons.forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));

// ---------- 設定ドロワー(下タブではなく、ヘッダーの歯車から横に出す) ----------

const settingsDrawer = document.getElementById("settings-drawer");
const settingsBackdrop = document.getElementById("settings-backdrop");

function openSettingsDrawer() {
  settingsDrawer.classList.add("open");
  settingsBackdrop.classList.remove("hidden");
  loadSettings();
}
function closeSettingsDrawer() {
  settingsDrawer.classList.remove("open");
  settingsBackdrop.classList.add("hidden");
}
document.getElementById("settings-btn").addEventListener("click", openSettingsDrawer);
document.getElementById("settings-close").addEventListener("click", closeSettingsDrawer);
settingsBackdrop.addEventListener("click", closeSettingsDrawer);

// ---------- progress bar / toast (study-trackerと同じ仕組み) ----------

let apiInFlight = 0;
let apiProgressShowTimer = null;
function apiProgressStart() {
  apiInFlight++;
  if (apiInFlight === 1) {
    clearTimeout(apiProgressShowTimer);
    apiProgressShowTimer = setTimeout(() => {
      document.getElementById("top-progress-bar")?.classList.remove("hidden");
    }, 200);
  }
}
function apiProgressEnd() {
  apiInFlight = Math.max(0, apiInFlight - 1);
  if (apiInFlight === 0) {
    clearTimeout(apiProgressShowTimer);
    document.getElementById("top-progress-bar")?.classList.add("hidden");
  }
}

let toastTimer = null;
function showToast(message) {
  const el = document.getElementById("toast-banner");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 4000);
}

// ---------- 起動時キャッシュ(体感速度改善。オフライン対応が目的ではない) ----------
// サーバーが正のデータ置き場であることは変えない。直前の取得内容をIndexedDBに保存し、
// 起動直後はまずそれを描画→裏で本物のfetchが終わったら上書きする(stale-while-revalidate)。
const CACHE_DB_NAME = "drill-cache";
const CACHE_STORE_NAME = "api-cache";
let cacheDbPromise = null;

function openCacheDb() {
  if (!cacheDbPromise) {
    cacheDbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) { reject(new Error("no indexedDB")); return; }
      const req = indexedDB.open(CACHE_DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(CACHE_STORE_NAME, { keyPath: "path" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return cacheDbPromise;
}

async function cacheGet(path) {
  try {
    const db = await openCacheDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE_NAME, "readonly");
      const req = tx.objectStore(CACHE_STORE_NAME).get(path);
      req.onsuccess = () => resolve(req.result ? req.result.data : undefined);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    return undefined;
  }
}

async function cacheSet(path, data) {
  try {
    const db = await openCacheDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CACHE_STORE_NAME, "readwrite");
      tx.objectStore(CACHE_STORE_NAME).put({ path, data });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    // キャッシュ書き込み失敗は無視してよい(次回起動時に恩恵がないだけ)
  }
}

async function api(path, options = {}, retries = 3) {
  apiProgressStart();
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
        if (!res.ok) throw new Error(`API error: ${res.status}`);
        const data = await res.json();
        if (!options.method || options.method.toUpperCase() === "GET") cacheSet(path, data);
        return data;
      } catch (err) {
        if (attempt >= retries) throw err;
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      }
    }
  } finally {
    apiProgressEnd();
  }
}

// キャッシュ即描画→裏で本物のfetchが終わったら再描画、の定型処理
async function loadWithCache(path, render) {
  const cached = await cacheGet(path);
  if (cached) render(cached);
  try {
    const fresh = await api(path);
    render(fresh);
    return fresh;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}

// 楽観的更新の共通処理: 成功する前提でローカル状態を即座に書き換えて再描画し(apply)、
// 保存(request)は裏で進める。失敗したらrevertで元に戻しトーストで知らせる。
async function optimistic(apply, revert, request) {
  apply();
  try {
    return await request();
  } catch (err) {
    revert();
    showToast("保存に失敗しました。もう一度お試しください");
    throw err;
  }
}

function formatLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function todayStr() { return formatLocalDate(new Date()); }

function newClientId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "cid-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

const RATING_LABELS = { 1: "難問", 2: "惜しい", 3: "苦戦", 4: "良好", 5: "即答" };

// ---------- 全体state ----------

const state = {
  today: null,
  books: [],
  mistakeTypes: [],
  settings: {},
  catalogCache: {},
  currentBookId: null,
};

// ---------- 共通: attempt送信 ----------

async function submitAttempt(problem, rating, { memo = null, mistakeType = null } = {}) {
  const payload = {
    client_attempt_id: newClientId(),
    problem_id: problem.id,
    rating,
    local_date: todayStr(),
    memo,
    mistake_type: mistakeType,
  };
  return api("/api/attempts", { method: "POST", body: JSON.stringify(payload) });
}

// ---------- 今日タブ ----------

async function loadToday() {
  const date = todayStr();
  await loadWithCache(`/api/queue/today?date=${date}`, (data) => {
    state.today = data;
    renderToday();
  });
}

function renderToday() {
  const data = state.today;
  if (!data) return;
  document.getElementById("quota-solved").textContent = data.solved_today;
  document.getElementById("quota-target").textContent = data.daily_target;
  document.getElementById("quota-achieved-msg").classList.toggle("hidden", data.solved_today < data.daily_target);
  document.getElementById("overdue-badge").textContent =
    data.overdue_total > 0 ? `復習待ち ${data.overdue_total}件` : "";

  const list = document.getElementById("today-queue");
  list.innerHTML = "";
  document.getElementById("today-empty").classList.toggle("hidden", data.queue.length > 0);
  data.queue.forEach((p) => list.appendChild(renderTodayRow(p)));
}

function renderTodayRow(problem) {
  const row = document.createElement("div");
  row.className = "problem-row";
  row.dataset.problemId = problem.id;

  const info = document.createElement("div");
  info.className = "problem-info";
  const num = document.createElement("div");
  num.className = "p-num";
  num.textContent = `${problem.book_title || ""} ${problem.section_name || ""} #${problem.number}`;
  const meta = document.createElement("div");
  meta.className = "p-meta";
  meta.textContent = problem.unit_name || "";
  info.appendChild(num);
  info.appendChild(meta);

  const btnWrap = document.createElement("div");
  btnWrap.className = "rate-buttons-inline";
  for (let r = 1; r <= 5; r++) {
    const btn = document.createElement("button");
    btn.className = "rate-btn";
    btn.dataset.rating = String(r);
    btn.textContent = String(r);
    btn.title = RATING_LABELS[r];
    btn.addEventListener("click", () => rateTodayProblem(problem, r, row));
    btnWrap.appendChild(btn);
  }
  const memoBtn = document.createElement("button");
  memoBtn.className = "retire-btn";
  memoBtn.textContent = "📝";
  memoBtn.title = "メモを付けて記録";
  memoBtn.addEventListener("click", () => openRateModal(problem, { onDone: () => markTodayRowDone(row) }));

  row.appendChild(info);
  row.appendChild(btnWrap);
  row.appendChild(memoBtn);
  return row;
}

function markTodayRowDone(row) {
  row.classList.add("done");
  setTimeout(() => row.remove(), 250);
}

async function rateTodayProblem(problem, rating, row) {
  await optimistic(
    () => {
      markTodayRowDone(row);
      if (state.today) {
        state.today.solved_today++;
        renderQuotaOnly();
      }
    },
    () => {
      row.classList.remove("done");
      if (state.today) state.today.solved_today = Math.max(0, state.today.solved_today - 1);
      renderQuotaOnly();
    },
    () => submitAttempt(problem, rating)
  );
}

function renderQuotaOnly() {
  if (!state.today) return;
  document.getElementById("quota-solved").textContent = state.today.solved_today;
  document.getElementById("quota-achieved-msg").classList.toggle(
    "hidden",
    state.today.solved_today < state.today.daily_target
  );
}

// ---------- 評価モーダル(本棚・今日タブの📝から共通利用) ----------

let rateModalCtx = null;

function openRateModal(problem, { onDone } = {}) {
  rateModalCtx = { problem, onDone, rating: null, mistakeType: null };
  document.getElementById("rate-modal-title").textContent =
    `${problem.book_title || ""} #${problem.number} を評価`;
  const btnWrap = document.getElementById("rate-modal-buttons");
  btnWrap.innerHTML = "";
  for (let r = 1; r <= 5; r++) {
    const btn = document.createElement("button");
    btn.className = "rate-btn";
    btn.dataset.rating = String(r);
    btn.textContent = `${r} ${RATING_LABELS[r]}`;
    btn.addEventListener("click", () => selectRateModalRating(r));
    btnWrap.appendChild(btn);
  }
  renderMistakeChips();
  document.getElementById("rate-modal-memo").value = "";
  document.getElementById("rate-modal").classList.remove("hidden");
}

function selectRateModalRating(rating) {
  rateModalCtx.rating = rating;
  document.querySelectorAll("#rate-modal-buttons .rate-btn").forEach((b) => {
    b.style.outline = Number(b.dataset.rating) === rating ? "2px solid #fff" : "none";
  });
  document.getElementById("rate-modal-mistake").classList.toggle("hidden", rating > 3);
}

function renderMistakeChips() {
  const wrap = document.getElementById("rate-modal-mistake");
  wrap.innerHTML = "";
  state.mistakeTypes.forEach((mt) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "mistake-chip";
    chip.textContent = mt.name;
    chip.addEventListener("click", () => {
      rateModalCtx.mistakeType = rateModalCtx.mistakeType === mt.name ? null : mt.name;
      wrap.querySelectorAll(".mistake-chip").forEach((c) => c.classList.remove("selected"));
      if (rateModalCtx.mistakeType) chip.classList.add("selected");
    });
    wrap.appendChild(chip);
  });
}

document.getElementById("rate-modal-cancel").addEventListener("click", () => {
  document.getElementById("rate-modal").classList.add("hidden");
  rateModalCtx = null;
});

document.getElementById("rate-modal-submit").addEventListener("click", async () => {
  if (!rateModalCtx || !rateModalCtx.rating) {
    showToast("評価を選んでください");
    return;
  }
  const { problem, rating, mistakeType, onDone } = rateModalCtx;
  const memo = document.getElementById("rate-modal-memo").value.trim() || null;
  document.getElementById("rate-modal").classList.add("hidden");
  try {
    await submitAttempt(problem, rating, { memo, mistakeType: rating <= 3 ? mistakeType : null });
    if (onDone) onDone();
    showToast("記録しました");
  } catch (err) {
    showToast("保存に失敗しました。もう一度お試しください");
  }
  rateModalCtx = null;
});

// ---------- 本棚タブ ----------

async function loadBookshelf() {
  if (state.books.length === 0) {
    state.books = await api("/api/books");
    const sel = document.getElementById("book-select");
    sel.innerHTML = "";
    state.books.forEach((b) => {
      const opt = document.createElement("option");
      opt.value = b.id;
      opt.textContent = b.title;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", () => renderBookshelfBook(Number(sel.value)));
    state.currentBookId = state.books[0]?.id;
  }
  if (state.currentBookId) {
    document.getElementById("book-select").value = state.currentBookId;
    renderBookshelfBook(state.currentBookId);
  }
}

async function renderBookshelfBook(bookId) {
  state.currentBookId = bookId;
  const tree = document.getElementById("bookshelf-tree");
  tree.innerHTML = "<p class='meta'>読み込み中...</p>";
  await loadWithCache(`/api/books/${bookId}/catalog`, (data) => {
    state.catalogCache[bookId] = data;
    if (state.currentBookId === bookId) renderCatalog(data);
  });
}

function renderCatalog(book) {
  const tree = document.getElementById("bookshelf-tree");
  tree.innerHTML = "";
  (book.sections || []).forEach((section) => {
    const sectionHeading = document.createElement("h3");
    sectionHeading.textContent = section.name;
    sectionHeading.style.margin = "14px 4px 6px";
    sectionHeading.style.fontSize = "13px";
    sectionHeading.style.color = "var(--text-dim)";
    tree.appendChild(sectionHeading);

    (section.chapters || []).forEach((chapter) => {
      const block = document.createElement("div");
      block.className = "chapter-block";
      const header = document.createElement("div");
      header.className = "chapter-header";
      header.textContent = `第${chapter.number}章 ${chapter.name}`;
      header.addEventListener("click", () => block.classList.toggle("expanded"));
      const body = document.createElement("div");
      body.className = "chapter-body";

      (chapter.units || []).forEach((unit) => {
        const unitBlock = document.createElement("div");
        unitBlock.className = "unit-block";
        const unitHeader = document.createElement("div");
        unitHeader.className = "unit-header";
        unitHeader.textContent = unit.name;
        unitBlock.appendChild(unitHeader);

        const list = document.createElement("div");
        list.className = "problem-list";
        (unit.problems || []).forEach((p) => list.appendChild(renderBookshelfRow(p, book)));
        unitBlock.appendChild(list);
        body.appendChild(unitBlock);
      });

      block.appendChild(header);
      block.appendChild(body);
      tree.appendChild(block);
    });
  });
}

function renderBookshelfRow(problem, book) {
  const wrap = document.createElement("div");
  wrap.className = "problem-row-wrap";

  const row = document.createElement("div");
  row.className = "problem-row" + (problem.retired_at ? " retired" : "");
  row.dataset.problemId = problem.id;

  const historyPanel = document.createElement("div");
  historyPanel.className = "problem-history hidden";

  const info = document.createElement("div");
  info.className = "problem-info tappable";
  const num = document.createElement("div");
  num.className = "p-num";
  num.textContent = `#${problem.number}`;
  const meta = document.createElement("div");
  meta.className = "p-meta";
  meta.textContent = problem.srs_last_rating
    ? `評価${problem.srs_last_rating} / 次回 ${problem.srs_next_due_date}${problem.srs_graduated ? " / 卒業" : ""}(タップで履歴)`
    : "未着手";
  info.appendChild(num);
  info.appendChild(meta);
  info.addEventListener("click", () => toggleProblemHistory(problem.id, historyPanel));

  const namedProblem = { ...problem, book_title: book.title };

  const btnWrap = document.createElement("div");
  btnWrap.className = "rate-buttons-inline";
  for (let r = 1; r <= 5; r++) {
    const btn = document.createElement("button");
    btn.className = "rate-btn";
    btn.dataset.rating = String(r);
    btn.textContent = String(r);
    btn.title = RATING_LABELS[r];
    // Todayタブと同じく、番号ボタンは1タップでそのまま記録する(メモなし)
    btn.addEventListener("click", async () => {
      await submitAttempt(namedProblem, r).catch(() => showToast("保存に失敗しました。もう一度お試しください"));
      renderBookshelfBook(state.currentBookId);
    });
    btnWrap.appendChild(btn);
  }
  const memoBtn = document.createElement("button");
  memoBtn.className = "retire-btn";
  memoBtn.textContent = "📝";
  memoBtn.title = "メモを付けて記録";
  memoBtn.addEventListener("click", () =>
    openRateModal(namedProblem, { onDone: () => renderBookshelfBook(state.currentBookId) })
  );

  const retireBtn = document.createElement("button");
  retireBtn.className = "retire-btn" + (problem.retired_at ? " active" : "");
  retireBtn.textContent = problem.retired_at ? "解除" : "もう出さない";
  retireBtn.addEventListener("click", () => toggleRetire(problem.id));

  row.appendChild(info);
  row.appendChild(memoBtn);
  row.appendChild(btnWrap);
  row.appendChild(retireBtn);
  wrap.appendChild(row);
  wrap.appendChild(historyPanel);
  return wrap;
}

// 問題ごとの過去の評価履歴(見る/wrong tapを取り消す用)。
// 新規PUT/編集APIは作らず、既存のGET /api/problems/{id}(attempts同梱)とDELETE /api/attempts/{id}
// (削除するとサーバー側でSRS状態を自動再計算する、main.pyのrecompute_problem_srs)を再利用する。
// 間違った評価を付けた場合は、該当行を削除してから正しい評価ボタンを押し直す運用にする。
async function toggleProblemHistory(problemId, panelEl) {
  if (!panelEl.classList.contains("hidden")) {
    panelEl.classList.add("hidden");
    return;
  }
  panelEl.classList.remove("hidden");
  panelEl.innerHTML = "<p class='meta'>読み込み中...</p>";
  const detail = await api(`/api/problems/${problemId}`);
  renderProblemHistory(panelEl, detail);
}

function renderProblemHistory(panelEl, detail) {
  panelEl.innerHTML = "";
  const attempts = (detail.attempts || []).slice().reverse(); // 新しい順に表示
  if (attempts.length === 0) {
    panelEl.innerHTML = "<p class='meta'>まだ記録がありません。</p>";
    return;
  }
  attempts.forEach((a) => {
    const row = document.createElement("div");
    row.className = "history-row";
    const badge = document.createElement("span");
    badge.className = "history-badge";
    badge.style.background = `var(--rate-${a.rating})`;
    badge.textContent = a.rating;
    const text = document.createElement("span");
    text.className = "history-text";
    const bits = [a.local_date];
    if (a.source === "seed") bits.push("自己申告");
    if (a.source === "import") bits.push("移行データ");
    if (a.mistake_type) bits.push(a.mistake_type);
    if (a.memo) bits.push(a.memo);
    text.textContent = bits.join(" ・ ");
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "note-delete-btn";
    delBtn.setAttribute("aria-label", "この記録を削除");
    delBtn.textContent = "🗑";
    delBtn.addEventListener("click", async () => {
      if (!confirm("この記録を削除しますか?間違えて付けた評価を取り消す場合はここから削除できます。")) return;
      await api(`/api/attempts/${a.id}`, { method: "DELETE" }).catch(() => showToast("削除に失敗しました"));
      delete state.catalogCache[state.currentBookId];
      renderBookshelfBook(state.currentBookId);
    });
    row.appendChild(badge);
    row.appendChild(text);
    row.appendChild(delBtn);
    panelEl.appendChild(row);
  });
}

async function toggleRetire(problemId) {
  await api(`/api/problems/${problemId}/retire`, { method: "POST" });
  delete state.catalogCache[state.currentBookId];
  renderBookshelfBook(state.currentBookId);
}

document.getElementById("open-onboarding-btn").addEventListener("click", openOnboarding);
document.getElementById("open-onboarding-btn-2").addEventListener("click", openOnboarding);

// ---------- メモタブ ----------

let notesFilterTimer = null;

async function loadNotes() {
  if (state.books.length === 0) state.books = await api("/api/books");
  const bookSel = document.getElementById("notes-book-filter");
  if (bookSel.options.length <= 1) {
    state.books.forEach((b) => {
      const opt = document.createElement("option");
      opt.value = b.id;
      opt.textContent = b.title;
      bookSel.appendChild(opt);
    });
  }
  if (state.mistakeTypes.length === 0) state.mistakeTypes = await api("/api/mistake-types");
  const mtSel = document.getElementById("notes-mistake-filter");
  if (mtSel.options.length <= 1) {
    state.mistakeTypes.forEach((mt) => {
      const opt = document.createElement("option");
      opt.value = mt.name;
      opt.textContent = mt.name;
      mtSel.appendChild(opt);
    });
  }
  [bookSel, mtSel, document.getElementById("notes-q")].forEach((el) => {
    el.oninput = () => {
      clearTimeout(notesFilterTimer);
      notesFilterTimer = setTimeout(fetchAndRenderNotes, 250);
    };
  });
  fetchAndRenderNotes();
}

async function fetchAndRenderNotes() {
  const bookId = document.getElementById("notes-book-filter").value;
  const mistakeType = document.getElementById("notes-mistake-filter").value;
  const q = document.getElementById("notes-q").value.trim();
  const params = new URLSearchParams();
  if (bookId) params.set("book_id", bookId);
  if (mistakeType) params.set("mistake_type", mistakeType);
  if (q) params.set("q", q);
  const notes = await api(`/api/notes?${params.toString()}`);
  const list = document.getElementById("notes-list");
  list.innerHTML = "";
  document.getElementById("notes-empty").classList.toggle("hidden", notes.length > 0);
  notes.forEach((n) => list.appendChild(renderNoteCard(n)));
}

function renderNoteCard(note) {
  const card = document.createElement("div");
  card.className = "note-card";
  const header = document.createElement("div");
  header.className = "note-card-header";
  const meta = document.createElement("div");
  meta.className = "note-meta";
  const parts = [note.noted_at];
  if (note.book_title) parts.push(`${note.book_title} #${note.problem_number}`);
  if (note.unit_name) parts.push(note.unit_name);
  meta.textContent = parts.join(" ・ ");
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "note-delete-btn";
  delBtn.setAttribute("aria-label", "削除");
  delBtn.textContent = "🗑";
  delBtn.addEventListener("click", () => deleteNote(note, card));
  header.appendChild(meta);
  header.appendChild(delBtn);
  const summary = document.createElement("div");
  summary.className = "note-summary";
  if (note.mistake_type) {
    const tag = document.createElement("span");
    tag.className = "note-tag";
    tag.textContent = note.mistake_type;
    summary.appendChild(tag);
  }
  summary.appendChild(document.createTextNode(note.summary));
  card.appendChild(header);
  card.appendChild(summary);
  return card;
}

async function deleteNote(note, cardEl) {
  if (!confirm("このメモを削除しますか?")) return;
  // note.kind === "standalone" は質問ログ由来のメモ(/api/notesで削除)、
  // "attempt" は問題評価に紐づくメモ(削除するとattempt自体を取り消し、SRS状態も再計算される)
  const url = note.kind === "attempt" ? `/api/attempts/${note.id}` : `/api/notes/${note.id}`;
  try {
    await api(url, { method: "DELETE" });
    cardEl.remove();
  } catch (err) {
    showToast("削除に失敗しました");
  }
}

// ---------- 統計タブ ----------

async function loadStats() {
  await loadWithCache(`/api/stats/overview?date=${todayStr()}`, renderStats);
}

function renderStats(data) {
  document.getElementById("stats-streak-num").textContent = data.streak_days;
  document.getElementById("header-streak").textContent = `🔥 ${data.streak_days}`;
  const paceEl = document.getElementById("stats-pace-text");
  if (data.exam_target_date && data.days_left != null) {
    paceEl.textContent =
      `目標(${data.exam_target_date})まであと${data.days_left}日、未着手${data.unattempted_total}問` +
      (data.pace_per_day != null ? ` → 1日あたり${data.pace_per_day}問ペースが必要` : "");
  } else {
    paceEl.textContent = "目標日は設定タブから設定できます";
  }
  const booksEl = document.getElementById("stats-books");
  booksEl.innerHTML = "";
  (data.books || []).forEach((b) => {
    const row = document.createElement("div");
    row.className = "stats-book-row";
    const title = document.createElement("div");
    title.className = "book-title";
    title.innerHTML = `<span>${b.title}</span><span>${b.attempted_problems}/${b.total_problems}</span>`;
    const track = document.createElement("div");
    track.className = "progress-bar-track";
    const fill = document.createElement("div");
    fill.className = "progress-bar-fill";
    fill.style.width = `${b.progress_percent}%`;
    track.appendChild(fill);
    row.appendChild(title);
    row.appendChild(track);
    booksEl.appendChild(row);
  });
}

// ---------- 設定タブ ----------

async function loadSettings() {
  const [settings, buildInfo] = await Promise.all([api("/api/settings"), api("/api/build-info")]);
  state.settings = settings;
  document.getElementById("setting-daily-target").value = settings.daily_target || 8;
  document.getElementById("setting-exam-date").value = settings.exam_target_date || "";
  const d = new Date(buildInfo.lastUpdated);
  document.getElementById("settings-last-updated").textContent =
    `最終更新: ${isNaN(d) ? buildInfo.lastUpdated : d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
}

document.getElementById("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    daily_target: Number(document.getElementById("setting-daily-target").value) || 8,
    exam_target_date: document.getElementById("setting-exam-date").value || null,
  };
  await api("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
  showToast("設定を保存しました");
  delete state.today; // daily_target変更を今日タブへ反映させるため、次回開いた時に再取得させる
  loadToday();
});

// ---------- 初回セットアップ: 単元一括自己申告 ----------

async function openOnboarding() {
  document.getElementById("onboarding-overlay").classList.remove("hidden");
  const listEl = document.getElementById("onboarding-list");
  listEl.innerHTML = "<p class='meta'>読み込み中...</p>";
  if (state.books.length === 0) state.books = await api("/api/books");

  listEl.innerHTML = "";
  for (const book of state.books) {
    const catalog = await api(`/api/books/${book.id}/catalog`);
    const heading = document.createElement("h3");
    heading.textContent = book.title;
    heading.style.fontSize = "13px";
    heading.style.color = "var(--text-dim)";
    heading.style.margin = "14px 4px 4px";
    listEl.appendChild(heading);
    (catalog.sections || []).forEach((section) => {
      (section.chapters || []).forEach((chapter) => {
        (chapter.units || []).forEach((unit) => {
          listEl.appendChild(renderOnboardingUnitRow(unit, section.name));
        });
      });
    });
  }
}

function renderOnboardingUnitRow(unit, sectionName) {
  const row = document.createElement("div");
  row.className = "onboarding-unit-row";
  const name = document.createElement("div");
  name.className = "onboarding-unit-name";
  name.textContent = `[${sectionName}] ${unit.name}`;
  const btns = document.createElement("div");
  btns.className = "onboarding-buttons";
  [["weak", "苦手"], ["normal", "普通"], ["good", "得意"]].forEach(([level, label]) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        await api(`/api/units/${unit.id}/seed-assessment`, {
          method: "POST",
          body: JSON.stringify({ level, local_date: todayStr() }),
        });
        row.classList.add("done");
      } catch (err) {
        showToast("保存に失敗しました");
        btn.disabled = false;
      }
    });
    btns.appendChild(btn);
  });
  const skipBtn = document.createElement("button");
  skipBtn.textContent = "スキップ";
  skipBtn.addEventListener("click", () => row.classList.add("done"));
  btns.appendChild(skipBtn);
  row.appendChild(name);
  row.appendChild(btns);
  return row;
}

document.getElementById("onboarding-close-btn").addEventListener("click", () => {
  document.getElementById("onboarding-overlay").classList.add("hidden");
  localStorage.setItem("drill_onboarding_seen", "1");
  Object.keys(state.catalogCache).forEach((k) => delete state.catalogCache[k]);
  loadToday();
});

// ---------- 起動 ----------

async function init() {
  state.mistakeTypes = await api("/api/mistake-types").catch(() => []);
  await loadToday();

  try {
    if (!localStorage.getItem("drill_onboarding_seen")) {
      openOnboarding();
    }
  } catch (err) {
    // localStorageが使えない環境(プライベートモード等)では単に初回セットアップを出さない
  }
}

// PC/スマホ間で使うため、他端末での評価結果をタブ復帰時に反映する
// (vocab-appの教訓: pushだけでは同期にならない、受信側にもpullの起点が要る。
// ただしDrillはvocab-appのような常時ポーリングは行わず、イベント起点のみに留める)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    loadToday();
    if (document.getElementById("tab-stats").classList.contains("active")) loadStats();
  }
});
window.addEventListener("online", () => {
  loadToday();
  if (document.getElementById("tab-stats").classList.contains("active")) loadStats();
});

init();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  });
}
