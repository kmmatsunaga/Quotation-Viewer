#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
メール送信ツール
Google Workspace サービスアカウント（ドメイン全体の委任）を使用
"""

import tkinter as tk
from tkinter import ttk, messagebox, scrolledtext
import threading
import os
import sys
import base64
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

# ──────────────────────────────────────────────
# 設定
# ──────────────────────────────────────────────
EMPLOYEES = [
    "kimdb@ekmtc.com",
    "okada@ekmtc.com",
    "msato@ekmtc.com",
    "takayama@ekmtc.com",
    "higuchi@ekmtc.com",
    "kanaumi@ekmtc.com",
]

# このスクリプトと同じフォルダに置いたサービスアカウントJSONファイル名
SERVICE_ACCOUNT_FILE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "service_account.json"
)

SCOPES = ["https://www.googleapis.com/auth/gmail.send"]


# ──────────────────────────────────────────────
# メール送信ロジック
# ──────────────────────────────────────────────
def send_email(sender: str, to: str, cc_list: list, bcc_list: list,
               subject: str, addressee: str, body: str):
    """Gmail API経由でメールを送信する"""
    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
    except ImportError:
        raise ImportError(
            "必要なライブラリが未インストールです。\n"
            "コマンドプロンプトで以下を実行してください：\n\n"
            "pip install google-auth google-auth-httplib2 google-api-python-client"
        )

    credentials = service_account.Credentials.from_service_account_file(
        SERVICE_ACCOUNT_FILE, scopes=SCOPES
    )
    delegated = credentials.with_subject(sender)
    service = build("gmail", "v1", credentials=delegated)

    msg = MIMEMultipart()
    msg["From"] = sender
    msg["To"] = to
    if cc_list:
        msg["Cc"] = ", ".join(cc_list)
    if bcc_list:
        msg["Bcc"] = ", ".join(bcc_list)
    msg["Subject"] = subject

    # 宛名を本文の先頭に付ける
    full_body = f"{addressee}\n\n{body}" if addressee else body
    msg.attach(MIMEText(full_body, "plain", "utf-8"))

    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode("utf-8")
    service.users().messages().send(userId=sender, body={"raw": raw}).execute()


# ──────────────────────────────────────────────
# GUI
# ──────────────────────────────────────────────
class MailSenderApp:
    LABEL_WIDTH = 6

    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title("メール送信ツール")
        self.root.geometry("720x680")
        self.root.resizable(True, True)
        self._build_ui()

    # ── UI構築 ──────────────────────────────────
    def _build_ui(self):
        main = ttk.Frame(self.root, padding=16)
        main.pack(fill=tk.BOTH, expand=True)
        main.columnconfigure(1, weight=1)

        row = 0

        # 送信者（ドロップダウン）
        self._label(main, "送信者:", row)
        self.sender_var = tk.StringVar(value=EMPLOYEES[0])
        cb = ttk.Combobox(main, textvariable=self.sender_var,
                          values=EMPLOYEES, state="readonly")
        cb.grid(row=row, column=1, columnspan=2, sticky=tk.EW, pady=3)
        row += 1

        # 宛先
        self._label(main, "宛先:", row)
        self.to_var = tk.StringVar()
        ttk.Entry(main, textvariable=self.to_var).grid(
            row=row, column=1, columnspan=2, sticky=tk.EW, pady=3)
        row += 1

        # CC
        self._label(main, "CC:", row)
        self.cc_var = tk.StringVar()
        ttk.Entry(main, textvariable=self.cc_var).grid(
            row=row, column=1, sticky=tk.EW, pady=3)
        ttk.Label(main, text="カンマ区切りで複数可",
                  foreground="gray").grid(row=row, column=2, sticky=tk.W, padx=6)
        row += 1

        # BCC
        self._label(main, "BCC:", row)
        self.bcc_var = tk.StringVar()
        ttk.Entry(main, textvariable=self.bcc_var).grid(
            row=row, column=1, sticky=tk.EW, pady=3)
        ttk.Label(main, text="カンマ区切りで複数可",
                  foreground="gray").grid(row=row, column=2, sticky=tk.W, padx=6)
        row += 1

        # 宛名
        self._label(main, "宛名:", row)
        self.addressee_var = tk.StringVar()
        ttk.Entry(main, textvariable=self.addressee_var).grid(
            row=row, column=1, sticky=tk.EW, pady=3)
        ttk.Label(main, text="例: 株式会社XX 山田様",
                  foreground="gray").grid(row=row, column=2, sticky=tk.W, padx=6)
        row += 1

        # 件名
        self._label(main, "件名:", row)
        self.subject_var = tk.StringVar()
        ttk.Entry(main, textvariable=self.subject_var).grid(
            row=row, column=1, columnspan=2, sticky=tk.EW, pady=3)
        row += 1

        # 本文
        self._label(main, "本文:", row, anchor=tk.NW)
        self.body_text = scrolledtext.ScrolledText(
            main, width=55, height=16, wrap=tk.WORD, font=("Yu Gothic", 10))
        self.body_text.grid(row=row, column=1, columnspan=2,
                            sticky=tk.NSEW, pady=3)
        main.rowconfigure(row, weight=1)
        row += 1

        # 送信ボタン
        self.send_btn = ttk.Button(
            main, text="  送信  ", command=self._on_send, width=20)
        self.send_btn.grid(row=row, column=1, pady=14)

    def _label(self, parent, text, row, anchor=tk.W):
        ttk.Label(parent, text=text, width=self.LABEL_WIDTH, anchor=anchor).grid(
            row=row, column=0, sticky=tk.NW if anchor == tk.NW else tk.W, pady=3)

    # ── イベント ─────────────────────────────────
    def _parse_addresses(self, raw: str) -> list:
        return [a.strip() for a in raw.split(",") if a.strip()]

    def _on_send(self):
        sender    = self.sender_var.get().strip()
        to        = self.to_var.get().strip()
        cc_raw    = self.cc_var.get().strip()
        bcc_raw   = self.bcc_var.get().strip()
        addressee = self.addressee_var.get().strip()
        subject   = self.subject_var.get().strip()
        body      = self.body_text.get("1.0", tk.END).strip()

        # バリデーション
        if not to:
            messagebox.showwarning("入力エラー", "宛先を入力してください。")
            return
        if not subject:
            messagebox.showwarning("入力エラー", "件名を入力してください。")
            return
        if not body:
            messagebox.showwarning("入力エラー", "本文を入力してください。")
            return

        cc_list  = self._parse_addresses(cc_raw)
        bcc_list = self._parse_addresses(bcc_raw)

        # 送信確認ダイアログ
        cc_disp  = f"\nCC : {', '.join(cc_list)}"  if cc_list  else ""
        bcc_disp = f"\nBCC: {', '.join(bcc_list)}" if bcc_list else ""
        if not messagebox.askyesno(
            "送信確認",
            f"以下の内容でメールを送信しますか？\n\n"
            f"送信者 : {sender}\n"
            f"宛先   : {to}{cc_disp}{bcc_disp}\n"
            f"件名   : {subject}"
        ):
            return

        self.send_btn.config(state="disabled", text="送信中...")

        def do_send():
            try:
                send_email(sender, to, cc_list, bcc_list,
                           subject, addressee, body)
                self.root.after(
                    0, lambda: messagebox.showinfo("完了", "メールを送信しました。"))
            except Exception as e:
                err = str(e)
                self.root.after(
                    0, lambda: messagebox.showerror(
                        "送信エラー", f"送信に失敗しました。\n\n{err}"))
            finally:
                self.root.after(
                    0, lambda: self.send_btn.config(state="normal", text="  送信  "))

        threading.Thread(target=do_send, daemon=True).start()


# ──────────────────────────────────────────────
# エントリーポイント
# ──────────────────────────────────────────────
def main():
    if not os.path.exists(SERVICE_ACCOUNT_FILE):
        root = tk.Tk()
        root.withdraw()
        messagebox.showerror(
            "設定エラー",
            f"サービスアカウントファイルが見つかりません。\n\n"
            f"{SERVICE_ACCOUNT_FILE}\n\n"
            f"setup_guide.txt を参照してセットアップしてください。"
        )
        sys.exit(1)

    root = tk.Tk()
    MailSenderApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
