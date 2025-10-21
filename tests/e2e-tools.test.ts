import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';

import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const TMP_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-image-mcp-e2e-'));
process.env.AI_IMAGE_API_MCP_STORAGE_ROOT = TMP_ROOT;

const { AiImageMcpServer } = await import('../src/index.js');
const storage = await import('../src/storage.js');
const clientModule = await import('../src/client.js');
const client = new clientModule.AiImageApiClient();

let generatedToken: string = '';
let generatedId: string = '';
let generatedPrompt = 'E2E test cat, vector, pink';

// 1. generate_image 正常系

test('generate_image: normal', async () => {
  const result = await client.generateImage({
    prompt: generatedPrompt,
    model: 'dreamshaper8',
    width: 512,
    height: 512,
    steps: 10,
    guidance_scale: 7.5,
    include_base64: true,
    include_metadata: true,
  });
  assert.ok(result.image_token, 'image_token should be present');
  assert.ok(result.image_base64, 'image_base64 should be present');
  generatedToken = result.image_token;
});

// 2. generate_image 異常系（空プロンプト）
test('generate_image: invalid prompt', async () => {
  await assert.rejects(
    () => client.generateImage({ prompt: '', model: 'dreamshaper8' }),
    /prompt.*required/
  );
});

// 3. optimize_and_generate_image 正常系

test('optimize_and_generate_image: normal', async () => {
  const result = await client.optimizeParameters({ query: generatedPrompt });
  assert.ok(result.prompt, 'optimized prompt should be present');
  // generation_overrides
  const genResult = await client.generateImage({
    prompt: result.prompt,
    model: 'dreamshaper8',
    width: 512,
    height: 512,
    steps: 10,
    guidance_scale: 7.5,
    include_base64: true,
    include_metadata: true,
  });
  assert.ok(genResult.image_token, 'image_token should be present');
});

// 4. get_available_models

test('get_available_models', async () => {
  const models = await client.getModels();
  assert.ok(models.models, 'models should be present');
  assert.ok(Object.keys(models.models).length > 0, 'at least one model');
});

// 5. get_model_detail 正常系

test('get_model_detail: normal', async () => {
  const models = await client.getModels();
  const firstModel = Object.keys(models.models)[0];
  const detail = await client.getModelDetail(firstModel);
  assert.ok(detail.model, 'model detail should be present');
});

// 6. get_model_detail 異常系

test('get_model_detail: invalid', async () => {
  await assert.rejects(
    () => client.getModelDetail('non-existent-model'),
    /Failed to get model detail/
  );
});

// 7. optimize_prompt 異常系

test('optimize_prompt: invalid', async () => {
  await assert.rejects(
    () => client.optimizeParameters({ query: '' }),
    /query.*required/
  );
});

// 8. search_images 正常系

test('search_images: normal', async () => {
  const images = await storage.listImages();
  assert.ok(Array.isArray(images), 'images should be array');
  assert.ok(images.length > 0, 'at least one image');
  generatedId = images[0].id;
});

// 9. search_images 異常系（limit, model, before/after）
test('search_images: filter', async () => {
  const images = await storage.listImages();
  const filtered = images.filter(img => img.model === 'dreamshaper8');
  assert.ok(filtered.length > 0, 'filtered images by model');
});

// 10. get_image_by_token 正常系

test('get_image_by_token: normal', async () => {
  const record = await storage.getImageRecordByToken(generatedToken);
  assert.ok(record, 'record should be found by token');
  assert.equal(record.prompt, generatedPrompt);
});

// 11. get_image_by_token 異常系

test('get_image_by_token: invalid', async () => {
  const record = await storage.getImageRecordByToken('invalid-token-xyz');
  assert.equal(record, undefined);
});

// 12. リソース保存・取得・URI・メタ情報検証

test('resource: uri and metadata', async () => {
  const record = await storage.getImageRecord(generatedId);
  assert.ok(record, 'record should be found by id');
  const uri = storage.getResourceUri(record.id);
  assert.ok(uri.startsWith('resource://ai-image-api/image/'), 'resource URI format');
  assert.ok(record.metadata, 'metadata should be present');
});

// 後始末
process.on('exit', async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});
