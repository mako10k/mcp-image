import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';

import dotenv from 'dotenv';
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const ONE_BY_ONE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Yfzi2cAAAAASUVORK5CYII=';

function ensureNoUndefinedFields(entry: Record<string, unknown>) {
  for (const [key, value] of Object.entries(entry)) {
    assert.notStrictEqual(
      value,
      undefined,
      `Expected property "${key}" to be defined`
    );
  }
}

test('readResource returns schema-friendly payload with blob and text entries', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-image-mcp-test-'));
  process.env.AI_IMAGE_API_MCP_STORAGE_ROOT = tmpRoot;

  try {
    const { AiImageMcpServer } = await import('../src/index.js');
    const storage = await import('../src/storage.js');

    const server = new AiImageMcpServer();

    const record = await storage.saveImage(ONE_BY_ONE_PNG_BASE64, {
      prompt: 'unit test prompt',
      model: 'unit-test-model',
      params: {},
      imageToken: 'test-token-123',
      metadata: { files: { image: 'images/test.png' } },
      downloadUrl: 'https://example.com/test.png',
      mimeType: 'image/png',
    });

    const resourceUri = storage.getResourceUri(record.id);
    const response = await (server as any).buildReadResourceResponse(resourceUri);

    assert.ok(Array.isArray(response.contents), 'contents should be an array');
    assert.equal(response.contents.length, 2, 'contents should include image blob and text metadata');

    const blobEntry = response.contents[0] as Record<string, unknown>;
    const textEntry = response.contents[1] as Record<string, unknown>;

    ensureNoUndefinedFields(blobEntry);
    ensureNoUndefinedFields(textEntry);

    assert.equal(blobEntry.uri, resourceUri);
    assert.equal(blobEntry.mimeType, 'image/png');
    assert.ok(typeof blobEntry.blob === 'string' && (blobEntry.blob as string).length > 0);
    assert.equal(blobEntry.downloadUrl, 'https://example.com/test.png');

  assert.equal(textEntry.uri, resourceUri);
  assert.equal(textEntry.mimeType, 'application/json');
  assert.ok(typeof textEntry.text === 'string');
  const meta = JSON.parse(textEntry.text as string);
  assert.equal(meta.image_token, 'test-token-123');
  assert.equal(meta.model, 'unit-test-model');
  assert.equal(meta.prompt, 'unit test prompt');
  } finally {
    delete process.env.AI_IMAGE_API_MCP_STORAGE_ROOT;
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
