import os
from datetime import datetime

from fastapi import FastAPI

from database import get_connection, init_db, row_to_dict, rows_to_dicts

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


@app.get("/api/build-info")
def build_info():
    return {"lastUpdated": LAST_UPDATED}


@app.get("/")
def root():
    return {"app": "Drill", "status": "ok"}
