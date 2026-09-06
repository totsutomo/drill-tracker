import os
import threading
from datetime import date, datetime, timedelta
from pathlib import Path

import libsql

DB_PATH = Path(__file__).parent / "data.db"
TURSO_DATABASE_URL = os.environ.get("TURSO_DATABASE_URL")
TURSO_AUTH_TOKEN = os.environ.get("TURSO_AUTH_TOKEN")

SCHEMA = """
CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    subject TEXT,
    slug TEXT UNIQUE,
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id),
    name TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    UNIQUE(book_id, name)
);

CREATE TABLE IF NOT EXISTS chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_id INTEGER NOT NULL REFERENCES sections(id),
    number INTEGER NOT NULL,
    name TEXT NOT NULL,
    range_from INTEGER, range_to INTEGER,
    sort_order INTEGER DEFAULT 0,
    UNIQUE(section_id, number)
);

CREATE TABLE IF NOT EXISTS units (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chapter_id INTEGER NOT NULL REFERENCES chapters(id),
    number INTEGER,
    name TEXT NOT NULL,
    range_from INTEGER, range_to INTEGER,
    sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS problems (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unit_id INTEGER NOT NULL REFERENCES units(id),
    section_id INTEGER NOT NULL REFERENCES sections(id),
    number INTEGER NOT NULL,
    catalog_order INTEGER NOT NULL,
    retired_at TEXT,
    srs_last_rating INTEGER,
    srs_next_due_date TEXT,
    srs_streak INTEGER DEFAULT 0,
    srs_graduated INTEGER DEFAULT 0,
    UNIQUE(section_id, number)
);
CREATE INDEX IF NOT EXISTS idx_problems_next_due ON problems(srs_next_due_date);

CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    problem_id INTEGER NOT NULL REFERENCES problems(id),
    client_attempt_id TEXT UNIQUE,
    rating INTEGER NOT NULL,
    local_date TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'solve',
    memo TEXT,
    mistake_type TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attempts_problem ON attempts(problem_id);

CREATE TABLE IF NOT EXISTS mistake_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS standalone_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT DEFAULT '数学',
    unit_name TEXT,
    mistake_type TEXT,
    summary TEXT NOT NULL,
    noted_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""

DEFAULT_MISTAKE_TYPES = ("符号ミス", "公式忘れ", "計算ミス", "方針が立たない", "読み間違い", "その他")

DEFAULT_SETTINGS = {
    "daily_target": "8",
    "exam_target_date": "2027-12-01",
}

# SRSの復習間隔(評価1-5)。評価4以上が2回連続(srs_streak>=2)になった時点で
# 卒業扱いとしてGRADUATED_INTERVAL_DAYSに差し替える(compute_next_srs_state参照)。
INTERVAL_DAYS = {1: 1, 2: 2, 3: 4, 4: 8, 5: 15}
GRADUATED_INTERVAL_DAYS = 60


# study-trackerと同じ理由: リクエストのたびに(特にTursoのようなリモートDBへ)新規接続を
# 張ると往復のたびに接続確立のコストがかかる。FastAPIの同期routeはスレッドプールで
# 実行されるため、スレッドごとに1本だけ接続を作って使い回す。
_local = threading.local()


def _open_connection():
    if TURSO_DATABASE_URL:
        return libsql.connect(database=TURSO_DATABASE_URL, auth_token=TURSO_AUTH_TOKEN)
    return libsql.connect(str(DB_PATH))


class _PooledConnection:
    """生のlibsql接続をラップし、close()を無視して接続をスレッドローカルに使い回すためのプロキシ。
    呼び出し側は今まで通り get_connection() → 使う → close() という書き方のままでよい。"""

    def __init__(self, conn):
        self._conn = conn

    def close(self):
        pass

    def _invalidate(self):
        try:
            self._conn.close()
        except Exception:
            pass
        if getattr(_local, "conn", None) is self:
            _local.conn = None

    def __getattr__(self, name):
        attr = getattr(self._conn, name)
        if not callable(attr):
            return attr

        def wrapper(*args, **kwargs):
            try:
                return attr(*args, **kwargs)
            except Exception:
                self._invalidate()
                raise

        return wrapper


def get_connection():
    cached = getattr(_local, "conn", None)
    if cached is not None:
        return cached
    proxy = _PooledConnection(_open_connection())
    _local.conn = proxy
    return proxy


def rows_to_dicts(cursor):
    columns = [col[0] for col in cursor.description]
    return [dict(zip(columns, row)) for row in cursor.fetchall()]


def row_to_dict(cursor, row):
    if row is None:
        return None
    columns = [col[0] for col in cursor.description]
    return dict(zip(columns, row))


def init_db():
    conn = get_connection()
    conn.executescript(SCHEMA)
    conn.commit()
    _migrate(conn)
    _seed_mistake_types(conn)
    _seed_settings(conn)
    conn.close()


def _migrate(conn):
    # 現時点では初回スキーマのみ。将来カラム追加時はstudy-trackerと同じ
    # 「PRAGMA table_info→ALTER TABLE ADD COLUMN」パターンをここに足していく。
    conn.commit()


def _seed_mistake_types(conn):
    count = conn.execute("SELECT COUNT(*) FROM mistake_types").fetchone()[0]
    if count == 0:
        for i, name in enumerate(DEFAULT_MISTAKE_TYPES):
            conn.execute(
                "INSERT INTO mistake_types (name, sort_order) VALUES (?, ?)", (name, i)
            )
        conn.commit()


def _seed_settings(conn):
    for key, value in DEFAULT_SETTINGS.items():
        row = conn.execute("SELECT 1 FROM settings WHERE key = ?", (key,)).fetchone()
        if row is None:
            conn.execute("INSERT INTO settings (key, value) VALUES (?, ?)", (key, value))
    conn.commit()


def add_days(local_date: str, days: int) -> str:
    d = date.fromisoformat(local_date)
    return (d + timedelta(days=days)).isoformat()


def compute_next_srs_state(prior_streak: int, rating: int):
    """評価1件を反映した後のstreak/graduated/次回までの日数を返す。
    (新streak, 新graduated, 次回までの日数)"""
    new_streak = prior_streak + 1 if rating >= 4 else 0
    new_graduated = 1 if new_streak >= 2 else 0
    interval = GRADUATED_INTERVAL_DAYS if new_graduated else INTERVAL_DAYS[rating]
    return new_streak, new_graduated, interval


def recompute_problem_srs(conn, problem_id: int):
    """attempts履歴(このproblem_idの全件)からproblems.srs_*列を再計算して書き戻す。
    POST/DELETE /api/attempts、インポートスクリプトのいずれからも呼ばれる共通ロジック。
    (attempts=過去の記録、problems=現在の状態のキャッシュ、という2章の分離を守るための唯一の書き込み経路)"""
    cur = conn.execute(
        "SELECT rating, local_date FROM attempts WHERE problem_id = ? "
        "ORDER BY local_date ASC, created_at ASC, id ASC",
        (problem_id,),
    )
    rows = cur.fetchall()
    if not rows:
        conn.execute(
            "UPDATE problems SET srs_last_rating = NULL, srs_next_due_date = NULL, "
            "srs_streak = 0, srs_graduated = 0 WHERE id = ?",
            (problem_id,),
        )
        return

    streak, graduated = 0, 0
    last_rating, next_due = None, None
    for rating, local_date in rows:
        streak, graduated, interval = compute_next_srs_state(streak, rating)
        last_rating = rating
        next_due = add_days(local_date, interval)

    conn.execute(
        "UPDATE problems SET srs_last_rating = ?, srs_next_due_date = ?, "
        "srs_streak = ?, srs_graduated = ? WHERE id = ?",
        (last_rating, next_due, streak, graduated, problem_id),
    )
