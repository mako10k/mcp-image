# AI Image API MCP Server

Modal.comにデプロイされたAI画像生成APIと連携するMCPサーバです。

## 機能

- **画像生成**: 自然言語プロンプトから画像を生成
- **モデル管理**: 利用可能なモデル一覧と詳細情報の取得
- **プロンプト最適化**: 画像生成に最適化されたプロンプト提案
- **品質制御**: ドラフト・標準・プレミアムの3段階の品質設定
- **リソース管理**: 生成した画像をユーザーごとのキャッシュに保存し、MCPリソースとして参照可能
- **ジョブ駆動の生成フロー**: ローカル Job API にジョブを登録し、進行状況をポーリング（利用不可時はModalの直接APIに自動フォールバック）
- **最適化と生成の一括実行**: `optimize_and_generate` ツールで最適化から生成までをワンステップで実行

## セットアップ

1. 依存関係のインストール:
```bash
npm install
```

2. TypeScriptのビルド:
```bash
npm run build
```

3. MCPクライアント（VS Code等）で接続:
```json
{
  "servers": {
    "ai-image-api-mcp-server": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/mcp-image/dist/index.js"]
    }
  }
}
```

## 利用可能なツール

### generate_image
自然言語プロンプトから画像を生成します。

**パラメータ:**
- `prompt` (必須): 画像生成のためのプロンプト
- `quality_tier`: `draft`, `standard`, `premium` (デフォルト: `standard`)
- `style_hint`: スタイル指定のヒント（オプション）
- `size_preference`: `small`, `medium`, `large` (デフォルト: `medium`)
- `experimental`: 実験的機能の有効化 (デフォルト: `false`)

このツールはまずローカルで稼働する Job API (`http://localhost:8099`) にジョブを投入し、完了までポーリングします。Job API にアクセスできない場合は自動的にModal.comの `text-to-image` エンドポイントへフォールバックします。

### get_available_models
利用可能なAI画像生成モデルの一覧を取得します。

### get_model_detail
特定のモデルの詳細情報を取得します。

**パラメータ:**
- `model_name` (必須): 詳細情報を取得するモデル名

### optimize_prompt
プロンプトを画像生成に最適化し、推奨パラメータを提案します。

**パラメータ:**
- `query` (必須): 最適化したいプロンプトまたは画像の説明
- `target_model`: 対象とするモデル（オプション）

### search_images
保存済みの生成画像をローカルキャッシュから検索します。Modal 側の API には検索エンドポイントが存在しないため、MCP サーバーが保持しているメタデータをフィルターします。

**パラメータ:**
- `query`: プロンプトに含まれるキーワード（部分一致）
- `model`: 生成に使用したモデル名での絞り込み
- `limit`: 取得件数の上限（1-20、デフォルト5）
- `before`: 指定日時より前に生成された画像に限定 (ISO 8601)
- `after`: 指定日時以降に生成された画像に限定 (ISO 8601)

### optimize_and_generate
プロンプト最適化と画像生成を一括で行います。Job API を経由した生成と、最適化ツールの推奨パラメータを組み合わせます。

**パラメータ:**
- `query` (必須): 生成したい内容の説明
- `target_model`: 優先的に使用したいモデル名（オプション）
- `quality_tier`: `draft`, `standard`, `premium` (デフォルト: `standard`)
- `size_preference`: `small`, `medium`, `large` (デフォルト: `medium`)
- `experimental`: 実験的モデルを優先的に使用 (デフォルト: `false`)
- `style_hint`: 最終プロンプトに追加したいスタイル（オプション）

## 生成画像のリソース管理

- 生成されたPNG画像は、ユーザーごとのホームディレクトリ配下にある `~/.cache/ai-image-api-mcp/images` に保存されます。
- メタデータは `~/.cache/ai-image-api-mcp/metadata.json` に蓄積され、MCPのリソースAPIで参照できます。
- リソースURI形式: `resource://ai-image-api/image/<uuid>`
- MCPクライアントから `resources/list` を呼ぶと保存済み画像が一覧され、`resources/read` では `contents[0].blob` にPNG本体、`contents[0].mimeType` に `image/png` が格納されたレスポンスが返ります（同じURIでメタ情報のテキスト要素も同梱）。
- `generate_image` のレスポンスには保存された画像の `resourceUri` が含まれます。
- `search_images` ツールはこのメタデータを利用して検索を行います（ai-image-api 自体には検索用エンドポイントが存在しません）。

### キャッシュに保存された画像を確認する

```bash
npm run single-test
```

実行後、最新の画像は `resources/list` の結果に含まれ、VS CodeなどのMCPクライアントから直接プレビューできます。

## APIエンドポイント

Modal.comにデプロイされた以下のAPIを使用：

- 画像生成: `https://mako10k--ai-image-api-text-to-image.modal.run`
- モデル一覧: `https://mako10k--ai-image-api-get-model-configs.modal.run`
- モデル詳細: `https://mako10k--ai-image-api-get-model-detail.modal.run`
- Job API（ローカル実行前提）: `http://localhost:8099`
  - ジョブ登録: `POST /jobs`
  - ジョブ状態確認: `GET /jobs/{job_id}/status`
  - 結果取得: `GET /jobs/{job_id}/result`
  - パラメータ最適化: `POST /optimize_params`

### Job API 認証設定

Modal 上の Job API を利用する場合、以下の環境変数で接続先とAPIキーを指定できます。

| 変数名 | 役割 | 備考 |
| --- | --- | --- |
| `JOBAPI_URL` | Job API のベースURL | 未設定時は `https://mako10k--ai-image-jobapi-serve.modal.run` を使用 |
| `JOBAPI_API_KEY` | `x-api-key` ヘッダーに付与するAPIキー | WebUIと共有する場合は `WEBUI_JOBAPI_API_KEY` でも可 |

例: `.env` (または MCP クライアントを起動するシェル) に以下を設定

```bash
export JOBAPI_URL=https://mako10k--ai-image-jobapi-serve.modal.run
export JOBAPI_API_KEY=h64JPkVDIlalIHfHTQkvZDHR-O_p8L4DYP3qxTwBJyQ
```

キーが設定されていない場合、Job API 呼び出しは 401 エラーとなり、`generate_image` などのツールは自動的にModalの直接エンドポイントへフォールバックします。

## 使用例

```javascript
// MCPクライアントから呼び出す例

// 1. 画像生成
await mcp.callTool('generate_image', {
  prompt: '夕日に照らされた未来都市',
  quality_tier: 'standard',
  style_hint: 'cyberpunk, neon lights',
  size_preference: 'medium'
});

// 2. モデル一覧取得
await mcp.callTool('get_available_models', {});

// 3. プロンプト最適化
await mcp.callTool('optimize_prompt', {
  query: '猫が庭にいる'
});

// 4. 最適化と生成をまとめて実行
await mcp.callTool('optimize_and_generate', {
  query: '霧に包まれたサイバーパンク都市を描いて',
  quality_tier: 'premium',
  size_preference: 'large'
});
```

## 開発

開発モードでの実行:
```bash
npm run dev
```

## ライセンス

MIT License