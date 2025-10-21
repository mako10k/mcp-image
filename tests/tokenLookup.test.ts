import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';

import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const ONE_BY_ONE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

test('getImageRecordByToken returns the correct record', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-image-mcp-token-test-'));
  process.env.AI_IMAGE_API_MCP_STORAGE_ROOT = tmpRoot;

  try {
    const storage = await import('../src/storage.js');

    // Save image with a token
    const testToken = 'test-token-abc123';
    await storage.saveImage(ONE_BY_ONE_PNG_BASE64, {
      prompt: 'token lookup test',
      model: 'test-model',
      params: {},
      imageToken: testToken,
      metadata: { test: true },
      downloadUrl: 'https://example.com/image.png',
      mimeType: 'image/png',
    });

    // Retrieve by token
    const record = await storage.getImageRecordByToken(testToken);

    assert.ok(record, 'Record should be found');
    assert.equal(record.imageToken, testToken);
    assert.equal(record.prompt, 'token lookup test');
    assert.equal(record.model, 'test-model');
    assert.equal(record.downloadUrl, 'https://example.com/image.png');
    assert.deepEqual(record.metadata, { test: true });

    // Verify not found for non-existent token
    const notFound = await storage.getImageRecordByToken('non-existent-token');
    assert.equal(notFound, undefined);

  } finally {
    delete process.env.AI_IMAGE_API_MCP_STORAGE_ROOT;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('handleGetImageByToken returns expected payload', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-image-mcp-handler-test-'));
  process.env.AI_IMAGE_API_MCP_STORAGE_ROOT = tmpRoot;

  try {
    const { AiImageMcpServer } = await import('../src/index.js');
    const storage = await import('../src/storage.js');

    const server = new AiImageMcpServer();

    const testToken = 'handler-test-token-xyz';
    await storage.saveImage(ONE_BY_ONE_PNG_BASE64, {
      prompt: 'handler token test',
      model: 'handler-model',
      params: {},
      imageToken: testToken,
      metadata: { source: 'unit-test' },
      downloadUrl: 'https://example.com/handler.png',
      mimeType: 'image/png',
    });

    const response = await (server as any).handleGetImageByToken({ image_token: testToken });

    assert.ok(Array.isArray(response.content), 'content should be an array');
    assert.ok(response.content.length >= 2, 'content should include image and text entries');

    const imageEntry = response.content.find((c: any) => c.type === 'image');
    assert.ok(imageEntry, 'should include image entry');
    assert.equal(imageEntry.mimeType, 'image/png');
    assert.ok(typeof imageEntry.data === 'string' && imageEntry.data.length > 0);

    const textEntry = response.content.find((c: any) => c.type === 'text' && c.text.includes('Image Token'));
    assert.ok(textEntry, 'should include summary text entry');
    assert.match(textEntry.text, new RegExp(testToken));

  } finally {
    delete process.env.AI_IMAGE_API_MCP_STORAGE_ROOT;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
