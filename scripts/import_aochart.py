"""
青チャート(Obsidian Vault)からDrillのDBへ、構成(章/単元/問題)と過去の実績(attempts)を
移行するワンショットスクリプト。

設計(実装プラン7章): Markdown → パーサー → 正規化した中間データ(books/sections/chapters/
units/problems/attempts/notes/warningsのリスト) → DB書き込み、の2段構成。
--dry-run はパーサーの結果だけを集計表示し、DBには一切書き込まない。

使い方:
    python scripts/import_aochart.py --dry-run     # 件数検証のみ
    python scripts/import_aochart.py               # 実際にDBへ投入(何度実行しても冪等)
"""

import argparse
import re
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Windows端末(既定cp1252/cp932)でも日本語出力が文字化け/例外にならないようにする
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from database import get_connection, init_db, recompute_problem_srs  # noqa: E402

VAULT_DIR = Path(r"C:\Users\totsu\No1\勉強\数学\青チャート")
QUESTION_LOG_PATH = Path(r"C:\Users\totsu\No1\勉強\数学\質問ログ.md")
WARNINGS_PATH = Path(__file__).resolve().parent / "import_warnings.txt"

BOOKS = [
    {"filename": "数学Ⅰ.md", "subject": "数学Ⅰ", "slug": "aochart-math1"},
    {"filename": "数学A.md", "subject": "数学A", "slug": "aochart-matha"},
    {"filename": "数学Ⅱ.md", "subject": "数学Ⅱ", "slug": "aochart-math2"},
    {"filename": "数学B.md", "subject": "数学B", "slug": "aochart-mathb"},
    {"filename": "数学C.md", "subject": "数学C", "slug": "aochart-mathc"},
]

# 旧: ◎○×または1/2/3(1=即答/2=時間かかったが解けた/3=解けなかった)
MARK_TO_OLD_RATING = {"◎": 1, "○": 2, "×": 3, "1": 1, "2": 2, "3": 3}
# 新5段階への変換(実装プラン3章)。新スケールは大きいほど良いため極性が逆転する。
OLD_TO_NEW_RATING = {1: 5, 2: 3, 3: 1}

IMPORT_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "drill-tracker-import")

SECTION_RE = re.compile(r"^##\s+(ログ|EXERCISE)\s*$")
CHAPTER_RE = re.compile(r"^####\s+第(\d+)章\s*([^\n(]*?)\((\d+)-(\d+)\)\s*$")
UNIT_COMMENT_RE = re.compile(r"^<!--\s*単元:\s*(.+?)\s*-->\s*$")
UNIT_TOKEN_RE = re.compile(r"([^/]+?)\((\d+)(?:-(\d+))?\)")
ROW_RE = re.compile(r"^\|\s*(\d+)\s*\|\s*(.*?)\s*\|\s*$")
HISTORY_ENTRY_RE = re.compile(r"(\d{2}-\d{2}):([◎○×123])(?:\(([^()]*)\))?")
NOTE_ROW_RE = re.compile(r"^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$")


# ---------------------------------------------------------------------------
# Stage 1: パース
# ---------------------------------------------------------------------------

def parse_subject_file(path: Path, warnings: list) -> list:
    """1科目分のMarkdownを読み、sectionsのリストを返す。
    各section: {orig_label, display_name, chapters: [...]}
    各chapter: {number, name, range_from, range_to, raw_units: [...], rows: [(number, history_cell)]}"""
    if not path.exists():
        warnings.append(f"WARNING: ファイルが見つかりません: {path}")
        return []

    text = path.read_text(encoding="utf-8")
    sections = []
    current_section = None
    current_chapter = None

    for raw_line in text.split("\n"):
        line = raw_line.strip()

        m = SECTION_RE.match(line)
        if m:
            label = m.group(1)
            current_section = {
                "orig_label": label,
                "display_name": "本編" if label == "ログ" else "EXERCISE",
                "chapters": [],
            }
            sections.append(current_section)
            current_chapter = None
            continue

        m = CHAPTER_RE.match(line)
        if m and current_section is not None:
            current_chapter = {
                "number": int(m.group(1)),
                "name": m.group(2).strip(),
                "range_from": int(m.group(3)),
                "range_to": int(m.group(4)),
                "raw_units": [],
                "rows": [],
            }
            current_section["chapters"].append(current_chapter)
            continue

        m = UNIT_COMMENT_RE.match(line)
        if m and current_chapter is not None:
            for tok in UNIT_TOKEN_RE.finditer(m.group(1)):
                name = re.sub(r"^\d+\.\s*", "", tok.group(1).strip()).strip()
                range_from = int(tok.group(2))
                range_to = int(tok.group(3)) if tok.group(3) else range_from
                current_chapter["raw_units"].append(
                    {"name": name, "from": range_from, "to": range_to}
                )
            continue

        m = ROW_RE.match(line)
        if m and current_chapter is not None:
            current_chapter["rows"].append((int(m.group(1)), m.group(2).strip()))
            continue

    return sections


def resolve_units(raw_units: list, warnings: list, context: tuple) -> list:
    """章内の単元トークンを解決する。
    1) 範囲が完全一致するものは名前を"/"で連結して1単元にマージ(情報を捏造しない安全な処理)
    2) 完全一致ではないが範囲が重なるものは、先に出現した方が重複部分を取り(先勝ち)、
       後に出現した方を縮小する。この場合のみwarningsに記録する(実装プラン7章)。
    戻り値: [{names: [...], from, to}, ...] (元の出現順)"""
    subject, section_name, chapter_num = context

    merged_order = []
    merged_map = {}
    for u in raw_units:
        key = (u["from"], u["to"])
        if key not in merged_map:
            merged_map[key] = {"names": [u["name"]], "from": u["from"], "to": u["to"]}
            merged_order.append(key)
        else:
            merged_map[key]["names"].append(u["name"])
    resolved = [merged_map[k] for k in merged_order]

    for i in range(len(resolved)):
        for j in range(i + 1, len(resolved)):
            a, b = resolved[i], resolved[j]
            if a["from"] > a["to"] or b["from"] > b["to"]:
                continue  # 既に別の重複処理で空になっている
            overlap_from = max(a["from"], b["from"])
            overlap_to = min(a["to"], b["to"])
            if overlap_from > overlap_to:
                continue  # 重なりなし
            warnings.append(
                f"WARNING: {subject} {section_name} 第{chapter_num}章 "
                f"{overlap_from}-{overlap_to} overlap "
                f"({'/'.join(a['names'])}/{'/'.join(b['names'])}) — 暫定的に先勝ち割当、要人手確認"
            )
            if b["from"] >= a["from"] and b["to"] <= a["to"]:
                b["from"], b["to"] = 1, 0  # bはaに完全に飲み込まれる→空区間にする
            elif b["from"] < overlap_from:
                b["to"] = overlap_from - 1
            else:
                b["from"] = overlap_to + 1

    return [u for u in resolved if u["from"] <= u["to"]]


def find_unit_index(resolved_units: list, number: int, warnings: list, context: tuple):
    subject, section_name, chapter_num = context
    matches = [idx for idx, u in enumerate(resolved_units) if u["from"] <= number <= u["to"]]
    if not matches:
        warnings.append(
            f"WARNING: {subject} {section_name} 第{chapter_num}章 問題{number} が"
            f"どの単元にも属しません — 要人手確認"
        )
        return None
    if len(matches) > 1:
        warnings.append(
            f"WARNING: {subject} {section_name} 第{chapter_num}章 問題{number} が"
            f"複数単元({len(matches)}件)に一致 — 先頭を採用"
        )
    return matches[0]


def parse_history_cell(cell: str, assume_year: int) -> list:
    attempts = []
    if not cell:
        return attempts
    for m in HISTORY_ENTRY_RE.finditer(cell):
        mmdd, mark, memo = m.group(1), m.group(2), m.group(3)
        old_rating = MARK_TO_OLD_RATING[mark]
        new_rating = OLD_TO_NEW_RATING[old_rating]
        attempts.append(
            {
                "local_date": f"{assume_year}-{mmdd}",
                "rating": new_rating,
                "memo": memo.strip() if memo else None,
            }
        )
    return attempts


def parse_question_log(path: Path, warnings: list) -> list:
    if not path.exists():
        warnings.append(f"WARNING: 質問ログファイルが見つかりません: {path}")
        return []
    notes = []
    for raw_line in path.read_text(encoding="utf-8").split("\n"):
        m = NOTE_ROW_RE.match(raw_line.strip())
        if m:
            notes.append(
                {
                    "noted_at": m.group(1),
                    "unit": m.group(2),
                    "mistake_type": m.group(3),
                    "summary": m.group(4),
                }
            )
    return notes


def build_books_data(assume_year: int, warnings: list) -> list:
    books_data = []
    for book_cfg in BOOKS:
        sections = parse_subject_file(VAULT_DIR / book_cfg["filename"], warnings)
        for section in sections:
            for chapter in section["chapters"]:
                context = (book_cfg["subject"], section["display_name"], chapter["number"])
                resolved = resolve_units(chapter["raw_units"], warnings, context)
                chapter["resolved_units"] = resolved
                assignments = []
                for number, history_cell in chapter["rows"]:
                    unit_index = find_unit_index(resolved, number, warnings, context)
                    attempts = parse_history_cell(history_cell, assume_year)
                    assignments.append(
                        {"number": number, "unit_index": unit_index, "attempts": attempts}
                    )
                chapter["assignments"] = assignments
        books_data.append(
            {"subject": book_cfg["subject"], "slug": book_cfg["slug"], "sections": sections}
        )
    return books_data


# ---------------------------------------------------------------------------
# Stage 2: DB書き込み(すべて自然キーによるupsertで冪等)
# ---------------------------------------------------------------------------

def upsert_book(conn, title, subject, slug, sort_order):
    row = conn.execute("SELECT id FROM books WHERE slug = ?", (slug,)).fetchone()
    if row:
        conn.execute(
            "UPDATE books SET title = ?, subject = ?, sort_order = ? WHERE id = ?",
            (title, subject, sort_order, row[0]),
        )
        return row[0]
    cur = conn.execute(
        "INSERT INTO books (title, subject, slug, sort_order) VALUES (?, ?, ?, ?)",
        (title, subject, slug, sort_order),
    )
    return cur.lastrowid


def upsert_section(conn, book_id, name, sort_order):
    row = conn.execute(
        "SELECT id FROM sections WHERE book_id = ? AND name = ?", (book_id, name)
    ).fetchone()
    if row:
        conn.execute("UPDATE sections SET sort_order = ? WHERE id = ?", (sort_order, row[0]))
        return row[0]
    cur = conn.execute(
        "INSERT INTO sections (book_id, name, sort_order) VALUES (?, ?, ?)",
        (book_id, name, sort_order),
    )
    return cur.lastrowid


def upsert_chapter(conn, section_id, number, name, range_from, range_to, sort_order):
    row = conn.execute(
        "SELECT id FROM chapters WHERE section_id = ? AND number = ?", (section_id, number)
    ).fetchone()
    if row:
        conn.execute(
            "UPDATE chapters SET name = ?, range_from = ?, range_to = ?, sort_order = ? WHERE id = ?",
            (name, range_from, range_to, sort_order, row[0]),
        )
        return row[0]
    cur = conn.execute(
        "INSERT INTO chapters (section_id, number, name, range_from, range_to, sort_order) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (section_id, number, name, range_from, range_to, sort_order),
    )
    return cur.lastrowid


def upsert_unit(conn, chapter_id, name, range_from, range_to, sort_order):
    row = conn.execute(
        "SELECT id FROM units WHERE chapter_id = ? AND name = ? AND range_from = ? AND range_to = ?",
        (chapter_id, name, range_from, range_to),
    ).fetchone()
    if row:
        conn.execute("UPDATE units SET sort_order = ? WHERE id = ?", (sort_order, row[0]))
        return row[0]
    cur = conn.execute(
        "INSERT INTO units (chapter_id, number, name, range_from, range_to, sort_order) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (chapter_id, None, name, range_from, range_to, sort_order),
    )
    return cur.lastrowid


def upsert_problem(conn, unit_id, section_id, number, catalog_order):
    row = conn.execute(
        "SELECT id FROM problems WHERE section_id = ? AND number = ?", (section_id, number)
    ).fetchone()
    if row:
        # retired_at/srs_*はユーザーの生きた状態なので触らない。所属・表示順だけ更新する
        conn.execute(
            "UPDATE problems SET unit_id = ?, catalog_order = ? WHERE id = ?",
            (unit_id, catalog_order, row[0]),
        )
        return row[0]
    cur = conn.execute(
        "INSERT INTO problems (unit_id, section_id, number, catalog_order) VALUES (?, ?, ?, ?)",
        (unit_id, section_id, number, catalog_order),
    )
    return cur.lastrowid


def insert_attempt_if_new(conn, problem_id, client_attempt_id, rating, local_date, source, memo=None):
    existing = conn.execute(
        "SELECT id FROM attempts WHERE client_attempt_id = ?", (client_attempt_id,)
    ).fetchone()
    if existing:
        return False
    conn.execute(
        "INSERT INTO attempts (problem_id, client_attempt_id, rating, local_date, source, memo) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (problem_id, client_attempt_id, rating, local_date, source, memo),
    )
    return True


def insert_note_if_new(conn, subject, unit_name, mistake_type, summary, noted_at):
    existing = conn.execute(
        "SELECT id FROM standalone_notes WHERE noted_at = ? AND summary = ?", (noted_at, summary)
    ).fetchone()
    if existing:
        return False
    conn.execute(
        "INSERT INTO standalone_notes (subject, unit_name, mistake_type, summary, noted_at) "
        "VALUES (?, ?, ?, ?, ?)",
        (subject, unit_name, mistake_type, summary, noted_at),
    )
    return True


def write_to_db(books_data: list, notes: list):
    init_db()
    conn = get_connection()
    catalog_counter = 0
    for book_idx, book in enumerate(books_data):
        book_id = upsert_book(conn, f"青チャート {book['subject']}", "数学", book["slug"], book_idx)
        for section_idx, section in enumerate(book["sections"]):
            section_id = upsert_section(conn, book_id, section["display_name"], section_idx)
            for chapter in section["chapters"]:
                chapter_id = upsert_chapter(
                    conn, section_id, chapter["number"], chapter["name"],
                    chapter["range_from"], chapter["range_to"], chapter["number"],
                )
                unit_ids = [
                    upsert_unit(conn, chapter_id, "/".join(u["names"]), u["from"], u["to"], uidx)
                    for uidx, u in enumerate(chapter["resolved_units"])
                ]
                for a in chapter["assignments"]:
                    if a["unit_index"] is None:
                        continue  # 既にwarningsに記録済み。孤立問題は作らない
                    unit_id = unit_ids[a["unit_index"]]
                    problem_id = upsert_problem(conn, unit_id, section_id, a["number"], catalog_counter)
                    catalog_counter += 1
                    for chain_idx, att in enumerate(a["attempts"]):
                        key = (
                            f"import|{book['slug']}|{section['display_name']}|"
                            f"{a['number']}|{chain_idx}|{att['local_date']}|{att['rating']}"
                        )
                        client_id = str(uuid.uuid5(IMPORT_NAMESPACE, key))
                        insert_attempt_if_new(
                            conn, problem_id, client_id, att["rating"], att["local_date"],
                            "import", att["memo"],
                        )
                    if a["attempts"]:
                        recompute_problem_srs(conn, problem_id)
    for note in notes:
        insert_note_if_new(conn, "数学", note["unit"], note["mistake_type"], note["summary"], note["noted_at"])
    conn.commit()
    return conn


def verify_integrity(conn) -> bool:
    checks = {
        "problems→units 孤立": "SELECT COUNT(*) FROM problems p LEFT JOIN units u ON p.unit_id=u.id WHERE u.id IS NULL",
        "problems→sections 孤立": "SELECT COUNT(*) FROM problems p LEFT JOIN sections s ON p.section_id=s.id WHERE s.id IS NULL",
        "units→chapters 孤立": "SELECT COUNT(*) FROM units u LEFT JOIN chapters c ON u.chapter_id=c.id WHERE c.id IS NULL",
        "chapters→sections 孤立": "SELECT COUNT(*) FROM chapters c LEFT JOIN sections s ON c.section_id=s.id WHERE s.id IS NULL",
        "attempts→problems 孤立": "SELECT COUNT(*) FROM attempts a LEFT JOIN problems p ON a.problem_id=p.id WHERE p.id IS NULL",
    }
    print("--- DB整合性チェック ---")
    ok = True
    for label, sql in checks.items():
        count = conn.execute(sql).fetchone()[0]
        print(f"{label}: {count}")
        ok = ok and count == 0
    dup = conn.execute(
        "SELECT COUNT(*) FROM (SELECT section_id, number FROM problems GROUP BY section_id, number HAVING COUNT(*) > 1)"
    ).fetchone()[0]
    print(f"同一section内の番号重複: {dup}")
    ok = ok and dup == 0
    print("結果: " + ("OK" if ok else "NG - 要調査"))
    return ok


# ---------------------------------------------------------------------------
# エントリポイント
# ---------------------------------------------------------------------------

def count_summary(books_data: list, notes: list) -> dict:
    n_sections = n_chapters = n_units = n_problems = n_attempts = 0
    for book in books_data:
        n_sections += len(book["sections"])
        for section in book["sections"]:
            n_chapters += len(section["chapters"])
            for chapter in section["chapters"]:
                n_units += len(chapter["resolved_units"])
                n_problems += len(chapter["assignments"])
                for a in chapter["assignments"]:
                    n_attempts += len(a["attempts"])
    return {
        "books": len(books_data),
        "sections": n_sections,
        "chapters": n_chapters,
        "units": n_units,
        "problems": n_problems,
        "attempts": n_attempts,
        "notes": len(notes),
    }


def main():
    parser = argparse.ArgumentParser(description="青チャート(Obsidian)→Drill DB 移行スクリプト")
    parser.add_argument("--dry-run", action="store_true", help="DBに書き込まず件数検証のみ行う")
    parser.add_argument("--assume-year", type=int, default=2026, help="履歴の MM-DD に補う年(既定: 2026)")
    parser.add_argument("--verify", action="store_true", help="実行後にDB整合性チェックを行う(--dry-run時は無視)")
    args = parser.parse_args()

    warnings = []
    books_data = build_books_data(args.assume_year, warnings)
    notes = parse_question_log(QUESTION_LOG_PATH, warnings)
    counts = count_summary(books_data, notes)

    integrity_ok = None
    if not args.dry_run:
        conn = write_to_db(books_data, notes)
        if args.verify:
            integrity_ok = verify_integrity(conn)
        conn.close()

    WARNINGS_PATH.write_text(
        ("\n".join(warnings) + "\n") if warnings else "", encoding="utf-8"
    )

    label = "[DRY RUN] " if args.dry_run else ""
    print("=" * 70)
    print(f"{label}インポート結果")
    print("=" * 70)
    print(
        f"Books: {counts['books']}  Sections: {counts['sections']}  "
        f"Chapters: {counts['chapters']}  Units: {counts['units']}"
    )
    print(
        f"Problems: {counts['problems']}  Attempts: {counts['attempts']}  "
        f"Notes: {counts['notes']}  Warnings: {len(warnings)}"
    )
    print("=" * 70)

    if warnings:
        print()
        print("#" * 70)
        print(f"# WARNINGS ({len(warnings)}件) — 要確認。import自体は正常終了しています")
        print("#" * 70)
        for w in warnings:
            print(w)
        print("#" * 70)
        print(f"詳細は {WARNINGS_PATH} にも保存されています")

    if integrity_ok is False:
        print()
        print("!!! DB整合性チェックでNGが検出されました。上記ログを確認してください !!!")

    sys.exit(0)


if __name__ == "__main__":
    main()
