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

API マッピング
- Job API: POST /images/caption
- 入力: 画像（token/base64/url 等）、言語、スタイル等
- 出力: `{ caption: string, language?: string, confidence?: number, metadata?: object }`

提案する MCP ツール定義（概略）
- name: `caption_image`
- inputSchema (JSON Schema 概要)
  - image_token?: string
  - resource_uri?: string
  - image_base64?: string
  - image_url?: string
  - language?: string (例: "ja", "en")
  - style?: string (例: "short", "detailed")
  - store_to_metadata?: boolean (default: false) … true の場合は PATCH /images/{image_token}/meta で `caption` を格納
- 出力 content
  - application/json: {
      image_token?: string,
      resource_uri?: string,
      caption: string,
      language?: string,
      confidence?: number,
      metadata?: object,
      stored_to_metadata?: boolean
    }

入力解決ロジック
1) resource_uri があればローカルメタデータから image_token と base64 を取得
2) image_token があれば GET /images/{image_token} で取得（base64 同梱/必要時）
3) image_base64 直接渡し
4) image_url を Job API にそのまま転送（APIが許容する場合）

エラー/検証
- いずれの画像参照も無い場合: InvalidRequest
- language/style が空文字は未指定扱い
- store_to_metadata が true かつ image_token 不明: InvalidRequest（保存先が特定できない）

テスト
- 最小: resource_uri 指定で caption が返る
- language=ja/en を切替
- store_to_metadata=true で PATCH 成功し、再取得したメタに caption が反映

---

## 2) upscale ツール

目的: 入力画像を指定倍率またはサイズで高解像度化。

API マッピング
- Job API: POST /upscale
- 入力: 画像、scale または target_width/target_height、model/denoise 等（API仕様に追随）
- 出力: 画像＋メタデータ

提案する MCP ツール定義（概略）
- name: `upscale_image`
- inputSchema
  - image_token?|resource_uri?|image_base64?|image_url?
  - scale?: number (例: 2, 4) … scale があれば target_* より優先
  - target_width?: integer (multipleOf:64)
  - target_height?: integer (multipleOf:64)
  - model?: string (例: "ESRGAN")
  - denoise_strength?: number
- 出力 content
  - [0] image/png
  - [1] application/json: {
      image_token: string,
      resource_uri: string,
      prompt?: string,           // 可能なら元画像の情報
      model?: string,
      created_at: string,
      used_params: object,
      metadata: object,
      original_image_token?: string
    }

保存
- 成功時は `saveImage()` を利用してキャッシュ。
- `original_image_token` を metadata に格納しトレーサビリティを確保。

検証
- scale と target_* が両方指定: scale を採用し target_* は無視（またはエラーにする方針も可）
- target_* 指定は 256–4096、64 の倍数に丸め/検証

---

## 3) image-to-image ツール

目的: 既存画像から変換生成（スタイル変更・構図保持など）。

API マッピング
- Job API: POST /image-to-image（同期） もしくは POST /jobs/image-to-image（非同期）
- 本サーバでは同期 API を優先。長時間化が懸念される場合はタイムアウト延長か、jobs API を利用してポーリング実装を選択可能なフラグを提供。

提案する MCP ツール定義（概略）
- name: `image_to_image`
- inputSchema
  - source: { resource_uri?|image_token?|image_base64?|image_url? }（必須いずれか）
  - prompt?: string
  - negative_prompt?: string
  - strength?: number (0–1 推奨)
  - guidance_scale?: number
  - steps?: integer
  - width?: integer (multipleOf:64)
  - height?: integer (multipleOf:64)
  - model?: string
  - seed?: integer
  - scheduler?: string
  - async?: boolean (default: false) … true の場合は jobs API を使い、`job_id` を返してクライアントでフォロー可能に
- 出力 content（同期）
  - [0] image/png
  - [1] application/json: {
      image_token: string,
      resource_uri: string,
      model: string,
      prompt?: string,
      created_at: string,
      used_params: object,
      metadata: object,
      source_image_token?: string
    }
- 出力 content（非同期 async=true）
  - application/json: { job_id: string, status: "queued"|"running"|..., poll_endpoints: { status: "/jobs/{id}/status", result: "/jobs/{id}/result" } }

検証/制約
- prompt なしでも strength が低ければ元画像重視の変換として許容
- width/height 未指定時はソース画像寸法を既定に使用

---

## 4) store-from-url ツール

目的: 公開 URL の画像を JOB API 経由で取得し、サーバのキャッシュとメタデータに登録。

API マッピング
- Job API: POST /images/store-from-url

提案する MCP ツール定義（概略）
- name: `store_image_from_url`
- inputSchema
  - image_url: string (required)
  - filename?: string
  - tags?: string[]
  - fetch_headers?: object (必要なら認証ヘッダー等)
- 出力 content
  - application/json: {
      image_token: string,
      resource_uri: string,
      mime_type: string,
      created_at: string,
      metadata: object,
      download_url?: string
    }

保存
- Job API のレスポンスに base64 が含まれる場合は `saveImage()` で保存、含まれない場合は download_url を用いてダウンロード→保存（既存の token 取得処理を流用）。

検証
- URL のスキームは http/https のみ許可
- 画像サイズが大きい場合のダウンロードタイムアウトを延長（環境変数で調整）

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