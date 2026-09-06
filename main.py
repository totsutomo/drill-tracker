import os
import uuid
from datetime import date as dtdate
from datetime import datetime
from typing import Optional
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, HTMLResponse
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


def _load_last_updated() -> str:
    build_info_path = os.path.join(os.path.dirname(__file__), "build_info.txt")
    try:
        with open(build_info_path) as f:
            return f.read().strip()
    except FileNotFoundError:
        return datetime.now().astimezone().isoformat()


LAST_UPDATED = _load_last_updated()

SEED_LEVEL_RATING = {"weak": 2, "normal": 3, "good": 4}


def _get_setting(conn, key: str, default: Optional[str] = None) -> Optional[str]:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row[0] if row else default


def _compute_streak(conn, today: str) -> int:
    # 「実際に解いた」日だけを数える(source='solve')。importの過去データや
    # seedの一括自己申告はアプリを使い続けている実感=ストリークには含めない
    rows = conn.execute("SELECT DISTINCT local_date FROM attempts WHERE source = 'solve'").fetchall()
    solved_dates = {r[0] for r in rows}
    streak = 0
    cursor_date = today
    while cursor_date in solved_dates:
        streak += 1
        cursor_date = add_days(cursor_date, -1)
    return streak


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
        problems = rows_to_dicts(
            conn.execute(f"SELECT * FROM problems WHERE section_id IN ({ph}) ORDER BY catalog_order, id", section_ids)
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


# ---------- 今日のキュー ----------

@app.get("/api/queue/today")
def queue_today(date: str):
    """dateは必ずクライアントのローカル日付(YYYY-MM-DD)。サーバーのUTC時計とNZ現地日付の
    ズレを避けるため、サーバー側では絶対に「今日」を計算しない(study-trackerの教訓#65と同種)。"""
    conn = get_connection()
    daily_target = int(_get_setting(conn, "daily_target", "8"))

    solved_today = conn.execute(
        "SELECT COUNT(*) FROM attempts WHERE source = 'solve' AND local_date = ?", (date,)
    ).fetchone()[0]

    overdue_total = conn.execute(
        "SELECT COUNT(*) FROM problems WHERE retired_at IS NULL "
        "AND srs_next_due_date IS NOT NULL AND srs_next_due_date <= ?",
        (date,),
    ).fetchone()[0]

    problem_display_cols = (
        "p.*, b.id AS book_id, b.title AS book_title, s.name AS section_name, "
        "c.name AS chapter_name, u.name AS unit_name"
    )
    problem_display_joins = (
        "JOIN sections s ON p.section_id = s.id "
        "JOIN books b ON s.book_id = b.id "
        "JOIN units u ON p.unit_id = u.id "
        "JOIN chapters c ON u.chapter_id = c.id"
    )

    review_queue = rows_to_dicts(
        conn.execute(
            f"SELECT {problem_display_cols} FROM problems p {problem_display_joins} "
            "WHERE p.retired_at IS NULL "
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
                f"SELECT {problem_display_cols} FROM problems p {problem_display_joins} "
                "WHERE p.retired_at IS NULL "
                "AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.problem_id = p.id) "
                "ORDER BY p.catalog_order ASC LIMIT ?",
                (remaining,),
            )
        )
        queue.extend(new_queue)

    conn.close()
    return {
        "date": date,
        "daily_target": daily_target,
        "solved_today": solved_today,
        "overdue_total": overdue_total,
        "review_count": len(review_queue),
        "new_count": len(new_queue),
        "queue": queue,
    }


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
def stats_overview(date: str):
    conn = get_connection()
    streak = _compute_streak(conn, date)

    books = rows_to_dicts(conn.execute("SELECT * FROM books ORDER BY sort_order, id"))
    for book in books:
        total = conn.execute(
            "SELECT COUNT(*) FROM problems p JOIN sections s ON p.section_id = s.id WHERE s.book_id = ?",
            (book["id"],),
        ).fetchone()[0]
        attempted = conn.execute(
            "SELECT COUNT(*) FROM problems p JOIN sections s ON p.section_id = s.id "
            "WHERE s.book_id = ? AND p.srs_last_rating IS NOT NULL",
            (book["id"],),
        ).fetchone()[0]
        book["total_problems"] = total
        book["attempted_problems"] = attempted
        book["progress_percent"] = round(attempted / total * 100) if total else 0

    exam_target_date = _get_setting(conn, "exam_target_date")
    unattempted_total = conn.execute(
        "SELECT COUNT(*) FROM problems WHERE srs_last_rating IS NULL AND retired_at IS NULL"
    ).fetchone()[0]

    days_left = None
    pace_per_day = None
    if exam_target_date:
        days_left = (dtdate.fromisoformat(exam_target_date) - dtdate.fromisoformat(date)).days
        if days_left > 0:
            pace_per_day = round(unattempted_total / days_left, 1)

    # 評価分布(Phase2): 現在のproblems.srs_last_ratingの分布。1度も解いていない問題は含めない
    dist_rows = conn.execute(
        "SELECT srs_last_rating, COUNT(*) FROM problems WHERE srs_last_rating IS NOT NULL GROUP BY srs_last_rating"
    ).fetchall()
    dist_map = {r[0]: r[1] for r in dist_rows}
    rating_distribution = {str(r): dist_map.get(r, 0) for r in (1, 2, 3, 4, 5)}

    # 正答率推移(Phase2): dateを含む週から遡って8週分。実際に解いた記録(source='solve')のみ集計
    weekly_trend = []
    for i in range(7, -1, -1):
        week_start = add_days(date, -7 * i)
        week_end = add_days(week_start, 6)
        cnt, avg = conn.execute(
            "SELECT COUNT(*), AVG(rating) FROM attempts WHERE source = 'solve' AND local_date BETWEEN ? AND ?",
            (week_start, week_end),
        ).fetchone()
        weekly_trend.append({
            "week_start": week_start,
            "count": cnt,
            "avg_rating": round(avg, 2) if avg is not None else None,
        })

    conn.close()
    return {
        "streak_days": streak,
        "books": books,
        "exam_target_date": exam_target_date,
        "days_left": days_left,
        "unattempted_total": unattempted_total,
        "pace_per_day": pace_per_day,
        "rating_distribution": rating_distribution,
        "weekly_trend": weekly_trend,
    }


@app.get("/api/stats/weakness")
def stats_weakness(date: str, days: int = 30):
    """ミスタイプ別頻度・要注意単元(実装プラン5章のPhase2項目)。
    直近days日分のsource='solve'記録のみを対象にする(古いimport/seedデータで
    今の弱点像が歪まないようにするため)。"""
    conn = get_connection()
    since = add_days(date, -days)

    mistake_breakdown = rows_to_dicts(
        conn.execute(
            "SELECT mistake_type, COUNT(*) AS count FROM attempts "
            "WHERE source = 'solve' AND mistake_type IS NOT NULL AND mistake_type != '' "
            "AND local_date >= ? GROUP BY mistake_type ORDER BY count DESC",
            (since,),
        )
    )

    weak_units = rows_to_dicts(
        conn.execute(
            """
            SELECT u.id AS unit_id, u.name AS unit_name, c.name AS chapter_name, b.title AS book_title,
                   COUNT(*) AS low_rating_count, ROUND(AVG(a.rating), 2) AS avg_rating
            FROM attempts a
            JOIN problems p ON a.problem_id = p.id
            JOIN units u ON p.unit_id = u.id
            JOIN chapters c ON u.chapter_id = c.id
            JOIN sections se ON c.section_id = se.id
            JOIN books b ON se.book_id = b.id
            WHERE a.source = 'solve' AND a.rating <= 2 AND a.local_date >= ?
            GROUP BY u.id
            ORDER BY low_rating_count DESC, avg_rating ASC
            LIMIT 5
            """,
            (since,),
        )
    )
    conn.close()
    return {"since": since, "mistake_breakdown": mistake_breakdown, "weak_units": weak_units}


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
