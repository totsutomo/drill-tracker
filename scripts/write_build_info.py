"""デプロイ時にbuild_info.txt(/api/build-infoとapp.js等のキャッシュ回避用の版情報)を書き出す。

Render時代はbuildCommandの`git log -1 --format=%cI`で書いていたが、Vercelのビルド環境には
.gitが無いことがあるため、取れなければビルド時刻で代用する。
"""
import subprocess
from datetime import datetime, timezone
from pathlib import Path


def main():
    try:
        stamp = subprocess.run(
            ["git", "log", "-1", "--format=%cI"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        stamp = ""
    if not stamp:
        stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    Path(__file__).resolve().parent.parent.joinpath("build_info.txt").write_text(stamp)
    print(f"build_info.txt: {stamp}")


if __name__ == "__main__":
    main()
