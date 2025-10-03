# MCP Image サーバー申し送り事項

## 背景
- XMPP ボット側では MCP stdio サーバー ID `ai-image` が登録されており、このリポジトリのサーバーが画像生成／配信を担当しています。
- 生成した画像をボットメッセージに添付する際、ボットは `resource://...` 形式の URI を HTTP ダウンロード URL に書き換えます。この処理ではサーバー ID を手がかりに MCP クライアントへ `readResource` を要求します。
- 2025-10-03 時点のボットログでは以下 2 点が原因で書き換えに失敗していることを確認しました。
  1. `resource://ai-image-api/...` という URI 前置詞のせいでサーバー ID を特定できず、`Unknown MCP server id: ai-image-api` が発生。
  2. MCP サーバー側の `readResource` 応答が SDK のバリデーション (Zod) に通らず、画像バイナリを取得できていません。

## 対応済み（ボット側）
- ボットは 2025-10-03 の修正で、過去のツール呼び出しから「URI → サーバー ID」対応をキャッシュし、`resource://ai-image-api/...` でも `ai-image` クライアントに問い合わせられるようになりました。
- そのため、今後は MCP サーバーが正しい形式で `readResource` のレスポンスを返せば、自動的に HTTP URL へ書き換えられる想定です。

## MCP サーバー側で必要な対応
1. **`readResource` のレスポンス整備**
   - SDK (`@modelcontextprotocol/sdk`) の `readResource` 応答は `contents` 配列に以下のようなオブジェクトを含める必要があります。
     ```json
     {
       "uri": "resource://ai-image-api/image/<uuid>",
       "blob": "<base64-encoded PNG>",
       "mimeType": "image/png",
       "description": "任意の説明文"
     }
     ```
   - 少なくとも `uri` と `blob` (または `text`) は必須です。現在の実装ではこれらが `undefined` のまま返っており、ボット側ログに次のエラーが出ています。
     - `ZodError: invalid_type: expected "string", received "undefined" (path: contents[0].uri)`
   - 画像バイナリを直接返せない場合は、`contents` 内に `downloadUrl` を含める形でも可ですが、SDK の型を満たしていることを確認してください。

2. **URI とサーバー ID の整合性確認**
   - 生成済みの URI には `resource://ai-image-api/...` というプレフィックスが用いられていますが、ボット設定上のサーバー ID は `ai-image` です。
   - URI プレフィックスはこのままでも動作しますが、新しい ID（例: `resource://ai-image/...`）に変更する場合は、ボット側でも既存会話ログとの互換性確認が必要です。

3. **HTTP アップロード連携の任意対応**
   - ボットは XMPP HTTP Upload を利用して公開 URL を発行します。`readResource` が `blob` を返せば自動でアップロードされますが、環境変数 `XMPP_HTTP_UPLOAD_JID` が未設定の場合は `uploadBuffer` が「not configured」とログ出力して終了します。
   - 本番運用で外部共有が必要な場合は、ボットのアップロード設定（`XMPP_HTTP_UPLOAD_JID`, `XMPP_HTTP_UPLOAD_MAX_BYTES`）を別途有効化してください。

## 動作確認の流れ (想定)
1. MCP サーバーをローカルで起動し、`node dist/index.js` ないし `npm start` で `readResource` が求める形式を返すよう修正済みであることを確認します。
2. XMPP ボットを `npm run start:pm2` 等で再起動し、画像生成の会話を行います。
3. ボットログ (`openai-xmpp-bot/logs/out.log`) に HTTP URL が出力され、`resource://` がメッセージ中で HTTPS リンクに置き換わっていることを確認します。

## 参考ログ抜粋
```
2025-10-03T10:39:06.339Z { "level": "debug", "msg": "Failed to resolve resource URI in assistant response", "meta": { "serverId": "ai-image-api", "uri": "resource://ai-image-api/image/01406b6e-7354-4fbf-979d-de8698e2c04c", "err": { "message": "Unknown MCP server id: ai-image-api" } } }
2025-10-03T10:39:04.324Z { "level": "warn", "msg": "Failed to read MCP resource content", "meta": { "serverId": "ai-image", "err": { "name": "ZodError", "message": "invalid_type: expected 'string', received 'undefined' (path: contents[0].uri)" } } }
```

## 追加タスク候補
- `readResource` のレスポンス修正と単体テスト追加。
- `resource://` URI の命名規則とサーバー ID の整理（ドキュメント化）。
- HTTP アップロード設定有効化後のエンドツーエンド試験。
