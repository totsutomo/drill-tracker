// ---------- tab switching ----------

const tabButtons = document.querySelectorAll(".tab-btn");
const tabPanels = document.querySelectorAll(".tab-panel");

// タブの切り替えをブラウザの履歴に積み、Alt+←/→・マウスの戻る/進む・Androidの戻るで
// 前のタブへ戻れるようにする(2026-09-28、Compassと同じ方式)。popstateからの呼び出しは履歴を積まない
function switchTab(tabId, { fromHistory = false } = {}) {
  const prevTab = document.querySelector(".tab-panel.active")?.id;
  if (!fromHistory && prevTab !== tabId) history.pushState({ tab: tabId }, "");
  tabButtons.forEach((b) => b.classList.toggle("active", b.dataset.tab === tabId));
  tabPanels.forEach((p) => p.classList.toggle("active", p.id === tabId));
  if (tabId === "tab-bookshelf") loadBookshelf();
  if (tabId === "tab-notes") loadNotes();
  if (tabId === "tab-stats") loadStats();
}
tabButtons.forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));

history.replaceState({ tab: document.querySelector(".tab-panel.active")?.id }, "");
window.addEventListener("popstate", (e) => {
  if (e.state?.tab) switchTab(e.state.tab, { fromHistory: true });
});

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
// action: { label, onClick } を渡すとトースト内にボタンを出す(評価直後の「取り消す」用、2026-09-27)。
// ボタン付きの時だけ押せるよう pointer-events を有効にし、表示時間も少し長くする。
function showToast(message, action = null) {
  const el = document.getElementById("toast-banner");
  el.textContent = "";
  const text = document.createElement("span");
  text.textContent = message;
  el.appendChild(text);
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      el.classList.remove("show");
      action.onClick();
    });
    el.appendChild(btn);
  }
  el.classList.toggle("has-action", !!action);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), action ? 6000 : 4000);
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
        const method = (options.method || "GET").toUpperCase();
        const headers = { "Content-Type": "application/json" };
        // 書き込み系(POST/PUT/DELETE)のみ鍵を付ける(2026-10-04、サーバー側がDRILL_WRITE_TOKEN
        // を要求するようになったため)。GETはこのアプリの設計上公開のままなので付けない。
        if (method !== "GET") {
          const config = window.DRILL_SYNC_CONFIG;
          if (config && config.writeToken) headers.Authorization = `Bearer ${config.writeToken}`;
        }
        const res = await fetch(path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
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
// 2026-09-28: 以前は端末キャッシュを読み終えてからサーバー取得を始めていた。今は両方を同時に始め、
// サーバーの応答が先に着いた場合は古いキャッシュで上書きしない(Compassのapiと同じ形)。
async function loadWithCache(path, render) {
  let fresh = false;
  const cachedPromise = cacheGet(path).then((data) => {
    if (fresh || data === undefined) return data;
    try {
      render(data);
    } catch (err) {
      console.error(`cached render failed: ${path}`, err);
    }
    return data;
  });
  try {
    const data = await api(path);
    fresh = true;
    render(data);
    return data;
  } catch (err) {
    const cached = await cachedPromise;
    if (cached !== undefined) return cached;
    throw err;
  }
}

// 本の一覧はほぼ変わらないので、端末に前回分があればそれで即進め、最新は裏で差し替える
// (2026-09-28。本棚・統計・メモの各タブが、まず本の一覧の取得を待ってから本体を読みに行っていた)
let booksPromise = null;
function ensureBooks() {
  if (state.books.length > 0) return Promise.resolve(state.books);
  if (!booksPromise) {
    booksPromise = (async () => {
      const refresh = api("/api/books").then((books) => (state.books = books));
      const cached = await cacheGet("/api/books");
      if (cached && cached.length > 0) {
        if (state.books.length === 0) state.books = cached;
        refresh.catch(() => {});
        return state.books;
      }
      return refresh;
    })().finally(() => {
      booksPromise = null;
    });
  }
  return booksPromise;
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

// study-tracker(Compass)側のlogged_atと同じ"YYYY-MM-DD HH:MM:SS"形式・端末ローカル時刻
// (vocab-appのstudyTrackerSync.ts、study-tracker app.jsのnowLocalTimestampと同方針)
function nowLocalTimestamp() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 19).replace("T", " ");
}

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
// 例外: database.py の FIRST_PASS_INTERVAL_DAYS(一周目が終わるまでの一時的な間隔延長、
// 2026-09-24追加)はここには反映していない。この見込み値がその間だけ実際より短く出ることが
// あるが、実際の記録直後に本物の値へ上書きされるため実害はない(意図的な未対応)。
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

// count = これまでの記録の件数(履歴パネルに並ぶ数)。何回つまずいた問題かを開かずに分かるようにする(2026-09-27)
function formatSrsMeta(rating, nextDue, graduated, count) {
  const times = count ? `${count}回 / ` : "";
  return `${times}評価${rating} / 次回 ${nextDue}${graduated ? " / 卒業" : ""}(タップで履歴)`;
}

// ---------- アイコン(絵文字を使わず、アプリのトーンに合わせた線画SVGを共通定義) ----------

const ICON_PENCIL =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4 20l4-1 11-11a2 2 0 0 0-3-3L5 16l-1 4z"/></svg>';
// 「もう出さない」(スマホの2段レイアウトでは文字を隠してこのアイコンだけにする、2026-10-02)
const ICON_RETIRE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<circle cx="12" cy="12" r="9"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/></svg>';
function setRetireLabel(btn, retired) {
  const label = retired ? "解除" : "もう出さない";
  btn.innerHTML = `${ICON_RETIRE}<span class="retire-label">${label}</span>`;
  btn.title = label;
  btn.setAttribute("aria-label", label);
}
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
  viewingDate: todayStr(),
  statsBookId: null, // 統計タブで選んでいる本(null=全体)。loadPrefで復元する(下のloadStats参照)
  statsDetail: null,
  pendingReveal: null, // 本棚を開いた直後にスクロールして見せたい問題 { chapterId, problemId }
};

// 端末ごとの表示の好み(最後に開いた本など)。localStorageが使えない環境でも動くよう必ずtry/catchする
function loadPref(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}
function savePref(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // 保存できなくても表示には影響しない
  }
}

// 本棚タブで開いている章(chapter.id)を覚えておく。renderCatalog()は評価のたびに
// ツリーを丸ごと作り直すため、これが無いと開いていた章が毎回閉じた状態に戻ってしまう(2026-09-07発覚)。
// 2026-09-27: アプリを開き直しても前回の続きから見られるよう、localStorageにも保存する。
const expandedChapterIds = new Set(loadPref("drill_expanded_chapters", []));

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
  const result = await api("/api/attempts", { method: "POST", body: JSON.stringify(payload) });
  syncAttemptToStudyTracker();
  return result;
}

// Compass(study-tracker、別オリジン)へこのattemptを自動記録。ベストエフォートで、
// 失敗してもUIには一切影響させない(vocab-appのsyncStudySessionと同方針、2026-09-19)。
// 2026-10-01に「Compassの学習ログが数学0分の行で埋まる」ため一度廃止したが、問題数はCompassの
// ヒートマップ・今日の実績に使うので10-02に復活。0分の行はCompass側の学習ログ一覧で隠す。
function syncAttemptToStudyTracker() {
  const config = window.DRILL_SYNC_CONFIG;
  if (!config || !config.studyTrackerUrl || !config.studyTrackerToken) return;
  const url = `${config.studyTrackerUrl}/api/study-logs/drill-sync?token=${encodeURIComponent(config.studyTrackerToken)}`;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ count: 1, logged_at: nowLocalTimestamp() }),
    keepalive: true,
  }).catch(() => {});
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
  if (data.streak_days != null) renderHeaderStreak(data.streak_days, data.streak_freeze_balance, data.streak_today_done);
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
  const wrap = document.createElement("div");
  wrap.className = "problem-row-wrap";

  const row = document.createElement("div");
  row.className = "problem-row problem-row-rate";
  row.dataset.problemId = problem.id;

  const historyPanel = document.createElement("div");
  historyPanel.className = "problem-history hidden";

  const info = document.createElement("div");
  info.className = "problem-info tappable";
  const num = document.createElement("div");
  num.className = "p-num";
  num.textContent = `${problem.book_title || ""} ${problem.section_name || ""} #${problem.number}`;
  const meta = document.createElement("div");
  meta.className = "p-meta";
  meta.textContent = problem.unit_name || "";
  info.appendChild(num);
  info.appendChild(meta);
  // 本棚タブの履歴パネルをそのまま流用(過去の評価履歴を見たいだけで、
  // metaに表示中の単元名を上書きされたくないのでmetaElはnullで渡す)。
  info.addEventListener("click", () => toggleProblemHistory(problem.id, historyPanel, null));

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
  wrap.appendChild(row);
  wrap.appendChild(historyPanel);
  return wrap;
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

// 新規solve1件ぶんを「済み」エントリとしてstate.todayへ積む共通処理。今日タブ自身の評価
// (recordTodayAttempt)だけでなく、本棚タブでの評価からも呼ぶ(2026-09-19、とっつー要望:
// 本棚で評価しても今日タブの済みセクションに開き直すまで反映されなかったのを直す)。
// state.todayはタブが非表示でも常にメモリ上に保持されているので、今日タブを開いていなくても
// ここで更新しておけば、あとでタブを開いた瞬間から最新の状態が見える。
function addSolveToTodayState(problem, rating, { memo = null, mistakeType = null } = {}) {
  if (!state.today) return null;
  // 本棚タブから評価した問題が、たまたま今日のキューにも並んでいることがある。
  // state.today.queueから外すだけだとDOM側(今日タブの行)が消えないまま残るため、
  // ここでキュー行の要素も一緒に片付ける(今日タブ自身からの評価でも同じ経路を通る)。
  const rowEl = getTodayRowEl(problem.id);
  if (rowEl) (rowEl.closest(".problem-row-wrap") || rowEl).remove();
  // 「済み」に積むエントリはここで1回だけ作り、後で送信が成功した時にattempt_idを
  // 直接このオブジェクトへ書き戻す(配列のインデックスで探すと、連続で評価した時に
  // 別の問題のエントリを誤って書き換えかねないため参照で持つ)。
  const entry = {
    ...problem,
    rating,
    memo,
    mistake_type: mistakeType,
    created_at: new Date().toISOString(),
    attempt_id: null,
  };
  state.today.queue = state.today.queue.filter((p) => p.id !== problem.id);
  state.today.solved_today++;
  if (state.today.streak_today_done === false) {
    state.today.streak_today_done = true;
    state.today.streak_days++;
    entry.flippedStreak = true;
    renderHeaderStreak(state.today.streak_days, state.today.streak_freeze_balance, true);
  }
  state.today.done_today = [entry, ...(state.today.done_today || [])];
  return entry;
}

// 上のstate更新を画面に反映する。今日タブが非表示でもDOM要素自体は常に存在する
// (タブ切り替えはCSSのactiveクラス付け替えのみ)ので、呼んでおいて問題ない。
function rerenderTodayAfterStateChange() {
  if (!state.today) return;
  renderQuotaOnly();
  renderTodayDoneSection();
  document.getElementById("today-empty").classList.toggle("hidden", state.today.queue.length > 0);
}

// 今日タブでの評価送信の共通処理(番号ボタンの即時評価・メモ付きモーダルの両方から呼ぶ)。
// 「やった問題」はリストから消すのではなく、下の済みセクションへ動かして評価バッジ付きで残す
// (2026-09-08、とっつー要望: 消えるとモチベが下がる/今日何をどう評価したか後から見えない)。
// DOM操作は必ずこの関数の中で「送信前」に同期的に行う(=optimistic)。
// awaitの後まで特定のrow要素への参照を持ち越さないことが、上のgetTodayRowEl注記のバグ修正の要。
async function recordTodayAttempt(problem, rating, { memo = null, mistakeType = null } = {}) {
  let ok = true;
  let entry;
  const created = optimistic(
    () => {
      entry = addSolveToTodayState(problem, rating, { memo, mistakeType });
      rerenderTodayAfterStateChange();
    },
    () => {
      // 失敗時はローカルの見込みを信用せず、サーバーの状態を取り直して確実に整合させる
      ok = false;
      loadToday();
    },
    () => submitAttempt(problem, rating, { memo, mistakeType })
  ).then((c) => {
    entry.attempt_id = c.id;
    syncTodayCache();
    return c;
  });
  const label = `${problem.book_title || ""} #${problem.number}`;
  const token = offerUndo(`${label} を評価${rating}で記録`, () => undoTodayRating(entry, problem, label, created));
  await created.catch(() => clearUndo(token));
  return ok;
}

async function rateTodayProblem(problem, rating) {
  await recordTodayAttempt(problem, rating);
}

async function submitTodayFromModal(problem, rating, opts) {
  // 「記録しました」は取り消しボタン付きのトースト(offerUndo)が兼ねる
  await recordTodayAttempt(problem, rating, opts);
}

// 直近1件だけ戻せるUndo。2026-09-16にZキー用として追加し、2026-09-27に評価直後のトーストの
// 「取り消す」ボタンからも使えるようにした(スマホでは押し間違えても取り消す手段がなかったため)。
// 今日タブ・本棚タブのどの評価経路もofferUndoを通すので、ここ1箇所で追跡すれば全部カバーできる。
// スタックにはせず常に最新の1件のみ(戻したら次のUndo対象はまた無しに戻る)。
let lastUndo = null;
let undoSeq = 0;

function offerUndo(message, run) {
  const token = ++undoSeq;
  lastUndo = { token, run };
  showToast(message, { label: "取り消す", onClick: undoLastRating });
  return token;
}

// 送信に失敗した記録は取り消し対象から外す(失敗時はoptimisticが既に巻き戻している)
function clearUndo(token) {
  if (lastUndo && lastUndo.token === token) lastUndo = null;
}

async function undoLastRating() {
  if (!lastUndo) {
    showToast("取り消せる記録がありません");
    return;
  }
  const { run } = lastUndo;
  lastUndo = null;
  await run();
}

// created: 記録送信のPromise。サーバー応答前に取り消された場合も、応答を待ってから削除する
// (以前はattempt_idが確定するまでUndo対象に載らず、評価直後の取り消しが効かなかった)。
async function undoTodayRating(entry, problem, label, created) {
  // 楽観的更新: サーバー応答を待たず先にキューへ戻す(problemは評価前のオブジェクト参照
  // そのものなので、srs_*系フィールドはrateされる前の値のまま=キューに戻す表示として正しい)。
  if (state.today) {
    state.today.done_today = (state.today.done_today || []).filter((d) => d !== entry);
    state.today.queue = [problem, ...state.today.queue.filter((p) => p.id !== problem.id)];
    state.today.solved_today = Math.max(0, state.today.solved_today - 1);
    if (entry.flippedStreak) {
      state.today.streak_today_done = false;
      state.today.streak_days = Math.max(0, state.today.streak_days - 1);
    }
    renderToday();
  }
  showToast(`${label} の評価を取り消しました`);
  try {
    const c = await created;
    await api(`/api/attempts/${c.id}`, { method: "DELETE" });
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
  const save = () => saveTodayDoneMemo(a, textarea.value.trim(), panelEl);
  saveBtn.addEventListener("click", save);
  bindEnterToSave(textarea, save);
  actions.appendChild(saveBtn);

  panelEl.appendChild(btnWrap);
  panelEl.appendChild(buildEditMistakeChips(a.mistake_type, (mt) => changeTodayDoneMistake(a, mt)));
  panelEl.appendChild(textarea);
  panelEl.appendChild(actions);
}

// 評価ボタンの並び順定義(1〜5)そのものを流用しているため、番号自体は変わらない。
// mistake_typeは評価に関わらず維持する(2026-09-23、既存の評価モーダルと同じ方針に統一)。
// 2026-09-16: 楽観的更新に統一する方針のため、先にaを書き換えて再描画してから
// 裏でDELETE→POSTを送る(失敗時だけ元に戻す)。ここは「既存の評価を書き換える」操作で
// 「追加前のstreak」を復元できないため、本棚の新規評価ボタンと違って次回予定日の
// プレビュー計算はしない(済みセクション自体にも次回予定日は表示していない)。
async function changeTodayDoneRating(a, newRating, panelEl) {
  if (newRating === a.rating) return;
  const prev = { attempt_id: a.attempt_id, rating: a.rating, mistake_type: a.mistake_type, created_at: a.created_at };
  a.rating = newRating;
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

// ミスタイプだけの変更は削除→付け直しではなくPUT /api/attempts/{id}/rating(評価は据え置き)で済ませる。
async function changeTodayDoneMistake(a, mistakeType) {
  const prevMistake = a.mistake_type;
  a.mistake_type = mistakeType;
  renderTodayDoneSection();
  try {
    await api(`/api/attempts/${a.attempt_id}/rating`, {
      method: "PUT",
      body: JSON.stringify({ rating: a.rating, mistake_type: mistakeType }),
    });
    syncTodayCache();
    showToast("ミスタイプを更新しました");
  } catch (err) {
    a.mistake_type = prevMistake;
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

// ---------- 今日タブ: 過去日の履歴閲覧(2026-09-24追加) ----------
// 「今日タブは今日の分だけ、メモタブはメモ付きの記録だけしか見えず、昨日どこまでやったか
// 確認できない」というとっつー要望。今日タブ自体は評価ボタン・楽観的更新・Undoなど
// state.today前提のロジックが密結合しているため、過去日はあえてそれらを一切再利用せず、
// 読み取り専用の別ビュー(today-history-view)として実装する(誤って今日の状態を壊すリスクを避ける)。

function formatDateNavLabel(dateStr) {
  if (dateStr === todayStr()) return "今日";
  const d = new Date(dateStr + "T00:00:00");
  const weekday = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}(${weekday})`;
}

function renderDateNav() {
  document.getElementById("today-date-label").textContent = formatDateNavLabel(state.viewingDate);
  const isToday = state.viewingDate === todayStr();
  document.getElementById("today-date-next").disabled = isToday;
  document.getElementById("today-date-today-btn").classList.toggle("hidden", isToday);
  document.getElementById("today-live-view").classList.toggle("hidden", !isToday);
  document.getElementById("today-history-view").classList.toggle("hidden", isToday);
}

async function goToDate(dateStr) {
  state.viewingDate = dateStr;
  renderDateNav();
  if (dateStr === todayStr()) {
    if (!state.today) await loadToday();
  } else {
    await loadHistoryForDate(dateStr);
  }
}

async function loadHistoryForDate(dateStr) {
  await loadWithCache(`/api/attempts/by-date?date=${dateStr}`, (data) => {
    // 連打でリクエストが前後した時、後から返ってきた古い日付のレスポンスで
    // 今見ている日付の表示を上書きしないためのガード
    if (state.viewingDate !== dateStr) return;
    renderHistoryList(data);
  });
}

function renderHistoryList(data) {
  const list = document.getElementById("today-history-list");
  list.innerHTML = "";
  data.entries.forEach((a) => list.appendChild(renderHistoryRow(a)));
  document.getElementById("today-history-empty").classList.toggle("hidden", data.entries.length > 0);
}

// renderTodayDoneRowとほぼ同じ見た目だが、タップ時に開くのは今日タブ専用の編集パネル
// (state.today.done_today前提のchangeTodayDoneRating等)ではなく、本棚タブ等でも使っている
// 汎用の問題履歴パネル(toggleProblemHistory、problem_id起点でstate.todayに依存しない)。
function renderHistoryRow(a) {
  const wrap = document.createElement("div");
  wrap.className = "problem-row-wrap";

  const row = document.createElement("div");
  row.className = "problem-row";

  const historyPanel = document.createElement("div");
  historyPanel.className = "problem-history hidden";

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
  info.addEventListener("click", () => toggleProblemHistory(a.id, historyPanel, null));

  const badge = document.createElement("span");
  badge.className = "history-badge today-done-badge";
  badge.style.background = `var(--rate-${a.rating})`;
  badge.title = RATING_LABELS[a.rating] || "";
  badge.textContent = a.rating;

  row.appendChild(info);
  row.appendChild(badge);
  wrap.appendChild(row);
  wrap.appendChild(historyPanel);
  return wrap;
}

document.getElementById("today-date-prev").addEventListener("click", () => {
  goToDate(addDaysLocal(state.viewingDate, -1));
});
document.getElementById("today-date-next").addEventListener("click", () => {
  if (state.viewingDate === todayStr()) return;
  goToDate(addDaysLocal(state.viewingDate, 1));
});
document.getElementById("today-date-today-btn").addEventListener("click", () => {
  goToDate(todayStr());
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
  // 良好/即答でもミスの種類を残したいケースがある(例: 解けたが非効率な方針だった)ため、
  // 評価に関わらず常時表示する(2026-09-23、とっつー要望)
  document.getElementById("rate-modal-mistake").classList.remove("hidden");
  document.getElementById("rate-modal-memo").value = "";
  document.getElementById("rate-modal").classList.remove("hidden");
}

function selectRateModalRating(rating) {
  rateModalCtx.rating = rating;
  document.querySelectorAll("#rate-modal-buttons .rate-btn").forEach((b) => {
    b.style.outline = Number(b.dataset.rating) === rating ? "2px solid #fff" : "none";
  });
}

// 編集パネル(今日の済み・本棚の履歴)のメモ欄用。評価モーダルと同じく
// Enterで保存・Shift+Enterで改行・IME変換確定のEnterは無視(2026-09-28、とっつー報告)。
function bindEnterToSave(textarea, save) {
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      save();
    }
  });
}

// 編集パネル用のミスタイプチップ。評価ボタンと同じく押した瞬間に保存する。
// 選択中のチップをもう一度押すと解除(null)。
function buildEditMistakeChips(current, onChange) {
  const wrap = document.createElement("div");
  wrap.className = "mistake-chips";
  state.mistakeTypes.forEach((mt) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "mistake-chip" + (mt.name === current ? " selected" : "");
    chip.textContent = mt.name;
    chip.addEventListener("click", () => onChange(mt.name === current ? null : mt.name));
    wrap.appendChild(chip);
  });
  return wrap;
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
  const { problem, rating, mistakeType, onSubmit } = rateModalCtx;
  const memo = document.getElementById("rate-modal-memo").value.trim() || null;
  document.getElementById("rate-modal").classList.add("hidden");
  rateModalCtx = null;
  await onSubmit(problem, rating, { memo, mistakeType });
});

// ---------- 本棚タブ ----------

function shortBookTitle(title) {
  return (title || "").replace(/^青チャート\s*/, "");
}

// 本のチップ(本棚・統計で共通)。activeIdがnullで includeAll の時は「全体」を選択中にする
function renderBookChips(containerId, activeId, onSelect, { includeAll = false } = {}) {
  const el = document.getElementById(containerId);
  el.innerHTML = "";
  const items = includeAll ? [{ id: null, title: "全体" }, ...state.books] : state.books;
  items.forEach((b) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "book-chip" + (b.id === activeId ? " active" : "");
    chip.textContent = b.id === null ? "全体" : shortBookTitle(b.title);
    chip.addEventListener("click", () => onSelect(b.id));
    el.appendChild(chip);
  });
  // 画面幅に収まらない時、選択中のチップが見える位置まで横にずらす
  const active = el.querySelector(".book-chip.active");
  if (active) el.scrollLeft = Math.max(0, active.offsetLeft - el.offsetLeft - 16);
}

async function loadBookshelf() {
  // openOnboarding()等、他の呼び出し元が先にstate.booksだけ埋めていることがある(初回起動時の
  // オンボーディング自動表示が該当)。「books取得済みか」と「表示中の本が決まっているか」は別々に判定する
  // (2026-09-07、両方を1つの条件で判定していて本棚が空白のまま固まるバグがあった)。
  await ensureBooks();
  if (!state.currentBookId) {
    // 2026-09-27: 以前は毎回先頭の本(数学Ⅰ)から始まり、開くたびに本を選び直す必要があった
    const saved = loadPref("drill_bookshelf_book", null);
    state.currentBookId = state.books.some((b) => b.id === saved) ? saved : state.books[0]?.id;
  }
  if (state.currentBookId) renderBookshelfBook(state.currentBookId);
}

// 前後の本へ切り替える([ / ] キー用)
function switchBookBy(delta) {
  if (!state.books.length || !state.currentBookId) return;
  const idx = state.books.findIndex((b) => b.id === state.currentBookId);
  const next = state.books[(idx + delta + state.books.length) % state.books.length];
  renderBookshelfBook(next.id);
}

// 統計タブの苦手な問題などから、その問題の本・章を開いて見せる
function openProblemInBookshelf(bookId, chapterId, problemId) {
  expandedChapterIds.add(chapterId);
  savePref("drill_expanded_chapters", [...expandedChapterIds]);
  state.pendingReveal = { bookId, chapterId, problemId };
  if (state.currentBookId !== bookId) {
    document.getElementById("bookshelf-tree").innerHTML = "<p class='meta'>読み込み中...</p>";
    state.currentBookId = bookId;
  }
  switchTab("tab-bookshelf");
}

// 章を開いてその問題までスクロールし、一瞬枠を光らせる
function revealProblemInBookshelf(chapterId, problemId) {
  expandedChapterIds.add(chapterId);
  savePref("drill_expanded_chapters", [...expandedChapterIds]);
  const block = document.querySelector(`#bookshelf-tree .chapter-block[data-chapter-id="${chapterId}"]`);
  if (block) block.classList.add("expanded");
  const row = document.querySelector(`#bookshelf-tree .problem-row-book[data-problem-id="${problemId}"]`);
  const wrap = row && row.closest(".problem-row-wrap");
  if (!wrap) return;
  wrap.scrollIntoView({ block: "center" });
  wrap.classList.add("flash");
  setTimeout(() => wrap.classList.remove("flash"), 1600);
}

// 章の進捗(着手/全体、もう出さない問題は除く=統計の進捗と同じ数え方)と「続きから」を、
// 表示中の本のカタログ(評価のたびに楽観的に書き換わるproblemオブジェクト)から作り直す
function chapterLiveProblems(chapter) {
  return (chapter.units || []).flatMap((u) => u.problems || []).filter((p) => !p.retired_at);
}

// 続きから = 本編で、カタログ順に最初の未着手問題(今日タブの新規問題と同じ選び方)
function findNextUnattempted(book) {
  for (const section of book.sections || []) {
    if (section.name === "EXERCISE") continue;
    for (const chapter of section.chapters || []) {
      for (const unit of chapter.units || []) {
        for (const problem of unit.problems || []) {
          if (problem.srs_last_rating == null && !problem.retired_at) return { section, chapter, unit, problem };
        }
      }
    }
  }
  return null;
}

function refreshBookshelfSummary() {
  const book = state.catalogCache[state.currentBookId];
  if (!book) return;
  (book.sections || []).forEach((section) =>
    (section.chapters || []).forEach((chapter) => {
      const block = document.querySelector(`#bookshelf-tree .chapter-block[data-chapter-id="${chapter.id}"]`);
      if (!block) return;
      const problems = chapterLiveProblems(chapter);
      const done = problems.filter((p) => p.srs_last_rating != null).length;
      block.querySelector(".chapter-progress").textContent = `着手 ${done}/${problems.length}`;
      block.querySelector(".chapter-bar > i").style.width = `${problems.length ? (done / problems.length) * 100 : 0}%`;
    })
  );

  // 前回解いた問題を優先して出す(2026-09-28)。この本でまだ1問も解いていなければ最初の未着手問題を出す
  const btn = document.getElementById("continue-btn");
  btn.classList.remove("hidden");
  btn.innerHTML = "";
  const last = findLastSolved(book);
  const target = last || findNextUnattempted(book);
  btn.classList.toggle("done", !target);
  btn.onclick = null;
  if (!target) {
    btn.textContent = "この本の本編は全問着手済みです";
    return;
  }
  const label = document.createElement("span");
  label.className = "continue-label";
  label.textContent = last ? "📍 前回はここまで" : "▶ ここから始める";
  const info = document.createElement("span");
  info.textContent = `${target.section.name} #${target.problem.number}`;
  const sub = document.createElement("span");
  sub.className = "continue-sub";
  const when = last ? ` ・ ${relativeDayLabel(last.problem.last_solved_at)}` : "";
  sub.textContent = `第${target.chapter.number}章 ${target.chapter.name} ・ ${target.unit.name}${when}`;
  info.appendChild(sub);
  btn.append(label, info);
  btn.onclick = () => revealProblemInBookshelf(target.chapter.id, target.problem.id);
}

// 本全体(EXERCISE含む)で、実際に解いた記録が一番新しい問題。もう出さない問題は除く
function findLastSolved(book) {
  let best = null;
  for (const section of book.sections || []) {
    for (const chapter of section.chapters || []) {
      for (const unit of chapter.units || []) {
        for (const problem of unit.problems || []) {
          if (!problem.last_solved_at || problem.retired_at) continue;
          if (!best || problem.last_solved_at > best.problem.last_solved_at) best = { section, chapter, unit, problem };
        }
      }
    }
  }
  return best;
}

// サーバーのcreated_at(SQLiteのdatetime('now')=UTCの"YYYY-MM-DD HH:MM:SS")と同じ形式の現在時刻。
// 楽観的更新で入れる値を、サーバー由来の値と文字列比較で並べられるようにするため
function nowUtcSqlString() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function relativeDayLabel(utcSqlString) {
  const d = new Date(utcSqlString.replace(" ", "T") + "Z");
  if (isNaN(d)) return "";
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  const days = Math.round((startOf(new Date()) - startOf(d)) / 86400000);
  if (days <= 0) return "今日";
  if (days === 1) return "昨日";
  return `${days}日前`;
}

function findCatalogProblem(problemId) {
  const book = state.catalogCache[state.currentBookId];
  for (const section of book?.sections || []) {
    for (const chapter of section.chapters || []) {
      for (const unit of chapter.units || []) {
        const found = (unit.problems || []).find((p) => p.id === problemId);
        if (found) return found;
      }
    }
  }
  return null;
}

async function renderBookshelfBook(bookId) {
  const isBookSwitch = state.currentBookId !== bookId;
  state.currentBookId = bookId;
  savePref("drill_bookshelf_book", bookId);
  renderBookChips("book-chips", bookId, (id) => renderBookshelfBook(id));
  // 本の切り替え時だけ「読み込み中」を出す。評価・メモ・もう出さない等の操作後に呼ばれる
  // 再描画では、ここでツリーを空にしてしまうと開いていた章の表示も一瞬消えてガタつくため出さない
  // (renderCatalogがexpandedChapterIdsを見て復元するとはいえ、消してから作り直す動き自体が目障りだった)。
  if (isBookSwitch) {
    document.getElementById("bookshelf-tree").innerHTML = "<p class='meta'>読み込み中...</p>";
  }
  if (isBookSwitch) document.getElementById("continue-btn").classList.add("hidden");
  const reveal = () => {
    const r = state.pendingReveal;
    if (r && r.bookId === bookId) revealProblemInBookshelf(r.chapterId, r.problemId);
  };
  await loadWithCache(`/api/books/${bookId}/catalog`, (data) => {
    state.catalogCache[bookId] = data;
    if (state.currentBookId === bookId) {
      renderCatalog(data);
      reveal();
    }
  });
  if (state.pendingReveal && state.pendingReveal.bookId === bookId) state.pendingReveal = null;
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
      block.dataset.chapterId = chapter.id;
      const header = document.createElement("div");
      header.className = "chapter-header";
      // 見出しに章の進捗(数字はrefreshBookshelfSummaryが入れる。評価のたびにそこだけ書き換える)
      header.innerHTML =
        '<div class="chapter-title-row"><span class="chapter-title"></span><span class="chapter-progress"></span></div>' +
        '<div class="chapter-bar"><i></i></div>';
      header.querySelector(".chapter-title").textContent = `第${chapter.number}章 ${chapter.name}`;
      header.addEventListener("click", () => {
        const nowExpanded = block.classList.toggle("expanded");
        if (nowExpanded) expandedChapterIds.add(chapter.id);
        else expandedChapterIds.delete(chapter.id);
        savePref("drill_expanded_chapters", [...expandedChapterIds]);
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
  refreshBookshelfSummary();
}

function renderBookshelfRow(problem, book) {
  const wrap = document.createElement("div");
  wrap.className = "problem-row-wrap";

  const row = document.createElement("div");
  row.className = "problem-row problem-row-rate problem-row-book" + (problem.retired_at ? " retired" : "");
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
    ? formatSrsMeta(problem.srs_last_rating, problem.srs_next_due_date, problem.srs_graduated, problem.attempt_count)
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
    problem.attempt_count = (problem.attempt_count || 0) + 1;
    problem.last_solved_at = nowUtcSqlString();
    meta.textContent = formatSrsMeta(rating, preview.nextDue, preview.graduated, problem.attempt_count);
  }

  // 番号ボタン(メモなし)とメモ付きモーダルの共通処理。先にmeta表示・problemの状態・今日タブの
  // 「済み」を書き換え(楽観的更新)、失敗した時だけ元に戻す。記録後はトーストの「取り消す」/Zキーで戻せる。
  function recordFromBookshelf(rating, opts = {}) {
    const prevMeta = meta.textContent;
    const prevFields = {
      srs_last_rating: problem.srs_last_rating,
      srs_next_due_date: problem.srs_next_due_date,
      srs_streak: problem.srs_streak,
      srs_graduated: problem.srs_graduated,
      attempt_count: problem.attempt_count,
      last_solved_at: problem.last_solved_at,
    };
    const restore = () => {
      Object.assign(problem, prevFields);
      meta.textContent = prevMeta;
      refreshBookshelfSummary();
    };
    applyRatingPreview(rating);
    refreshBookshelfSummary();
    // 今日タブが裏で開いていなくても「済み」件数へ即反映する(2026-09-19)。
    const todayEntry = addSolveToTodayState(namedProblem, rating, opts);
    if (todayEntry) rerenderTodayAfterStateChange();
    const created = submitAttempt(namedProblem, rating, opts).then((c) => {
      if (todayEntry) {
        todayEntry.attempt_id = c.id;
        syncTodayCache();
      }
      syncCatalogCache(book.id);
      return c;
    });
    const label = `${book.title} #${problem.number}`;
    const token = offerUndo(`${label} を評価${rating}で記録`, async () => {
      restore();
      showToast(`${label} の評価を取り消しました`);
      try {
        const c = await created;
        await api(`/api/attempts/${c.id}`, { method: "DELETE" });
        syncCatalogCache(book.id);
      } catch (err) {
        showToast("取り消しに失敗しました");
        refreshMetaOnly(problem.id, meta);
      }
      // 今日タブ側(済み・キュー)は個別に巻き戻さず、サーバーの状態を取り直して整合させる
      if (todayEntry) loadToday();
    });
    created.catch(() => {
      clearUndo(token);
      restore();
      // 今日タブ側は個別に巻き戻さず、サーバーの状態を取り直して整合させる
      if (todayEntry) loadToday();
      showToast("保存に失敗しました。もう一度お試しください");
    });
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
    btn.addEventListener("click", () => recordFromBookshelf(r));
    btnWrap.appendChild(btn);
  }
  const memoBtn = document.createElement("button");
  memoBtn.className = "retire-btn";
  memoBtn.innerHTML = ICON_PENCIL;
  memoBtn.title = "メモを付けて記録";
  memoBtn.addEventListener("click", () =>
    openRateModal(namedProblem, { onSubmit: (p, rating, opts) => recordFromBookshelf(rating, opts) })
  );

  const starBtn = createStarButton(problem, () => syncCatalogCache(book.id));

  const retireBtn = document.createElement("button");
  retireBtn.className = "retire-btn retire-toggle" + (problem.retired_at ? " active" : "");
  setRetireLabel(retireBtn, !!problem.retired_at);
  retireBtn.addEventListener("click", async () => {
    const wasRetired = !!problem.retired_at;
    problem.retired_at = wasRetired ? null : "now";
    retireBtn.classList.toggle("active", !wasRetired);
    setRetireLabel(retireBtn, !wasRetired);
    row.classList.toggle("retired", !wasRetired);
    refreshBookshelfSummary();
    try {
      await api(`/api/problems/${problem.id}/retire`, { method: "POST" });
      syncCatalogCache(book.id);
    } catch (err) {
      problem.retired_at = wasRetired ? "now" : null;
      retireBtn.classList.toggle("active", wasRetired);
      setRetireLabel(retireBtn, wasRetired);
      row.classList.toggle("retired", wasRetired);
      refreshBookshelfSummary();
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
      ? formatSrsMeta(detail.srs_last_rating, detail.srs_next_due_date, detail.srs_graduated, (detail.attempts || []).length)
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
    // 履歴の削除・評価修正で未着手に戻る等した時、章の進捗と「続きから」も追いかけて直す
    const cached = findCatalogProblem(problemId);
    if (cached) {
      for (const k of ["srs_last_rating", "srs_next_due_date", "srs_streak", "srs_graduated"]) cached[k] = detail[k];
      cached.attempt_count = (detail.attempts || []).length;
      const solveTimes = (detail.attempts || []).filter((a) => a.source === "solve").map((a) => a.created_at).sort();
      cached.last_solved_at = solveTimes.length ? solveTimes[solveTimes.length - 1] : null;
      refreshBookshelfSummary();
    }
    metaEl.textContent = detail.srs_last_rating
      ? formatSrsMeta(detail.srs_last_rating, detail.srs_next_due_date, detail.srs_graduated, (detail.attempts || []).length)
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
  const save = () => saveHistoryMemo(a, textarea.value.trim(), problemId, historyPanelEl, metaEl, textEl);
  saveBtn.addEventListener("click", save);
  bindEnterToSave(textarea, save);
  actions.appendChild(saveBtn);

  editPanelEl.appendChild(btnWrap);
  editPanelEl.appendChild(
    buildEditMistakeChips(a.mistake_type, (mt) =>
      changeHistoryMistake(a, mt, problemId, historyPanelEl, metaEl, badgeEl, textEl, editPanelEl)
    )
  );
  editPanelEl.appendChild(textarea);
  editPanelEl.appendChild(actions);
}

async function changeHistoryRating(a, newRating, problemId, historyPanelEl, metaEl, badgeEl, textEl, editPanelEl) {
  if (newRating === a.rating) return;
  const prev = { rating: a.rating, mistake_type: a.mistake_type };
  a.rating = newRating;
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

// パネルを作り直すとメモ欄の書きかけが消えるため、チップの見た目だけ差し替える。
async function changeHistoryMistake(a, mistakeType, problemId, historyPanelEl, metaEl, badgeEl, textEl, editPanelEl) {
  const prevMistake = a.mistake_type;
  const rerenderChips = () => {
    editPanelEl.querySelector(".mistake-chips").replaceWith(
      buildEditMistakeChips(a.mistake_type, (mt) =>
        changeHistoryMistake(a, mt, problemId, historyPanelEl, metaEl, badgeEl, textEl, editPanelEl)
      )
    );
    renderHistoryText(textEl, a);
  };
  a.mistake_type = mistakeType;
  rerenderChips();
  try {
    await api(`/api/attempts/${a.id}/rating`, {
      method: "PUT",
      body: JSON.stringify({ rating: a.rating, mistake_type: mistakeType }),
    });
    syncCatalogCache(state.currentBookId);
    showToast("ミスタイプを更新しました");
  } catch (err) {
    a.mistake_type = prevMistake;
    rerenderChips();
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
  await ensureBooks();
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

function currentNotesPath() {
  const bookId = document.getElementById("notes-book-filter").value;
  const mistakeType = document.getElementById("notes-mistake-filter").value;
  const q = document.getElementById("notes-q").value.trim();
  const params = new URLSearchParams();
  if (bookId) params.set("book_id", bookId);
  if (mistakeType) params.set("mistake_type", mistakeType);
  if (q) params.set("q", q);
  return `/api/notes?${params.toString()}`;
}

// メモを編集・削除した回数。読み込み中にそれが起きたら、読み込み前の中身で一覧を描き直さない
let notesMutationSeq = 0;

// 2026-09-28: 前回の中身を即描画→裏で最新に差し替え(loadWithCache)
async function fetchAndRenderNotes() {
  const path = currentNotesPath();
  const seq = notesMutationSeq;
  await loadWithCache(path, (notes) => {
    if (currentNotesPath() !== path || notesMutationSeq !== seq) return;
    if (document.querySelector("#notes-list .note-edit-textarea")) return; // 書きかけのメモを消さない
    const list = document.getElementById("notes-list");
    list.innerHTML = "";
    document.getElementById("notes-empty").classList.toggle("hidden", notes.length > 0);
    notes.forEach((n) => list.appendChild(renderNoteCard(n)));
  });
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

  bindEnterToSave(textarea, () => saveBtn.click());
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
    notesMutationSeq++;
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

// 2026-09-27: 評価に付いたメモ(kind === "attempt")は、以前はDELETE /api/attempts/{id}で
// 評価記録ごと消していた(メモだけを書き換えるAPIがなかった2026-09-06当時の作り)。確認文は
// 「メモを削除」なのに評価とSRSの次回予定まで消えてしまうため、メモ欄だけを空にする形に変更。
// 質問ログ由来のメモ(kind === "standalone")は従来どおりメモそのものを削除する。
async function deleteNote(note, cardEl) {
  const isAttempt = note.kind === "attempt";
  if (!confirm(isAttempt ? "このメモを消しますか?(問題の評価は残ります)" : "このメモを削除しますか?")) return;
  notesMutationSeq++;
  cardEl.remove();
  document.getElementById("notes-empty").classList.toggle(
    "hidden",
    document.getElementById("notes-list").children.length > 0
  );
  try {
    if (isAttempt) {
      const doneEntry = (state.today?.done_today || []).find((d) => d.attempt_id === note.id);
      if (doneEntry) {
        doneEntry.memo = null;
        renderTodayDoneSection();
      }
      await api(`/api/attempts/${note.id}/memo`, { method: "PUT", body: JSON.stringify({ memo: "" }) });
      if (doneEntry) syncTodayCache();
    } else {
      await api(`/api/notes/${note.id}`, { method: "DELETE" });
    }
  } catch (err) {
    showToast("削除に失敗しました");
    loadNotes();
  }
}

// ---------- 統計タブ ----------

// 4本は互いに独立しているので並行して読み、1本が失敗しても他のカードは表示する
// (2026-09-27。以前は順番に待っていたため、統計APIの遅さがそのまま全カードの遅れになっていた)。
// 本のチップで絞り込める(全体/各本)。連続日数・目標ペースは常に全体の値。
async function loadStats() {
  await ensureBooks().catch(() => []);
  if (state.statsBookId === null) state.statsBookId = loadPref("drill_stats_book", null);
  if (state.statsBookId != null && !state.books.some((b) => b.id === state.statsBookId)) state.statsBookId = null;
  renderBookChips("stats-book-chips", state.statsBookId, selectStatsBook, { includeAll: true });
  const date = todayStr();
  const bookId = state.statsBookId;
  const q = bookId != null ? `&book_id=${bookId}` : "";
  // 本を素早く切り替えた時、前の本の応答が後から届いて上書きしないようにする
  const onlyIfCurrent = (render) => (data) => {
    if (state.statsBookId === bookId) render(data);
  };
  const [overview, , detail] = await Promise.allSettled([
    loadWithCache(`/api/stats/overview?date=${date}${q}`, onlyIfCurrent(renderStats)),
    loadWithCache(`/api/stats/weakness?date=${date}${q}`, onlyIfCurrent(renderWeakness)),
    loadWithCache(`/api/stats/detail?date=${date}${q}`, onlyIfCurrent(renderStatsDetail)),
    loadWithCache(`/api/stats/heatmap`, onlyIfCurrent(renderHeatmap)),
  ]);
  document.getElementById("stats-load-error").classList.toggle(
    "hidden",
    overview.status !== "rejected" && detail.status !== "rejected"
  );
}

function selectStatsBook(bookId) {
  state.statsBookId = bookId;
  savePref("drill_stats_book", bookId);
  statsWeakExpanded = false;
  loadStats();
}

// ヘッダーの連続日数。今日タブのAPIも同じ値を返すので、統計APIを待たずに出せる
// todayDone === false の間(今日まだ解いていない)は炎を薄くして「今日の分がまだ」と分かるようにする
function renderHeaderStreak(days, freezeBalance, todayDone) {
  document.getElementById("header-streak-num").textContent = days;
  const chip = document.getElementById("header-streak");
  chip.classList.toggle("pending", todayDone === false);
  chip.title = todayDone === false ? "今日はまだ解いていません(1問解くと連続日数が続きます)" : "";
  const freezeBadge = document.getElementById("header-streak-freeze");
  const balance = freezeBalance || 0;
  freezeBadge.classList.toggle("hidden", balance <= 0);
  freezeBadge.textContent = "🧊".repeat(Math.min(balance, 2));
}

function renderStats(data) {
  document.getElementById("stats-streak-num").textContent = data.streak_days;
  renderHeaderStreak(data.streak_days, data.streak_freeze_balance, data.streak_today_done);
  document.getElementById("stats-streak-freeze").textContent = "🧊".repeat(Math.min(data.streak_freeze_balance || 0, 2));
  const hint = document.getElementById("stats-streak-hint");
  hint.classList.toggle("hidden", data.streak_today_done !== false);
  hint.textContent = `今日1問解くと ${data.streak_days + 1} 日連続`;
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

// 2026-09-27: 以前はSVGを縦横比固定のまま高さ80pxに収めていたため、横幅の広い画面では点が
// 中央の300px幅に押し込まれ、日付ラベル(横幅いっぱいに均等配置)とずれていた(最新の点が
// 2つ前のラベルの上に来て「更新されていない」ように見えた)。線は縦横比を無視して引き伸ばし、
// 点・数値・ラベルは同じ%座標でHTML配置して、どの幅でも位置が揃うようにする。
function renderTrend(weeklyTrend) {
  const el = document.getElementById("stats-trend");
  el.innerHTML = "";
  if (!weeklyTrend || weeklyTrend.length === 0) return;
  const n = weeklyTrend.length;
  const xPct = (i) => (n === 1 ? 50 : 5 + (i * 90) / (n - 1));
  const yPct = (rating) => 85 - ((rating - 1) / 4) * 70;
  const points = weeklyTrend
    .map((wk, i) => ({ wk, x: xPct(i), y: wk.avg_rating != null ? yPct(wk.avg_rating) : null }))
    .filter((p) => p.y != null);

  const plot = document.createElement("div");
  plot.className = "trend-plot";
  let svg = '<svg viewBox="0 0 100 100" preserveAspectRatio="none" class="trend-svg">';
  if (points.length > 1) {
    svg += `<polyline points="${points.map((p) => `${p.x},${p.y}`).join(" ")}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke" />`;
  }
  plot.innerHTML = svg + "</svg>";
  points.forEach((p) => {
    const dot = document.createElement("span");
    dot.className = "trend-dot";
    dot.style.left = `${p.x}%`;
    dot.style.top = `${p.y}%`;
    dot.title = `${p.wk.week_start}〜${p.wk.week_end || ""}: 平均${p.wk.avg_rating}(${p.wk.count}問)`;
    const value = document.createElement("span");
    value.className = "trend-value";
    value.textContent = p.wk.avg_rating.toFixed(1);
    dot.appendChild(value);
    plot.appendChild(dot);
  });
  el.appendChild(plot);

  const labels = document.createElement("div");
  labels.className = "trend-labels";
  weeklyTrend.forEach((wk, i) => {
    const span = document.createElement("span");
    span.style.left = `${xPct(i)}%`;
    span.textContent = i === n - 1 ? "直近7日" : wk.week_start.slice(5); // "MM-DD"
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

// ---------- 統計タブ: 拡充分(2026-09-27、Stackの統計画面に合わせる) ----------

let statsWeakExpanded = false;
const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

function renderBarChart(el, bars) {
  el.innerHTML = "";
  const max = Math.max(1, ...bars.map((b) => b.count));
  bars.forEach((b) => {
    const col = document.createElement("div");
    col.className = "bar-col" + (b.current ? " current" : "") + (b.freeze && !b.count ? " freeze" : "");
    const value = document.createElement("em");
    value.textContent = b.count ? b.count : b.freeze ? "🧊" : "";
    const bar = document.createElement("i");
    bar.style.height = `${b.freeze && !b.count ? 6 : Math.max(2, (b.count / max) * 80)}px`;
    const label = document.createElement("small");
    label.textContent = b.label;
    col.title = b.title || "";
    col.append(value, bar, label);
    el.appendChild(col);
  });
}

function renderStatsDetail(d) {
  state.statsDetail = d;
  document.getElementById("stats-streak-sub").textContent =
    `最長 ${d.longest_streak}日 ・ 🧊は7日続けるごとに1個(最大2個)貯まり、休んだ日に自動で使われます`;
  document.getElementById("stats-today-count").textContent = d.today.count;
  document.getElementById("stats-today-good").textContent =
    d.today.count ? `${Math.round((d.today.good / d.today.count) * 100)}%` : "–";
  document.getElementById("stats-due-now").textContent = d.forecast[0]?.count ?? "-";

  const today = todayStr();
  renderBarChart(
    document.getElementById("stats-daily"),
    d.daily.map((x) => ({
      count: x.count,
      freeze: x.freeze,
      current: x.date === today,
      label: x.date === today ? "今日" : String(Number(x.date.slice(8))),
      title: `${x.date}: ${x.count}問${x.freeze ? "(フリーズで継続)" : ""}`,
    }))
  );
  renderBarChart(
    document.getElementById("stats-forecast"),
    d.forecast.map((x, i) => ({
      count: x.count,
      current: i === 0,
      label: i === 0 ? "今日まで" : WEEKDAY_LABELS[new Date(x.date + "T00:00:00").getDay()],
      title: `${x.date}: ${x.count}問`,
    }))
  );

  renderStatsWeak(d);
  document.getElementById("stats-starred-count").textContent = `${d.starred_total} ›`;

  document.getElementById("stats-progress-title").textContent =
    d.progress_by === "chapter" ? "進捗(本編のみ・章ごと)" : "進捗(本編のみ)";
  const progressEl = document.getElementById("stats-progress");
  progressEl.innerHTML = "";
  d.progress.forEach((g) => {
    const row = document.createElement("div");
    row.className = "progress-row";
    const head = document.createElement("div");
    head.className = "progress-head";
    const name = document.createElement("span");
    name.textContent = d.progress_by === "chapter" ? g.label : shortBookTitle(g.label);
    const nums = document.createElement("span");
    nums.textContent = `着手 ${g.attempted} ・ 習得 ${g.mastered} / ${g.total}`;
    head.append(name, nums);
    const track = document.createElement("div");
    track.className = "progress-track";
    const pct = (n) => (g.total ? (n / g.total) * 100 : 0);
    track.innerHTML = `<i class="pt-attempted" style="width:${pct(g.attempted)}%"></i><i class="pt-mastered" style="width:${pct(g.mastered)}%"></i>`;
    row.append(head, track);
    const fpLine = d.progress_by === "book" ? firstPassBookLine(d, g.id) : null;
    if (fpLine) row.appendChild(fpLine);
    progressEl.appendChild(row);
  });

  renderFirstPass(d);
}

// ---------- 統計タブ: 1周完了の予測(2026-09-30、Stackのsrc/firstPass.tsと同じ考え方) ----------
// 「1周」= 本編の全問題に1回は手をつけること(覚えたかどうかは進捗の「習得」で見る)。
// ペースは直近14日(今日を含む)の平均。7日だと1日休んだだけで予測が大きく揺れ、30日だと最近の頑張りが反映されにくい。
// 比較線はStackの「1週間前の予想」ではなく、目標日にちょうど0になる線。目標日は本ごと(設定、NZ留学中は手元にある
// 本だけ帰国日までに、のように本によって違う)。遅れていても赤にはしない
const FP_PACE_DAYS = 14;
const FP_HISTORY_DAYS = 56; // main.pyのFIRST_PASS_HISTORY_DAYSと同じ
const FP_PLUS = 1;

/** 2つのYYYY-MM-DDの差(日)。UTCで数えるので夏時間の切り替わりでずれない */
function daysBetweenDates(from, to) {
  const utc = (s) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(to) - utc(from)) / 86400000);
}

function combineFirstPass(books) {
  const merge = (key) => {
    const out = {};
    books.forEach((b) => Object.entries(b[key]).forEach(([d, n]) => (out[d] = (out[d] || 0) + n)));
    return out;
  };
  return {
    remaining: books.reduce((s, b) => s + b.remaining, 0),
    total: books.reduce((s, b) => s + b.total, 0),
    started: merge("started"),
    started_other: merge("started_other"),
  };
}

function forecastFirstPass(b, today, targetDate) {
  // 実際に解いて着手した日(ペースに入る)と、一括評価で着手扱いになった日(推移にだけ入る)。今日=0、昨日=-1 …
  const solved = Object.entries(b.started).map(([d, n]) => [daysBetweenDates(today, d), n]);
  const all = solved.concat(Object.entries(b.started_other).map(([d, n]) => [daysBetweenDates(today, d), n]));
  const pace = solved.filter(([i]) => i > -FP_PACE_DAYS && i <= 0).reduce((s, [, n]) => s + n, 0) / FP_PACE_DAYS;
  const finish = (perDay) => {
    const days = Math.ceil(b.remaining / perDay);
    return { days, finishDate: addDaysLocal(today, days) };
  };
  let days = null;
  let finishDate = null;
  if (b.remaining === 0) {
    days = 0;
    finishDate = today;
  } else if (pace > 0) {
    ({ days, finishDate } = finish(pace));
  }
  const targetDays = targetDate ? daysBetweenDates(today, targetDate) : null;
  const need = targetDays > 0 && b.remaining > 0 ? b.remaining / targetDays : null;
  // 「こうすれば◯日」。ペース0の時は目標に間に合うペースで再開した場合(サボった後に戻る見通しを出す)
  let lever = null;
  if (b.remaining > 0) {
    if (pace === 0) {
      if (need != null) {
        const perDay = Math.max(1, Math.ceil(need));
        lever = { kind: "restart", perDay, ...finish(perDay) };
      }
    } else {
      const perDay = Math.round((pace + FP_PLUS) * 10) / 10;
      lever = { kind: "plus", perDay, ...finish(perDay) };
    }
  }
  // 各日の終わりの残り = 今の残り + その日より後に手をつけた数(古い順、最後が今)
  const history = Array.from({ length: FP_HISTORY_DAYS }, (_, k) => {
    const day = k - (FP_HISTORY_DAYS - 1);
    return b.remaining + all.filter(([i]) => i > day).reduce((s, [, n]) => s + n, 0);
  });
  return { ...b, pace, days, finishDate, lever, targetDate, targetDays, need, history };
}

function fmtRate(n) {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

/** "2027-04-30" → 今年なら"4/30"、来年以降なら"2027/4/30" */
function fmtShortDate(dateStr, today) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return y === Number(today.slice(0, 4)) ? `${m}/${d}` : `${y}/${m}/${d}`;
}

/** 本の名前を「数Ⅱ・B・C」のようにまとめる(2冊目以降は「数」を省く) */
function joinBookNames(books) {
  return books.map((b, i) => {
    const t = shortBookTitle(b.label);
    return i > 0 ? t.replace(/^数学?/, "") : t.replace(/^数学/, "数");
  }).join("・");
}

/**
 * 予測の中身(あと◯日・目標との差・ペース・「こうすれば」)。
 * 目標日は本ごと(設定)。同じ目標日の本はまとめて1つの予測にする
 */
function firstPassSectionHtml(f, today) {
  const started = f.total - f.remaining;
  let html = '<div class="fp-head">';
  if (f.remaining === 0) html += '<span class="fp-big">1周完了</span>';
  else if (f.days === null) html += '<span class="fp-big fp-none">ペースなし</span>';
  else html += `<span class="fp-big">あと<b>${f.days.toLocaleString()}</b>日</span><span class="fp-date">${fmtShortDate(f.finishDate, today)}ごろ</span>`;
  html += "</div>";
  html += `<div class="fp-bar"><i style="width:${(started / f.total) * 100}%"></i></div>`;
  html += `<div class="fp-sub">着手 ${started.toLocaleString()} / ${f.total.toLocaleString()}問(本編のみ)</div>`;
  if (f.remaining === 0) return html;
  if (f.targetDate) {
    const target = fmtShortDate(f.targetDate, today);
    if (f.targetDays <= 0) {
      html += `<div class="fp-target">目標 ${target} を過ぎています</div>`;
    } else if (f.finishDate) {
      const diff = daysBetweenDates(f.finishDate, f.targetDate);
      const rel = diff > 0 ? `より <b class="fp-good">${diff}日早い</b>` : diff < 0 ? `より <b>${-diff}日遅い</b>` : "にちょうど";
      html += `<div class="fp-target">目標 ${target} ${rel}</div>`;
    } else {
      html += `<div class="fp-target">目標 ${target} まであと${f.targetDays}日</div>`;
    }
  }
  const paceText = f.pace > 0 ? `直近${FP_PACE_DAYS}日: ${fmtRate(f.pace)}問/日` : `直近${FP_PACE_DAYS}日は新しい問題に手をつけていません`;
  const needText = f.need != null ? `(目標に必要: ${fmtRate(f.need)}問/日)` : "";
  html += `<div class="fp-sub">${paceText}${needText}</div>`;
  if (f.lever) {
    const how = f.lever.kind === "restart" ? `1日${f.lever.perDay}問で再開すれば` : `+${FP_PLUS}問/日(${fmtRate(f.lever.perDay)}問/日)なら`;
    html += `<div class="fp-lever">${how} <b>${f.lever.days.toLocaleString()}日</b>(${fmtShortDate(f.lever.finishDate, today)})</div>`;
  }
  return html;
}

function renderFirstPass(d) {
  const card = document.getElementById("stats-firstpass-card");
  const chartCard = document.getElementById("stats-burndown-card");
  const fp = d.first_pass;
  if (!fp) return; // 古い形のキャッシュ(この機能の追加前)。サーバーの応答で描き直される
  const today = todayStr();
  const books = fp.books.filter((b) => b.total > 0 && (state.statsBookId == null || b.id === state.statsBookId));
  card.classList.toggle("hidden", books.length === 0);
  chartCard.classList.toggle("hidden", books.length === 0);
  if (books.length === 0) return;

  // 目標日ごとにまとめる(近い順)。目標のない本は最後に「目標なし」として分ける
  const byTarget = new Map();
  books.filter((b) => b.target_date).forEach((b) => byTarget.set(b.target_date, [...(byTarget.get(b.target_date) || []), b]));
  const groups = [...byTarget.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, bs]) => ({ date, books: bs }));
  const noTarget = books.filter((b) => !b.target_date);
  const bookScoped = state.statsBookId != null;

  let html = "";
  let chart = null; // グラフに出すのは一番近い目標(目標がなければ全部)
  let chartName = "";
  if (groups.length === 0) {
    const f = forecastFirstPass(combineFirstPass(books), today, null);
    html += firstPassSectionHtml(f, today);
    chart = f;
    chartName = bookScoped ? shortBookTitle(books[0].label) : "";
  }
  groups.forEach((g, i) => {
    const f = forecastFirstPass(combineFirstPass(g.books), today, g.date);
    const names = joinBookNames(g.books);
    html += `<div class="fp-group${i > 0 ? " fp-group-next" : ""}">`;
    html += `<div class="fp-group-title">${fmtShortDate(g.date, today)}までの目標 · ${names}</div>`;
    html += firstPassSectionHtml(f, today) + "</div>";
    if (i === 0) {
      chart = f;
      chartName = names;
    }
  });
  if (groups.length > 0 && noTarget.length > 0) {
    const left = noTarget.reduce((s, b) => s + b.remaining, 0);
    html += `<div class="fp-notarget">目標なし: ${joinBookNames(noTarget)}(未着手 ${left.toLocaleString()}問)</div>`;
  }
  if (groups.length === 0 && !bookScoped) html += '<p class="stats-note">本ごとの1周の目標日は設定から入れられます</p>';
  document.getElementById("stats-firstpass-title").textContent = bookScoped ? `1周完了の予測 · ${shortBookTitle(books[0].label)}` : "1周完了の予測";
  document.getElementById("stats-firstpass").innerHTML = html;
  document.getElementById("stats-burndown-title").textContent = chartName ? `未着手の推移 · ${chartName}` : "未着手の推移";

  state.statsBurndown = chart;
  renderBurndown();
}

/** 本ごとの「あと◯日」(進捗カードの各行の下に出す) */
function firstPassBookLine(d, bookId) {
  const b = d.first_pass && d.first_pass.books.find((x) => x.id === bookId);
  if (!b || b.total === 0) return null;
  const today = todayStr();
  const f = forecastFirstPass(b, today, b.target_date);
  const line = document.createElement("div");
  line.className = "fp-bookline";
  const left = document.createElement("span");
  const right = document.createElement("span");
  const target = b.target_date ? ` · 目標${fmtShortDate(b.target_date, today)}` : " · 目標なし";
  if (f.remaining === 0) {
    right.textContent = "1周完了";
  } else if (f.days === null) {
    left.textContent = `直近${FP_PACE_DAYS}日 0問`;
    right.innerHTML = `<span class="fp-none">ペースなし</span>${target}`;
  } else {
    left.textContent = `${fmtRate(f.pace)}問/日`;
    right.innerHTML = `あと<b>${f.days.toLocaleString()}</b>日(${fmtShortDate(f.finishDate, today)}ごろ)${target}`;
  }
  line.append(left, right);
  return line;
}

function niceCeil(v) {
  if (v <= 0) return 10;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((m) => m * p >= v) || 10) * p;
}

let burndownObserver = null;
let burndownWidth = 0;

/**
 * 未着手の数の推移(実線、8週)+今のペースで続けた場合(点線)+目標日にちょうど0になる線(緑)。
 * 横軸は日(今日=0)。目標日が1年以上先でも入るよう、目盛りは月ごと
 */
function renderBurndown() {
  const el = document.getElementById("stats-burndown");
  const f = state.statsBurndown;
  if (!f) return;
  if (!burndownObserver && window.ResizeObserver) {
    burndownObserver = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width);
      if (w && w !== burndownWidth) renderBurndown();
    });
    burndownObserver.observe(el);
  }
  burndownWidth = Math.round(el.clientWidth);
  const W = burndownWidth || 340;
  const H = 190, L = 38, R = 14, T = 22, B = 22;
  const today = todayStr();
  const past = FP_HISTORY_DAYS - 1;
  const targetDays = f.targetDays > 0 ? f.targetDays : 0;
  // 予測が目標よりずっと先の時は、グラフが横に潰れないよう右端で切ってラベルに日付を出す
  const cap = Math.max(90, targetDays * 1.3);
  const future = Math.min(cap, Math.max(7, targetDays, f.days || 0));
  const x = (day) => L + ((day + past) / (past + future)) * (W - L - R);
  const yMax = niceCeil(Math.max(...f.history));
  const y = (v) => T + (1 - v / yMax) * (H - T - B);
  const txt = (tx, ty, str, attrs) =>
    `<text x="${tx}" y="${ty}" stroke="var(--bg-card)" stroke-width="3" paint-order="stroke" ${attrs}>${str}</text>`;

  let s = `<svg width="${W}" height="${H}" class="fp-chart" role="img" aria-label="未着手の問題数の推移と予測">`;
  s += txt(2, 10, "(問)", 'fill="var(--text-dim)"');
  [0, yMax / 2, yMax].forEach((g) => {
    s += `<line x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}" stroke="var(--bg-elevated)" />`;
    s += `<text x="${L - 4}" y="${y(g) + 3}" text-anchor="end" fill="var(--text-dim)">${g.toLocaleString()}</text>`;
  });
  const xLabels = [{ x: x(0), s: "今日", anchor: "middle", strong: true }];
  // 目標日が遠いと過去8週ぶんは左端の狭い帯になるので、「今日」とぶつかる時は「8週前」を出さない
  if (x(0) - x(-past) >= 56) xLabels.push({ x: x(-past), s: "8週前", anchor: "start" });
  let lastLabelX = -Infinity;
  const gridAt = (day, label) => {
    const gx = x(day);
    s += `<line x1="${gx}" x2="${gx}" y1="${T}" y2="${H - B}" stroke="var(--bg-elevated)" stroke-dasharray="2 3" />`;
    const clear = xLabels.every((l) => Math.abs(l.x - gx) >= 34) && gx - lastLabelX >= 40 && gx + 16 <= W;
    if (clear) {
      xLabels.push({ x: gx, s: label, anchor: "middle" });
      lastLabelX = gx;
    }
  };
  if (past + future <= 200) {
    // 半年くらいまでは1週間ごと(今日から数えて7日おき)に縦線、日付のラベルは重ならない間隔に間引く
    for (let day = -Math.floor(past / 7) * 7; day <= future; day += 7) {
      if (day !== 0) gridAt(day, fmtShortDate(addDaysLocal(today, day), today));
    }
  } else {
    // それより長い時は月の初めごと
    const m = new Date(addDaysLocal(today, -past) + "T00:00:00");
    m.setDate(1);
    for (m.setMonth(m.getMonth() + 1); ; m.setMonth(m.getMonth() + 1)) {
      const day = daysBetweenDates(today, formatLocalDate(m));
      if (day > future) break;
      gridAt(day, m.getMonth() === 0 ? `${m.getFullYear()}/1` : `${m.getMonth() + 1}月`);
    }
  }
  const pts = f.history.map((v, i) => `${x(i - past)},${y(v)}`).join(" ");
  s += `<polygon points="${x(-past)},${y(0)} ${pts} ${x(0)},${y(0)}" fill="var(--accent)" opacity="0.12" />`;
  // 目標日にちょうど0になる線: グラフの左端の残りから目標日の0まで
  const showTarget = targetDays > 0 && f.remaining > 0;
  if (showTarget) {
    s += `<line x1="${x(-past)}" y1="${y(f.history[0])}" x2="${x(targetDays)}" y2="${y(0)}" stroke="var(--good)" stroke-width="2" />`;
    // 線の終わり(目標日の0)の右側は空いているのでそこに書く。右端に余裕がなければ左上に
    const tx = x(targetDays);
    const roomRight = tx + 64 <= W;
    s += txt(roomRight ? tx + 5 : tx - 4, y(0) - 6, `目標 ${fmtShortDate(f.targetDate, today)}`, `text-anchor="${roomRight ? "start" : "end"}" fill="var(--good)"`);
  }
  s += `<polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="2" />`;
  const now = f.history[past];
  const showProj = f.pace > 0 && now > 0;
  if (showProj) {
    const zeroDay = now / f.pace;
    const endDay = Math.min(zeroDay, future);
    const endValue = Math.max(0, now - f.pace * endDay);
    s += `<line x1="${x(0)}" y1="${y(now)}" x2="${x(endDay)}" y2="${y(endValue)}" stroke="var(--accent)" stroke-width="2" stroke-dasharray="5 4" />`;
    s += `<circle cx="${x(endDay)}" cy="${y(endValue)}" r="3.5" fill="var(--bg-card)" stroke="var(--accent)" stroke-width="2" />`;
    const label = (zeroDay > future ? "→ " : "") + fmtShortDate(f.finishDate, today);
    // 右端で切った時は、文字がはみ出さないよう右寄せにする
    s += txt(x(endDay), y(endValue) - 12, label, `text-anchor="${x(endDay) + 50 > W ? "end" : "middle"}" fill="var(--text)" font-weight="700"`);
  }
  s += `<circle cx="${x(0)}" cy="${y(now)}" r="3.5" fill="var(--accent)" />`;
  xLabels.forEach((l) => {
    const strong = l.strong ? ' font-weight="700"' : "";
    s += `<text x="${l.x}" y="${H - 6}" text-anchor="${l.anchor}" fill="var(${l.strong ? "--text" : "--text-dim"})"${strong}>${l.s}</text>`;
  });
  s += "</svg>";
  s += '<div class="fp-legend"><span>— 実際</span>';
  if (showProj) s += "<span>- - 今のペース</span>";
  if (showTarget) s += '<span class="fp-good">— 目標日にちょうど0になる線</span>';
  s += "</div>";
  if (showTarget) s += '<p class="stats-note">青い点線が緑の線より下なら、目標日に間に合うペース</p>';
  el.innerHTML = s;
}

// 苦手な問題は「眺めて終わり」にしないよう、タップでその問題の本棚へ飛べるようにする
function renderStatsWeak(d) {
  document.getElementById("stats-weak-title").textContent = `苦手な問題(最新の評価が1〜2) ${d.weak_total}問`;
  const list = document.getElementById("stats-weak-list");
  list.innerHTML = "";
  if (d.weak.length === 0) {
    list.innerHTML = "<p class='meta'>ありません。評価1〜2を付けた問題がここに並びます。</p>";
    return;
  }
  const shown = statsWeakExpanded ? d.weak : d.weak.slice(0, 5);
  shown.forEach((p) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "weak-row";
    const name = document.createElement("span");
    name.className = "weak-name";
    const badge = document.createElement("span");
    badge.className = "history-badge";
    badge.style.background = `var(--rate-${p.srs_last_rating})`;
    badge.textContent = p.srs_last_rating;
    const text = document.createElement("span");
    text.textContent = `${shortBookTitle(p.book_title)} #${p.number} ${p.unit_name || ""}`;
    name.append(badge, text);
    const due = document.createElement("span");
    due.className = "weak-due";
    due.textContent = p.srs_next_due_date ? `次回 ${p.srs_next_due_date.slice(5)} ›` : "›";
    row.append(name, due);
    row.addEventListener("click", () => openProblemInBookshelf(p.book_id, p.chapter_id, p.id));
    list.appendChild(row);
  });
  if (d.weak.length > 5) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "weak-more";
    more.textContent = statsWeakExpanded ? "閉じる" : `すべて見る(${d.weak_total}問)`;
    more.addEventListener("click", () => {
      statsWeakExpanded = !statsWeakExpanded;
      renderStatsWeak(d);
    });
    list.appendChild(more);
  }
}

document.getElementById("stats-starred-link").addEventListener("click", openStarredDrawer);


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
  const onlyTitle = state.statsBookId != null ? state.books.find((b) => b.id === state.statsBookId)?.title : null;
  (data.units || []).filter((u) => !onlyTitle || u.book_title === onlyTitle).forEach((u) => {
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
  renderBookTargetInputs(await ensureBooks().catch(() => []));
  const d = new Date(buildInfo.lastUpdated);
  document.getElementById("settings-last-updated").textContent =
    `最終更新: ${isNaN(d) ? buildInfo.lastUpdated : d.toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
}

document.getElementById("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const bookTargets = {};
  document.querySelectorAll("#setting-book-targets input[data-book-id]").forEach((input) => {
    bookTargets[input.dataset.bookId] = input.value || null;
  });
  const payload = {
    daily_target: Number(document.getElementById("setting-daily-target").value) || 8,
    exam_target_date: document.getElementById("setting-exam-date").value || null,
    book_targets: bookTargets,
  };
  await api("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
  showToast("設定を保存しました");
  // 本の一覧(端末のキャッシュ含む)にも反映して、統計タブを開き直した時に新しい目標日で描く
  state.books.forEach((b) => {
    if (String(b.id) in bookTargets) b.first_pass_target = bookTargets[b.id];
  });
  cacheSet("/api/books", state.books);
  if (document.getElementById("tab-stats").classList.contains("active")) loadStats();
  delete state.today; // daily_target変更を今日タブへ反映させるため、次回開いた時に再取得させる
  loadToday();
});

// 本ごとの1周の目標日(2026-09-30)。空欄=目標なし(手元にない本など)
function renderBookTargetInputs(books) {
  const el = document.getElementById("setting-book-targets");
  el.innerHTML = "";
  books.forEach((b) => {
    const row = document.createElement("label");
    row.className = "book-target-row";
    const name = document.createElement("span");
    name.textContent = shortBookTitle(b.title);
    const input = document.createElement("input");
    input.type = "date";
    input.dataset.bookId = b.id;
    input.value = b.first_pass_target || "";
    row.append(name, input);
    el.appendChild(row);
  });
}

// ---------- 初回セットアップ: 単元一括自己申告 ----------

async function openOnboarding() {
  document.getElementById("onboarding-overlay").classList.remove("hidden");
  const listEl = document.getElementById("onboarding-list");
  listEl.innerHTML = "<p class='meta'>読み込み中...</p>";
  await ensureBooks();

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

// タブ切り替え(Alt+1〜4、今日/本棚/メモ/統計の表示順と対応)。数字だけの
// 1〜5キーは評価に使っているため修飾キーが要る。isTypingTarget判定より前に
// 置いてテキスト欄にフォーカスがあっても効くようにする(2026-09-16追加)。
// 2026-10-03にCtrl+数字からAlt+数字へ変更し、Compass・Stack・vocab-appとそろえた
// (Ctrl+数字は普通のブラウザタブで開くとブラウザのタブ切替に先取りされる)。
// Alt+数字はe.keyが配列によって変わりうるためe.codeで見る
const TAB_SHORTCUT_ORDER = ["tab-today", "tab-bookshelf", "tab-notes", "tab-stats"];

document.addEventListener("keydown", (e) => {
  if (e.altKey && !e.ctrlKey && !e.metaKey && /^Digit[1-4]$/.test(e.code)) {
    const tabId = TAB_SHORTCUT_ORDER[Number(e.code.slice(5)) - 1];
    if (tabId) {
      e.preventDefault();
      switchTab(tabId);
    }
    return;
  }

  // 評価モーダルが開いている間: 1-5で評価選択、Enterで記録、Escでキャンセル。
  // isTypingTarget判定より前に置く(メモ欄やチップ等どこにフォーカスがあっても効くように)。
  // Enterはe.preventDefault()して、フォーカスがボタンにある場合のブラウザ標準の
  // Enter→click発火(rateModalCtxが既にnull化された後に発火し例外になる)を防ぐ
  // (2026-09-23、とっつー報告: 評価を押した直後のEnterでセーブされない不具合の修正)。
  const rateModal = document.getElementById("rate-modal");
  if (!rateModal.classList.contains("hidden")) {
    const memoFocused = e.target && e.target.id === "rate-modal-memo";
    if (memoFocused) {
      // IME変換確定のEnter(e.isComposing)まで拾うと、変換中に誤って記録してしまうため除外。
      // Shift+Enterは改行(テキストエリアの標準動作のまま素通しする)。
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        document.getElementById("rate-modal-submit").click();
      }
      return;
    }
    if (e.key >= "1" && e.key <= "5") {
      e.preventDefault();
      selectRateModalRating(Number(e.key));
    } else if (e.key === "Enter") {
      e.preventDefault();
      document.getElementById("rate-modal-submit").click();
    } else if (e.key === "Escape") {
      e.preventDefault();
      document.getElementById("rate-modal-cancel").click();
    }
    return;
  }

  // Escは入力欄にいても効かせる(開いているパネルを手前から1つ閉じる)。2026-09-27以前は
  // 設定ドロワーしか閉じられず、★ドロワーと「単元をまとめて評価」はEscが効かなかった。
  if (e.key === "Escape" && closeTopPanel()) {
    e.preventDefault();
    return;
  }

  if (isTypingTarget(e.target)) return;
  // パネルが開いている間は、裏のタブへの1文字ショートカットを無効にする
  if (anyPanelOpen()) return;

  if (e.key === "?") {
    e.preventDefault();
    openShortcutHelp();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  // / で検索(メモタブの検索欄へ)、, で設定。4アプリ共通の割り当て(2026-10-03)
  if (e.key === "/") {
    e.preventDefault();
    switchTab("tab-notes");
    document.getElementById("notes-q").focus();
    return;
  }
  if (e.key === ",") {
    e.preventDefault();
    openSettingsDrawer();
    return;
  }

  const activeTab = document.querySelector(".tab-panel.active")?.id;

  // 今日タブ表示中: 1-5でキュー先頭の問題を即評価(メモなし)、Mでメモ付き評価モーダルを開く、
  // Zで直前の評価を取り消す(キューが空でも使えるよう、problem存在チェックより前に置く)、
  // ←/→で前日/翌日の記録を見る(2026-09-27追加)
  if (activeTab === "tab-today") {
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      goToDate(addDaysLocal(state.viewingDate, -1));
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (state.viewingDate !== todayStr()) goToDate(addDaysLocal(state.viewingDate, 1));
      return;
    }
    if (e.key === "z" || e.key === "Z") {
      e.preventDefault();
      undoLastRating();
      return;
    }
    // 過去日を表示している間は今日のキューが隠れているので、見えない問題を評価しないようにする
    if (state.viewingDate !== todayStr()) return;
    const problem = (state.today?.queue || [])[0];
    if (!problem) return;
    if (e.key >= "1" && e.key <= "5") {
      e.preventDefault();
      rateTodayProblem(problem, Number(e.key));
    } else if (e.key === "m" || e.key === "M") {
      e.preventDefault();
      openRateModal(problem, { onSubmit: submitTodayFromModal });
    }
    return;
  }

  // 本棚タブ: ← / → で前後の本(2026-10-03に [ / ] から変更、他アプリの「前/次」とそろえた)、Zで直前の評価を取り消す(本棚の評価ボタンもUndo対象)
  if (activeTab === "tab-bookshelf") {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      switchBookBy(e.key === "ArrowRight" ? 1 : -1);
    } else if (e.key === "z" || e.key === "Z") {
      e.preventDefault();
      undoLastRating();
    }
    return;
  }

});

// 開いているパネル(手前にあるものから順)を1つ閉じる。閉じたらtrue
function closeTopPanel() {
  const help = document.getElementById("shortcut-help");
  if (!help.classList.contains("hidden")) {
    help.classList.add("hidden");
    return true;
  }
  if (!document.getElementById("onboarding-overlay").classList.contains("hidden")) {
    document.getElementById("onboarding-close-btn").click();
    return true;
  }
  if (starredDrawer.classList.contains("open")) {
    closeStarredDrawer();
    return true;
  }
  if (settingsDrawer.classList.contains("open")) {
    closeSettingsDrawer();
    return true;
  }
  return false;
}

function anyPanelOpen() {
  return (
    !document.getElementById("shortcut-help").classList.contains("hidden") ||
    !document.getElementById("onboarding-overlay").classList.contains("hidden") ||
    starredDrawer.classList.contains("open") ||
    settingsDrawer.classList.contains("open")
  );
}

function openShortcutHelp() {
  const help = document.getElementById("shortcut-help");
  help.classList.remove("hidden");
  document.getElementById("shortcut-help-close").focus({ preventScroll: true });
}
document.getElementById("shortcut-help-close").addEventListener("click", () => {
  document.getElementById("shortcut-help").classList.add("hidden");
});
document.getElementById("shortcut-help-btn").addEventListener("click", () => {
  closeSettingsDrawer();
  openShortcutHelp();
});

// ---------- 起動 ----------

async function init() {
  // 2026-09-28: 以前はミス分類→今日タブ→統計の順に1つずつ待っていた。互いに独立なので同時に始める
  // (ミス分類は評価パネルを開くまで使わないので、前回分を即使い、最新は裏で差し替える)。
  loadWithCache("/api/mistake-types", (data) => {
    state.mistakeTypes = data;
  }).catch(() => {});
  renderDateNav();
  const today = loadToday();
  // 統計タブは従来「タブを開いた時だけ」読み込んでいたため、今日タブなどで数分過ごしてから
  // 統計タブを開くと毎回そこで待たされていた。起動直後の今日タブ表示をブロックしないよう
  // awaitはせず、裏で先に読み込んでキャッシュを温めておく(2026-09-19、とっつー要望)。
  loadStats().catch(() => {});
  await today;

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
