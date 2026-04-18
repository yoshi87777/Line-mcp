# LINE Bot 引き継ぎドキュメント

**最終更新**: 2026-04-17  
**リポジトリ**: https://github.com/yoshi87777/Line-mcp  
**VPS**: aria-nova.xyz (45.32.55.165)

---

## アーキテクチャ

```
LINE
 ├── Yoshiki DM (U846a6931bfdd24cb05e90485c82a4a0f)
 │    └── ARIA /chat (http://127.0.0.1:8000/chat)
 │         └── Geminiフォールバック
 │
 ├── 他人DM
 │    └── Gemini（秘書モード）
 │         ・丁寧な日本語
 │         ・日程調整の会話
 │         ・Yoshikiの個人情報は開示しない
 │
 └── グループチャット
      └── Gemini（関西弁、会話のみ）
```

---

## サービス構成（VPS: aria-nova.xyz）

| サービス | PM2名 | ポート | 役割 |
|---------|-------|-------|------|
| LINE webhook | `line-webhook` | 3000 | このbot本体 |
| ARIA API | `aria-api` | 8000 | タスク・スケジュール管理 |
| ARIA bot | `aria-bot` | - | Slackなど別チャネル |

**Nginx**: `/webhook` → `127.0.0.1:3000` にプロキシ済み  
**LINE Webhook URL**: `https://aria-nova.xyz/webhook`

---

## プライバシー・セキュリティ

- **Yoshiki以外はARIAに一切アクセスしない**
- YoshikiのLINE IDは環境変数 `DESTINATION_USER_ID` でハードロック
- 他人のDMはGeminiのみ（Supabaseの個人データに触れない）
- グループチャットはGeminiのみ

---

## 環境変数（VPS: /root/Line-mcp/.env）

```
CHANNEL_ACCESS_TOKEN=...    # LINE Bot アクセストークン
CHANNEL_SECRET=...          # LINE Bot チャンネルシークレット
DESTINATION_USER_ID=...     # YoshikiのLINE user ID
GEMINI_API_KEY=...          # Gemini APIキー（メイン）
GEMINI_API_KEYS_EXTRA=...   # Gemini APIキー（ローテーション用、カンマ区切り）
PORT=3000
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
ARIA_API_TOKEN=aria-mobile-2026
```

---

## Supabaseテーブル

| テーブル | 用途 |
|---------|------|
| `line_conversations` | LINE会話履歴（source_idで識別） |
| `users` | ARIAユーザー（line_user_idでLINEと紐付け） |
| `line_auth_tokens` | LINE認証トークン（将来用） |
| `schedule_requests` | スケジュール承認リクエスト（将来用） |
| `scheduled_events` | 確定スケジュール |
| `tasks` | タスク管理 |

---

## テスト体制

| コマンド | テスト数 | 内容 |
|---------|---------|------|
| `npm test` | 42件 | プライバシー（13）＋動作（29）。デプロイ前に自動実行 |
| `npm run test:llm` | 5件 | 実際のGemini呼び出し＋Geminiジャッジで品質チェック |

**テストファイル：**
- `test-privacy.js` — ARIAアクセス制御テスト（Yoshiki以外はARIAに触れない）
- `test-behavior.js` — ルーティング・プロンプト・DB保存・フォールバック動作テスト
- `test-llm.js` — 実Gemini応答をGemini（またはClaude）がジャッジ

## ヘルスチェック

```bash
# エンドポイント確認
curl https://aria-nova.xyz/health

# LINEから直接確認（Yoshikiのみ）
!status  # → commit hash / Supabase / ARIA / Gemini keys 等を返信
```

毎朝 8:00 JST に自動でYoshikiのLINEにヘルスレポートが届く。

## デプロイ方法

```bash
# ローカルでテスト通過を確認してからプッシュ
npm test   # 42件全通過を確認

git push

# VPS（自動）
ssh root@45.32.55.165
cd /root/Line-mcp
git pull
npm install   # 依存関係変化時のみ
npm test      # VPS側でも再確認（PM2再起動前に自動実行）
pm2 restart line-webhook
```

---

## 将来の拡張（未実装）

### 秘書→承認フロー
1. Popcorn等がARIAにDMして日程調整
2. ARIAが情報を集めてYoshikiに承認リクエスト通知
3. Yoshikiが承認 → 秘書がPopcornに確定連絡
4. `schedule_requests` テーブルは既に作成済み

### LINE認証（マルチユーザー）
1. 「ARIAと連携したい」と送る
2. ワンタイムリンクを発行
3. aria-mobileで認証 → LINE IDとARIAアカウント紐付け
4. `line_auth_tokens` テーブルは既に作成済み

### ARIA会話エージェント独立化
- 会話エージェントをARIAから分離
- Gemini Function Callingでツールとして各APIを呼ぶ
- 認証はARIA-USER-IDヘッダーで付与（api.py改修が必要）

---

## ログ確認

```bash
pm2 logs line-webhook --lines 50
```
