import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const TMP_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-image-mcp-e2e-'));
process.env.AI_IMAGE_API_MCP_STORAGE_ROOT = TMP_ROOT;

const RUN_EXTENDED = process.env.MCP_IMAGE_RUN_EXTENDED === '1';

const ONE_BY_ONE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

// Import MCP server and storage modules
const { AiImageMcpServer } = await import('../src/index.js');
const storage = await import('../src/storage.js');

// Create a single AiImageApiClient instance that will be used for all operations
// This ensures all API calls (generation, retrieval, search) use the same JOBAPI endpoint
const clientModule = await import('../src/client.js');
const client = new clientModule.AiImageApiClient();

// Create MCP server instance for handler testing
const server = new AiImageMcpServer();

let generatedToken: string = '';
let generatedId: string = '';
let generatedPrompt = 'E2E test cat, vector, pink';

// Helper: Save generated image to local storage for later retrieval tests
async function saveGeneratedImage(result: any, prompt: string, model: string) {
  if (!result.image_base64) {
    console.warn('No image_base64 in result, skipping local save');
    return null;
  }
  
  const record = await storage.saveImage(result.image_base64, {
    prompt: prompt,
    model: model,
    params: result.used_params || {},
    imageToken: result.image_token,
    metadata: result.metadata,
    downloadUrl: result.download_url,
    mimeType: result.mime_type || 'image/png',
  });
  
  return record;
}

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
  
  // Save to local storage for later retrieval tests
  const record = await saveGeneratedImage(result, generatedPrompt, 'dreamshaper8');
  if (record) {
    generatedId = record.id;
  }
});

// 2. generate_image 異常系（空プロンプト）
test('generate_image: invalid prompt', async () => {
  await assert.rejects(
    () => client.generateImage({ prompt: '', model: 'dreamshaper8' }),
    /422|prompt|required|min_length/i  // API側で422エラーが返ることを確認
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
  
  // Save to local storage
  await saveGeneratedImage(genResult, result.prompt, 'dreamshaper8');
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

test('caption_image handler: normal', { skip: !RUN_EXTENDED }, async () => {
  assert.ok(generatedToken, 'generated token must be set before caption test');
  const response = await (server as any).handleCaptionImage({ image_token: generatedToken });
  assert.ok(Array.isArray(response.content), 'content should be an array');
  const textEntry = response.content.find((entry: any) => entry.type === 'text');
  assert.ok(textEntry, 'caption response should include text entry');
  const payload = JSON.parse(textEntry.text);
  assert.ok(typeof payload.caption === 'string' && payload.caption.length > 0, 'caption should be non-empty');
  assert.ok(payload.image_token, 'payload should include image_token');
});

test('upscale_image handler: scale 2', async () => {
  const response = await (server as any).handleUpscaleImage({ image_token: generatedToken, scale: 2, poll_timeout_seconds: 600 });
  assert.ok(Array.isArray(response.content), 'content should be array');
  const jsonEntry = response.content.find((entry: any) => entry.type === 'text');
  assert.ok(jsonEntry, 'upscale response should include JSON entry');
  const payload = JSON.parse(jsonEntry.text);
  assert.ok(payload.image_token, 'upscale payload should include image_token');
  assert.equal(payload.used_params.scale, 2);
});

test('image_to_image handler: synchronous', { skip: !RUN_EXTENDED }, async () => {
  const resource = storage.getResourceUri(generatedId);
  const response = await (server as any).handleImageToImage({
    resource_uri: resource,
    prompt: 'stylized minimal cat sketch',
    steps: 10,
    strength: 0.6,
  });
  assert.ok(Array.isArray(response.content), 'content should be array');
  const jsonEntry = response.content.find((entry: any) => entry.type === 'text');
  assert.ok(jsonEntry, 'img2img response should include JSON entry');
  const payload = JSON.parse(jsonEntry.text);
  assert.ok(payload.image_token, 'img2img payload should include image_token');
  assert.equal(payload.prompt, 'stylized minimal cat sketch');
});

test('store_image_from_url handler: fallback upload', async () => {
  const pngBuffer = Buffer.from(ONE_BY_ONE_PNG_BASE64, 'base64');
  const httpServer = createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': pngBuffer.length,
    });
    res.end(pngBuffer);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });

  try {
    const address = httpServer.address() as AddressInfo;
    const imageUrl = `http://127.0.0.1:${address.port}/test.png`;
    const response = await (server as any).handleStoreImageFromUrl({
      image_url: imageUrl,
      filename: 'fallback-test.png',
    });

    assert.ok(Array.isArray(response.content), 'content should be array');
    const textEntry = response.content.find((entry: any) => entry.type === 'text');
    assert.ok(textEntry, 'store_image_from_url should include JSON entry');
    const payload = JSON.parse(textEntry.text);
    assert.ok(payload.image_token, 'payload should include image_token');
    assert.equal(payload.fallback_upload_used, true, 'fallback upload should be flagged');

    const imageEntry = response.content.find((entry: any) => entry.type === 'image');
    assert.ok(imageEntry, 'store_image_from_url should include image content');
    assert.equal(imageEntry.mimeType, 'image/png');
  } finally {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});

// 後始末
process.on('exit', async () => {
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
});
