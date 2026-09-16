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

// ---------- 重要な問題ドロワー(本棚を本ごとに開かなくても全本横断で見る、2026-09-16追加) ----------

const starredDrawer = document.getElementById("starred-drawer");
const starredBackdrop = document.getElementById("starred-backdrop");

function openStarredDrawer() {
  starredDrawer.classList.add("open");
  starredBackdrop.classList.remove("hidden");
  loadStarredList();
}
function closeStarredDrawer() {
  starredDrawer.classList.remove("open");
  starredBackdrop.classList.add("hidden");
}
document.getElementById("starred-btn").addEventListener("click", openStarredDrawer);
document.getElementById("starred-close").addEventListener("click", closeStarredDrawer);
starredBackdrop.addEventListener("click", closeStarredDrawer);

async function loadStarredList() {
  const list = document.getElementById("starred-list");
  list.innerHTML = "<p class='meta'>読み込み中...</p>";
  const problems = await api("/api/problems/starred").catch(() => []);
  document.getElementById("starred-empty").classList.toggle("hidden", problems.length > 0);
  list.innerHTML = "";
  problems.forEach((p) => list.appendChild(renderStarredRow(p)));
}

function renderStarredRow(p) {
  const card = document.createElement("div");
  card.className = "note-card";
  const header = document.createElement("div");
  header.className = "note-card-header";
  const meta = document.createElement("div");
  meta.className = "note-meta";
  meta.textContent = [`${p.book_title || ""} ${p.section_name || ""} #${p.number}`, p.unit_name]
    .filter(Boolean)
    .join(" ・ ");
  const unstarBtn = document.createElement("button");
  unstarBtn.type = "button";
  unstarBtn.className = "note-delete-btn";
  unstarBtn.setAttribute("aria-label", "重要マークを外す");
  unstarBtn.innerHTML = starIconSvg(true);
  unstarBtn.addEventListener("click", async () => {
    // 2026-09-16: 楽観的更新に統一。先にカードを消し、失敗したら丸ごと読み直す
    // (このドロワーは★が付いた問題しか出さない一覧なので、個別revertより読み直しの方が単純)。
    card.remove();
    delete state.catalogCache[p.book_id];
    document.getElementById("starred-empty").classList.toggle(
      "hidden",
      document.getElementById("starred-list").children.length > 0
    );
    try {
      await api(`/api/problems/${p.id}/star`, { method: "POST" });
    } catch (err) {
      showToast("解除に失敗しました");
      loadStarredList();
    }
  });
  header.appendChild(meta);
  header.appendChild(unstarBtn);
  const summary = document.createElement("div");
  summary.className = "note-summary";
  summary.textContent = p.srs_last_rating
    ? `評価${p.srs_last_rating} / 次回 ${p.srs_next_due_date}`
    : "未着手";
  card.appendChild(header);
  card.appendChild(summary);
  return card;
}

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

// 楽観的更新の成功後にIndexedDBキャッシュ(loadWithCacheが読むstale-while-revalidate用)も
// 揃えておくためのヘルパー(2026-09-16追加)。楽観的更新はstate.today/state.catalogCacheという
// メモリ上の状態を直接書き換えるだけで、IndexedDB側はGETした時にしかcacheSetされない。
// これを放っておくと「タブを離れて戻る→一瞬古い状態が描画される→フレッシュな取得で直る」
// というフリッカーが起きる(以前は成功後に必ずrenderBookshelfBook等でGETし直していたため
// 気づかなかった問題)。
function syncTodayCache() {
  if (!state.today) return;
  cacheSet(`/api/queue/today?date=${todayStr()}`, state.today);
}

function syncCatalogCache(bookId) {
  if (state.catalogCache[bookId]) {
    cacheSet(`/api/books/${bookId}/catalog`, state.catalogCache[bookId]);
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

// ---------- SRSプレビュー計算(2026-09-16追加、database.pyのcompute_next_srs_stateの複製) ----------
// 「本棚タブの評価ボタンを押した瞬間に次回予定日を表示したい」という楽観的更新のためだけの
// クライアント側の見込み計算。本物の計算はあくまでサーバー(database.py)側で行われ、そちらが
// 正。ここでの値はUIを一瞬で更新するための「たぶんこうなる」という予測に過ぎず、ズレていても
// 実害はない(サーバーの計算結果を待って上書きすることはせず、ページを開き直せば正しい値になる
// 程度の話)。ただし database.py の INTERVAL_DAYS / GRADUATED_INTERVAL_DAYS /
// 卒業条件(streak>=2)を変更した時は、ここも必ず同じ値に直すこと。
const SRS_INTERVAL_DAYS_PREVIEW = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 15 };
const SRS_GRADUATED_INTERVAL_DAYS_PREVIEW = 60;

function addDaysLocal(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return formatLocalDate(d);
}

// fromDateから新規に評価を1件追加した場合の見込みを返す。priorStreakは「この評価を
// 追加する前」の problem.srs_streak をそのまま渡す(新規評価にのみ正確に使える。
// 既存の評価を書き換える操作は「追加前のstreak」を復元できないため対象外)。
function previewSrsNextDue(priorStreak, rating, fromDate) {
  const newStreak = rating >= 4 ? priorStreak + 1 : 0;
  const graduated = newStreak >= 2;
  const interval = graduated ? SRS_GRADUATED_INTERVAL_DAYS_PREVIEW : SRS_INTERVAL_DAYS_PREVIEW[rating];
  return { nextDue: addDaysLocal(fromDate, interval), streak: newStreak, graduated };
}

function formatSrsMeta(rating, nextDue, graduated) {
  return `評価${rating} / 次回 ${nextDue}${graduated ? " / 卒業" : ""}(タップで履歴)`;
}

// ---------- アイコン(絵文字を使わず、アプリのトーンに合わせた線画SVGを共通定義) ----------

const ICON_PENCIL =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4 20l4-1 11-11a2 2 0 0 0-3-3L5 16l-1 4z"/></svg>';
const ICON_TRASH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>' +
  '<line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
function starIconSvg(filled) {
  return `<svg viewBox="0 0 24 24" fill="${filled ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    '<path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6-4.5-4.2 6.1-.7z"/></svg>';
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

// 本棚タブで開いている章(chapter.id)を覚えておく。renderCatalog()は評価のたびに
// ツリーを丸ごと作り直すため、これが無いと開いていた章が毎回閉じた状態に戻ってしまう(2026-09-07発覚)。
const expandedChapterIds = new Set();

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

  renderTodayDoneSection();
}

// 今日タブの行を問題idから探す。「メモを書いている間に他端末の更新でリスト全体が
// 作り直された」等でDOM要素の参照だけを覚えておくと、あとで動かそうとした時には
// 既に消えたノードを触ることになり画面に反映されない不具合があったため(2026-09-08発覚)、
// row要素は保存せず、操作する瞬間に毎回IDで引き直す方式にした。
function getTodayRowEl(problemId) {
  return document.querySelector(`#today-queue .problem-row[data-problem-id="${problemId}"]`);
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
    btn.addEventListener("click", () => rateTodayProblem(problem, r));
    btnWrap.appendChild(btn);
  }
  const memoBtn = document.createElement("button");
  memoBtn.className = "retire-btn";
  memoBtn.innerHTML = ICON_PENCIL;
  memoBtn.title = "メモを付けて記録";
  memoBtn.addEventListener("click", () => openRateModal(problem, { onSubmit: submitTodayFromModal }));

  const starBtn = createStarButton(problem, syncTodayCache);

  row.appendChild(info);
  row.appendChild(btnWrap);
  row.appendChild(memoBtn);
  row.appendChild(starBtn);
  return row;
}

// 重要マークのトグルボタン(今日タブのキュー行・本棚タブの問題行で共通利用、2026-09-16追加)。
// 結果が完全に予測できる単純なトグルなので、サーバー応答を待たずに先にアイコンを
// 書き換える(2026-09-16、楽観的更新に統一する方針に合わせて変更)。失敗時だけ戻す。
function applyStarState(btn, problem, starred) {
  problem.starred_at = starred ? "now" : null;
  btn.classList.toggle("active", starred);
  btn.innerHTML = starIconSvg(starred);
  btn.title = starred ? "重要マークを外す" : "重要マークを付ける";
}

function createStarButton(problem, onSynced) {
  const btn = document.createElement("button");
  btn.className = "retire-btn star-btn" + (problem.starred_at ? " active" : "");
  btn.innerHTML = starIconSvg(!!problem.starred_at);
  btn.title = problem.starred_at ? "重要マークを外す" : "重要マークを付ける";
  btn.addEventListener("click", async () => {
    // サーバー側はNULL/現在時刻のトグルなので、連打で2回リクエストが飛ぶと
    // 見た目と実データの向きがズレる。連打防止に送信中だけ無効化する。
    if (btn.disabled) return;
    const wasStarred = !!problem.starred_at;
    applyStarState(btn, problem, !wasStarred);
    btn.disabled = true;
    try {
      await api(`/api/problems/${problem.id}/star`, { method: "POST" });
      if (onSynced) onSynced();
    } catch (err) {
      applyStarState(btn, problem, wasStarred);
      showToast("更新に失敗しました。もう一度お試しください");
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

// 今日タブでの評価送信の共通処理(番号ボタンの即時評価・メモ付きモーダルの両方から呼ぶ)。
// 「やった問題」はリストから消すのではなく、下の済みセクションへ動かして評価バッジ付きで残す
// (2026-09-08、とっつー要望: 消えるとモチベが下がる/今日何をどう評価したか後から見えない)。
// DOM操作は必ずこの関数の中で「送信前」に同期的に行う(=optimistic)。
// awaitの後まで特定のrow要素への参照を持ち越さないことが、上のgetTodayRowEl注記のバグ修正の要。
async function recordTodayAttempt(problem, rating, { memo = null, mistakeType = null } = {}) {
  let ok = true;
  // 「済み」に積むエントリはここで1回だけ作り、後で送信が成功した時にattempt_idを
  // 直接このオブジェクトへ書き戻す(配列のインデックスで探すと、連続してキーボードで
  // 評価した時に別の問題のエントリを誤って書き換えかねないため参照で持つ)。
  const entry = {
    ...problem,
    rating,
    memo,
    mistake_type: mistakeType,
    created_at: new Date().toISOString(),
    attempt_id: null,
  };
  await optimistic(
    () => {
      const rowEl = getTodayRowEl(problem.id);
      if (rowEl) rowEl.remove();
      if (!state.today) return;
      state.today.queue = state.today.queue.filter((p) => p.id !== problem.id);
      state.today.solved_today++;
      state.today.done_today = [entry, ...(state.today.done_today || [])];
      renderQuotaOnly();
      renderTodayDoneSection();
      document.getElementById("today-empty").classList.toggle("hidden", state.today.queue.length > 0);
    },
    () => {
      // 失敗時はローカルの見込みを信用せず、サーバーの状態を取り直して確実に整合させる
      ok = false;
      loadToday();
    },
    () => submitAttempt(problem, rating, { memo, mistakeType })
  )
    .then((created) => {
      entry.attempt_id = created.id;
      lastRatedAttempt = {
        attemptId: created.id,
        label: `${problem.book_title || ""} #${problem.number}`,
        entry,
        problem,
      };
      syncTodayCache();
    })
    .catch(() => {});
  return ok;
}

async function rateTodayProblem(problem, rating) {
  await recordTodayAttempt(problem, rating);
}

async function submitTodayFromModal(problem, rating, opts) {
  const ok = await recordTodayAttempt(problem, rating, opts);
  if (ok) showToast("記録しました");
}

// 直近1件だけ戻せるUndo(2026-09-16追加、Zキー用)。評価ボタン/キーボード/メモ付きモーダル、
// どの経路でもrecordTodayAttemptを通るのでここ1箇所で追跡すれば全部カバーできる。
// スタックにはせず常に最新の1件のみ(戻したら次のUndo対象はまた無しに戻る)。
let lastRatedAttempt = null;

async function undoLastRating() {
  if (!lastRatedAttempt) {
    showToast("取り消せる記録がありません");
    return;
  }
  const { attemptId, label, entry, problem } = lastRatedAttempt;
  lastRatedAttempt = null;
  // 2026-09-16: 楽観的更新に統一。サーバー応答を待たず先にキューへ戻す
  // (problemは評価前のオブジェクト参照そのものなので、srs_*系フィールドは
  // rateされる前の値のまま=キューに戻す表示として正しい)。
  if (state.today) {
    state.today.done_today = (state.today.done_today || []).filter((d) => d !== entry);
    state.today.queue = [problem, ...state.today.queue];
    state.today.solved_today = Math.max(0, state.today.solved_today - 1);
    renderToday();
  }
  showToast(`${label} の評価を取り消しました`);
  try {
    await api(`/api/attempts/${attemptId}`, { method: "DELETE" });
    syncTodayCache();
  } catch (err) {
    showToast("取り消しに失敗しました。最新の状態を再取得します");
    await loadToday();
  }
}

function renderQuotaOnly() {
  if (!state.today) return;
  document.getElementById("quota-solved").textContent = state.today.solved_today;
  document.getElementById("quota-achieved-msg").classList.toggle(
    "hidden",
    state.today.solved_today < state.today.daily_target
  );
}

// ---------- 今日タブ: 済みセクション(スクショのDONE/SKIPPEDグループ表示を参考に) ----------

let todayDoneExpanded = false;

function renderTodayDoneSection() {
  const doneToday = (state.today && state.today.done_today) || [];
  const section = document.getElementById("today-done-section");
  section.classList.toggle("hidden", doneToday.length === 0);
  document.getElementById("today-done-count").textContent = doneToday.length;
  const list = document.getElementById("today-done-list");
  list.innerHTML = "";
  doneToday.forEach((a) => list.appendChild(renderTodayDoneRow(a)));
  list.classList.toggle("hidden", !todayDoneExpanded);
  document.getElementById("today-done-toggle").classList.toggle("expanded", todayDoneExpanded);
}

function renderTodayDoneRow(a) {
  const wrap = document.createElement("div");
  wrap.className = "problem-row-wrap";

  const row = document.createElement("div");
  row.className = "problem-row today-done-row";

  const editPanel = document.createElement("div");
  editPanel.className = "problem-history hidden";

  const info = document.createElement("div");
  info.className = "problem-info tappable";
  const num = document.createElement("div");
  num.className = "p-num";
  num.textContent = `${a.book_title || ""} ${a.section_name || ""} #${a.number}`;
  const meta = document.createElement("div");
  meta.className = "p-meta";
  const bits = [a.unit_name || ""];
  if (a.mistake_type) bits.push(a.mistake_type);
  if (a.memo) bits.push(a.memo);
  meta.textContent = bits.filter(Boolean).join(" ・ ");
  info.appendChild(num);
  info.appendChild(meta);
  info.addEventListener("click", () => toggleTodayDoneEdit(a, editPanel));

  const badge = document.createElement("span");
  badge.className = "history-badge today-done-badge";
  badge.style.background = `var(--rate-${a.rating})`;
  badge.title = RATING_LABELS[a.rating] || "";
  badge.textContent = a.rating;

  row.appendChild(info);
  row.appendChild(badge);
  wrap.appendChild(row);
  wrap.appendChild(editPanel);
  return wrap;
}

// 済み行をタップすると開く編集パネル(2026-09-16追加、とっつー要望: 済みセクションで
// 評価を直し忘れやメモの付け足しをしたいのに別タブに行かないとできなかった)。
// 新規APIは作らず、本棚タブの評価修正(削除→付け直し、main.pyのrecompute_problem_srsで
// SRS自動再計算)とメモタブのインライン編集(PUT /api/attempts/{id}/memo)をそのまま流用する。
function toggleTodayDoneEdit(a, panelEl) {
  if (!panelEl.classList.contains("hidden")) {
    panelEl.classList.add("hidden");
    return;
  }
  panelEl.classList.remove("hidden");
  renderTodayDoneEditPanel(a, panelEl);
}

function renderTodayDoneEditPanel(a, panelEl) {
  panelEl.innerHTML = "";

  const btnWrap = document.createElement("div");
  btnWrap.className = "rate-buttons-inline";
  for (let r = 1; r <= 5; r++) {
    const btn = document.createElement("button");
    btn.className = "rate-btn";
    btn.dataset.rating = String(r);
    btn.textContent = String(r);
    btn.title = RATING_LABELS[r];
    if (r === a.rating) btn.style.outline = "2px solid #fff";
    btn.addEventListener("click", () => changeTodayDoneRating(a, r, panelEl));
    btnWrap.appendChild(btn);
  }

  const textarea = document.createElement("textarea");
  textarea.className = "note-edit-textarea";
  textarea.placeholder = "メモを追加・編集";
  textarea.value = a.memo || "";

  const actions = document.createElement("div");
  actions.className = "note-edit-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "note-edit-save";
  saveBtn.textContent = "メモを保存";
  saveBtn.addEventListener("click", () => saveTodayDoneMemo(a, textarea.value.trim(), panelEl));
  actions.appendChild(saveBtn);

  panelEl.appendChild(btnWrap);
  panelEl.appendChild(textarea);
  panelEl.appendChild(actions);
}

// 評価ボタンの並び順定義(1〜5)そのものを流用しているため、番号自体は変わらない。
// 5<=3のときだけmistake_typeを引き継ぐのは既存の評価モーダルと同じ仕様。
// 2026-09-16: 楽観的更新に統一する方針のため、先にaを書き換えて再描画してから
// 裏でDELETE→POSTを送る(失敗時だけ元に戻す)。ここは「既存の評価を書き換える」操作で
// 「追加前のstreak」を復元できないため、本棚の新規評価ボタンと違って次回予定日の
// プレビュー計算はしない(済みセクション自体にも次回予定日は表示していない)。
async function changeTodayDoneRating(a, newRating, panelEl) {
  if (newRating === a.rating) return;
  const prev = { attempt_id: a.attempt_id, rating: a.rating, mistake_type: a.mistake_type, created_at: a.created_at };
  a.rating = newRating;
  a.mistake_type = newRating <= 3 ? a.mistake_type : null;
  renderTodayDoneSection();
  try {
    await api(`/api/attempts/${prev.attempt_id}`, { method: "DELETE" });
    const created = await submitAttempt(a, newRating, {
      memo: a.memo,
      mistakeType: a.mistake_type,
    });
    a.attempt_id = created.id;
    a.created_at = created.created_at;
    syncTodayCache();
    showToast("評価を更新しました");
  } catch (err) {
    Object.assign(a, prev);
    renderTodayDoneSection();
    showToast("更新に失敗しました。もう一度お試しください");
  }
}

async function saveTodayDoneMemo(a, memo, panelEl) {
  const prevMemo = a.memo;
  a.memo = memo || null;
  renderTodayDoneSection();
  try {
    await api(`/api/attempts/${a.attempt_id}/memo`, { method: "PUT", body: JSON.stringify({ memo }) });
    syncTodayCache();
    showToast("メモを保存しました");
  } catch (err) {
    a.memo = prevMemo;
    renderTodayDoneSection();
    showToast("保存に失敗しました。もう一度お試しください");
  }
}

document.getElementById("today-done-toggle").addEventListener("click", () => {
  todayDoneExpanded = !todayDoneExpanded;
  renderTodayDoneSection();
});

// ---------- 評価モーダル(本棚・今日タブの📝から共通利用) ----------

let rateModalCtx = null;

// onSubmit(problem, rating, {memo, mistakeType}) が送信・UI反映・トーストまで一手に引き受ける。
// 今日タブ/本棚タブでモーダル後にやることが違う(今日タブ=済みセクションへ移動、
// 本棚タブ=ツリー再描画)ため、呼び出し側から丸ごと差し替えられるようにしている。
function openRateModal(problem, { onSubmit } = {}) {
  rateModalCtx = { problem, onSubmit, rating: null, mistakeType: null };
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

// メモ欄にフォーカスがある間、下のPC用ショートカット(isTypingTarget判定で無効化される)の
// 代わりにEnter=記録・Shift+Enter=改行にする(2026-09-16、とっつー要望)。
document.getElementById("rate-modal-memo").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    document.getElementById("rate-modal-submit").click();
  }
});

document.getElementById("rate-modal-submit").addEventListener("click", async () => {
  if (!rateModalCtx || !rateModalCtx.rating) {
    showToast("評価を選んでください");
    return;
  }
  const { problem, rating, mistakeType, onSubmit } = rateModalCtx;
  const memo = document.getElementById("rate-modal-memo").value.trim() || null;
  document.getElementById("rate-modal").classList.add("hidden");
  rateModalCtx = null;
  await onSubmit(problem, rating, { memo, mistakeType: rating <= 3 ? mistakeType : null });
});

// ---------- 本棚タブ ----------

async function loadBookshelf() {
  // 「books配列を取得済みか」と「本棚タブの<select>をまだ組み立てていないか」は別物として扱う。
  // openOnboarding()等、他の呼び出し元が先にstate.booksだけ埋めていることがあり(初回起動時のオンボーディング自動表示が該当)、
  // 以前はstate.books.length===0だけで判定していたため、その場合<select>もcurrentBookIdも一生初期化されず
  // 本棚タブが空白のまま固まるバグがあった(2026-09-07発覚)。
  if (state.books.length === 0) {
    state.books = await api("/api/books");
  }
  const sel = document.getElementById("book-select");
  if (sel.options.length === 0) {
    sel.innerHTML = "";
    state.books.forEach((b) => {
      const opt = document.createElement("option");
      opt.value = b.id;
      opt.textContent = b.title;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", () => renderBookshelfBook(Number(sel.value)));
  }
  if (!state.currentBookId) {
    state.currentBookId = state.books[0]?.id;
  }
  if (state.currentBookId) {
    document.getElementById("book-select").value = state.currentBookId;
    renderBookshelfBook(state.currentBookId);
  }
}

async function renderBookshelfBook(bookId) {
  const isBookSwitch = state.currentBookId !== bookId;
  state.currentBookId = bookId;
  // 本の切り替え時だけ「読み込み中」を出す。評価・メモ・もう出さない等の操作後に呼ばれる
  // 再描画では、ここでツリーを空にしてしまうと開いていた章の表示も一瞬消えてガタつくため出さない
  // (renderCatalogがexpandedChapterIdsを見て復元するとはいえ、消してから作り直す動き自体が目障りだった)。
  if (isBookSwitch) {
    document.getElementById("bookshelf-tree").innerHTML = "<p class='meta'>読み込み中...</p>";
  }
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
      block.className = "chapter-block" + (expandedChapterIds.has(chapter.id) ? " expanded" : "");
      const header = document.createElement("div");
      header.className = "chapter-header";
      header.textContent = `第${chapter.number}章 ${chapter.name}`;
      header.addEventListener("click", () => {
        const nowExpanded = block.classList.toggle("expanded");
        if (nowExpanded) expandedChapterIds.add(chapter.id);
        else expandedChapterIds.delete(chapter.id);
      });
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
  info.addEventListener("click", () => toggleProblemHistory(problem.id, historyPanel, meta));

  const namedProblem = { ...problem, book_title: book.title };

  // 新規評価1件ぶんのSRS見込みをその場で計算してmeta表示・problemのローカル状態を即座に
  // 書き換える(2026-09-16、楽観的更新に統一する方針)。previewSrsNextDueは「追加前のstreak」
  // が必要で、新規評価(このボタン)の場合はproblem.srs_streakがそのまま使える
  // (既存評価の書き換え系操作は「追加前streak」を復元できないため対象外、そちらは
  // changeTodayDoneRating/changeHistoryRatingで別途コメント)。
  function applyRatingPreview(rating) {
    const preview = previewSrsNextDue(problem.srs_streak || 0, rating, todayStr());
    problem.srs_last_rating = rating;
    problem.srs_next_due_date = preview.nextDue;
    problem.srs_streak = preview.streak;
    problem.srs_graduated = preview.graduated ? 1 : 0;
    meta.textContent = formatSrsMeta(rating, preview.nextDue, preview.graduated);
  }

  const btnWrap = document.createElement("div");
  btnWrap.className = "rate-buttons-inline";
  for (let r = 1; r <= 5; r++) {
    const btn = document.createElement("button");
    btn.className = "rate-btn";
    btn.dataset.rating = String(r);
    btn.textContent = String(r);
    btn.title = RATING_LABELS[r];
    // Todayタブと同じく、番号ボタンは1タップでそのまま記録する(メモなし)。
    // 失敗した場合だけ元のmeta表示・problemの状態に戻す。
    btn.addEventListener("click", async () => {
      const prevMeta = meta.textContent;
      const prevFields = {
        srs_last_rating: problem.srs_last_rating,
        srs_next_due_date: problem.srs_next_due_date,
        srs_streak: problem.srs_streak,
        srs_graduated: problem.srs_graduated,
      };
      applyRatingPreview(r);
      try {
        await submitAttempt(namedProblem, r);
        syncCatalogCache(book.id);
      } catch (err) {
        Object.assign(problem, prevFields);
        meta.textContent = prevMeta;
        showToast("保存に失敗しました。もう一度お試しください");
      }
    });
    btnWrap.appendChild(btn);
  }
  const memoBtn = document.createElement("button");
  memoBtn.className = "retire-btn";
  memoBtn.innerHTML = ICON_PENCIL;
  memoBtn.title = "メモを付けて記録";
  memoBtn.addEventListener("click", () =>
    openRateModal(namedProblem, {
      onSubmit: async (p, rating, opts) => {
        const prevMeta = meta.textContent;
        const prevFields = {
          srs_last_rating: problem.srs_last_rating,
          srs_next_due_date: problem.srs_next_due_date,
          srs_streak: problem.srs_streak,
          srs_graduated: problem.srs_graduated,
        };
        applyRatingPreview(rating);
        try {
          await submitAttempt(p, rating, opts);
          syncCatalogCache(book.id);
          showToast("記録しました");
        } catch (err) {
          Object.assign(problem, prevFields);
          meta.textContent = prevMeta;
          showToast("保存に失敗しました。もう一度お試しください");
        }
      },
    })
  );

  const starBtn = createStarButton(problem, () => syncCatalogCache(book.id));

  const retireBtn = document.createElement("button");
  retireBtn.className = "retire-btn retire-toggle" + (problem.retired_at ? " active" : "");
  retireBtn.textContent = problem.retired_at ? "解除" : "もう出さない";
  retireBtn.addEventListener("click", async () => {
    const wasRetired = !!problem.retired_at;
    problem.retired_at = wasRetired ? null : "now";
    retireBtn.classList.toggle("active", !wasRetired);
    retireBtn.textContent = wasRetired ? "もう出さない" : "解除";
    row.classList.toggle("retired", !wasRetired);
    try {
      await api(`/api/problems/${problem.id}/retire`, { method: "POST" });
      syncCatalogCache(book.id);
    } catch (err) {
      problem.retired_at = wasRetired ? "now" : null;
      retireBtn.classList.toggle("active", wasRetired);
      retireBtn.textContent = wasRetired ? "解除" : "もう出さない";
      row.classList.toggle("retired", wasRetired);
      showToast("更新に失敗しました。もう一度お試しください");
    }
  });

  // 並び順: 情報→評価(最頻出)→メモ→★重要→もう出さない(最後、かつCSS側で1段余白を空けて誤タップを防ぐ)。
  // 以前はメモボタンが評価ボタンより前にあり、今日タブ(情報→評価→メモ)と順序が食い違って
  // 指の動きが画面ごとに変わっていたため統一した(2026-09-07)。★は2026-09-16追加でメモの隣に置いた。
  row.appendChild(info);
  row.appendChild(btnWrap);
  row.appendChild(memoBtn);
  row.appendChild(starBtn);
  row.appendChild(retireBtn);
  wrap.appendChild(row);
  wrap.appendChild(historyPanel);
  return wrap;
}

// 問題ごとの過去の評価履歴(見る/直す/取り消す用)。
// 削除はDELETE /api/attempts/{id}(サーバー側でSRS状態を自動再計算する、main.pyの
// recompute_problem_srs)をそのまま使う。評価の書き換えは2026-09-16追加のPUT
// /api/attempts/{id}/ratingを使う(local_dateは変えない。削除→付け直しだと
// 過去日の記録が今日の日付に化けてしまうため、日付を変えない専用APIにした)。
async function toggleProblemHistory(problemId, panelEl, metaEl) {
  if (!panelEl.classList.contains("hidden")) {
    panelEl.classList.add("hidden");
    return;
  }
  panelEl.classList.remove("hidden");
  panelEl.innerHTML = "<p class='meta'>読み込み中...</p>";
  await refreshProblemHistory(problemId, panelEl, metaEl);
}

async function refreshProblemHistory(problemId, panelEl, metaEl) {
  const detail = await api(`/api/problems/${problemId}`);
  if (metaEl) {
    metaEl.textContent = detail.srs_last_rating
      ? formatSrsMeta(detail.srs_last_rating, detail.srs_next_due_date, detail.srs_graduated)
      : "未着手";
  }
  renderProblemHistory(panelEl, detail, metaEl);
}

// 履歴の評価修正・削除は既存の記録を書き換える操作で「追加前のstreak」を復元できないため、
// 次回予定日の正確なプレビュー計算はできない(本棚の新規評価ボタンと違う制約、
// previewSrsNextDueの注記を参照)。楽観的更新はするが、外側のmeta行(次回予定日)だけは
// 裏で問題を取り直して追いかけて直す(失敗しても静かに諦める。次に開けば直る表示専用の値なので)。
async function refreshMetaOnly(problemId, metaEl) {
  if (!metaEl) return;
  try {
    const detail = await api(`/api/problems/${problemId}`);
    metaEl.textContent = detail.srs_last_rating
      ? formatSrsMeta(detail.srs_last_rating, detail.srs_next_due_date, detail.srs_graduated)
      : "未着手";
  } catch (err) {
    // 裏更新なので失敗は無視する
  }
}

function renderProblemHistory(panelEl, detail, metaEl) {
  panelEl.innerHTML = "";
  const attempts = (detail.attempts || []).slice().reverse(); // 新しい順に表示
  if (attempts.length === 0) {
    panelEl.innerHTML = "<p class='meta'>まだ記録がありません。</p>";
    return;
  }
  attempts.forEach((a) => panelEl.appendChild(renderHistoryAttemptRow(a, detail.id, panelEl, metaEl)));
}

function renderHistoryText(textEl, a) {
  const bits = [a.local_date];
  if (a.source === "seed") bits.push("自己申告");
  if (a.source === "import") bits.push("移行データ");
  if (a.mistake_type) bits.push(a.mistake_type);
  if (a.memo) bits.push(a.memo);
  textEl.textContent = bits.join(" ・ ");
}

function renderHistoryAttemptRow(a, problemId, panelEl, metaEl) {
  const wrap = document.createElement("div");
  wrap.className = "history-row-wrap";

  const row = document.createElement("div");
  row.className = "history-row";
  const badge = document.createElement("span");
  badge.className = "history-badge";
  badge.style.background = `var(--rate-${a.rating})`;
  badge.textContent = a.rating;
  const text = document.createElement("span");
  text.className = "history-text";
  renderHistoryText(text, a);

  const editPanel = document.createElement("div");
  editPanel.className = "history-edit-panel hidden";

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "note-delete-btn";
  editBtn.setAttribute("aria-label", "この記録を編集");
  editBtn.innerHTML = ICON_PENCIL;
  editBtn.addEventListener("click", () => {
    if (!editPanel.classList.contains("hidden")) {
      editPanel.classList.add("hidden");
      return;
    }
    editPanel.classList.remove("hidden");
    renderHistoryEditPanel(a, problemId, editPanel, panelEl, metaEl, badge, text);
  });

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "note-delete-btn";
  delBtn.setAttribute("aria-label", "この記録を削除");
  delBtn.innerHTML = ICON_TRASH;
  delBtn.addEventListener("click", async () => {
    if (!confirm("この記録を削除しますか?間違えて付けた評価を取り消す場合はここから削除できます。")) return;
    // 2026-09-16: 削除も楽観的更新に統一。先に行を消し、失敗した時だけ履歴パネル全体を
    // 取り直して復元する(個々の行だけを元に戻すより、確実に正しい状態に戻せるため)。
    wrap.remove();
    if (panelEl.children.length === 0) {
      panelEl.innerHTML = "<p class='meta'>まだ記録がありません。</p>";
    }
    try {
      await api(`/api/attempts/${a.id}`, { method: "DELETE" });
      syncCatalogCache(state.currentBookId);
      refreshMetaOnly(problemId, metaEl);
    } catch (err) {
      showToast("削除に失敗しました");
      await refreshProblemHistory(problemId, panelEl, metaEl);
    }
  });

  row.appendChild(badge);
  row.appendChild(text);
  row.appendChild(editBtn);
  row.appendChild(delBtn);
  wrap.appendChild(row);
  wrap.appendChild(editPanel);
  return wrap;
}

// 今日タブの済みセクション編集パネルと同じ構成(評価ボタン+メモ欄)を、本棚の履歴行にも展開する。
function renderHistoryEditPanel(a, problemId, editPanelEl, historyPanelEl, metaEl, badgeEl, textEl) {
  editPanelEl.innerHTML = "";

  const btnWrap = document.createElement("div");
  btnWrap.className = "rate-buttons-inline";
  for (let r = 1; r <= 5; r++) {
    const btn = document.createElement("button");
    btn.className = "rate-btn";
    btn.dataset.rating = String(r);
    btn.textContent = String(r);
    btn.title = RATING_LABELS[r];
    if (r === a.rating) btn.style.outline = "2px solid #fff";
    btn.addEventListener("click", () =>
      changeHistoryRating(a, r, problemId, historyPanelEl, metaEl, badgeEl, textEl, editPanelEl)
    );
    btnWrap.appendChild(btn);
  }

  const textarea = document.createElement("textarea");
  textarea.className = "note-edit-textarea";
  textarea.placeholder = "メモを追加・編集";
  textarea.value = a.memo || "";

  const actions = document.createElement("div");
  actions.className = "note-edit-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "note-edit-save";
  saveBtn.textContent = "メモを保存";
  saveBtn.addEventListener("click", () =>
    saveHistoryMemo(a, textarea.value.trim(), problemId, historyPanelEl, metaEl, textEl)
  );
  actions.appendChild(saveBtn);

  editPanelEl.appendChild(btnWrap);
  editPanelEl.appendChild(textarea);
  editPanelEl.appendChild(actions);
}

async function changeHistoryRating(a, newRating, problemId, historyPanelEl, metaEl, badgeEl, textEl, editPanelEl) {
  if (newRating === a.rating) return;
  const prev = { rating: a.rating, mistake_type: a.mistake_type };
  a.rating = newRating;
  a.mistake_type = newRating <= 3 ? a.mistake_type : null;
  badgeEl.style.background = `var(--rate-${a.rating})`;
  badgeEl.textContent = a.rating;
  renderHistoryText(textEl, a);
  renderHistoryEditPanel(a, problemId, editPanelEl, historyPanelEl, metaEl, badgeEl, textEl);
  try {
    await api(`/api/attempts/${a.id}/rating`, {
      method: "PUT",
      body: JSON.stringify({ rating: newRating, mistake_type: a.mistake_type }),
    });
    syncCatalogCache(state.currentBookId);
    refreshMetaOnly(problemId, metaEl);
    showToast("評価を更新しました");
  } catch (err) {
    Object.assign(a, prev);
    badgeEl.style.background = `var(--rate-${a.rating})`;
    badgeEl.textContent = a.rating;
    renderHistoryText(textEl, a);
    renderHistoryEditPanel(a, problemId, editPanelEl, historyPanelEl, metaEl, badgeEl, textEl);
    showToast("更新に失敗しました。もう一度お試しください");
  }
}

async function saveHistoryMemo(a, memo, problemId, historyPanelEl, metaEl, textEl) {
  const prevMemo = a.memo;
  a.memo = memo || null;
  renderHistoryText(textEl, a);
  try {
    await api(`/api/attempts/${a.id}/memo`, { method: "PUT", body: JSON.stringify({ memo }) });
    syncCatalogCache(state.currentBookId);
    showToast("メモを保存しました");
  } catch (err) {
    a.memo = prevMemo;
    renderHistoryText(textEl, a);
    showToast("保存に失敗しました。もう一度お試しください");
  }
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
  const actions = document.createElement("div");
  actions.className = "note-card-actions";
  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "note-delete-btn";
  editBtn.setAttribute("aria-label", "編集");
  editBtn.innerHTML = ICON_PENCIL;
  editBtn.addEventListener("click", () => startEditNote(note, card));
  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "note-delete-btn";
  delBtn.setAttribute("aria-label", "削除");
  delBtn.innerHTML = ICON_TRASH;
  delBtn.addEventListener("click", () => deleteNote(note, card));
  actions.appendChild(editBtn);
  actions.appendChild(delBtn);
  header.appendChild(meta);
  header.appendChild(actions);
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

// メモ編集(2026-09-08追加)。attempt由来のメモは/api/attempts/{id}/memo、
// standalone由来は/api/notes/{id}をPUTする。保存に成功したらカードを丸ごと作り直す。
function startEditNote(note, cardEl) {
  if (cardEl.querySelector(".note-edit-textarea")) return; // 二重に編集UIを開かない
  const summaryEl = cardEl.querySelector(".note-summary");
  const textarea = document.createElement("textarea");
  textarea.className = "note-edit-textarea";
  textarea.value = note.summary;

  const actions = document.createElement("div");
  actions.className = "note-edit-actions";
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "note-edit-save";
  saveBtn.textContent = "保存";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "note-edit-cancel";
  cancelBtn.textContent = "キャンセル";
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);

  summaryEl.replaceWith(textarea);
  textarea.insertAdjacentElement("afterend", actions);
  textarea.focus();

  cancelBtn.addEventListener("click", () => {
    actions.remove();
    textarea.replaceWith(summaryEl);
  });

  saveBtn.addEventListener("click", async () => {
    const value = textarea.value.trim();
    if (!value) {
      showToast("メモを入力してください");
      return;
    }
    const url = note.kind === "attempt" ? `/api/attempts/${note.id}/memo` : `/api/notes/${note.id}`;
    const body = note.kind === "attempt" ? { memo: value } : { summary: value };
    // 2026-09-16: 楽観的更新に統一。先にカードを新しい内容で作り直し、失敗した時だけ
    // 一覧を読み直す(置き換え後は古いcardEl参照が使えなくなるため、個別revertではなく
    // loadNotesでの全体再取得にしている)。
    note.summary = value;
    cardEl.replaceWith(renderNoteCard(note));
    try {
      await api(url, { method: "PUT", body: JSON.stringify(body) });
      showToast("更新しました");
    } catch (err) {
      showToast("更新に失敗しました");
      loadNotes();
    }
  });
}

async function deleteNote(note, cardEl) {
  if (!confirm("このメモを削除しますか?")) return;
  // note.kind === "standalone" は質問ログ由来のメモ(/api/notesで削除)、
  // "attempt" は問題評価に紐づくメモ(削除するとattempt自体を取り消し、SRS状態も再計算される)
  const url = note.kind === "attempt" ? `/api/attempts/${note.id}` : `/api/notes/${note.id}`;
  cardEl.remove();
  try {
    await api(url, { method: "DELETE" });
  } catch (err) {
    showToast("削除に失敗しました");
    loadNotes();
  }
}

// ---------- 統計タブ ----------

async function loadStats() {
  await loadWithCache(`/api/stats/overview?date=${todayStr()}`, renderStats);
  await loadWithCache(`/api/stats/weakness?date=${todayStr()}`, renderWeakness);
  await loadWithCache(`/api/stats/heatmap`, renderHeatmap);
}

function renderStats(data) {
  document.getElementById("stats-streak-num").textContent = data.streak_days;
  document.getElementById("header-streak-num").textContent = data.streak_days;
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

  renderDistribution(data.rating_distribution);
  renderTrend(data.weekly_trend);
}

function renderDistribution(distribution) {
  const el = document.getElementById("stats-distribution");
  el.innerHTML = "";
  if (!distribution) return;
  const max = Math.max(1, ...Object.values(distribution));
  for (const rating of [1, 2, 3, 4, 5]) {
    const count = distribution[String(rating)] || 0;
    const row = document.createElement("div");
    row.className = "dist-row";
    const label = document.createElement("span");
    label.className = "dist-label";
    label.textContent = rating;
    const track = document.createElement("div");
    track.className = "dist-track";
    const fill = document.createElement("div");
    fill.className = "dist-fill";
    fill.style.width = `${(count / max) * 100}%`;
    fill.style.background = `var(--rate-${rating})`;
    track.appendChild(fill);
    const num = document.createElement("span");
    num.className = "dist-count";
    num.textContent = count;
    row.appendChild(label);
    row.appendChild(track);
    row.appendChild(num);
    el.appendChild(row);
  }
}

function renderTrend(weeklyTrend) {
  const el = document.getElementById("stats-trend");
  el.innerHTML = "";
  if (!weeklyTrend || weeklyTrend.length === 0) return;
  const w = 300, h = 80, pad = 10;
  const stepX = (w - pad * 2) / (weeklyTrend.length - 1 || 1);
  const yFor = (rating) => h - pad - ((rating - 1) / 4) * (h - pad * 2);
  const points = weeklyTrend.map((wk, i) => {
    const x = pad + i * stepX;
    const y = wk.avg_rating != null ? yFor(wk.avg_rating) : null;
    return { x, y, wk };
  });
  const withData = points.filter((p) => p.y != null);
  let svg = `<svg viewBox="0 0 ${w} ${h}" class="trend-svg">`;
  if (withData.length > 1) {
    const line = withData.map((p) => `${p.x},${p.y}`).join(" ");
    svg += `<polyline points="${line}" fill="none" stroke="var(--accent)" stroke-width="2" />`;
  }
  withData.forEach((p) => {
    svg += `<circle cx="${p.x}" cy="${p.y}" r="3" fill="var(--accent)" />`;
  });
  svg += `</svg>`;
  el.innerHTML = svg;
  const labels = document.createElement("div");
  labels.className = "trend-labels";
  weeklyTrend.forEach((wk) => {
    const span = document.createElement("span");
    span.textContent = wk.week_start.slice(5); // "MM-DD"
    labels.appendChild(span);
  });
  el.appendChild(labels);
}

function renderWeakness(data) {
  const breakdownEl = document.getElementById("stats-mistake-breakdown");
  const emptyEl = document.getElementById("stats-weakness-empty");
  const weakUnitsEl = document.getElementById("stats-weak-units");
  breakdownEl.innerHTML = "";
  weakUnitsEl.innerHTML = "";

  const breakdown = data.mistake_breakdown || [];
  emptyEl.classList.toggle("hidden", breakdown.length > 0);
  const max = Math.max(1, ...breakdown.map((m) => m.count));
  breakdown.forEach((m) => {
    const row = document.createElement("div");
    row.className = "dist-row";
    const label = document.createElement("span");
    label.className = "dist-label mistake-label";
    label.textContent = m.mistake_type;
    const track = document.createElement("div");
    track.className = "dist-track";
    const fill = document.createElement("div");
    fill.className = "dist-fill";
    fill.style.width = `${(m.count / max) * 100}%`;
    fill.style.background = "var(--rate-2)";
    track.appendChild(fill);
    const num = document.createElement("span");
    num.className = "dist-count";
    num.textContent = m.count;
    row.appendChild(label);
    row.appendChild(track);
    row.appendChild(num);
    breakdownEl.appendChild(row);
  });

  const weakUnits = data.weak_units || [];
  if (weakUnits.length === 0) {
    weakUnitsEl.innerHTML = "<p class='meta'>該当する単元はありません。</p>";
  }
  weakUnits.forEach((u) => {
    const row = document.createElement("div");
    row.className = "weak-unit-row";
    row.innerHTML =
      `<div><strong>${u.unit_name}</strong><span class="meta">${u.book_title} ${u.chapter_name}</span></div>` +
      `<div class="weak-unit-badge">低評価${u.low_rating_count}件 平均${u.avg_rating}</div>`;
    weakUnitsEl.appendChild(row);
  });
}

function heatmapColor(unit) {
  if (!unit.attempted) return "var(--bg-elevated)";
  if (unit.avg_rating >= 4) return "var(--rate-5)";
  if (unit.avg_rating >= 2.5) return "var(--rate-3)";
  return "var(--rate-1)";
}

function renderHeatmap(data) {
  const el = document.getElementById("stats-heatmap");
  el.innerHTML = "";
  let currentBook = null;
  (data.units || []).forEach((u) => {
    if (u.book_title !== currentBook) {
      currentBook = u.book_title;
      const heading = document.createElement("div");
      heading.className = "heatmap-book-heading";
      heading.textContent = currentBook;
      el.appendChild(heading);
    }
    const cell = document.createElement("div");
    cell.className = "heatmap-cell";
    cell.style.background = heatmapColor(u);
    cell.title = `${u.chapter_name} ${u.unit_name}(${u.attempted}/${u.total}問、平均${u.avg_rating ?? "-"})`;
    cell.textContent = u.unit_name;
    el.appendChild(cell);
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

// ---------- PC用キーボードショートカット ----------
// スマホでは指でタップするので無関係。PCで開いた時に、評価ボタンを一つずつマウスで
// 狙わなくても数字キーだけでキューを消化できるようにする(今日タブが主な対象)。
// input/textarea/select にフォーカスがある間は横取りしない(検索欄への"1"入力等を壊さないため)。

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

// タブ切り替え(Ctrl+1〜4、今日/本棚/メモ/統計の表示順と対応)。数字だけの
// 1〜5キーは評価に使っているため区別が要る一方、Ctrlは日本語入力中でも
// 素通りするテキスト編集ショートカットではないため、isTypingTarget判定より前に
// 置いてテキスト欄にフォーカスがあっても効くようにする(2026-09-16追加)。
const TAB_SHORTCUT_ORDER = ["tab-today", "tab-bookshelf", "tab-notes", "tab-stats"];

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key >= "1" && e.key <= "4") {
    const tabId = TAB_SHORTCUT_ORDER[Number(e.key) - 1];
    if (tabId) {
      e.preventDefault();
      switchTab(tabId);
    }
    return;
  }

  if (isTypingTarget(e.target)) return;

  // 評価モーダルが開いている間: 1-5で評価選択、Enterで記録、Escでキャンセル
  const rateModal = document.getElementById("rate-modal");
  if (!rateModal.classList.contains("hidden")) {
    if (e.key >= "1" && e.key <= "5") {
      selectRateModalRating(Number(e.key));
    } else if (e.key === "Enter") {
      document.getElementById("rate-modal-submit").click();
    } else if (e.key === "Escape") {
      document.getElementById("rate-modal-cancel").click();
    }
    return;
  }

  // 設定ドロワーが開いている間: Escで閉じる
  if (settingsDrawer.classList.contains("open")) {
    if (e.key === "Escape") closeSettingsDrawer();
    return;
  }

  // 今日タブ表示中: 1-5でキュー先頭の問題を即評価(メモなし)、Mでメモ付き評価モーダルを開く、
  // Zで直前の評価を取り消す(キューが空でも使えるよう、problem存在チェックより前に置く)
  if (document.getElementById("tab-today").classList.contains("active")) {
    if (e.key === "z" || e.key === "Z") {
      e.preventDefault();
      undoLastRating();
      return;
    }
    const problem = (state.today?.queue || [])[0];
    if (!problem) return;
    if (e.key >= "1" && e.key <= "5") {
      e.preventDefault();
      rateTodayProblem(problem, Number(e.key));
    } else if (e.key === "m" || e.key === "M") {
      e.preventDefault();
      openRateModal(problem, { onSubmit: submitTodayFromModal });
    }
  }
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
// 2026-09-07: 本棚タブがこの起点から漏れていて、開いたまま他端末で評価しても
// タブ復帰時に反映されないバグがあったため追加(今日タブ・統計タブは元から対象済み)。
function refreshActiveTab() {
  loadToday();
  if (document.getElementById("tab-stats").classList.contains("active")) loadStats();
  if (document.getElementById("tab-bookshelf").classList.contains("active") && state.currentBookId) {
    renderBookshelfBook(state.currentBookId);
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshActiveTab();
});
window.addEventListener("online", refreshActiveTab);

init();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {});
  });
}
