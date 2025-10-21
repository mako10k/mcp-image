import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';

export interface ImageRecord {
  id: string;
  filename: string;
  prompt: string;
  model: string;
  createdAt: string;
  params: Record<string, unknown>;
  imageToken?: string;
  metadata?: Record<string, unknown>;
  downloadUrl?: string;
  mimeType?: string;
}

export const RESOURCE_URI_PREFIX = 'resource://ai-image-api/image/';

const STORAGE_ROOT = (() => {
  const override = process.env.AI_IMAGE_API_MCP_STORAGE_ROOT;
  if (override && override.trim().length > 0) {
    return path.resolve(override.trim());
  }
  return path.join(os.homedir(), '.cache', 'ai-image-api-mcp');
})();
const IMAGE_DIR = path.join(STORAGE_ROOT, 'images');
const METADATA_FILE = path.join(STORAGE_ROOT, 'metadata.json');
const DEFAULT_PERMISSIONS = 0o700;

async function ensureStorageDirectories(): Promise<void> {
  await fs.mkdir(IMAGE_DIR, { recursive: true, mode: DEFAULT_PERMISSIONS });
}

async function readMetadata(): Promise<ImageRecord[]> {
  try {
    const data = await fs.readFile(METADATA_FILE, 'utf-8');
    const parsed = JSON.parse(data) as ImageRecord[];
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return [];
  } catch (error: any) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return [];
    }
    throw error;
  }
}

async function writeMetadata(records: ImageRecord[]): Promise<void> {
  await ensureStorageDirectories();
  const contents = JSON.stringify(records, null, 2);
  await fs.writeFile(METADATA_FILE, contents, { encoding: 'utf-8', mode: DEFAULT_PERMISSIONS });
}

export interface SaveImageInfo {
  prompt: string;
  model: string;
  params: Record<string, unknown>;
  imageToken?: string;
  metadata?: Record<string, unknown>;
  downloadUrl?: string;
  mimeType?: string;
}

export async function saveImage(
  base64Data: string,
  info: SaveImageInfo
): Promise<ImageRecord> {
  await ensureStorageDirectories();

  const id = uuidv4();
  const filename = `${id}.png`;
  const filePath = path.join(IMAGE_DIR, filename);
  const buffer = Buffer.from(base64Data, 'base64');

  await fs.writeFile(filePath, buffer, { mode: 0o600 });

  const record: ImageRecord = {
    id,
    filename,
    prompt: info.prompt,
    model: info.model,
    params: info.params,
    createdAt: new Date().toISOString(),
    imageToken: info.imageToken,
    metadata: info.metadata,
    downloadUrl: info.downloadUrl,
    mimeType: info.mimeType ?? 'image/png',
  };

  const records = await readMetadata();
  records.unshift(record);
  await writeMetadata(records);

  return record;
}

export async function listImages(): Promise<ImageRecord[]> {
  const records = await readMetadata();
  return records;
}

export async function getImageRecord(id: string): Promise<ImageRecord | undefined> {
  const records = await readMetadata();
  return records.find((record) => record.id === id);
}

export async function getImageRecordByToken(imageToken: string): Promise<ImageRecord | undefined> {
  const records = await readMetadata();
  return records.find((record) => record.imageToken === imageToken);
}

export async function readImageBase64(record: ImageRecord): Promise<string> {
  const filePath = path.join(IMAGE_DIR, record.filename);
  const buffer = await fs.readFile(filePath);
  return buffer.toString('base64');
}

export function getResourceUri(id: string): string {
  return `${RESOURCE_URI_PREFIX}${id}`;
}
