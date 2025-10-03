# AI Image API MCP Server

Modal.comにデプロイされたAI画像生成APIと連携するMCPサーバです。

## 機能

- **画像生成**: 自然言語プロンプトから画像を生成
- **モデル管理**: 利用可能なモデル一覧と詳細情報の取得
- **プロンプト最適化**: 画像生成に最適化されたプロンプト提案
- **品質制御**: ドラフト・標準・プレミアムの3段階の品質設定
- **リソース管理**: 生成した画像をユーザーごとのキャッシュに保存し、MCPリソースとして参照可能

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

## 生成画像のリソース管理

- 生成されたPNG画像は、ユーザーごとのホームディレクトリ配下にある `~/.cache/ai-image-api-mcp/images` に保存されます。
- メタデータは `~/.cache/ai-image-api-mcp/metadata.json` に蓄積され、MCPのリソースAPIで参照できます。
- リソースURI形式: `resource://ai-image-api/image/<uuid>`
- MCPクライアントから `resources/list` を呼ぶと保存済み画像が一覧され、`resources/read` で画像データとメタ情報を取得できます。
- `generate_image` のレスポンスには保存された画像の `resourceUri` が含まれます。

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
```

## 開発

開発モードでの実行:
```bash
npm run dev
```

## ライセンス

MIT License