# ai-image-api 画像トークン刷新対応 申し送り

最終更新: 2025-10-11

## 背景と目的
- `~/ai-image-api` 側で Phase B のトークンフロー整備を実施し、同期/非同期生成APIとキャプションAPIがすべて `image_token` 中心で結果を返すように刷新。
- MCP エージェント (`~/mcp-image`) はこれまで Base64 を前提にしたハンドリングが多かったため、連携更新時の注意事項をまとめる。

## 変更点サマリ
1. **同期生成API** (`POST /text-to-image`, `POST /image-to-image`, `POST /upscale`)
   - デフォルトレスポンスが `image_token` + `metadata` となり、Base64は `include_base64=true` 指定時のみ。
   - `metadata.files` に画像ファイルやサムネイル、埋め込みの相対パスが格納される。

2. **非同期ジョブAPI**
   - `GET /jobs/{job_id}/result` が `image_token` と `metadata` を返却し、Base64はオプション化。
   - `result_token` が DB に保存され、アップスケール含む各ジョブの結果をTokenで一意に参照可能。

3. **ImageStore 統合**
   - バックグラウンドジョブ／アップスケール処理も `ImageStore.register_image` を利用。
   - 画像メタ情報は JSON (同一ディレクトリ) に集約。旧 `image_file_store` 由来のファイル保存は廃止済み。

4. **キャプションAPI** (`POST /images/caption`)
   - Base64のみで呼び出した場合でも画像を ImageStore に保存し、`image_token` + `image_metadata` をレスポンスに含める。
   - 既存トークン指定時はメタデータをマージしてキャプション／モデルID／タイムスタンプを更新。

5. **テスト整備**
   - pytest 側で `JOBAPI_IMAGES_DIR` を一時ディレクトリに差し替えるフィクスチャを追加。
   - 回帰テスト: `pytest tests/job_manager/test_api_text2img.py tests/job_manager/test_api_img2img.py tests/job_manager/test_api_job_result.py tests/job_manager/test_api_image_caption.py`

## MCP 実装への影響
- **レスポンス処理**: `image_token` を第一優先で扱うよう更新が必要。Base64を期待していたロジックは `include_base64` クエリを明示的に付与するか、ImageStore からダウンロードするフローに置き換える。
- **生成後フロー**: token→metadata→必要に応じたURL生成 or `GET /images/{token}` 利用を推奨。
- **キャプション結果**: 返却された `image_token` を参照し、後段処理（再キャプションやメタ更新）に活用可能。
- **互換モード**: 当面は `include_base64` で旧挙動も利用可能だが、将来的な廃止を想定してトークンベースへ移行推奨。
- **実装状況**: `src/index.ts` では `include_base64/include_metadata` を強制し、`image_token`・`metadata`・`download_url` を `storage.ts` に保存するよう改修済み。`readResource` は保存済みの Base64 を優先し、テキストペイロードにトークンとメタ情報を含める。
- **ストレージ設定**: テストやスタンドアロン検証のため、`AI_IMAGE_API_MCP_STORAGE_ROOT` 環境変数でキャッシュディレクトリを上書き可能。

## MCP サーバー側フォローアップ (2025-10-03 Bot Incident)
- **`readResource` 応答のバリデーション対応**
   - MCP SDK (`@modelcontextprotocol/sdk`) は `contents` の各要素に `uri` と `blob` (または `text`) を必須とする。`src/index.ts` の `ReadResourceRequest` ハンドラでは `blob` に Base64 エンコード済みPNG、`mimeType` に `image/png` を必ず設定すること。
   - レコード情報のメタテキストは別エントリ (`mimeType: text/plain`) として返却し、`uri` を同一に揃える。Zod の `invalid_type` エラーを確実に解消する。
- **リソース URI プレフィックスの整合性**
   - 現行実装は `resource://ai-image-api/image/<uuid>` を返却し、XMPP ボット側は `ai-image` サーバーIDにルーティングするキャッシュを保持。URI プレフィックスを変更する場合は、履歴互換性を考慮しボットチームと事前調整する。
- **HTTP Upload 連携の有効化**
   - ボットが `blob` を受け取ると HTTP Upload による公開URL化を自動試行。`XMPP_HTTP_UPLOAD_JID` / `XMPP_HTTP_UPLOAD_MAX_BYTES` が未設定の場合は「not configured」ログで終了するため、外部共有要求のある環境では確実に設定する。

## 検証フローの推奨手順
1. MCP サーバーをローカルで起動 (`npm start` もしくは `node dist/index.js`) し、`readResource` のレスポンスが上記スキーマに合致するか確認。
2. XMPP ボットを再起動 (`npm run start:pm2`) し、画像生成会話を開始。
3. `openai-xmpp-bot/logs/out.log` にて `resource://` URI が HTTPS へ書き換えられていることを確認。

## 追加タスク候補 (MCP側)
- [x] 生成・キャプション結果の `image_token` ハンドリング実装。
- [ ] ImageStore メタ (`metadata.files.image` 等) を用いた省メモリ転送ロジックの整備。
- [ ] キャプションAPIのレスポンス変更に合わせたパーサ更新。
- [x] `readResource` スキーマ検証ユニットテストの追加。（`npm test` で `tests/readResourceSchema.test.ts` を実行）
- [ ] XMPP ボットとの URI プレフィックス整合性を確認する回帰テスト整備。
- [ ] HTTP Upload 環境変数の設定手順を README に追記。

## 参考
- プロジェクト計画: `~/ai-image-api/docs/image-token-workflow-plan.md`
- ImageStore仕様: `~/ai-image-api/job_manager/image_store.py`
- テスト事例: `~/ai-image-api/tests/job_manager/test_api_job_result.py`, `test_api_image_caption.py`
