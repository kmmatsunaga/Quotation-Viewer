"""
categorize.py を完了まで自動再起動するループスクリプト
止まっても自動で再起動し続け、全件完了したら終了する
"""

import os
import subprocess
import sys
import time
from datetime import datetime

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CATEGORIZE_PY = os.path.join(SCRIPT_DIR, "categorize.py")
LOG_FILE = os.path.join(SCRIPT_DIR, "categorize_log.txt")

os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = (
    r"C:\Users\matsunaga\Documents\key"
    r"\booking-data-388605@appspot.gserviceaccount.com"
    r"\booking-data-388605-ec9e7af2c0e1.json"
)

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")


def log(msg):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def run_once():
    cmd = [
        sys.executable, CATEGORIZE_PY,
        "--table", "both",
        "--limit", "999999",
    ]
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    env["GEMINI_API_KEY"] = GEMINI_API_KEY

    with open(LOG_FILE, "a", encoding="utf-8") as logf:
        proc = subprocess.Popen(cmd, env=env, stdout=logf, stderr=logf)
        return proc.wait()


def main():
    if not GEMINI_API_KEY:
        print("エラー: GEMINI_API_KEY が設定されていません")
        sys.exit(1)

    log("=== 自動再起動ループ開始 ===")
    attempt = 0

    while True:
        attempt += 1
        log(f"--- 試行 {attempt} 回目 開始 ---")
        ret = run_once()
        log(f"--- 試行 {attempt} 回目 終了 (returncode={ret}) ---")

        if ret == 0:
            log("=== 全件完了！ループ終了 ===")
            break

        log("異常終了 or タイムアウト。30秒後に再起動します...")
        time.sleep(30)


if __name__ == "__main__":
    main()
