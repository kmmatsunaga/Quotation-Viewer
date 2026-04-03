"""
Gmail → BigQuery アップローダー
Streamlit web app for uploading Gmail send/receive history to BigQuery.
"""

import streamlit as st
from dotenv import load_dotenv

load_dotenv()

from auth_handler import AuthHandler
from gmail_client import GmailClient
from bigquery_client import BigQueryClient

INITIAL_START_DATE = "2025/01/01"


# -----------------------------------------------------------------------
# Page setup
# -----------------------------------------------------------------------

st.set_page_config(
    page_title="メール履歴 BigQuery アップローダー",
    page_icon="📧",
    layout="wide",
)


# -----------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------

def _make_bq() -> BigQueryClient:
    return BigQueryClient()


CLOUD_RUN_JOB_NAME = (
    "projects/booking-data-388605/locations/asia-northeast1/jobs/gmail-upload-job"
)
JST = __import__("datetime").timezone(__import__("datetime").timedelta(hours=9))


def _trigger_job(user_email: str, direction: str, mode: str) -> str | None:
    """Cloud Run Job を非同期起動する。実行名を返す。"""
    from google.cloud import run_v2
    client  = run_v2.JobsClient()
    request = run_v2.RunJobRequest(
        name=CLOUD_RUN_JOB_NAME,
        overrides=run_v2.RunJobRequest.Overrides(
            container_overrides=[
                run_v2.RunJobRequest.Overrides.ContainerOverride(
                    args=[
                        "upload_job.py",
                        "--user_email", user_email,
                        "--direction",  direction,
                        "--mode",       mode,
                    ]
                )
            ]
        ),
    )
    operation = client.run_job(request=request)
    try:
        return operation.metadata.name  # projects/.../executions/gmail-upload-job-xxxxx
    except Exception:
        return None


def _get_execution_result(execution_name: str) -> tuple[bool, bool, str]:
    """
    Cloud Run execution の状態を確認する。
    Returns: (is_finished, is_failed, reason)
    """
    from google.cloud import run_v2
    try:
        client = run_v2.ExecutionsClient()
        exec_obj = client.get_execution(name=execution_name)
        for condition in exec_obj.conditions:
            if condition.type_ == "Completed":
                state_name = condition.state.name if hasattr(condition.state, "name") else str(condition.state)
                if "FAILED" in state_name:
                    msg = condition.message or "実行が失敗しました（タイムアウトの可能性）"
                    return True, True, msg
                elif "SUCCEEDED" in state_name:
                    return True, False, ""
        return False, False, ""
    except Exception as e:
        return False, False, str(e)


def _find_execution_by_time(started_at) -> tuple[str | None, bool | None]:
    """
    started_at に最も近い Cloud Run 実行を探し (execution_name, is_failed) を返す。
    execution_name が不明な旧レコード向けフォールバック。
    """
    from google.cloud import run_v2
    from datetime import timezone
    try:
        client = run_v2.ExecutionsClient()
        for exec_obj in client.list_executions(parent=CLOUD_RUN_JOB_NAME):
            ct = exec_obj.create_time
            if ct is None or started_at is None:
                continue
            # タイムゾーン付きに統一
            sa = started_at
            if hasattr(sa, "tzinfo") and sa.tzinfo is None:
                sa = sa.replace(tzinfo=timezone.utc)
            if hasattr(ct, "tzinfo") and ct.tzinfo is None:
                ct = ct.replace(tzinfo=timezone.utc)
            if abs((ct - sa).total_seconds()) < 600:  # 10分以内
                for cond in exec_obj.conditions:
                    if cond.type_ == "Completed":
                        state = cond.state.name if hasattr(cond.state, "name") else str(cond.state)
                        return exec_obj.name, "FAILED" in state
    except Exception:
        pass
    return None, None


def _sync_running_status(bq: "BigQueryClient", user_email: str, direction: str, status: dict) -> dict:
    """
    BigQuery が 'running' のとき Cloud Run の実際の状態を確認し、
    失敗/完了していれば BigQuery を更新して最新状態を返す。
    """
    execution_name = status.get("execution_name")

    if not execution_name:
        # 旧レコード（execution_name未保存）: 時刻で照合
        execution_name, is_failed = _find_execution_by_time(status.get("started_at"))
        if execution_name is None:
            return status  # まだ実行中 or 照合不能
        is_finished, is_failed2, reason = _get_execution_result(execution_name)
        if not is_finished:
            return status
        is_failed = is_failed or is_failed2
    else:
        is_finished, is_failed, reason = _get_execution_result(execution_name)
        if not is_finished:
            return status

    reason = locals().get("reason") or ("実行が失敗しました（タイムアウトの可能性）" if is_failed else "")
    if is_failed:
        bq.update_job_status(user_email, direction, "failed", error_message=reason)
        return {**status, "status": "failed", "error_message": reason}
    else:
        bq.update_job_status(user_email, direction, "completed")
        return {**status, "status": "completed"}


def _cancel_execution(execution_name: str) -> None:
    """Cloud Run Job の実行をキャンセルする。"""
    from google.cloud import run_v2
    try:
        client = run_v2.ExecutionsClient()
        client.cancel_execution(name=execution_name)
    except Exception as e:
        print(f"cancel_execution error: {e}")


def _fmt_jst(dt) -> str:
    """タイムスタンプを JST 文字列に変換する。"""
    if dt is None:
        return "─"
    try:
        if hasattr(dt, "astimezone"):
            return dt.astimezone(JST).strftime("%Y-%m-%d %H:%M JST")
    except Exception:
        pass
    return str(dt)


def _show_direction_card(
    bq: "BigQueryClient",
    user_email: str,
    direction: str,
) -> None:
    """送信 or 受信カードを描画し、ジョブ起動ボタンを提供する。"""
    label  = "📤 送信メール" if direction == "send" else "📥 受信メール"
    status = bq.get_job_status(user_email).get(direction)

    # 実行中の場合は Cloud Run の実際の状態と突き合わせる
    if status and status.get("status") == "running":
        status = _sync_running_status(bq, user_email, direction, status)

    # ステータス表示
    if status is None:
        st.info("未実行")
    else:
        s = status.get("status", "")
        if s == "running":
            st.warning("⏳ 実行中…（ブラウザを閉じても処理は続きます）")
        elif s == "completed":
            st.success(
                f"✅ 完了  取得: **{status.get('total_fetched', '─')} 件** / "
                f"追加: **{status.get('uploaded_count', '─')} 件**"
            )
        elif s in ("failed", "cancelled"):
            icon = "❌" if s == "failed" else "⏹️"
            label_s = "失敗" if s == "failed" else "中断済み"
            st.error(f"{icon} {label_s}")
            if status.get("error_message"):
                with st.expander("詳細"):
                    st.code(status["error_message"])
        elif s == "paused":
            st.warning("⏸️ 一時停止済み（途中までのデータは保存されています）")
        else:
            st.info(f"状態: {s}")

        col_s, col_e = st.columns(2)
        col_s.caption(f"開始: {_fmt_jst(status.get('started_at'))}")
        col_e.caption(f"完了: {_fmt_jst(status.get('finished_at'))}")

    is_running = status is not None and status.get("status") == "running"

    if is_running:
        # 実行中: 一時ストップ・中断ボタン
        exec_name = (status or {}).get("execution_name")
        st.caption("⚠️ 既にアップロード済みのデータは保存されています。")
        ctrl_cols = st.columns(2)
        if ctrl_cols[0].button("⏸️ 一時ストップ", key=f"btn_{direction}_pause", type="secondary"):
            with st.spinner("停止シグナルを送信中…"):
                bq.set_job_signal(user_email, direction, "pause")
                st.info("停止シグナルを送りました。次のバッチ完了後に止まります。")
        if ctrl_cols[1].button("⏹️ 中断", key=f"btn_{direction}_cancel", type="secondary"):
            with st.spinner("中断中…"):
                bq.set_job_signal(user_email, direction, "cancel")
                if exec_name:
                    _cancel_execution(exec_name)
                bq.update_job_status(user_email, direction, "cancelled",
                                     error_message="ユーザーが中断しました")
                st.rerun()
    else:
        # 実行中でない: 全件アップロードボタン
        if st.button("🚀 全件アップロード", type="primary", key=f"btn_{direction}_full"):
            with st.spinner("ジョブを起動中…"):
                try:
                    exec_name = _trigger_job(user_email, direction, "full")
                    bq.update_job_status(user_email, direction, "running",
                                         execution_name=exec_name)
                    st.rerun()
                except Exception as e:
                    st.error(f"起動エラー: {e}")


# -----------------------------------------------------------------------
# Auth flow
# -----------------------------------------------------------------------

auth = AuthHandler()

# Handle OAuth callback (Google redirects back with ?code=...)
params = st.query_params
if "code" in params and "credentials" not in st.session_state:
    try:
        creds = auth.exchange_code(params["code"], params.get("state", ""))
        st.session_state["credentials"] = creds
        # Save refresh token for scheduled job
        try:
            bq_tmp = _make_bq()
            bq_tmp.ensure_tables_exist()
            if creds.refresh_token:
                gmail_tmp = GmailClient(creds)
                bq_tmp.save_user_token(
                    gmail_tmp.get_user_email(), creds.refresh_token
                )
        except Exception:
            pass  # Non-fatal; token save will be retried on next upload
        st.query_params.clear()
        st.rerun()
    except Exception as e:
        st.error(f"認証エラー: {e}")
        st.stop()

# Not logged in
if "credentials" not in st.session_state:
    st.title("📧 メール履歴 BigQuery アップローダー")
    st.markdown(
        """
        このアプリは Gmail の送受信履歴を BigQuery へ保存します。
        まず Google アカウントでログインしてください。
        """
    )
    auth_url = auth.get_auth_url()
    st.markdown(
        f'<a href="{auth_url}" target="_self">'
        '<button style="background:#4285F4;color:#fff;padding:10px 24px;'
        'border:none;border-radius:6px;font-size:15px;cursor:pointer;">'
        "🔐 Google でログイン"
        "</button></a>",
        unsafe_allow_html=True,
    )
    st.stop()

# Refresh access token if expired
creds = st.session_state["credentials"]
if creds.expired and creds.refresh_token:
    from google.auth.transport.requests import Request
    creds.refresh(Request())
    st.session_state["credentials"] = creds

# Verify connection
try:
    gmail = GmailClient(creds)
    user_email = gmail.get_user_email()
except Exception as e:
    st.error(f"Gmail 接続エラー: {e}")
    if st.button("再ログイン"):
        del st.session_state["credentials"]
        st.rerun()
    st.stop()

bq = _make_bq()
bq.ensure_tables_exist()

# -----------------------------------------------------------------------
# Main UI
# -----------------------------------------------------------------------

col_h, col_out = st.columns([5, 1])
with col_h:
    st.title("📧 メール履歴 BigQuery アップローダー")
    st.caption(f"ログイン中: {user_email}")
with col_out:
    st.write("")
    if st.button("ログアウト"):
        del st.session_state["credentials"]
        st.rerun()

ADMIN_EMAIL = "matsunaga@ekmtc.com"

tab_upload, tab_delete, tab_sync, tab_info = st.tabs(
    ["📤 アップロード", "🗑️ データ削除", "⏸️ 同期管理", "ℹ️ 使い方"]
)


# -----------------------------------------------------------------------
# Tab 1: Upload
# -----------------------------------------------------------------------

with tab_upload:
    st.header("メール履歴のアップロード")
    st.markdown(
        "ジョブを起動するとバックグラウンドで処理が始まります。"
        "**ブラウザを閉じても処理は続きます。**"
    )

    if st.button("🔃 状態を更新", key="btn_refresh"):
        st.rerun()

    col_send, col_recv = st.columns(2)
    with col_send:
        st.subheader("📤 送信メール")
        _show_direction_card(bq, user_email, "send")
    with col_recv:
        st.subheader("📥 受信メール")
        _show_direction_card(bq, user_email, "receive")


# -----------------------------------------------------------------------
# Tab 2: Delete
# -----------------------------------------------------------------------

with tab_delete:
    import pandas as pd

    st.header("メールデータの検索・削除")
    st.warning(
        "⚠️ BigQuery 上のレコードを削除します。この操作は取り消せません。"
        "　削除したデータは定期実行でも**再追加されません**。"
    )

    # --- フィルタ ---
    st.subheader("🔍 絞り込み検索")

    f_col1, f_col2 = st.columns([2, 3])
    with f_col1:
        f_direction = st.radio("送受信", ["送信", "受信"], horizontal=True, key="f_dir")
    with f_col2:
        address_label = "送信先（To）" if f_direction == "送信" else "送信元（From）"
        f_address = st.text_input(address_label, placeholder="例: someone@example.com", key="f_addr")

    f_col3, f_col4 = st.columns(2)
    with f_col3:
        f_date_from = st.date_input("期間（開始）", value=None, key="f_dfrom")
    with f_col4:
        f_date_to   = st.date_input("期間（終了）",  value=None, key="f_dto")

    f_subject = st.text_input("メールタイトル（部分一致）", placeholder="例: 請求書", key="f_subj")

    if st.button("🔍 検索", type="primary", key="btn_search"):
        dir_key = "send" if f_direction == "送信" else "receive"
        with st.spinner("検索中…"):
            try:
                results = bq.search_emails(
                    direction=dir_key,
                    user_email=user_email,
                    date_from=f_date_from.strftime("%Y-%m-%d") if f_date_from else None,
                    date_to=f_date_to.strftime("%Y-%m-%d")     if f_date_to   else None,
                    address=f_address.strip() or None,
                    subject=f_subject.strip() or None,
                )
                st.session_state["del_results"]   = results
                st.session_state["del_direction"] = dir_key
            except Exception as e:
                st.error(f"検索エラー: {e}")

    # --- 検索結果 ---
    if st.session_state.get("del_results") is not None:
        results   = st.session_state["del_results"]
        dir_key   = st.session_state.get("del_direction", "send")
        tbl_name  = "csmail_send" if dir_key == "send" else "csmail_receive"

        if not results:
            st.info("該当するメールが見つかりませんでした。")
        else:
            st.subheader(f"検索結果: {len(results)} 件（最大 300 件）")

            df_raw = pd.DataFrame(results)
            show_cols = [c for c in ["Datetime", "From", "To", "Subject", "User", "message_id"]
                         if c in df_raw.columns]
            df_show = df_raw[show_cols].copy()
            df_show.insert(0, "選択", False)

            edited = st.data_editor(
                df_show,
                column_config={
                    "選択":      st.column_config.CheckboxColumn("選択", default=False, width="small"),
                    "Datetime":  st.column_config.TextColumn("日時",     width="medium"),
                    "From":      st.column_config.TextColumn("From",     width="medium"),
                    "To":        st.column_config.TextColumn("To",       width="medium"),
                    "Subject":   st.column_config.TextColumn("件名",     width="large"),
                    "User":      st.column_config.TextColumn("User",     width="medium"),
                    "message_id":st.column_config.TextColumn("ID",       width="small"),
                },
                disabled=[c for c in df_show.columns if c != "選択"],
                use_container_width=True,
                hide_index=True,
                key="del_editor",
            )

            selected = edited[edited["選択"] == True]
            n_sel = len(selected)

            st.divider()
            if n_sel == 0:
                st.info("削除したいメールの左端チェックボックスにチェックを入れてください。")
            else:
                st.warning(f"**{n_sel} 件**を削除します。削除後は定期実行でも再追加されません。")
                confirmed_del = st.checkbox(
                    "選択したレコードを削除することに同意します（取り消し不可）",
                    key="del_confirm",
                )
                if st.button("🗑️ 削除実行", type="primary",
                             disabled=not confirmed_del, key="btn_delete_exec"):
                    sel_ids  = selected["message_id"].tolist()
                    id_set   = set(sel_ids)
                    full_rows = [r for r in results if r.get("message_id") in id_set]
                    with st.spinner("削除中…"):
                        try:
                            deleted_n = bq.delete_by_message_ids(sel_ids, tbl_name, full_rows)
                            st.success(
                                f"✅ {deleted_n} 件を削除しました。"
                                "これらのメールは今後の定期実行でも追加されません。"
                            )
                            st.session_state["del_results"] = None
                            st.rerun()
                        except Exception as e:
                            st.error(f"削除エラー: {e}")


# -----------------------------------------------------------------------
# Tab 3: Sync management
# -----------------------------------------------------------------------

with tab_sync:
    st.header("自動同期の管理")
    st.markdown("退職者対応など、特定ユーザーの定期自動同期を停止・再開できます。")

    # --- 自分の同期状態 ---
    st.subheader("あなたの自動同期設定")
    my_enabled = bq.get_sync_status(user_email)
    if my_enabled:
        st.success("✅ 自動同期: **有効**")
        if st.button("⏸️ 自動同期を停止する", key="my_stop"):
            bq.set_sync_enabled(user_email, False)
            st.warning("自動同期を停止しました。")
            st.rerun()
    else:
        st.warning("⏸️ 自動同期: **停止中**")
        if st.button("▶️ 自動同期を再開する", key="my_resume"):
            bq.set_sync_enabled(user_email, True)
            st.success("自動同期を再開しました。")
            st.rerun()

    # --- 管理者専用: 全ユーザー一覧 ---
    if user_email == ADMIN_EMAIL:
        st.divider()
        st.subheader("全ユーザーの同期状態（管理者専用）")

        all_users = bq.get_all_users_status()
        if not all_users:
            st.info("登録済みユーザーがいません。")
        else:
            header = st.columns([3, 2, 2])
            header[0].markdown("**ユーザー**")
            header[1].markdown("**同期状態**")
            header[2].markdown("**操作**")
            st.divider()

            for u in all_users:
                email = u["user_email"]
                enabled = u.get("sync_enabled") is not False  # NULL → True
                col1, col2, col3 = st.columns([3, 2, 2])
                col1.write(email)
                if enabled:
                    col2.success("有効")
                    if col3.button("⏸️ 停止", key=f"stop_{email}"):
                        bq.set_sync_enabled(email, False)
                        st.rerun()
                else:
                    col2.warning("停止中")
                    if col3.button("▶️ 再開", key=f"resume_{email}"):
                        bq.set_sync_enabled(email, True)
                        st.rerun()


# -----------------------------------------------------------------------
# Tab 4: Info
# -----------------------------------------------------------------------

with tab_info:
    st.header("使い方 / 仕組み")
    st.markdown(
        f"""
### 基本フロー

1. **初回** — 送信・受信それぞれの「全件アップロード」ボタンを押して 2025/01/01 からのメールを取得・保存
2. **以降** — 送信・受信それぞれの「差分アップロード」で前回以降の新着だけを追加
3. **定期自動実行** — Cloud Scheduler が 3 時間ごとに自動で差分アップロードを実施

### 保存先テーブル

| テーブル | 内容 |
|---|---|
| `booking-data-388605.updated_tables.csmail_send` | 送信メール |
| `booking-data-388605.updated_tables.csmail_receive` | 受信メール |
| `booking-data-388605.updated_tables.user_tokens` | 定期実行用リフレッシュトークン（管理者のみ参照） |

### 定期実行の仕組み

ログイン時にあなたの OAuth リフレッシュトークンが `user_tokens` テーブルへ保存されます。
Cloud Scheduler（9:00 / 12:00 / 15:00 / 18:00）が `scheduler_job.py` を実行し、
登録済みの全ユーザー分の差分アップロードを自動で行います。

### 社員への展開方法

このアプリの Cloud Run URL を社員に共有し、各自 Google ログインをしてもらうだけです。
初回ログイン後は自動でスケジュール登録されます。
        """
    )
