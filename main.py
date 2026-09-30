import json
import os
import uuid
from datetime import date as dtdate
from datetime import datetime
from typing import Optional
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from database import (
    add_days,
    get_connection,
    init_db,
    recompute_problem_srs,
    row_to_dict,
    rows_to_dicts,
)

app = FastAPI(title="Drill")

init_db()

# study-tracker(Compass、別オリジン)へattempt実績を自動記録するための設定。
# 未設定の環境ではconfig.jsが空値を返しapp.js側がサイレントに何もしない
# (vocab-appのstudyTrackerSync.tsと同方針、2026-09-19)。
STUDY_TRACKER_URL = os.environ.get("STUDY_TRACKER_URL", "https://study-tracker-x6zf.onrender.com")
STUDY_TRACKER_SYNC_TOKEN = os.environ.get("STUDY_TRACKER_SYNC_TOKEN")


def _load_last_updated() -> str:
    build_info_path = os.path.join(os.path.dirname(__file__), "build_info.txt")
    try:
        with open(build_info_path) as f:
            return f.read().strip()
    except FileNotFoundError:
        return datetime.now().astimezone().isoformat()


LAST_UPDATED = _load_last_updated()

SEED_LEVEL_RATING = {"weak": 2, "normal": 3, "good": 4}


def _all_settings(conn) -> dict:
    return {k: v for k, v in conn.execute("SELECT key, value FROM settings").fetchall()}


def _streak_ending_at(end_date: str, covered_dates: set) -> int:
    streak = 0
    cursor_date = end_date
    while cursor_date in covered_dates:
        streak += 1
        cursor_date = add_days(cursor_date, -1)
    return streak


STREAK_FREEZE_MILESTONE_STEP = 7
STREAK_FREEZE_BALANCE_CAP = 2


# never miss twiceの自動版(2026-09-19)。昨日1日だけ欠けていて、それまでに7日以上の
# 連続実績がありフリーズ残高が残っていれば自動消費して継続扱いにする。あわせて現在の
# ストリークが新しい7の倍数に到達していれば(残高が上限未満なら)フリーズを1個貯める。
# べき等: 同じ状態で何度呼んでも結果は変わらない(streak_freezes.dateがPRIMARY KEYのため
# 同じ日を二重に消費することはない)。/api/queue/today・/api/stats/overviewのリクエストごとに呼ぶ
#
# 2026-09-27: Tursoは1クエリごとに約0.3秒の往復がかかるため、同じ日付一覧を何度も読み直していた
# 旧実装(1回の呼び出しで7〜9クエリ)を、3回読んでメモリ上で判定する形に変更。
# 戻り値は(現在のストリーク日数, フリーズ残高)で、呼び出し側はこれをそのまま表示に使う。
def _settle_streak_freeze(conn, today: str, settings: dict) -> tuple:
    # 「実際に解いた」日だけを数える(source='solve')。importの過去データや
    # seedの一括自己申告はアプリを使い続けている実感=ストリークには含めない
    solved, freezes = set(), set()
    for kind, d in conn.execute(
        "SELECT DISTINCT 's', local_date FROM attempts WHERE source = 'solve' "
        "UNION ALL SELECT 'f', date FROM streak_freezes"
    ).fetchall():
        (solved if kind == "s" else freezes).add(d)
    milestone = int(settings.get("streak_freeze_milestone") or "0")

    def balance() -> int:
        return max(0, milestone // STREAK_FREEZE_MILESTONE_STEP - len(freezes))

    yesterday = add_days(today, -1)
    if yesterday not in solved and yesterday not in freezes:
        streak_before_gap = _streak_ending_at(add_days(yesterday, -1), solved | freezes)
        if streak_before_gap >= STREAK_FREEZE_MILESTONE_STEP and balance() >= 1:
            conn.execute("INSERT INTO streak_freezes (date) VALUES (?)", (yesterday,))
            conn.commit()
            freezes.add(yesterday)

    # 今日まだ1問も解いていない間は「昨日までの連続日数」を出す(2026-09-27)。以前は今日の分が
    # 記録されるまで0と表示され、14日続けていても朝開くたびに途切れたように見えていた。
    # 今日が終わっても解かなければ、翌日には昨日が欠けて(フリーズがなければ)0になる。
    covered = solved | freezes
    today_done = today in covered
    current_streak = _streak_ending_at(today if today_done else yesterday, covered)
    # whileにしているのは、settleがしばらく呼ばれない間に複数の節目(7,14...)を一度に
    # 追い越していても、呼ばれた時点でまとめて追いつけるようにするため
    new_milestone = milestone
    while current_streak >= milestone + STREAK_FREEZE_MILESTONE_STEP and balance() < STREAK_FREEZE_BALANCE_CAP:
        milestone += STREAK_FREEZE_MILESTONE_STEP
    if milestone != new_milestone:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('streak_freeze_milestone', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(milestone),),
        )
        conn.commit()
    return current_streak, balance(), today_done


# ---------- books / catalog ----------

class BookCreate(BaseModel):
    title: str
    subject: Optional[str] = None
    slug: str
    sort_order: int = 0


@app.get("/api/books")
def list_books():
    conn = get_connection()
    result = rows_to_dicts(conn.execute("SELECT * FROM books ORDER BY sort_order, id"))
    conn.close()
    return result


@app.post("/api/books")
def create_book(payload: BookCreate):
    conn = get_connection()
    existing = conn.execute("SELECT id FROM books WHERE slug = ?", (payload.slug,)).fetchone()
    if existing:
        conn.close()
        raise HTTPException(status_code=409, detail="slug already exists")
    cur = conn.execute(
        "INSERT INTO books (title, subject, slug, sort_order) VALUES (?, ?, ?, ?)",
        (payload.title, payload.subject, payload.slug, payload.sort_order),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return {"id": new_id}


@app.get("/api/books/{book_id}/catalog")
def get_book_catalog(book_id: int):
    """本の全構造(section→chapter→unit→problem)+各problemのsrs状態をネストして1本で返す。
    本棚タブがブック切り替えのたびに複数回APIを叩かずに済むようにするため(通信回数削減)。"""
    conn = get_connection()
    cur = conn.execute("SELECT * FROM books WHERE id = ?", (book_id,))
    book = row_to_dict(cur, cur.fetchone())
    if book is None:
        conn.close()
        raise HTTPException(status_code=404, detail="book not found")

    sections = rows_to_dicts(
        conn.execute("SELECT * FROM sections WHERE book_id = ? ORDER BY sort_order, id", (book_id,))
    )
    section_ids = [s["id"] for s in sections]

    chapters, units, problems = [], [], []
    if section_ids:
        ph = ",".join("?" * len(section_ids))
        chapters = rows_to_dicts(
            conn.execute(f"SELECT * FROM chapters WHERE section_id IN ({ph}) ORDER BY sort_order, id", section_ids)
        )
        chapter_ids = [c["id"] for c in chapters]
        if chapter_ids:
            ph2 = ",".join("?" * len(chapter_ids))
            units = rows_to_dicts(
                conn.execute(f"SELECT * FROM units WHERE chapter_id IN ({ph2}) ORDER BY sort_order, id", chapter_ids)
            )
        # attempt_count = 履歴パネルに並ぶ記録の件数(本棚の行に「3回」と出す、2026-09-27)。
        # Tursoは往復ごとに時間がかかるので、別クエリにせず同じSELECTの中で数える
        # last_solved_at = 実際に解いた記録(source='solve')の最新時刻(UTC)。本棚の「前回はここまで」用(2026-09-28)
        problems = rows_to_dicts(
            conn.execute(
                "SELECT p.*, (SELECT COUNT(*) FROM attempts a WHERE a.problem_id = p.id) AS attempt_count, "
                "(SELECT MAX(a.created_at) FROM attempts a WHERE a.problem_id = p.id AND a.source = 'solve') AS last_solved_at "
                f"FROM problems p WHERE p.section_id IN ({ph}) ORDER BY p.catalog_order, p.id",
                section_ids,
            )
        )
    conn.close()

    problems_by_unit = {}
    for p in problems:
        problems_by_unit.setdefault(p["unit_id"], []).append(p)
    units_by_chapter = {}
    for u in units:
        u["problems"] = problems_by_unit.get(u["id"], [])
        units_by_chapter.setdefault(u["chapter_id"], []).append(u)
    chapters_by_section = {}
    for c in chapters:
        c["units"] = units_by_chapter.get(c["id"], [])
        chapters_by_section.setdefault(c["section_id"], []).append(c)
    for s in sections:
        s["chapters"] = chapters_by_section.get(s["id"], [])
    book["sections"] = sections
    return book


# ---------- problems / units ----------
# 注意: /api/problems/lookup は /api/problems/{problem_id} より前に定義すること。
# FastAPIはルートを登録順に評価するため、{problem_id}を先に書くと"lookup"という
# 文字列がint変換に失敗して404/422になり、lookupルートに到達できなくなる。

@app.get("/api/problems/lookup")
def lookup_problem(book_slug: str, section: str, number: int):
    """mathqa-logスキルが問題番号からproblem_idを解決するために使う。"""
    conn = get_connection()
    cur = conn.execute(
        "SELECT p.* FROM problems p "
        "JOIN sections s ON p.section_id = s.id "
        "JOIN books b ON s.book_id = b.id "
        "WHERE b.slug = ? AND s.name = ? AND p.number = ?",
        (book_slug, section, number),
    )
    problem = row_to_dict(cur, cur.fetchone())
    conn.close()
    if problem is None:
        raise HTTPException(status_code=404, detail="problem not found")
    return problem


@app.get("/api/problems/starred")
def list_starred_problems():
    """本棚タブを本ごとに開かなくても、重要マークした問題を全本横断でまとめて見るための一覧。
    ヘッダーの★アイコンから開くドロワー用(2026-09-16追加)。
    静的パス(/starred)は/{problem_id}より前に置かないと、FastAPIが先にint変換を試みて
    422エラーになる(パスルーティングは登録順マッチのため)。"""
    conn = get_connection()
    rows = rows_to_dicts(
        conn.execute(
            "SELECT p.*, b.id AS book_id, b.title AS book_title, s.name AS section_name, "
            "c.name AS chapter_name, u.name AS unit_name "
            "FROM problems p "
            "JOIN sections s ON p.section_id = s.id "
            "JOIN books b ON s.book_id = b.id "
            "JOIN units u ON p.unit_id = u.id "
            "JOIN chapters c ON u.chapter_id = c.id "
            "WHERE p.starred_at IS NOT NULL "
            "ORDER BY p.starred_at DESC"
        )
    )
    conn.close()
    return rows


@app.get("/api/problems/{problem_id}")
def get_problem(problem_id: int):
    conn = get_connection()
    cur = conn.execute("SELECT * FROM problems WHERE id = ?", (problem_id,))
    problem = row_to_dict(cur, cur.fetchone())
    if problem is None:
        conn.close()
        raise HTTPException(status_code=404, detail="problem not found")
    problem["attempts"] = rows_to_dicts(
        conn.execute(
            "SELECT * FROM attempts WHERE problem_id = ? ORDER BY local_date, created_at, id", (problem_id,)
        )
    )
    conn.close()
    return problem


@app.get("/api/units/{unit_id}/problems")
def get_unit_problems(unit_id: int):
    conn = get_connection()
    cur = conn.execute("SELECT * FROM units WHERE id = ?", (unit_id,))
    unit = row_to_dict(cur, cur.fetchone())
    if unit is None:
        conn.close()
        raise HTTPException(status_code=404, detail="unit not found")
    unit["problems"] = rows_to_dicts(
        conn.execute("SELECT * FROM problems WHERE unit_id = ? ORDER BY number", (unit_id,))
    )
    conn.close()
    return unit


class SeedAssessmentIn(BaseModel):
    level: str  # "weak" | "normal" | "good"
    local_date: str  # クライアントのローカル日付。サーバーのUTC時計は使わない


@app.post("/api/units/{unit_id}/seed-assessment")
def seed_assessment(unit_id: int, payload: SeedAssessmentIn):
    """初回セットアップの単元一括自己申告(実装プラン7.5章)。
    既に何らかのattempt(solve/import/seedいずれか)がある問題は触らない。
    これにより「同じ単元のボタンを2度押す」二重送信に対しても冪等になる
    (2回目は全問題がスキップされ、重複したseed行が増えない)。"""
    rating = SEED_LEVEL_RATING.get(payload.level)
    if rating is None:
        raise HTTPException(status_code=400, detail="level must be one of weak/normal/good")

    conn = get_connection()
    unit_row = conn.execute("SELECT id FROM units WHERE id = ?", (unit_id,)).fetchone()
    if unit_row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="unit not found")

    problem_ids = [r[0] for r in conn.execute("SELECT id FROM problems WHERE unit_id = ?", (unit_id,)).fetchall()]
    seeded = 0
    for pid in problem_ids:
        has_attempt = conn.execute(
            "SELECT 1 FROM attempts WHERE problem_id = ? LIMIT 1", (pid,)
        ).fetchone()
        if has_attempt:
            continue
        client_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO attempts (problem_id, client_attempt_id, rating, local_date, source) "
            "VALUES (?, ?, ?, ?, 'seed')",
            (pid, client_id, rating, payload.local_date),
        )
        recompute_problem_srs(conn, pid)
        seeded += 1
    conn.commit()
    conn.close()
    return {"unit_id": unit_id, "level": payload.level, "problems_seeded": seeded, "problems_skipped": len(problem_ids) - seeded}


# ---------- attempts ----------

class AttemptIn(BaseModel):
    client_attempt_id: str
    problem_id: int
    rating: int
    local_date: str
    memo: Optional[str] = None
    mistake_type: Optional[str] = None


@app.post("/api/attempts")
def create_attempt(payload: AttemptIn):
    if payload.rating not in (1, 2, 3, 4, 5):
        raise HTTPException(status_code=400, detail="rating must be between 1 and 5")

    conn = get_connection()
    problem = conn.execute("SELECT id FROM problems WHERE id = ?", (payload.problem_id,)).fetchone()
    if problem is None:
        conn.close()
        raise HTTPException(status_code=404, detail="problem not found")

    dup_cur = conn.execute("SELECT * FROM attempts WHERE client_attempt_id = ?", (payload.client_attempt_id,))
    dup_row = dup_cur.fetchone()
    if dup_row is not None:
        # 冪等: 同じclient_attempt_idの再送は新規行を作らず既存行をそのまま返す
        result = row_to_dict(dup_cur, dup_row)
        conn.close()
        return result

    cur = conn.execute(
        "INSERT INTO attempts (problem_id, client_attempt_id, rating, local_date, source, memo, mistake_type) "
        "VALUES (?, ?, ?, ?, 'solve', ?, ?)",
        (payload.problem_id, payload.client_attempt_id, payload.rating, payload.local_date, payload.memo, payload.mistake_type),
    )
    new_id = cur.lastrowid
    recompute_problem_srs(conn, payload.problem_id)
    conn.commit()

    result_cur = conn.execute("SELECT * FROM attempts WHERE id = ?", (new_id,))
    result = row_to_dict(result_cur, result_cur.fetchone())
    conn.close()
    return result


class AttemptMemoUpdateIn(BaseModel):
    memo: str


@app.put("/api/attempts/{attempt_id}/memo")
def update_attempt_memo(attempt_id: int, payload: AttemptMemoUpdateIn):
    """メモタブでのメモ編集用(2026-09-08追加)。評価(rating)やSRS状態には触れない。"""
    conn = get_connection()
    row = conn.execute("SELECT id FROM attempts WHERE id = ?", (attempt_id,)).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="attempt not found")
    conn.execute("UPDATE attempts SET memo = ? WHERE id = ?", (payload.memo, attempt_id))
    conn.commit()
    conn.close()
    return {"updated": True}


class AttemptRatingUpdateIn(BaseModel):
    rating: int
    mistake_type: Optional[str] = None


@app.put("/api/attempts/{attempt_id}/rating")
def update_attempt_rating(attempt_id: int, payload: AttemptRatingUpdateIn):
    """本棚タブの履歴編集用(2026-09-16追加)。削除→付け直すと当日の日付に
    変わってしまい過去日の記録を直す用途に使えないため、local_date/sourceは
    変えずにrating/mistake_typeだけ書き換えてSRSを再計算する。"""
    conn = get_connection()
    row = conn.execute("SELECT problem_id FROM attempts WHERE id = ?", (attempt_id,)).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="attempt not found")
    problem_id = row[0]
    conn.execute(
        "UPDATE attempts SET rating = ?, mistake_type = ? WHERE id = ?",
        (payload.rating, payload.mistake_type, attempt_id),
    )
    recompute_problem_srs(conn, problem_id)
    conn.commit()
    conn.close()
    return {"updated": True}


@app.delete("/api/attempts/{attempt_id}")
def delete_attempt(attempt_id: int):
    conn = get_connection()
    row = conn.execute("SELECT problem_id FROM attempts WHERE id = ?", (attempt_id,)).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="attempt not found")
    problem_id = row[0]
    conn.execute("DELETE FROM attempts WHERE id = ?", (attempt_id,))
    recompute_problem_srs(conn, problem_id)
    conn.commit()
    conn.close()
    return {"deleted": True}


@app.post("/api/problems/{problem_id}/retire")
def toggle_retire(problem_id: int):
    conn = get_connection()
    row = conn.execute("SELECT retired_at FROM problems WHERE id = ?", (problem_id,)).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="problem not found")
    if row[0]:
        conn.execute("UPDATE problems SET retired_at = NULL WHERE id = ?", (problem_id,))
        retired = False
    else:
        conn.execute("UPDATE problems SET retired_at = datetime('now') WHERE id = ?", (problem_id,))
        retired = True
    conn.commit()
    conn.close()
    return {"problem_id": problem_id, "retired": retired}


@app.post("/api/problems/{problem_id}/star")
def toggle_star(problem_id: int):
    """重要マーク(2026-09-16追加)。retireと同じトグル方式。"""
    conn = get_connection()
    row = conn.execute("SELECT starred_at FROM problems WHERE id = ?", (problem_id,)).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="problem not found")
    if row[0]:
        conn.execute("UPDATE problems SET starred_at = NULL WHERE id = ?", (problem_id,))
        starred = False
    else:
        conn.execute("UPDATE problems SET starred_at = datetime('now') WHERE id = ?", (problem_id,))
        starred = True
    conn.commit()
    conn.close()
    return {"problem_id": problem_id, "starred": starred}


# ---------- 今日のキュー ----------

PROBLEM_DISPLAY_COLS = (
    "p.*, b.id AS book_id, b.title AS book_title, s.name AS section_name, "
    "c.name AS chapter_name, u.name AS unit_name"
)
PROBLEM_DISPLAY_JOINS = (
    "JOIN sections s ON p.section_id = s.id "
    "JOIN books b ON s.book_id = b.id "
    "JOIN units u ON p.unit_id = u.id "
    "JOIN chapters c ON u.chapter_id = c.id"
)


def _solved_on_date(conn, date: str):
    """指定日(クライアントのローカル日付)に解いた問題の一覧(evaluation付き)。
    queue_todayの「今日の済み」と、過去日を遡って見る/api/attempts/by-dateの両方から
    呼ぶ共通処理(2026-09-24、履歴閲覧機能追加時に切り出し)。"""
    return rows_to_dicts(
        conn.execute(
            f"SELECT a.id AS attempt_id, a.rating AS rating, a.memo AS memo, "
            f"a.mistake_type AS mistake_type, a.created_at AS created_at, {PROBLEM_DISPLAY_COLS} "
            f"FROM attempts a JOIN problems p ON a.problem_id = p.id {PROBLEM_DISPLAY_JOINS} "
            "WHERE a.source = 'solve' AND a.local_date = ? "
            "ORDER BY a.created_at DESC, a.id DESC",
            (date,),
        )
    )


@app.get("/api/queue/today")
def queue_today(date: str):
    """dateは必ずクライアントのローカル日付(YYYY-MM-DD)。サーバーのUTC時計とNZ現地日付の
    ズレを避けるため、サーバー側では絶対に「今日」を計算しない(study-trackerの教訓#65と同種)。"""
    conn = get_connection()
    # ヘッダーの連続日数を統計APIの応答待ち(旧: 起動から10秒以上「-」表示)にしないよう、ここでも返す
    settings = _all_settings(conn)
    streak_days, streak_freeze_balance, streak_today_done = _settle_streak_freeze(conn, date, settings)
    daily_target = int(settings.get("daily_target") or "8")

    overdue_total = conn.execute(
        "SELECT COUNT(*) FROM problems p JOIN sections s ON p.section_id = s.id "
        "WHERE p.retired_at IS NULL AND s.name != 'EXERCISE' "
        "AND p.srs_next_due_date IS NOT NULL AND p.srs_next_due_date <= ?",
        (date,),
    ).fetchone()[0]

    # 2026-09-08: とりあえずEXERCISEセクションは今日の出題対象から除外(とっつー要望)。
    # 恒久的に外すのか設定で切り替えたいのかは未確定なので、いったんハードコードで絞る。
    review_queue = rows_to_dicts(
        conn.execute(
            f"SELECT {PROBLEM_DISPLAY_COLS} FROM problems p {PROBLEM_DISPLAY_JOINS} "
            "WHERE p.retired_at IS NULL AND s.name != 'EXERCISE' "
            "AND p.srs_next_due_date IS NOT NULL AND p.srs_next_due_date <= ? "
            "ORDER BY p.srs_last_rating ASC, p.srs_next_due_date ASC, p.catalog_order ASC "
            "LIMIT ?",
            (date, daily_target),
        )
    )

    queue = list(review_queue)
    remaining = daily_target - len(queue)
    new_queue = []
    if remaining > 0:
        new_queue = rows_to_dicts(
            conn.execute(
                f"SELECT {PROBLEM_DISPLAY_COLS} FROM problems p {PROBLEM_DISPLAY_JOINS} "
                "WHERE p.retired_at IS NULL AND s.name != 'EXERCISE' "
                "AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.problem_id = p.id) "
                "ORDER BY p.catalog_order ASC LIMIT ?",
                (remaining,),
            )
        )
        queue.extend(new_queue)

    # 今日すでに解いた問題(evaluation付き)。キューから消すのではなく「済み」として
    # 別グループで見せ続けるための一覧(2026-09-08、とっつー要望: 消すとモチベが下がる)。
    done_today = _solved_on_date(conn, date)
    # 旧実装はCOUNT(*)を別クエリで取っていたが、条件がdone_todayと全く同じなので件数で代用する
    solved_today = len(done_today)

    conn.close()
    return {
        "date": date,
        "daily_target": daily_target,
        "streak_days": streak_days,
        "streak_freeze_balance": streak_freeze_balance,
        "streak_today_done": streak_today_done,
        "solved_today": solved_today,
        "overdue_total": overdue_total,
        "review_count": len(review_queue),
        "new_count": len(new_queue),
        "queue": queue,
        "done_today": done_today,
    }


@app.get("/api/attempts/by-date")
def attempts_by_date(date: str):
    """指定した過去日(クライアントのローカル日付)に解いた問題の一覧。今日タブの「済み」と
    同じデータを任意の日付で見るための専用エンドポイント(2026-09-24追加。「昨日どこまで
    やったか確認できない」というとっつー要望。今日タブはstate.today前提の楽観的更新・undo
    ロジックと密結合しているため、過去日の一覧は流用せず読み取り専用の別経路にした)。"""
    conn = get_connection()
    solved = _solved_on_date(conn, date)
    conn.close()
    return {"date": date, "solved_count": len(solved), "entries": solved}


# ---------- メモ・見返し ----------

class NoteIn(BaseModel):
    subject: str = "数学"
    unit_name: Optional[str] = None
    mistake_type: Optional[str] = None
    summary: str
    noted_at: str


@app.get("/api/notes")
def list_notes(
    book_id: Optional[int] = None,
    unit_name: Optional[str] = None,
    mistake_type: Optional[str] = None,
    q: Optional[str] = None,
    from_: Optional[str] = Query(None, alias="from"),
    to: Optional[str] = None,
):
    """attempts(memoあり)とstandalone_notesをマージして返す(質問ログ.mdの後継の見返し画面用)。"""
    conn = get_connection()

    attempt_conditions = ["a.memo IS NOT NULL", "a.memo != ''"]
    attempt_params: list = []
    if book_id is not None:
        attempt_conditions.append("b.id = ?")
        attempt_params.append(book_id)
    if unit_name:
        attempt_conditions.append("u.name LIKE ?")
        attempt_params.append(f"%{unit_name}%")
    if mistake_type:
        attempt_conditions.append("a.mistake_type = ?")
        attempt_params.append(mistake_type)
    if q:
        attempt_conditions.append("a.memo LIKE ?")
        attempt_params.append(f"%{q}%")
    if from_:
        attempt_conditions.append("a.local_date >= ?")
        attempt_params.append(from_)
    if to:
        attempt_conditions.append("a.local_date <= ?")
        attempt_params.append(to)

    attempt_notes = rows_to_dicts(
        conn.execute(
            f"""
            SELECT a.id AS id, 'attempt' AS kind, a.local_date AS noted_at, a.memo AS summary,
                   a.mistake_type AS mistake_type, u.name AS unit_name, b.title AS book_title,
                   p.number AS problem_number, b.id AS book_id
            FROM attempts a
            JOIN problems p ON a.problem_id = p.id
            JOIN units u ON p.unit_id = u.id
            JOIN sections s ON p.section_id = s.id
            JOIN books b ON s.book_id = b.id
            WHERE {' AND '.join(attempt_conditions)}
            """,
            attempt_params,
        )
    )

    standalone_notes = []
    if book_id is None:  # standalone_notesは特定の本に紐付かないため、本で絞られた検索では対象外
        standalone_conditions = []
        standalone_params: list = []
        if unit_name:
            standalone_conditions.append("unit_name LIKE ?")
            standalone_params.append(f"%{unit_name}%")
        if mistake_type:
            standalone_conditions.append("mistake_type = ?")
            standalone_params.append(mistake_type)
        if q:
            standalone_conditions.append("summary LIKE ?")
            standalone_params.append(f"%{q}%")
        if from_:
            standalone_conditions.append("noted_at >= ?")
            standalone_params.append(from_)
        if to:
            standalone_conditions.append("noted_at <= ?")
            standalone_params.append(to)
        where = ("WHERE " + " AND ".join(standalone_conditions)) if standalone_conditions else ""
        standalone_notes = rows_to_dicts(
            conn.execute(
                f"""
                SELECT id, 'standalone' AS kind, noted_at, summary, mistake_type, unit_name,
                       NULL AS book_title, NULL AS problem_number, NULL AS book_id
                FROM standalone_notes
                {where}
                """,
                standalone_params,
            )
        )

    conn.close()
    merged = attempt_notes + standalone_notes
    merged.sort(key=lambda n: n["noted_at"], reverse=True)
    return merged


@app.post("/api/notes")
def create_note(payload: NoteIn):
    conn = get_connection()
    cur = conn.execute(
        "INSERT INTO standalone_notes (subject, unit_name, mistake_type, summary, noted_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (payload.subject, payload.unit_name, payload.mistake_type, payload.summary, payload.noted_at),
    )
    conn.commit()
    new_id = cur.lastrowid
    conn.close()
    return {"id": new_id}


class NoteUpdateIn(BaseModel):
    summary: str


@app.put("/api/notes/{note_id}")
def update_note(note_id: int, payload: NoteUpdateIn):
    conn = get_connection()
    row = conn.execute("SELECT id FROM standalone_notes WHERE id = ?", (note_id,)).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="note not found")
    conn.execute("UPDATE standalone_notes SET summary = ? WHERE id = ?", (payload.summary, note_id))
    conn.commit()
    conn.close()
    return {"updated": True}


@app.delete("/api/notes/{note_id}")
def delete_note(note_id: int):
    conn = get_connection()
    row = conn.execute("SELECT id FROM standalone_notes WHERE id = ?", (note_id,)).fetchone()
    if row is None:
        conn.close()
        raise HTTPException(status_code=404, detail="note not found")
    conn.execute("DELETE FROM standalone_notes WHERE id = ?", (note_id,))
    conn.commit()
    conn.close()
    return {"deleted": True}


@app.get("/api/mistake-types")
def list_mistake_types():
    conn = get_connection()
    result = rows_to_dicts(conn.execute("SELECT * FROM mistake_types ORDER BY sort_order, id"))
    conn.close()
    return result


# ---------- 統計 ----------

@app.get("/api/stats/overview")
def stats_overview(date: str, book_id: Optional[int] = None):
    # 2026-09-27: 本ごと・週ごとにクエリを投げていた旧実装はTurso相手に約30往復(12秒超)かかり、
    # 統計タブを開いても前回のキャッシュが長時間表示されたまま「更新されない」ように見えていた。
    # 本ごと・週ごとの集計はGROUP BYで1回ずつにまとめる。返す形は旧実装と同じ。
    conn = get_connection()
    settings = _all_settings(conn)
    streak, streak_freeze_balance, streak_today_done = _settle_streak_freeze(conn, date, settings)

    # 2026-09-08にEXERCISEセクションを今日タブの出題対象から除外した際、ペース計算(unattempted)だけ
    # 直し忘れていた(EXERCISE分の未着手問題が「残り」に永久にカウントされ続け、pace_per_dayが
    # 実態より過大に出る不整合があった)。queue_todayと同じ条件に揃えて2026-09-16に修正。
    books = rows_to_dicts(
        conn.execute(
            "SELECT b.*, COUNT(p.id) AS total_problems, "
            "SUM(CASE WHEN p.srs_last_rating IS NOT NULL THEN 1 ELSE 0 END) AS attempted_problems, "
            "SUM(CASE WHEN p.srs_last_rating IS NULL AND p.retired_at IS NULL AND s.name != 'EXERCISE' "
            "THEN 1 ELSE 0 END) AS unattempted_main "
            "FROM books b LEFT JOIN sections s ON s.book_id = b.id LEFT JOIN problems p ON p.section_id = s.id "
            "GROUP BY b.id ORDER BY b.sort_order, b.id"
        )
    )
    unattempted_total = 0
    for book in books:
        total = book["total_problems"] or 0
        attempted = book["attempted_problems"] or 0
        unattempted_total += book.pop("unattempted_main") or 0
        book["attempted_problems"] = attempted
        book["progress_percent"] = round(attempted / total * 100) if total else 0

    exam_target_date = settings.get("exam_target_date")

    days_left = None
    pace_per_day = None
    if exam_target_date:
        days_left = (dtdate.fromisoformat(exam_target_date) - dtdate.fromisoformat(date)).days
        if days_left > 0:
            pace_per_day = round(unattempted_total / days_left, 1)

    # 評価分布(Phase2): 現在のproblems.srs_last_ratingの分布。1度も解いていない問題は含めない
    # book_id指定時(統計タブで本を選んだ時、2026-09-27)は評価分布と推移だけその本に絞る。
    # 連続日数・ペース・本ごとの進捗は常に全体の値
    book_cond = " AND s.book_id = ?" if book_id is not None else ""
    book_params = (book_id,) if book_id is not None else ()
    dist_rows = conn.execute(
        "SELECT p.srs_last_rating, COUNT(*) FROM problems p JOIN sections s ON p.section_id = s.id "
        f"WHERE p.srs_last_rating IS NOT NULL{book_cond} GROUP BY p.srs_last_rating",
        book_params,
    ).fetchall()
    dist_map = {r[0]: r[1] for r in dist_rows}
    rating_distribution = {str(r): dist_map.get(r, 0) for r in (1, 2, 3, 4, 5)}

    # 正答率推移(Phase2): 実際に解いた記録(source='solve')のみ集計。
    # 2026-09-27: 旧実装は「dateから始まる7日」を最新の週にしていたため、最新の週が今日1日分だけ
    # (未来の6日を含む)になり、朝に数問解いただけで平均が急落して見えた。今日で終わる7日ごとに区切る。
    oldest_start = add_days(date, -7 * 7 - 6)
    bucket_rows = conn.execute(
        "SELECT CAST((julianday(?) - julianday(a.local_date)) / 7 AS INTEGER) AS bucket, COUNT(*), AVG(a.rating) "
        "FROM attempts a JOIN problems p ON a.problem_id = p.id JOIN sections s ON p.section_id = s.id "
        f"WHERE a.source = 'solve' AND a.local_date BETWEEN ? AND ?{book_cond} GROUP BY bucket",
        (date, oldest_start, date) + book_params,
    ).fetchall()
    buckets = {r[0]: (r[1], r[2]) for r in bucket_rows}
    weekly_trend = []
    for i in range(7, -1, -1):
        week_end = add_days(date, -7 * i)
        cnt, avg = buckets.get(i, (0, None))
        weekly_trend.append({
            "week_start": add_days(week_end, -6),
            "week_end": week_end,
            "count": cnt,
            "avg_rating": round(avg, 2) if avg is not None else None,
        })

    conn.close()
    return {
        "streak_days": streak,
        "streak_freeze_balance": streak_freeze_balance,
        "streak_today_done": streak_today_done,
        "books": books,
        "exam_target_date": exam_target_date,
        "days_left": days_left,
        "unattempted_total": unattempted_total,
        "pace_per_day": pace_per_day,
        "rating_distribution": rating_distribution,
        "weekly_trend": weekly_trend,
    }


@app.get("/api/stats/weakness")
def stats_weakness(date: str, days: int = 30, book_id: Optional[int] = None):
    """ミスタイプ別頻度・要注意単元(実装プラン5章のPhase2項目)。
    直近days日分のsource='solve'記録のみを対象にする(古いimport/seedデータで
    今の弱点像が歪まないようにするため)。"""
    conn = get_connection()
    since = add_days(date, -days)

    book_cond = " AND s.book_id = ?" if book_id is not None else ""
    book_params = (book_id,) if book_id is not None else ()
    mistake_breakdown = rows_to_dicts(
        conn.execute(
            "SELECT a.mistake_type AS mistake_type, COUNT(*) AS count FROM attempts a "
            "JOIN problems p ON a.problem_id = p.id JOIN sections s ON p.section_id = s.id "
            "WHERE a.source = 'solve' AND a.mistake_type IS NOT NULL AND a.mistake_type != '' "
            f"AND a.local_date >= ?{book_cond} GROUP BY a.mistake_type ORDER BY count DESC",
            (since,) + book_params,
        )
    )

    weak_units = rows_to_dicts(
        conn.execute(
            f"""
            SELECT u.id AS unit_id, u.name AS unit_name, c.name AS chapter_name, b.title AS book_title,
                   COUNT(*) AS low_rating_count, ROUND(AVG(a.rating), 2) AS avg_rating
            FROM attempts a
            JOIN problems p ON a.problem_id = p.id
            JOIN units u ON p.unit_id = u.id
            JOIN chapters c ON u.chapter_id = c.id
            JOIN sections se ON c.section_id = se.id
            JOIN books b ON se.book_id = b.id
            WHERE a.source = 'solve' AND a.rating <= 2 AND a.local_date >= ?{book_cond.replace("s.book_id", "b.id")}
            GROUP BY u.id
            ORDER BY low_rating_count DESC, avg_rating ASC
            LIMIT 5
            """,
            (since,) + book_params,
        )
    )
    conn.close()
    return {"since": since, "mistake_breakdown": mistake_breakdown, "weak_units": weak_units}


# 統計タブの拡充(2026-09-27、Stackの統計画面に合わせる)。今日の数字・直近14日・今後7日の
# 復習予定・進捗(本編のみ、着手/習得)・苦手な問題・★の件数をまとめて返す。
# Tursoは1クエリごとに往復がかかるため、問題は1回で全件(約1100行)読んでPython側で集計する。
# 進捗・復習予定・苦手な問題は今日タブの出題対象と同じ「本編・もう出さない以外」に揃える
# (2026-09-08にEXERCISEを出題対象から外したのに、本ごとの進捗の分母にだけ残っていたため)。
MASTERED_RATING = 4
WEAK_RATING = 2


# 1周完了の予測の推移グラフに出す過去の日数(今日を含む8週)。ペース(直近14日)もこの範囲に収まる
FIRST_PASS_HISTORY_DAYS = 56


@app.get("/api/stats/detail")
def stats_detail(date: str, book_id: Optional[int] = None):
    conn = get_connection()
    problems = rows_to_dicts(
        conn.execute(
            "SELECT p.id, p.number, p.retired_at, p.starred_at, p.srs_last_rating, p.srs_next_due_date, "
            "b.id AS book_id, b.title AS book_title, s.name AS section_name, "
            "c.id AS chapter_id, c.number AS chapter_number, c.name AS chapter_name, u.name AS unit_name, "
            "b.first_pass_target AS book_target, "
            # 1周完了の予測用(2026-09-30): 初めて記録した日と、初めて実際に解いた日。
            # 往復を増やさないよう相関サブクエリで同じ問い合わせに載せる(attempts.problem_idに索引あり)
            "(SELECT MIN(a.local_date) FROM attempts a WHERE a.problem_id = p.id) AS first_date, "
            "(SELECT MIN(a.local_date) FROM attempts a WHERE a.problem_id = p.id AND a.source = 'solve') AS first_solve_date "
            f"FROM problems p {PROBLEM_DISPLAY_JOINS} "
            "ORDER BY b.sort_order, b.id, s.sort_order, c.sort_order, c.id, p.catalog_order"
        )
    )
    since = add_days(date, -13)
    book_cond = " AND s.book_id = ?" if book_id is not None else ""
    daily_rows = conn.execute(
        "SELECT a.local_date, COUNT(*), SUM(CASE WHEN a.rating >= ? THEN 1 ELSE 0 END) "
        "FROM attempts a JOIN problems p ON a.problem_id = p.id JOIN sections s ON p.section_id = s.id "
        f"WHERE a.source = 'solve' AND a.local_date BETWEEN ? AND ?{book_cond} GROUP BY a.local_date",
        (MASTERED_RATING, since, date) + ((book_id,) if book_id is not None else ()),
    ).fetchall()
    solved_dates, freeze_dates = set(), set()
    for kind, d in conn.execute(
        "SELECT DISTINCT 's', local_date FROM attempts WHERE source = 'solve' "
        "UNION ALL SELECT 'f', date FROM streak_freezes"
    ).fetchall():
        (solved_dates if kind == "s" else freeze_dates).add(d)
    conn.close()

    # 最長の連続日数(フリーズで守った日も連続に含める。ヘッダーの連続日数と同じ数え方)
    longest, run, prev = 0, 0, None
    for d in sorted(solved_dates | freeze_dates):
        run = run + 1 if prev is not None and add_days(prev, 1) == d else 1
        longest = max(longest, run)
        prev = d

    daily_map = {r[0]: (r[1], r[2] or 0) for r in daily_rows}
    daily = []
    for i in range(13, -1, -1):
        d = add_days(date, -i)
        daily.append({"date": d, "count": daily_map.get(d, (0, 0))[0], "freeze": d in freeze_dates})
    today_count, today_good = daily_map.get(date, (0, 0))

    in_scope = [p for p in problems if book_id is None or p["book_id"] == book_id]
    main_live = [p for p in in_scope if p["section_name"] != "EXERCISE" and not p["retired_at"]]

    forecast = []
    for i in range(7):
        d = add_days(date, i)
        if i == 0:  # 「今日まで」は期限切れの分を含む(今日タブの「復習待ち」と同じ条件)
            n = sum(1 for p in main_live if p["srs_next_due_date"] and p["srs_next_due_date"] <= d)
        else:
            n = sum(1 for p in main_live if p["srs_next_due_date"] == d)
        forecast.append({"date": d, "count": n})

    # 本を選んでいない時は本ごと、選んだ時は章ごと
    by_chapter = book_id is not None
    groups = {}
    if not by_chapter:  # 本編が1問もない本も0として並べる
        for p in problems:
            groups.setdefault(p["book_id"], {"id": p["book_id"], "label": p["book_title"], "total": 0, "attempted": 0, "mastered": 0})
    for p in main_live:
        key = p["chapter_id"] if by_chapter else p["book_id"]
        label = f"第{p['chapter_number']}章 {p['chapter_name']}" if by_chapter else p["book_title"]
        g = groups.setdefault(key, {"id": key, "label": label, "total": 0, "attempted": 0, "mastered": 0})
        g["total"] += 1
        if p["srs_last_rating"] is not None:
            g["attempted"] += 1
            if p["srs_last_rating"] >= MASTERED_RATING:
                g["mastered"] += 1

    # 1周完了の予測(2026-09-30): 本ごとの残り(未着手)と、直近の着手日ごとの問題数。
    # 本を絞り込んでいても全部の本を返す(本ごとの「あと◯日」と全体の予測の両方に使う)。
    # 本編のみ(EXERCISE・除外済みは数えない)。単元の一括評価(seed)で初めて記録した問題は
    # 実際に解いたわけではないので、推移(残りの減り方)には入れるがペースには入れない
    fp_since = add_days(date, -(FIRST_PASS_HISTORY_DAYS - 1))
    fp_books = {}
    for p in problems:
        fp_books.setdefault(p["book_id"], {
            "id": p["book_id"], "label": p["book_title"], "target_date": p["book_target"] or None,
            "total": 0, "remaining": 0, "started": {}, "started_other": {},
        })
    for p in problems:
        if p["section_name"] == "EXERCISE" or p["retired_at"]:
            continue
        fb = fp_books[p["book_id"]]
        fb["total"] += 1
        if p["srs_last_rating"] is None:
            fb["remaining"] += 1
        elif p["first_date"] and p["first_date"] >= fp_since:
            key = "started" if p["first_solve_date"] == p["first_date"] else "started_other"
            fb[key][p["first_date"]] = fb[key].get(p["first_date"], 0) + 1

    weak = [p for p in main_live if p["srs_last_rating"] is not None and p["srs_last_rating"] <= WEAK_RATING]
    weak.sort(key=lambda p: (p["srs_next_due_date"] or "", p["srs_last_rating"]))

    return {
        "today": {"count": today_count, "good": today_good},
        "longest_streak": longest,
        "daily": daily,
        "forecast": forecast,
        "progress_by": "chapter" if by_chapter else "book",
        "progress": list(groups.values()),
        "weak_total": len(weak),
        "weak": [
            {k: p[k] for k in ("id", "number", "book_id", "book_title", "section_name", "chapter_id",
                               "unit_name", "srs_last_rating", "srs_next_due_date")}
            for p in weak[:30]
        ],
        "starred_total": sum(1 for p in in_scope if p["starred_at"]),
        "first_pass": {"books": list(fp_books.values())},
    }


@app.get("/api/stats/heatmap")
def stats_heatmap():
    """単元別ヒートマップ(実装プラン5章のPhase2項目)。旧Obsidianダッシュボードの
    緑(得意)/橙(普通)/赤(苦手)の色分けを踏襲し、色判定自体はフロント側に任せる
    (avg_ratingを返すだけにして、閾値変更の際にAPIを叩き直さなくて済むようにする)。"""
    conn = get_connection()
    units = rows_to_dicts(
        conn.execute(
            """
            SELECT u.id AS unit_id, u.name AS unit_name, c.name AS chapter_name, b.title AS book_title,
                   b.sort_order AS book_sort, se.sort_order AS section_sort, c.sort_order AS chapter_sort,
                   u.sort_order AS unit_sort,
                   COUNT(p.id) AS total,
                   SUM(CASE WHEN p.srs_last_rating IS NOT NULL THEN 1 ELSE 0 END) AS attempted,
                   ROUND(AVG(CASE WHEN p.srs_last_rating IS NOT NULL THEN p.srs_last_rating END), 2) AS avg_rating
            FROM units u
            JOIN chapters c ON u.chapter_id = c.id
            JOIN sections se ON c.section_id = se.id
            JOIN books b ON se.book_id = b.id
            LEFT JOIN problems p ON p.unit_id = u.id
            GROUP BY u.id
            ORDER BY book_sort, section_sort, chapter_sort, unit_sort, u.id
            """
        )
    )
    conn.close()
    return {"units": units}


# ---------- 設定 ----------

class SettingsUpdate(BaseModel):
    daily_target: Optional[int] = None
    exam_target_date: Optional[str] = None
    # 本ごとの1周の目標日 {book_id: "YYYY-MM-DD" | null}。nullで目標なしに戻す
    book_targets: Optional[dict[int, Optional[str]]] = None


@app.get("/api/settings")
def get_settings():
    conn = get_connection()
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    conn.close()
    return {k: v for k, v in rows}


@app.put("/api/settings")
def update_settings(payload: SettingsUpdate):
    conn = get_connection()
    if payload.daily_target is not None:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('daily_target', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(payload.daily_target),),
        )
    if payload.exam_target_date is not None:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('exam_target_date', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (payload.exam_target_date,),
        )
    if payload.book_targets:
        conn.executemany(
            "UPDATE books SET first_pass_target = ? WHERE id = ?",
            [(d or None, book_id) for book_id, d in payload.book_targets.items()],
        )
    conn.commit()
    conn.close()
    return get_settings()


@app.get("/api/build-info")
def build_info():
    return {"lastUpdated": LAST_UPDATED}


# ---------- static frontend ----------
# study-trackerと同じパターン: デプロイのたびに変わるLAST_UPDATEDをapp.js/style.cssの
# URLに付与し、PWAがタブを閉じずに再開してもブラウザキャッシュに古いJSが残らないようにする。

app.mount("/static", StaticFiles(directory="static"), name="static")

_INDEX_HTML_CACHE: Optional[str] = None


def _render_index_html() -> str:
    global _INDEX_HTML_CACHE
    if _INDEX_HTML_CACHE is None:
        with open("static/index.html", encoding="utf-8") as f:
            html = f.read()
        v = quote(LAST_UPDATED, safe="")
        html = html.replace('href="/static/style.css"', f'href="/static/style.css?v={v}"')
        html = html.replace('src="/static/app.js"', f'src="/static/app.js?v={v}"')
        _INDEX_HTML_CACHE = html
    return _INDEX_HTML_CACHE


@app.get("/")
def index():
    return HTMLResponse(content=_render_index_html(), headers={"Cache-Control": "no-cache"})


@app.get("/manifest.json")
def manifest():
    return FileResponse("static/manifest.json")


@app.get("/service-worker.js")
def service_worker():
    return FileResponse("static/service-worker.js", headers={"Cache-Control": "no-cache"})


@app.get("/config.js")
def config_js():
    # env var駆動でstudy-tracker連携トークンをクライアントJSへ渡す。gitにトークンを
    # 直書きしないための橋渡しで、値自体はどのみちブラウザから見える前提(vocab-app方式と同じ)。
    config = {"studyTrackerUrl": STUDY_TRACKER_URL, "studyTrackerToken": STUDY_TRACKER_SYNC_TOKEN}
    body = f"window.DRILL_SYNC_CONFIG = {json.dumps(config)};"
    return Response(content=body, media_type="application/javascript", headers={"Cache-Control": "no-cache"})
