# ============================================================
# setup-secrets.ps1
# Google Secret Manager からシークレットを取得し、
# 各サブプロジェクトの .env ファイルとBQキーを配置する
#
# 使い方:
#   1. gcloud auth login
#   2. gcloud config set project booking-data-388605
#   3. .\setup-secrets.ps1
# ============================================================

$ErrorActionPreference = "Stop"
$project = "booking-data-388605"

Write-Host "=== Secret Manager からシークレットを取得中... ===" -ForegroundColor Cyan

# ── 1. meeting-dashboard/.env ──
$anthropicKey = gcloud secrets versions access latest --secret=anthropic-api-key --project=$project 2>&1
if ($LASTEXITCODE -ne 0) { Write-Error "anthropic-api-key の取得に失敗: $anthropicKey"; exit 1 }

$envMeeting = "ANTHROPIC_API_KEY=$anthropicKey"
$envMeeting | Out-File -FilePath "meeting-dashboard/.env" -Encoding utf8NoBOM -NoNewline
Write-Host "[OK] meeting-dashboard/.env" -ForegroundColor Green

# ── 2. gmail-bq-uploader/.env ──
$clientId = gcloud secrets versions access latest --secret=google-oauth-client-id --project=$project 2>&1
$clientSecret = gcloud secrets versions access latest --secret=google-oauth-client-secret --project=$project 2>&1

$envGmail = @"
# -- Google OAuth2 --
GOOGLE_CLIENT_ID=$clientId
GOOGLE_CLIENT_SECRET=$clientSecret

# ローカル開発時は 8501、Cloud Run デプロイ後は実際の URL に変更
REDIRECT_URI=http://localhost:8501

# -- BigQuery サービスアカウント --
GOOGLE_SERVICE_ACCOUNT_KEY_PATH=./key/bq-service-account-key.json
"@
$envGmail | Out-File -FilePath "gmail-bq-uploader/.env" -Encoding utf8NoBOM
Write-Host "[OK] gmail-bq-uploader/.env" -ForegroundColor Green

# ── 3. BQ サービスアカウントキー (JSON) ──
$keyDir = "key"
if (!(Test-Path $keyDir)) { New-Item -ItemType Directory -Path $keyDir | Out-Null }

gcloud secrets versions access latest --secret=bq-service-account-key --project=$project | Out-File -FilePath "$keyDir/bq-service-account-key.json" -Encoding utf8NoBOM
Write-Host "[OK] $keyDir/bq-service-account-key.json" -ForegroundColor Green

Write-Host ""
Write-Host "=== 完了! ===" -ForegroundColor Cyan
Write-Host "Note: .env と key/ は .gitignore で除外済みです。" -ForegroundColor Yellow
