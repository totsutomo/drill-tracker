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
    starred_at TEXT,
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

-- ストリーク・フリーズ(never miss twiceの自動版、2026-09-19)で「欠けた日を継続扱いにした」
-- 日付だけを記録する。残高はsettings.streak_freeze_milestone(7日ごとに+1相当、上限2個)から
-- このテーブルの件数を引いて算出する(main.py _settle_streak_freeze参照)
CREATE TABLE IF NOT EXISTS streak_freezes (
    date TEXT PRIMARY KEY
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

# 一周目(カタログ全問題への初回着手)が終わるまでの一時的な間隔(2026-09-24、とっつー要望)。
# 間違えた問題がすぐ復習キューの先頭に戻ってきて新規問題の出題枠を食い、解き方を覚えて
# しまうだけの実践的でない練習になっていた。一周目が終わっていない間はこちらを使い、
# 一周目が完了(全問題に1回は着手済み)した時点でINTERVAL_DAYSに自動で戻る
# (is_first_pass_in_progress/compute_next_srs_state参照)。
FIRST_PASS_INTERVAL_DAYS = {1: 3, 2: 5, 3: 7, 4: 10, 5: 15}


# study-trackerと同じ理由: リクエストのたびに(特にTursoのようなリモートDBへ)新規接続を
# 張ると往復のたびに接続確立のコストがかかる。FastAPIの同期routeはスレッドプールで
# 実行されるため、スレッドごとに1本だけ接続を作って使い回す。
_local = threading.local()


def _open_connection():
    if TURSO_DATABASE_URL:
        return libsql.connect(database=TURSO_DATABASE_URL, auth_token=TURSO_AUTH_TOKEN)
    return libsql.connect(str(DB_PATH))


# 書き込みは同時に1本だけにする(2026-09-28)。libsqlはTursoとの通信を待つ間もPythonのGILを握ったまま
# なので、2本の書き込みが同時に来ると「先に書き込み権を取ったAのcommit」が「Aの書き込み権が空くのを
# 待つB」にGILを奪われて進めず、Turso側でAのトランザクションが"idle for too long"として取り消されていた
# (Compassでカレンダーの×を続けて押すと一部の削除が500になった不具合と同じ。Drillでも評価を続けて押すと起きうる)。
# Lock.acquireはGILを手放して待つので、ここで順番待ちさせればAのcommitは止まらない。
_write_lock = threading.Lock()
_WRITE_LOCK_TIMEOUT_S = 15  # commit漏れ等で解放されなかった場合でも、永久に止まらないための上限

_READ_PREFIXES = ("SELECT", "PRAGMA", "EXPLAIN")


def _is_write(name, args):
    if name == "executescript":
        return True
    if name not in ("execute", "executemany") or not args:
        return False
    return not str(args[0]).lstrip().upper().startswith(_READ_PREFIXES)


class _PooledConnection:
    """生のlibsql接続をラップし、close()を無視して接続をスレッドローカルに使い回すためのプロキシ。
    呼び出し側は今まで通り get_connection() → 使う → close() という書き方のままでよい。"""

    def __init__(self, conn):
        self._conn = conn
        self._holds_write_lock = False

    def close(self):
        # 実際には閉じない。次のリクエスト(同じスレッド)でも同じ接続を使い回す。
        pass

    def _release_write_lock(self):
        if self._holds_write_lock:
            self._holds_write_lock = False
            try:
                _write_lock.release()
            except RuntimeError:
                pass

    def _acquire_write_lock(self):
        if self._holds_write_lock:
            return
        self._holds_write_lock = _write_lock.acquire(timeout=_WRITE_LOCK_TIMEOUT_S)

    def _reconnect(self):
        try:
            self._conn.close()
        except Exception:
            pass
        self._conn = _open_connection()

    def _discard_leftover_transaction(self):
        """前のリクエストがcommitせずに終わった場合の後始末(書き込み権と開きっぱなしのトランザクションを捨てる)"""
        if not self._holds_write_lock:
            return
        try:
            self._conn.rollback()
        except Exception:
            self._reconnect()
        self._release_write_lock()

    def __getattr__(self, name):
        attr = getattr(self._conn, name)
        if not callable(attr):
            return attr

        def wrapper(*args, **kwargs):
            if _is_write(name, args):
                self._acquire_write_lock()
            was_in_transaction = self._conn.in_transaction
            try:
                return getattr(self._conn, name)(*args, **kwargs)
            except Exception:
                # 接続そのものが壊れている可能性があるため張り直す。トランザクションの外で失敗した
                # 1文(=まだ何も書き込まれていない)なら、新しい接続で1回だけやり直す
                # (しばらく使っていない接続はTurso側で切られていて、最初の1文が失敗することがある)。
                self._reconnect()
                if name in ("execute", "executemany") and not was_in_transaction:
                    try:
                        return getattr(self._conn, name)(*args, **kwargs)
                    except Exception:
                        self._reconnect()
                        self._release_write_lock()
                        raise
                self._release_write_lock()
                raise
            finally:
                if name in ("commit", "rollback"):
                    self._release_write_lock()

        return wrapper


def get_connection():
    cached = getattr(_local, "conn", None)
    if cached is not None:
        cached._discard_leftover_transaction()
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
    # study-trackerと同じ「PRAGMA table_info→ALTER TABLE ADD COLUMN」パターン。
    # CREATE TABLE IF NOT EXISTSは既存DBには効かないため、本番Turso・ローカル両方の
    # 既存データを壊さずカラムを足すにはこの方式が必要(2026-09-16、starred_at追加時に導入)。
    cols = {row[1] for row in conn.execute("PRAGMA table_info(problems)").fetchall()}
    if "starred_at" not in cols:
        conn.execute("ALTER TABLE problems ADD COLUMN starred_at TEXT")
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


def is_first_pass_in_progress(conn) -> bool:
    """一周目(カタログ全問題への初回着手)がまだ終わっていないか。queue_todayの出題対象
    (retire済み・EXERCISEセクションを除く)のうち、1件でも未着手の問題が残っていればTrue。"""
    row = conn.execute(
        "SELECT 1 FROM problems p JOIN sections s ON p.section_id = s.id "
        "WHERE p.retired_at IS NULL AND s.name != 'EXERCISE' "
        "AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.problem_id = p.id) LIMIT 1"
    ).fetchone()
    return row is not None


def compute_next_srs_state(prior_streak: int, rating: int, source: str = "solve", first_pass_mode: bool = False):
    """評価1件を反映した後のstreak/graduated/次回までの日数を返す。
    (新streak, 新graduated, 次回までの日数)
    source='seed'(7.5章の単元一括自己申告)は実際に解いた確認ではないため、
    rating>=4でも卒業ロジックのstreakには一切寄与させない。
    first_pass_mode=Trueの間はFIRST_PASS_INTERVAL_DAYSを使う(is_first_pass_in_progress参照)。"""
    if source == "seed":
        new_streak = 0
    else:
        new_streak = prior_streak + 1 if rating >= 4 else 0
    new_graduated = 1 if new_streak >= 2 else 0
    if new_graduated:
        interval = GRADUATED_INTERVAL_DAYS
    else:
        interval_table = FIRST_PASS_INTERVAL_DAYS if first_pass_mode else INTERVAL_DAYS
        interval = interval_table[rating]
    return new_streak, new_graduated, interval


def recompute_problem_srs(conn, problem_id: int):
    """attempts履歴(このproblem_idの全件)からproblems.srs_*列を再計算して書き戻す。
    POST/DELETE /api/attempts、インポートスクリプトのいずれからも呼ばれる共通ロジック。
    (attempts=過去の記録、problems=現在の状態のキャッシュ、という2章の分離を守るための唯一の書き込み経路)"""
    cur = conn.execute(
        "SELECT rating, local_date, source FROM attempts WHERE problem_id = ? "
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

    first_pass_mode = is_first_pass_in_progress(conn)
    streak, graduated = 0, 0
    last_rating, next_due = None, None
    for rating, local_date, source in rows:
        streak, graduated, interval = compute_next_srs_state(streak, rating, source, first_pass_mode)
        last_rating = rating
        next_due = add_days(local_date, interval)

    conn.execute(
        "UPDATE problems SET srs_last_rating = ?, srs_next_due_date = ?, "
        "srs_streak = ?, srs_graduated = ? WHERE id = ?",
        (last_rating, next_due, streak, graduated, problem_id),
    )
