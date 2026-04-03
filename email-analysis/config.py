"""
設定ファイル
"""

# BigQuery
PROJECT_ID = "booking-data-388605"
DATASET_ID = "updated_tables"
TABLE_RECEIVE = "csmail_receive"
TABLE_SEND = "csmail_send"
TABLE_CATEGORY = "csmail_category"

# サービスアカウントキーのパス
BQ_KEY_PATH = "C:/Users/matsunaga/Documents/key/booking-data-388605@appspot.gserviceaccount.com/booking-data-388605-ec9e7af2c0e1.json"

# Gemini API
GEMINI_MODEL = "gemini-2.5-flash"   # コスト効率重視
BATCH_SIZE = 50          # 1回のAPI呼び出しで処理するメール件数
MAX_BODY_CHARS = 500     # Bodyの最大文字数（トークン節約）

# 分析対象外の件名パターン（これにマッチするメールはカテゴリ分けしない）
EXCLUDE_SUBJECT_PATTERNS = [
    "Delivery Status Notification (Failure)",
    "Delivery Status Notification (Delay)",
    "[Action Required] B/L(Booking) supplementation on Korea T/S Shipments",
    "楽楽精算",
    "セキュリティ通知",
    "Undelivered Mail Returned to Sender",
    "Returned mail: see transcript for details",
]

# カテゴリ定義
# L1: 大カテゴリ, L2: 詳細カテゴリ（業務の実態に即して定義）
CATEGORIES = {
    "ブッキング": [
        "新規依頼・発番",          # 初回のブッキング依頼
        "承認依頼",               # e-KMTCでのWEB BKG後の承認リクエスト
        "本船変更依頼",            # 既存BKGの本船を変更したい
        "仕向地（POD）変更",       # 揚げ地・仕向港の変更依頼
        "コンテナ変更",            # タイプ・本数・サイズの変更
        "スペース確認",            # 特定便にスペースがあるか確認
        "進捗照会・確認",          # ブッキング状況・コンファーム確認
        "キャンセル",              # ブッキングキャンセル依頼
    ],
    "CY・搬入関連": [
        "CUT延長依頼",             # 書類・CYカットの延長をお願い
        "早期搬入依頼",            # CY OPENより前に搬入したい
        "遅れ搬入依頼",            # CUT後・本船遅延等による搬入遅れ
        "CY OPEN日確認",           # CYオープン日を知りたい
        "前搬入許可依頼",          # 指定日より前に搬入したいケース
    ],
    "T/S（積み替え）": [
        "接続依頼",                # T/S先本船の指定・接続リクエスト
        "最速接続依頼",            # 至急・最短での接続を依頼
        "T/S先本船変更",           # 接続先本船の変更依頼
        "T/S先・ルート確認",       # どこでT/Sするか、ルート確認
    ],
    "運賃・見積もり": [
        "新規見積依頼",            # 新規ルートの運賃見積もり依頼
        "適用運賃確認",            # 現在適用されている運賃の確認
        "運賃更改・交渉",          # 既存契約の運賃交渉・更新
        "Rate Application",       # R/Aリンク・レートアプリ関連
        "現地費用確認",            # 現地のローカルチャージ確認
    ],
    "B/L関連": [
        "B/L Draft確認",           # B/Lドラフトの内容確認・承認
        "B/L修正・訂正依頼",       # 発行済みB/Lの訂正
        "SURRENDER B/L依頼",       # サレンダーB/L（原本不発行）依頼
        "D/O・貨物引渡し",         # D/O LESS・デバンニング関連
        "SI・VGM提出",             # Shipping Instruction・VGM提出
    ],
    "DG（危険品）": [
        "積載可否確認",            # 危険品が積めるか確認
        "DG申請・書類提出",        # DG申請フォーム・書類の提出
        "MSDS提出依頼",            # MSDS（化学品安全データシート）
    ],
    "スケジュール": [
        "スケジュール照会",         # 特定ルート・便のスケジュール確認
        "ETA・ETD確認",            # 到着・出発予定日の確認
        "本船遅延・変更通知",       # 本船遅延・スケジュール変更の連絡
    ],
    "フリータイム・D/O": [
        "フリータイム延長依頼",     # コンテナのフリータイム延長
        "D/O LESS依頼",            # 輸入貨物の早期引渡し依頼
        "滞留コンテナ対応",         # コンテナ返却・滞留料金関連
    ],
    "クレーム・損傷": [
        "コンテナ損傷",            # コンテナ自体の破損・損傷
        "貨物損傷・紛失",          # 積み荷の損傷・紛失クレーム
        "遅延クレーム",            # 本船遅延による損害クレーム
        "誤請求・請求確認",         # チャージ・請求書の誤りや確認
    ],
    "OOG・特殊貨物": [
        "OOG（超大型貨物）",       # Out of Gauge 貨物
        "SOC（荷主コンテナ）",     # Shipper Owned Container
        "リーファー（冷蔵）",       # 冷凍・冷蔵コンテナ
        "タンクコンテナ",           # 液体・化学品タンク
    ],
    "e-KMTC・システム": [
        "操作方法・サポート",       # e-KMTCの使い方の質問
        "システムエラー・不具合",   # ログインできない・画面エラー等
    ],
    "その他": [
        "自動通知メール",           # システム自動送信のお知らせ
        "挨拶・担当者変更",         # 挨拶メール・担当者交代連絡
        "社内連絡・転送",           # 社内向けや転送メール
        "一般照会",                # 上記に当てはまらない問合せ
    ],
}
