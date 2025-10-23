# MCP 拡張ツール設計（caption / upscale / image-to-image / store-from-url）

本書は、既存の AI Image API MCP Server に以下 4 つのツールを追加する際の設計指針です。すべての応答は JSON-only（必要時に画像メディアを併送）であり、stdout は JSON-RPC 専用・ログは stderr の方針に準拠します。

- caption: 画像からキャプション（説明文）を生成
- upscale: 画像のアップスケール（高解像度化）
- image-to-image: 既存画像を入力として新しい画像を生成
- store-from-url: 外部 URL の画像を取り込み・メタデータ登録

Job API 側の該当エンドポイント（OpenAPI 取得済）
- POST /images/caption
- POST /upscale
- POST /image-to-image（または POST /jobs/image-to-image）
- POST /images/store-from-url

共通事項
- 画像参照の入力は可能なら統一インターフェースを提供する（優先度: resource_uri > image_token > image_base64 > image_url）。
- 返却は JSON 1 ペイロード＋必要に応じて image/png を content[0] として併送。
- 成功時はローカルキャッシュ（~/.cache/ai-image-api-mcp）に保存し、`resource://ai-image-api/image/<uuid>` を付与。
- 例外・バリデーションは既存の generate_image と同等の粒度で McpError を返す。

---

## 1) caption ツール

目的: 入力画像の内容を説明するテキスト（キャプション）を生成。

API マッピング（OpenAPI 真偽確認済み）
- Job API: POST `/images/caption`
- リクエスト: `ImageCaptionRequest`
  - `image_token?`: ImageStore に保存済みの画像トークン
  - `image_base64?`: Base64 エンコード済み RGB 画像
  - `prompt?`: BLIP-2 へ加える追加プロンプト
  - `max_new_tokens? (1-512, default 64)`
  - `temperature? (0-2, default 0)`
  - `top_p? (0-1, default 0.95)`
  - `use_nucleus_sampling? (boolean, default false)`
  - `repetition_penalty? (0.5-2, default 1)`
  - `model_id?`: BLIP-2 モデル指定
- レスポンス: `ImageCaptionResponse`
  - 必須: `caption`, `model_id`, `device`, `dtype`, `metadata`
  - 任意: `image_token`, `image_metadata`

提案する MCP ツール定義（更新版）
- name: `caption_image`
- inputSchema
  - `resource_uri?`
  - `image_token?`
  - `image_base64?`
  - `image_url?`（Job API が URL を直接受け取らないため、必要なら先に store-from-url で解決）
  - `prompt?`
  - `max_new_tokens?`
  - `temperature?`
  - `top_p?`
  - `use_nucleus_sampling?`
  - `repetition_penalty?`
  - `model_id?`
  - `store_to_metadata?: boolean`（default false。true の場合は PATCH `/images/{image_token}/meta` を発行し caption を保存）

出力 content
- [0]（任意）application/json: `caption` 等を含む本 API レスポンス＋ `resource_uri`
- store_to_metadata=true の場合は `stored_to_metadata: true` を追加して結果を明示

入力解決ロジック
1. `resource_uri` → ローカルキャッシュから `image_token` と base64 を取得
2. `image_token` → GET `/images/{image_token}` でデータ取得（base64 未提供なら download_url 経由の保存ロジックを流用）
3. `image_base64` → そのまま転送
4. `image_url` → 直接は不可。`store_image_from_url` で事前登録し、得た `image_token` を使用

エラー/検証
- 画像参照 (`resource_uri`/`image_token`/`image_base64`) が一つも無い場合: `InvalidRequest`
- 引数値は OpenAPI の min/max を尊重してバリデーション（範囲外なら `InvalidRequest`）
- `store_to_metadata=true` かつ `image_token` 不明: `InvalidRequest`

テスト
- 基本: `resource_uri` 指定で caption が返り JSON が正しい
- パラメータ境界: `max_new_tokens=1` と `512`、`temperature=0/2`
- `store_to_metadata=true` で PATCH 成功し、GET `/images/{token}/meta` に caption が付与される

---

## 2) upscale ツール

目的: 入力画像を指定倍率で高解像度化。

API マッピング
- Job API: POST `/upscale`
- リクエスト: `UpscaleRequest`
  - `image_token`（必須）
  - `scale?`（int, 1–8, default 2）
- レスポンス: `UpscaleJobStatusResponse { job_id: string, status: string }`
  - アップスケールは非同期ジョブ。完了画像を得るには `/jobs/{job_id}/result` で `include_base64=true` を指定し、`JobResultResponse` を取得。

提案する MCP ツール定義（更新版）
- name: `upscale_image`
- inputSchema
  - `resource_uri?`
  - `image_token?`
  - `scale?`（1–8 の整数。未指定時は 2）
  - `poll_timeout_seconds?`（ジョブ完了待ちの上限値。default 300）
  - `poll_interval_seconds?`（default 5）

ジョブ処理フロー
1. 画像参照を `image_token` に解決（resource_uri → token、image_base64 は一旦 `/images/store` で保存して token 化）。
2. POST `/upscale` を実行し `job_id` を取得。
3. `/jobs/{job_id}/status` で進捗確認。`status` が `succeeded` になるまでポーリング。
4. `/jobs/{job_id}/result?include_base64=true` を取得。
5. 戻り値の `image_base64` を `saveImage()` に渡し、`metadata` に `upscaled_from: <元token>` を追記。

出力 content
- [0] image/png（`image_base64` から）
- [1] application/json: {
    image_token,
    resource_uri,
    created_at,
    upscale_job: { job_id, status },
    used_params: { scale },
    metadata,
    original_image_token: <入力トークン>
  }

検証
- `scale` が 1–8 の整数でない場合は `InvalidRequest`
- 画像トークン未解決時は `InvalidRequest`
- ポーリングが `poll_timeout_seconds` を超えたら `InternalError`

テスト
- `scale=2` の基本ケース
- `poll_timeout_seconds` より長いジョブでタイムアウト動作を確認
- `resource_uri` 経由での解決

---

## 3) image-to-image ツール

目的: 既存画像から新しい画像を生成（構図保持・スタイル変更）。

API マッピング
- 迅速な同期生成: POST `/image-to-image`
  - リクエスト: `ImageToImageJobRequest`
    - 必須: `prompt`, `init_image_token`
    - 任意: `negative_prompt`, `model` (default `sd21`), `guidance_scale` (default 7.5), `steps` (default 20), `width` (default 512), `height` (default 512), `seed`, `strength` (default 0.7)
  - クエリ: `include_base64`（default false。true でベース64同梱）
  - レスポンス: `ImageToImageJobResponse`（`image_token`, `metadata`, `used_params`, `image_base64?`）
- 長時間ジョブ: POST `/jobs/image-to-image` → `/jobs/{job_id}/status` → `/jobs/{job_id}/result`

提案する MCP ツール定義（更新版）
- name: `image_to_image`
- inputSchema
  - `resource_uri?`
  - `image_token?`
  - `image_base64?`（必要なら先に `/images/store` で変換）
  - `prompt`（必須）
  - `negative_prompt?`
  - `model?`
  - `guidance_scale?`
  - `steps?`
  - `width?`
  - `height?`
  - `seed?`
  - `strength?`
  - `include_base64?: boolean`（default true）
  - `async?: boolean`（default false）
  - `poll_timeout_seconds?`, `poll_interval_seconds?`（async=true のときに使用）

処理フロー
1. 画像参照から `init_image_token` を解決。
2. `async=false`（既定）: `/image-to-image?include_base64=true` を呼び、レスポンスの `image_base64` をキャッシュ。
3. `async=true`: `/jobs/image-to-image` でジョブ作成 → ポーリングで完了 → `/jobs/{job_id}/result?include_base64=true` 取得。
4. SaveImage 時に `metadata.source_image_token` と `metadata.used_params` を記録。

検証
- `prompt` は空文字不可 → `InvalidRequest`
- `width`/`height` は 64 の倍数で 256–2048 → 既存のバリデータを再利用
- `strength` は 0–1 の範囲に収める

出力 content（同期）
- [0] image/png
- [1] application/json: {
    image_token,
    resource_uri,
    model,
    prompt,
    created_at,
    used_params,
    metadata,
    source_image_token
  }

出力 content（非同期）
- application/json: { job_id, status, poll_endpoints: { status, result } }

テスト
- 同期モードで `include_base64=true`
- 非同期モードでポーリング完走と結果保存
- `resource_uri` → `image_token` 解決
---

## 4) store-from-url ツール

目的: 外部 URL の画像を Job API 経由で ImageStore に登録し、ローカルキャッシュへ保存。

API マッピング
- Job API: POST `/images/store-from-url`
- リクエスト: `ImageUrlUploadRequest`
  - `url`（必須, http/https, 最大長 2083）
  - 任意: `source` (default `url-import`), `prompt`, `negative_prompt`, `parameters`, `derived_from`, `tags`, `extra`, `filename`, `timeout`, `max_bytes`
- レスポンス: `ImageUploadResponse { image_token, metadata }`

提案する MCP ツール定義（更新版）
- name: `store_image_from_url`
- inputSchema
  - `image_url`（必須）
  - `source?`
  - `prompt?`
  - `negative_prompt?`
  - `parameters?`
  - `derived_from?`
  - `tags?`
  - `extra?`
  - `filename?`
  - `timeout?`
  - `max_bytes?`

処理フロー
1. URL バリデーション（http/https のみ）。
2. POST `/images/store-from-url` を呼び `image_token` を取得。
3. GET `/images/{image_token}` で base64 が得られる場合はそのまま `saveImage()`。base64 が無い場合は `download_url` を利用して取得後に保存。
4. 保存時に `metadata.source` や `parameters` を記録。

出力 content
- application/json: {
    image_token,
    resource_uri,
    mime_type,
    created_at,
    metadata,
    download_url?
  }

検証
- URL が http/https 以外 → `InvalidRequest`
- `timeout` が負数 → `InvalidRequest`
- `max_bytes` が 0 以下 → `InvalidRequest`

テスト
- 正常系: 公開 PNG URL
- 大容量 URL で `max_bytes` を下回ることを確認
- タグや derived_from を指定したレスポンスで metadata が保存される

---

## エラーハンドリング方針（共通）
- Job API ステータスコードを既存の `handleError()` と同様に分類: 400/404/429/500/timeout。
- 入力検証エラーは `McpError(ErrorCode.InvalidRequest, ...)`。
- ネットワーク/接続ミスは `Service unavailable` 文言に統一。

---

## ロギング・I/O ポリシー
- すべての操作ログは `console.error` に出力（stdout 汚染防止）。
- パラメータは 200 文字程度で切り詰めて記録（機微情報の漏洩抑止）。

---

## ストレージとリソース URI
- 画像保存は既存の `saveImage()`（`storage.ts`）を再利用。
- 返却 JSON に `resource_uri` を含め、MCP クライアントから参照可能に。
- 関連元画像（source/original）がある場合はメタデータにトレースを記録（`source_image_token` / `original_image_token`）。

---

## 最小テスト計画
- caption: 既存生成画像の `resource_uri` を入力し、caption が JSON で返る（必要に応じて META 保存）。
- upscale: 512x512 → 1024x1024 のアップスケールが成功し、PNG＋JSON が返る。
- image-to-image: source 画像＋prompt あり/なしで生成が成功。async=true の場合に job_id が返る。
- store-from-url: 外部 PNG を保存し、`resource_uri` と `image_token` が返る。

---

## 追加の公開ツール定義（src/index.ts への追記例・概要）
- `caption_image`
- `upscale_image`
- `image_to_image`
- `store_image_from_url`

各ツールの `inputSchema` は上記の概略を JSON Schema に落とし込み、`CallToolRequest` 分岐にハンドラを追加。応答は既存パターンに合わせて `[image?, json]` を返すこと。

---

## 実装メモ
- `src/client.ts` に対応 API 呼び出しメソッドを追加（caption/upscale/img2img/storeFromUrl）。
- include_base64 / include_metadata のクエリサポートがあれば付与して一貫化。
- 画像解決ヘルパーを共通化（resource_uri→記録→base64/token の順に解決）。
- async フロー（jobs API）を使う場合: 既存の `testConnection` のような小ユーティリティでポーリングヘルパーを用意しても良い。

以上。