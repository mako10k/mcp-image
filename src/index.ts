#!/usr/bin/env node
/**
 * AI Image Generation API MCP Server
 *
 * This server proxies requests to the AI image generation APIs deployed on Modal.com
 * and exposes them through the MCP protocol.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { AiImageApiClient } from './client.js';
import {
  ImageGenerationParams,
  ImageSearchParams,
  OptimizeAndGenerateRequest,
  OptimizeParametersRequest,
  Txt2ImgRequest,
  ImageCaptionRequest,
  ImageCaptionResponse,
  UpscaleRequest,
  UpscaleJobStatusResponse,
  JobResultResponse,
  ImageToImageJobRequest,
  ImageToImageJobResponse,
  ImageToImageJobCreationResponse,
  ImageUrlUploadRequest,
  ImageUploadResponse,
  ImageMetadataPatch,
  ImageUploadRequest,
} from './types.js';
import {
  saveImage,
  listImages,
  getImageRecord,
  getImageRecordByToken,
  readImageBase64,
  getResourceUri,
  RESOURCE_URI_PREFIX,
  ImageRecord,
} from './storage.js';

interface ImageReferenceInput {
  resource_uri?: unknown;
  image_token?: unknown;
  image_base64?: unknown;
}

interface ResolvedImageReference {
  imageToken?: string;
  record?: ImageRecord;
  directBase64?: string;
  source: 'resource_uri' | 'image_token' | 'image_base64';
}

export class AiImageMcpServer {
  private server: Server;
  private apiClient: AiImageApiClient | null = null;
  private configWarningShown = false;

  constructor() {
    this.server = new Server(
      {
        name: 'ai-image-api-mcp-server',
        version: '1.0.3',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.setupToolHandlers();
    this.setupResourceHandlers();
    this.setupErrorHandling();
    this.warnIfConfigMissing();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers(): void {
    // Provide tool list
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'generate_image',
            description: 'Low-level direct image generation tool. Only use this when you need precise control over specific parameters or want to bypass optimization entirely. For most image generation needs, use optimize_and_generate_image instead for better results.',
            inputSchema: {
              type: 'object',
              properties: {
                prompt: {
                  type: 'string',
                  description: 'Natural language prompt for image generation',
                },
                model: {
                  type: 'string',
                  description: 'Model name used by the Modal text-to-image function',
                },
                negative_prompt: {
                  type: 'string',
                  description: 'Negative prompt used to suppress unwanted concepts',
                },
                guidance_scale: {
                  type: 'number',
                  description: 'Classifier-Free Guidance scale value',
                },
                steps: {
                  type: 'integer',
                  description: 'Number of diffusion steps',
                  minimum: 1,
                },
                width: {
                  type: 'integer',
                  minimum: 256,
                  maximum: 2048,
                  multipleOf: 64,
                  description: 'Output image width (multiple of 64, max 2048, 1024 or less recommended)',
                },
                height: {
                  type: 'integer',
                  minimum: 256,
                  maximum: 2048,
                  multipleOf: 64,
                  description: 'Output image height (multiple of 64, max 2048, 1024 or less recommended)',
                },
                seed: {
                  type: 'integer',
                  description: 'Random seed for deterministic generations (auto if omitted)',
                },
                scheduler: {
                  type: 'string',
                  description: 'Scheduler name (e.g., euler, dpm++)',
                },
              },
              required: ['prompt'],
              additionalProperties: true,
            },
          },
          {
            name: 'get_available_models',
            description: 'Retrieve the list of available image generation models. Consider using optimize_and_generate_image with target_model parameter instead, which automatically selects the best model and optimizes the prompt.',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'get_model_detail',
            description: 'Fetch detailed information for a specific model. For most use cases, optimize_and_generate_image automatically selects and configures the best model, making manual model selection unnecessary.',
            inputSchema: {
              type: 'object',
              properties: {
                model_name: {
                  type: 'string',
                  description: 'Model name to look up',
                },
              },
              required: ['model_name'],
            },
          },
          {
            name: 'optimize_prompt',
            description: 'Low-level prompt optimization tool that only returns optimization suggestions without generating images. Use optimize_and_generate_image instead for the complete workflow that both optimizes and generates the image in one step.',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Prompt or description to optimize',
                },
                target_model: {
                  type: 'string',
                  description: 'Preferred model for optimization (optional)',
                },
              },
              required: ['query'],
            },
          },
          {
            name: 'optimize_and_generate_image',
            description: 'RECOMMENDED: Primary image generation tool that automatically optimizes prompts and generates high-quality images in a single call. This should be your first choice for all image generation tasks as it provides the best results with minimal configuration.',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Prompt or description to optimize',
                },
                target_model: {
                  type: 'string',
                  description: 'Preferred model during optimization (optional)',
                },
                generation_overrides: {
                  type: 'object',
                  description: 'Overrides applied to the final image generation. Accepts the same keys as generate_image.',
                  additionalProperties: true,
                  properties: {
                    prompt: { type: 'string' },
                    model: { type: 'string' },
                    negative_prompt: { type: 'string' },
                    guidance_scale: { type: 'number' },
                    steps: { type: 'integer' },
                    width: { type: 'integer' },
                    height: { type: 'integer' },
                    seed: { type: 'integer' },
                    scheduler: { type: 'string' },
                  },
                },
              },
              required: ['query'],
              additionalProperties: true,
            },
          },
          {
            name: 'search_images',
            description: 'Search previously generated images from local cache. Use this to find and reuse existing images before generating new ones with optimize_and_generate_image.',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Keyword to match within prompts or generation parameters (partial match).',
                },
                model: {
                  type: 'string',
                  description: 'Filter results to images generated by the specified model.',
                },
                limit: {
                  type: 'integer',
                  minimum: 1,
                  maximum: 20,
                  default: 5,
                  description: 'Maximum number of images to return (1-20).',
                },
                before: {
                  type: 'string',
                  description: 'Only include images generated before this timestamp (ISO 8601).',
                },
                after: {
                  type: 'string',
                  description: 'Only include images generated at or after this timestamp (ISO 8601).',
                },
              },
            },
          },
          {
            name: 'get_image_by_token',
            description: 'Retrieve image metadata and content using an image_token. Returns the stored image record including base64 data, metadata, and download URL if available.',
            inputSchema: {
              type: 'object',
              properties: {
                image_token: {
                  type: 'string',
                  description: 'The image token returned by a previous generation request.',
                },
              },
              required: ['image_token'],
            },
          },
          {
            name: 'caption_image',
            description: 'Generate a natural language caption describing an existing image.',
            inputSchema: {
              type: 'object',
              properties: {
                resource_uri: {
                  type: 'string',
                  description: 'Resource URI referencing a cached image.'
                },
                image_token: {
                  type: 'string',
                  description: 'Existing Modal image token to caption.'
                },
                image_base64: {
                  type: 'string',
                  description: 'Base64-encoded image data (PNG/JPEG).'
                },
                image_url: {
                  type: 'string',
                  description: 'Direct image URL. Use store_image_from_url first if possible.'
                },
                prompt: {
                  type: 'string',
                  description: 'Optional additional prompt passed to the captioning model.'
                },
                max_new_tokens: {
                  type: 'integer',
                  minimum: 1,
                  maximum: 512,
                  description: 'Maximum caption length in tokens.'
                },
                temperature: {
                  type: 'number',
                  minimum: 0,
                  maximum: 2,
                  description: 'Sampling temperature.'
                },
                top_p: {
                  type: 'number',
                  minimum: 0,
                  maximum: 1,
                  description: 'Nucleus sampling top-p parameter.'
                },
                use_nucleus_sampling: {
                  type: 'boolean',
                  description: 'Whether to enable nucleus sampling.'
                },
                repetition_penalty: {
                  type: 'number',
                  minimum: 0.5,
                  maximum: 2,
                  description: 'Penalty applied to repeated tokens.'
                },
                model_id: {
                  type: 'string',
                  description: 'Specific captioning model ID to use.'
                },
                store_to_metadata: {
                  type: 'boolean',
                  description: 'If true, persist the caption into the Modal image metadata when possible.'
                }
              },
              additionalProperties: false,
            },
          },
          {
            name: 'upscale_image',
            description: 'Upscale an existing image using Modal’s upscale endpoint and return the higher-resolution result.',
            inputSchema: {
              type: 'object',
              properties: {
                resource_uri: {
                  type: 'string',
                  description: 'Resource URI referencing a cached image to upscale.'
                },
                image_token: {
                  type: 'string',
                  description: 'Modal image token to upscale.'
                },
                image_base64: {
                  type: 'string',
                  description: 'Base64-encoded image data. The server will upload this before upscaling.'
                },
                scale: {
                  type: 'integer',
                  minimum: 1,
                  maximum: 8,
                  description: 'Integer upscale factor (1-8).'
                },
                poll_timeout_seconds: {
                  type: 'integer',
                  minimum: 1,
                  maximum: 1800,
                  description: 'Maximum seconds to wait for the upscale job to finish (default 300).'
                },
                poll_interval_seconds: {
                  type: 'integer',
                  minimum: 1,
                  maximum: 60,
                  description: 'Polling interval in seconds while waiting for the job (default 5).'
                }
              },
              additionalProperties: false,
            },
          },
          {
            name: 'image_to_image',
            description: 'Generate a new image from an existing source image (img2img).',
            inputSchema: {
              type: 'object',
              properties: {
                resource_uri: {
                  type: 'string',
                  description: 'Resource URI referencing the source image.'
                },
                image_token: {
                  type: 'string',
                  description: 'Existing Modal image token for the source image.'
                },
                image_base64: {
                  type: 'string',
                  description: 'Base64-encoded source image. The server uploads this to obtain a token if needed.'
                },
                prompt: {
                  type: 'string',
                  description: 'Primary text prompt guiding the generation.'
                },
                negative_prompt: {
                  type: 'string',
                  description: 'Negative prompt to suppress concepts.'
                },
                model: {
                  type: 'string',
                  description: 'Model identifier (defaults to sd21).'
                },
                guidance_scale: {
                  type: 'number',
                  description: 'Classifier-free guidance scale.'
                },
                steps: {
                  type: 'integer',
                  minimum: 1,
                  description: 'Diffusion steps (default 20).'
                },
                width: {
                  type: 'integer',
                  minimum: 256,
                  maximum: 2048,
                  multipleOf: 64,
                  description: 'Output width in pixels (multiple of 64).'
                },
                height: {
                  type: 'integer',
                  minimum: 256,
                  maximum: 2048,
                  multipleOf: 64,
                  description: 'Output height in pixels (multiple of 64).'
                },
                seed: {
                  type: 'integer',
                  description: 'Random seed for deterministic results.'
                },
                strength: {
                  type: 'number',
                  minimum: 0,
                  maximum: 1,
                  description: 'Blend strength between source image and prompt (default 0.7).'
                },
                include_base64: {
                  type: 'boolean',
                  description: 'Whether to request base64 output directly from the sync endpoint (default true).'
                },
                async: {
                  type: 'boolean',
                  description: 'If true, enqueue the job and return job info instead of waiting.'
                },
                poll_timeout_seconds: {
                  type: 'integer',
                  minimum: 1,
                  maximum: 1800,
                  description: 'Maximum seconds to wait for async job completion when polling (default 600).'
                },
                poll_interval_seconds: {
                  type: 'integer',
                  minimum: 1,
                  maximum: 60,
                  description: 'Polling interval when async job polling is used (default 5).'
                }
              },
              required: ['prompt'],
              additionalProperties: false,
            },
          },
          {
            name: 'store_image_from_url',
            description: 'Fetch an image from a public URL, register it with Modal, and cache it locally.',
            inputSchema: {
              type: 'object',
              properties: {
                image_url: {
                  type: 'string',
                  description: 'Public HTTP/HTTPS URL of the image to import.'
                },
                source: {
                  type: 'string',
                  description: 'Source identifier stored alongside the image metadata.'
                },
                prompt: {
                  type: 'string',
                  description: 'Optional prompt metadata to attach to the stored image.'
                },
                negative_prompt: {
                  type: 'string',
                  description: 'Optional negative prompt metadata.'
                },
                parameters: {
                  type: 'object',
                  description: 'Arbitrary parameter metadata to store.'
                },
                derived_from: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'List of source image tokens this image derives from.'
                },
                tags: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Tags to store alongside the image.'
                },
                extra: {
                  type: 'object',
                  description: 'Additional metadata payload.'
                },
                filename: {
                  type: 'string',
                  description: 'Filename hint when storing the image.'
                },
                timeout: {
                  type: 'number',
                  minimum: 0,
                  description: 'Timeout in seconds for downloading the image.'
                },
                max_bytes: {
                  type: 'integer',
                  minimum: 1,
                  description: 'Maximum download size in bytes.'
                }
              },
              required: ['image_url'],
              additionalProperties: false,
            },
          },
        ],
      };
    });

    // Tool execution handler
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'generate_image':
            return await this.handleGenerateImage(args as unknown as ImageGenerationParams);

          case 'get_available_models':
            return await this.handleGetAvailableModels();

          case 'get_model_detail':
            return await this.handleGetModelDetail(args as unknown as { model_name: string });

          case 'optimize_prompt':
            return await this.handleOptimizePrompt(args as unknown as OptimizeParametersRequest);

          case 'optimize_and_generate_image':
            return await this.handleOptimizeAndGenerate(args as unknown as OptimizeAndGenerateRequest);

          case 'search_images':
            return await this.handleSearchImages(args as unknown as ImageSearchParams);

          case 'get_image_by_token':
            return await this.handleGetImageByToken(args as unknown as { image_token: string });

          case 'caption_image':
            return await this.handleCaptionImage(args as Record<string, unknown>);

          case 'upscale_image':
            return await this.handleUpscaleImage(args as Record<string, unknown>);

          case 'image_to_image':
            return await this.handleImageToImage(args as Record<string, unknown>);

          case 'store_image_from_url':
            return await this.handleStoreImageFromUrl(args as Record<string, unknown>);

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${name}`
            );
        }
      } catch (error) {
        if (error instanceof McpError) {
          throw error;
        }

        console.error(`Error in tool ${name}:`, error);
        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    });
  }

  private setupResourceHandlers(): void {
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const images = await listImages();

      const resources = images.map((image) => {
        const preview = image.prompt.length > 60
          ? `${image.prompt.slice(0, 57)}...`
          : image.prompt;
        return {
          uri: getResourceUri(image.id),
          mimeType: image.mimeType ?? 'image/png',
          name: `generated-${image.id}`,
          description: `${new Date(image.createdAt).toLocaleString()} | ${image.model} | ${preview}`,
        };
      });

      return {
        resources,
      };
    });

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      return this.buildReadResourceResponse(uri);
    });
  }

  private isConfigured(): boolean {
    const jobApiUrl = (
      process.env.JOB_API_SERVER_URL
      || process.env.JOBAPI_URL
      || process.env.MODAL_JOB_API_URL
      || ''
    ).trim();

    return jobApiUrl.length > 0;
  }

  private warnIfConfigMissing(): void {
    if (!this.isConfigured() && !this.configWarningShown) {
      console.warn('[AI Image] Modal Job API URL is not configured. Set MODAL_JOB_API_URL (or JOB_API_SERVER_URL/JOBAPI_URL) before invoking tools.');
      this.configWarningShown = true;
    }
  }

  private getApiClient(): AiImageApiClient {
    if (this.apiClient) {
      return this.apiClient;
    }

    try {
      this.apiClient = new AiImageApiClient();
      return this.apiClient;
    } catch (error) {
      this.warnIfConfigMissing();

      const message = error instanceof Error ? error.message : 'Unknown configuration error';
      console.error('[AI Image] Failed to initialize Modal Job API client:', message);

      throw new McpError(
        ErrorCode.InternalError,
        'AI Image MCP server is not configured correctly. Ensure MODAL_JOB_API_URL (or JOB_API_SERVER_URL/JOBAPI_URL) is set before using this tool.'
      );
    }
  }

  private async buildReadResourceResponse(uri: string) {
    const resourceId = this.extractResourceId(uri);

    const record = await getImageRecord(resourceId);
    if (!record) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Resource not found: ${uri}`
      );
    }

    let base64: string | undefined;
    try {
      base64 = await readImageBase64(record);
    } catch (error) {
      console.warn('[AI Image] Failed to read cached image binary', {
        resourceId,
        err: error instanceof Error ? error.message : error,
      });
    }

    if (typeof base64 !== 'string' || base64.trim().length === 0) {
      throw new McpError(
        ErrorCode.InternalError,
        'Image binary is unavailable. Regenerate the image or configure image_token download handling.'
      );
    }

    const mimeType = record.mimeType ?? 'image/png';
    const description = `${new Date(record.createdAt).toISOString()} | ${record.model}`;

    const metadataSnippet = record.metadata
      ? JSON.stringify(record.metadata).slice(0, 400)
      : undefined;

    const textLines = [
      `Generated: ${record.createdAt}`,
      `Model: ${record.model}`,
      `Prompt: ${record.prompt}`,
    ];

    if (record.imageToken) {
      textLines.push(`Image Token: ${record.imageToken}`);
    }
    if (record.downloadUrl) {
      textLines.push(`Download URL: ${record.downloadUrl}`);
    }
    if (metadataSnippet) {
      textLines.push(`Metadata (truncated): ${metadataSnippet}`);
    }

    const primaryContent: Record<string, unknown> = {
      uri,
      blob: base64,
      mimeType,
      description,
    };

    if (record.downloadUrl) {
      primaryContent['downloadUrl'] = record.downloadUrl;
    }

    return {
      contents: [
        primaryContent,
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify({
            created_at: record.createdAt,
            model: record.model,
            prompt: record.prompt,
            image_token: record.imageToken,
            download_url: record.downloadUrl,
            metadata: record.metadata,
          }),
        },
      ],
    };
  }

  private extractResourceId(uri: string): string {
    if (!uri.startsWith(RESOURCE_URI_PREFIX)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Unsupported resource URI: ${uri}`
      );
    }

    const resourceId = uri.slice(RESOURCE_URI_PREFIX.length).trim();
    if (!resourceId) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Resource ID is missing'
      );
    }

    return resourceId;
  }

  private async handleSearchImages(params: ImageSearchParams = {}) {
    const {
      query,
      model,
      limit,
      before,
      after,
    } = params;

    const parsedLimit = limit !== undefined ? Number(limit) : undefined;
    const normalizedLimit = Number.isFinite(parsedLimit)
      ? Math.min(Math.max(Math.floor(parsedLimit as number), 1), 20)
      : 5;

    const beforeTime = before ? Date.parse(before) : undefined;
    if (before && Number.isNaN(beforeTime)) {
      throw new McpError(ErrorCode.InvalidRequest, `Invalid "before" timestamp: ${before}`);
    }

    const afterTime = after ? Date.parse(after) : undefined;
    if (after && Number.isNaN(afterTime)) {
      throw new McpError(ErrorCode.InvalidRequest, `Invalid "after" timestamp: ${after}`);
    }

    let images = await listImages();

    const queryLower = query?.trim().toLowerCase();
    if (queryLower) {
      images = images.filter((record) => {
        const promptMatch = record.prompt.toLowerCase().includes(queryLower);
        const paramsMatch = JSON.stringify(record.params ?? {}).toLowerCase().includes(queryLower);
        return promptMatch || paramsMatch;
      });
    }

    const modelLower = model?.trim().toLowerCase();
    if (modelLower) {
      images = images.filter((record) => record.model.toLowerCase() === modelLower);
    }

    if (afterTime !== undefined) {
      images = images.filter((record) => Date.parse(record.createdAt) >= afterTime);
    }

    if (beforeTime !== undefined) {
      images = images.filter((record) => Date.parse(record.createdAt) <= beforeTime);
    }

    images.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

    const limited = images.slice(0, normalizedLimit);

    const results = limited.map((record) => ({
      id: record.id,
      resource_uri: getResourceUri(record.id),
      created_at: record.createdAt,
      model: record.model,
      prompt: record.prompt,
      mime_type: record.mimeType ?? 'image/png',
      image_token: record.imageToken,
      download_url: record.downloadUrl,
      metadata: record.metadata,
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            total_matches: images.length,
            returned: results.length,
            results,
          }),
        },
      ],
    };
  }

  /**
   * Handle image retrieval by token
   */
  private async handleGetImageByToken(params: { image_token: string }) {
    const { image_token } = params;

    if (!image_token || typeof image_token !== 'string' || image_token.trim().length === 0) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        '"image_token" is required and must be a non-empty string.'
      );
    }

    const record = await getImageRecordByToken(image_token.trim());

    if (!record) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `No image found with token: ${image_token}`
      );
    }

    let base64: string | undefined;
    try {
      base64 = await readImageBase64(record);
    } catch (error) {
      console.warn('[AI Image] Failed to read image binary for token', {
        imageToken: image_token,
        err: error instanceof Error ? error.message : error,
      });
    }

    const resourceUri = getResourceUri(record.id);
    const mimeType = record.mimeType ?? 'image/png';

    const responseData: Record<string, unknown> = {
      image_token: record.imageToken,
      resource_uri: resourceUri,
      mime_type: mimeType,
      prompt: record.prompt,
      model: record.model,
      created_at: record.createdAt,
    };

    if (record.metadata) {
      responseData.metadata = record.metadata;
    }

    if (record.downloadUrl) {
      responseData.download_url = record.downloadUrl;
    }

    if (base64 && base64.length > 0) {
      responseData.image_base64 = base64;
    }

    const content: Array<Record<string, unknown>> = [];

    if (base64 && base64.length > 0) {
      content.push({
        type: 'image',
        data: base64,
        mimeType,
      });
    }

    content.push({
      type: 'text',
      text: JSON.stringify(responseData),
    });

    return { content };
  }

  /**
   * Handle image generation
   */
  private async handleGenerateImage(params: ImageGenerationParams) {
    if (!params || typeof params !== 'object') {
      throw new McpError(ErrorCode.InvalidRequest, 'Request body must be an object.');
    }

    const promptValue = typeof params.prompt === 'string' ? params.prompt.trim() : '';
    if (!promptValue) {
      throw new McpError(ErrorCode.InvalidRequest, '"prompt" is required and must be a non-empty string.');
    }

    const sanitized: Txt2ImgRequest = {
      ...params,
      prompt: promptValue,
    };

    const legacyKeys = ['quality_tier', 'size_preference', 'style_hint', 'experimental'];
    for (const key of legacyKeys) {
      if (key in sanitized) {
        delete (sanitized as Record<string, unknown>)[key];
      }
    }

    const asOptionalNumber = (value: unknown, field: string): number | undefined => {
      if (value === undefined || value === null || value === '') {
        return undefined;
      }

      if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
          throw new McpError(ErrorCode.InvalidRequest, `${field} must be a finite number.`);
        }
        return value;
      }

      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        throw new McpError(ErrorCode.InvalidRequest, `${field} must be a finite number.`);
      }
      return parsed;
    };

    const asOptionalInteger = (value: unknown, field: string): number | undefined => {
      const numeric = asOptionalNumber(value, field);
      if (numeric === undefined) {
        return undefined;
      }
      if (!Number.isInteger(numeric)) {
        throw new McpError(ErrorCode.InvalidRequest, `${field} must be an integer value.`);
      }
      return numeric;
    };

    const normalizeDimension = (value: unknown, field: 'width' | 'height'): number | undefined => {
      const numeric = asOptionalInteger(value, field);
      if (numeric === undefined) {
        return undefined;
      }

      const MIN_DIMENSION = 256;
      const MAX_DIMENSION = 2048;

      if (numeric % 64 !== 0) {
        throw new McpError(ErrorCode.InvalidRequest, `${field} must be a multiple of 64.`);
      }
      if (numeric < MIN_DIMENSION) {
        throw new McpError(ErrorCode.InvalidRequest, `${field} must be at least ${MIN_DIMENSION}px.`);
      }
      if (numeric > MAX_DIMENSION) {
        throw new McpError(ErrorCode.InvalidRequest, `${field} must not exceed ${MAX_DIMENSION}px.`);
      }

      return numeric;
    };

    const rawRecord = params as Record<string, unknown>;

    const guidanceScale = asOptionalNumber(rawRecord['guidance_scale'], 'guidance_scale');
    if (guidanceScale !== undefined) {
      sanitized.guidance_scale = guidanceScale;
    } else {
      delete sanitized.guidance_scale;
    }

    const steps = asOptionalInteger(rawRecord['steps'], 'steps');
    if (steps !== undefined) {
      sanitized.steps = steps;
    } else {
      delete sanitized.steps;
    }

    const width = normalizeDimension(rawRecord['width'], 'width');
    if (width !== undefined) {
      sanitized.width = width;
    } else {
      delete sanitized.width;
    }

    const height = normalizeDimension(rawRecord['height'], 'height');
    if (height !== undefined) {
      sanitized.height = height;
    } else {
      delete sanitized.height;
    }

    const seed = asOptionalInteger(rawRecord['seed'], 'seed');
    if (seed !== undefined) {
      sanitized.seed = seed;
    } else {
      delete sanitized.seed;
    }

    if (sanitized.negative_prompt !== undefined) {
      const negativePrompt = String(sanitized.negative_prompt).trim();
      sanitized.negative_prompt = negativePrompt.length > 0 ? negativePrompt : undefined;
    }

    if (sanitized.scheduler !== undefined) {
      const scheduler = String(sanitized.scheduler).trim();
      sanitized.scheduler = scheduler.length > 0 ? scheduler : undefined;
    }

    const modelValue = sanitized.model;
    if (modelValue === undefined || modelValue === null || String(modelValue).trim() === '') {
      sanitized.model = 'dreamshaper8';
    } else if (typeof modelValue !== 'string') {
      sanitized.model = String(modelValue).trim();
    } else {
      sanitized.model = modelValue.trim();
    }

    sanitized.include_base64 = true;
    sanitized.include_metadata = true;

    console.error(`[AI Image] Generating image via Modal | model=${sanitized.model ?? 'default'} prompt="${promptValue}"`);

    const response = await this.getApiClient().generateImage(sanitized);
    const usedParamsRecord = (response.used_params ?? {}) as Record<string, unknown>;

    let base64Payload = typeof response.image_base64 === 'string'
      ? response.image_base64.trim()
      : '';

    if (!base64Payload && response.download_url) {
      console.warn('[AI Image] Modal response omitted image_base64; download_url provided instead.', {
        downloadUrl: response.download_url,
      });
    }

    if (!base64Payload) {
      throw new McpError(
        ErrorCode.InternalError,
        'Modal AI Image API did not return image_base64. Ensure include_base64=true or configure token download handling.'
      );
    }

    const metadataRecord = (response.metadata ?? {}) as Record<string, unknown>;

    const record = await saveImage(base64Payload, {
      prompt: sanitized.prompt,
      model: typeof sanitized.model === 'string' && sanitized.model.length > 0
        ? sanitized.model
        : (typeof usedParamsRecord['model'] === 'string' ? (usedParamsRecord['model'] as string) : 'unknown'),
      params: {
        request: sanitized,
        used_params: usedParamsRecord,
      },
      imageToken: response.image_token,
      metadata: metadataRecord,
      downloadUrl: response.download_url,
      mimeType: response.mime_type ?? 'image/png',
    });

    const resourceUri = getResourceUri(record.id);

    const formatValue = (value: unknown): string => {
      if (value === undefined) {
        return 'undefined';
      }
      if (value === null) {
        return 'null';
      }
      if (typeof value === 'string') {
        return value.length > 200 ? `${value.slice(0, 197)}...` : value;
      }
      if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
      }
      try {
        const serialized = JSON.stringify(value);
        return serialized.length > 200 ? `${serialized.slice(0, 197)}...` : serialized;
      } catch (error) {
        return String(value);
      }
    };

    const formatParameterSection = (data: Record<string, unknown>, maxEntries = 24) => {
      const entries = Object.entries(data).filter(([, value]) => value !== undefined);
      const limited = entries.slice(0, maxEntries);
      const lines = limited.map(([key, value]) => `- ${key}: ${formatValue(value)}`);
      const truncated = entries.length > limited.length;
      return { lines, truncated };
    };

    const requestSection = formatParameterSection(sanitized as Record<string, unknown>);
    const usedSection = formatParameterSection(usedParamsRecord);

    const truncationNotices: string[] = [];
    if (requestSection.truncated) {
      truncationNotices.push('Some request parameters were omitted because there were too many to display.');
    }
    if (usedSection.truncated) {
      truncationNotices.push('Some parameters reported by Modal were omitted because there were too many to display.');
    }

    const summaryParts = [
      'Image generation completed!',
      '',
      '**Request parameters:**',
      requestSection.lines.length ? requestSection.lines.join('\n') : '- (No additional parameters)',
      '',
      '**Parameters reported by Modal:**',
      usedSection.lines.length ? usedSection.lines.join('\n') : '- (Not provided in the response)',
      '',
      `**Resource URI:** ${resourceUri}`,
    ];

    summaryParts.push('', `**Image token:** ${response.image_token}`);

    if (response.download_url) {
      summaryParts.push(`**Download URL:** ${response.download_url}`);
    }

    if (truncationNotices.length > 0) {
      summaryParts.push('', ...truncationNotices.map((notice) => `Note: ${notice}`));
    }

    const jsonPayload = {
      image_token: response.image_token,
      resource_uri: resourceUri,
      mime_type: record.mimeType ?? 'image/png',
      download_url: response.download_url,
      prompt: record.prompt,
      model: record.model,
      created_at: record.createdAt,
      used_params: usedParamsRecord,
      metadata: metadataRecord,
    };

    return {
      content: [
        {
          type: 'image',
          data: base64Payload,
          mimeType: record.mimeType ?? 'image/png',
        },
        {
          type: 'text',
          text: JSON.stringify(jsonPayload),
        },
      ],
    };
  }

  /**
   * Retrieve the list of available models
   */
  private async handleGetAvailableModels() {
    console.error('[AI Image] Fetching available models');

    const result = await this.getApiClient().getModels();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result),
        },
      ],
    };
  }

  /**
   * Retrieve detailed information about a model
   */
  private async handleGetModelDetail(params: { model_name: string }) {
    const { model_name } = params;

    console.error(`[AI Image] Fetching model detail for: ${model_name}`);

    const result = await this.getApiClient().getModelDetail(model_name);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result),
        },
      ],
    };
  }

  private extractGenerationOverrides(params: OptimizeAndGenerateRequest): Partial<Txt2ImgRequest> {
    const overrides: Partial<Txt2ImgRequest> = {};
    const recognizedKeys: (keyof Txt2ImgRequest)[] = [
      'prompt',
      'model',
      'negative_prompt',
      'guidance_scale',
      'steps',
      'width',
      'height',
      'seed',
      'scheduler',
    ];
    const paramRecord = params as unknown as Record<string, unknown>;
    for (const key of recognizedKeys) {
      if (Object.prototype.hasOwnProperty.call(paramRecord, key)) {
        const value = paramRecord[key];
        if (value !== undefined) {
          overrides[key] = value as unknown;
        }
      }
    }

    if (params.generation_overrides && typeof params.generation_overrides === 'object') {
      for (const [key, value] of Object.entries(params.generation_overrides)) {
        overrides[key as keyof Txt2ImgRequest] = value as unknown;
      }
    }

    return overrides;
  }

  private applyGenerationOverrides(target: Txt2ImgRequest, overrides: Partial<Txt2ImgRequest>): void {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        continue;
      }

      if (value === null) {
        delete target[key];
        continue;
      }

      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed.length === 0) {
          delete target[key];
          continue;
        }
        target[key] = trimmed;
        continue;
      }

      target[key] = value as unknown;
    }
  }

  /**
   * Handle prompt optimization
   */
  private async handleOptimizePrompt(params: OptimizeParametersRequest) {
    const queryValue = typeof params.query === 'string' ? params.query.trim() : '';
    if (!queryValue) {
      throw new McpError(ErrorCode.InvalidRequest, '"query" is required and must be a non-empty string.');
    }

    const paramRecord = params as unknown as Record<string, unknown>;
    const normalizeModelValue = (value: unknown): string | undefined => {
      if (typeof value !== 'string') {
        return undefined;
      }
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    };

    const targetModelValue = normalizeModelValue(paramRecord['target_model']);
    const directModelValue = normalizeModelValue(params.model);
    const selectedModel = targetModelValue ?? directModelValue;

    console.error('[AI Image] Optimizing prompt: "%s" model=%s', queryValue, selectedModel ?? 'auto');

    const optimizeRequest: OptimizeParametersRequest = selectedModel
      ? { query: queryValue, model: selectedModel }
      : { query: queryValue };

    const result = await this.getApiClient().optimizeParameters(optimizeRequest);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result),
        },
      ],
    };
  }

  private async handleOptimizeAndGenerate(params: OptimizeAndGenerateRequest) {
    if (!params || typeof params !== 'object') {
      throw new McpError(ErrorCode.InvalidRequest, 'Request body must be an object.');
    }

    const queryValue = typeof params.query === 'string' ? params.query.trim() : '';
    if (!queryValue) {
      throw new McpError(ErrorCode.InvalidRequest, '"query" is required and must be a non-empty string.');
    }

    const normalizeModelValue = (value: unknown): string | undefined => {
      if (typeof value !== 'string') {
        return undefined;
      }
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    };

    const paramRecord = params as Record<string, unknown>;

    const targetModelValue = normalizeModelValue(paramRecord['target_model']);
    const directModelValue = normalizeModelValue(params.model ?? paramRecord['model']);

    const optimizeModel = targetModelValue ?? directModelValue;

    console.error('[AI Image] Optimize & Generate | query="%s" model=%s', queryValue, optimizeModel ?? 'auto');
    console.error('[AI Image] Note: This process involves two steps (optimization + generation) and may take up to 15 minutes total, especially on first connection to JOBAPI server');

    const optimizeRequest: OptimizeParametersRequest = optimizeModel
      ? { query: queryValue, model: optimizeModel }
      : { query: queryValue };

    const optimizeResult = await this.getApiClient().optimizeParameters(optimizeRequest);

    const mergedRecommendations: Record<string, unknown> = {
      ...(optimizeResult.recommended_params ?? {}),
      ...(optimizeResult.recommended_parameters ?? {}),
    };

    const basePrompt = typeof optimizeResult.prompt === 'string' && optimizeResult.prompt.trim().length > 0
      ? optimizeResult.prompt.trim()
      : queryValue;

    const generationParams: Txt2ImgRequest = {
      prompt: basePrompt,
    };

    if (typeof optimizeResult.negative_prompt === 'string' && optimizeResult.negative_prompt.trim().length > 0) {
      generationParams.negative_prompt = optimizeResult.negative_prompt.trim();
    }
    if (typeof optimizeResult.guidance_scale === 'number') {
      generationParams.guidance_scale = optimizeResult.guidance_scale;
    }
    if (typeof optimizeResult.steps === 'number') {
      generationParams.steps = optimizeResult.steps;
    }
    if (typeof optimizeResult.width === 'number') {
      generationParams.width = optimizeResult.width;
    }
    if (typeof optimizeResult.height === 'number') {
      generationParams.height = optimizeResult.height;
    }
    if (typeof optimizeResult.seed === 'number') {
      generationParams.seed = optimizeResult.seed;
    }

    const optimizedModel = typeof optimizeResult.model === 'string' ? optimizeResult.model.trim() : '';
    const suggestedModel = typeof optimizeResult.suggested_model === 'string' ? optimizeResult.suggested_model.trim() : '';
    if (optimizedModel.length > 0) {
      generationParams.model = optimizedModel;
    } else if (suggestedModel.length > 0) {
      generationParams.model = suggestedModel;
    }

    for (const [key, value] of Object.entries(mergedRecommendations)) {
      if (key === 'prompt') {
        continue;
      }

      if (value === undefined || value === null) {
        continue;
      }

      if (generationParams[key] === undefined) {
        generationParams[key] = value as unknown;
      }
    }

    const overrides = this.extractGenerationOverrides(params);
    this.applyGenerationOverrides(generationParams, overrides);

    const finalPrompt = typeof generationParams.prompt === 'string' ? generationParams.prompt.trim() : '';
    generationParams.prompt = finalPrompt.length > 0 ? finalPrompt : queryValue;

    const generationParamsSnapshot = JSON.parse(JSON.stringify(generationParams)) as Txt2ImgRequest;

    console.error('[AI Image] Optimization complete, now generating image with optimized parameters...');
    const generationResult = await this.handleGenerateImage(generationParams);

    const combinedContent = [
      ...generationResult.content,
      {
        type: 'text' as const,
        text: JSON.stringify({
          optimize_result: optimizeResult,
          applied_generation_params: generationParamsSnapshot,
        }),
      },
    ];

    return {
      content: combinedContent,
    };
  }

  private sanitizeOptionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private parseOptionalNumber(
    value: unknown,
    field: string,
    options?: { min?: number; max?: number }
  ): number | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      throw new McpError(ErrorCode.InvalidRequest, `${field} must be a finite number.`);
    }

    if (options?.min !== undefined && numeric < options.min) {
      throw new McpError(ErrorCode.InvalidRequest, `${field} must be at least ${options.min}.`);
    }

    if (options?.max !== undefined && numeric > options.max) {
      throw new McpError(ErrorCode.InvalidRequest, `${field} must not exceed ${options.max}.`);
    }

    return numeric;
  }

  private parseOptionalInteger(
    value: unknown,
    field: string,
    options?: { min?: number; max?: number }
  ): number | undefined {
    const numeric = this.parseOptionalNumber(value, field, options);
    if (numeric === undefined) {
      return undefined;
    }

    if (!Number.isInteger(numeric)) {
      throw new McpError(ErrorCode.InvalidRequest, `${field} must be an integer.`);
    }

    return numeric;
  }

  private parseOptionalDimension(value: unknown, field: 'width' | 'height'): number | undefined {
    const numeric = this.parseOptionalInteger(value, field, { min: 256, max: 2048 });
    if (numeric === undefined) {
      return undefined;
    }
    if (numeric % 64 !== 0) {
      throw new McpError(ErrorCode.InvalidRequest, `${field} must be a multiple of 64.`);
    }
    return numeric;
  }

  private parseOptionalBoolean(value: unknown, field: string): boolean | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') {
        return true;
      }
      if (normalized === 'false') {
        return false;
      }
    }
    throw new McpError(ErrorCode.InvalidRequest, `${field} must be a boolean.`);
  }

  private parseOptionalStringArray(value: unknown, field: string): string[] | undefined {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    if (!Array.isArray(value)) {
      throw new McpError(ErrorCode.InvalidRequest, `${field} must be an array of strings.`);
    }
    const sanitized = value.map((entry, index) => {
      if (typeof entry !== 'string') {
        throw new McpError(ErrorCode.InvalidRequest, `${field}[${index}] must be a string.`);
      }
      const trimmed = entry.trim();
      if (trimmed.length === 0) {
        throw new McpError(ErrorCode.InvalidRequest, `${field}[${index}] must be a non-empty string.`);
      }
      return trimmed;
    });
    return sanitized;
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private async resolveImageReference(input: ImageReferenceInput): Promise<ResolvedImageReference> {
    const resourceUri = this.sanitizeOptionalString(input.resource_uri);
    if (resourceUri) {
      const record = await getImageRecord(this.extractResourceId(resourceUri));
      if (!record) {
        throw new McpError(ErrorCode.InvalidRequest, `Resource not found: ${resourceUri}`);
      }
      const tokenFromRecord = this.sanitizeOptionalString(record.imageToken);
      return {
        imageToken: tokenFromRecord,
        record,
        source: 'resource_uri',
      };
    }

    const imageToken = this.sanitizeOptionalString(input.image_token);
    if (imageToken) {
      const record = await getImageRecordByToken(imageToken);
      return {
        imageToken,
        record: record ?? undefined,
        source: 'image_token',
      };
    }

    const imageBase64 = this.sanitizeOptionalString(input.image_base64);
    if (imageBase64) {
      return {
        directBase64: imageBase64,
        source: 'image_base64',
      };
    }

    throw new McpError(
      ErrorCode.InvalidRequest,
      'Provide at least one of resource_uri, image_token, or image_base64.'
    );
  }

  private async readRecordBase64(record: ImageRecord): Promise<string | undefined> {
    try {
      return await readImageBase64(record);
    } catch (error) {
      console.warn('[AI Image] Failed to read cached image binary for record', {
        id: record.id,
        err: error instanceof Error ? error.message : error,
      });
      return undefined;
    }
  }

  private async ensureImageToken(
    reference: ResolvedImageReference,
    options?: {
      uploadIfNeeded?: boolean;
      uploadSource?: string;
      derivedFrom?: string[];
      prompt?: string;
    }
  ): Promise<{ imageToken: string; record?: ImageRecord }> {
    if (reference.imageToken) {
      return { imageToken: reference.imageToken, record: reference.record };
    }

    if (!options?.uploadIfNeeded) {
      throw new McpError(ErrorCode.InvalidRequest, 'image_token is required for this operation.');
    }

    let base64: string | undefined = reference.directBase64;
    if (!base64 && reference.record) {
      base64 = await this.readRecordBase64(reference.record);
    }

    if (!base64) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'Unable to resolve base64 image data. Provide image_base64 explicitly or reference a cached resource.'
      );
    }

    const client = this.getApiClient();
    const uploadRequest: ImageUploadRequest = {
      image_base64: base64,
      source: options?.uploadSource ?? 'mcp-upload',
      derived_from: options?.derivedFrom,
      prompt: options?.prompt,
    };

    const uploadResponse = await client.uploadImage(uploadRequest);
    return {
      imageToken: uploadResponse.image_token,
      record: reference.record,
    };
  }

  private async fetchImageBase64(imageToken: string): Promise<string | undefined> {
    try {
      const lookup = await this.getApiClient().getImageByToken(imageToken);
      const base64 = this.sanitizeOptionalString(lookup.image_base64);
      return base64;
    } catch (error) {
      console.warn('[AI Image] Failed to download base64 for image token', {
        imageToken,
        err: error instanceof Error ? error.message : error,
      });
      return undefined;
    }
  }

  private pruneUndefined<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) {
        result[key] = value;
      }
    }
    return result;
  }

  private async waitForJobResult(
    jobId: string,
    options: {
      includeBase64?: boolean;
      pollIntervalSeconds?: number;
      timeoutSeconds?: number;
    }
  ): Promise<JobResultResponse> {
    const includeBase64 = options.includeBase64 ?? false;
    const pollIntervalMs = Math.max(1, options.pollIntervalSeconds ?? 5) * 1000;
    const timeoutMs = Math.max(1, options.timeoutSeconds ?? 300) * 1000;
    const deadline = Date.now() + timeoutMs;

    let lastStatus: string | undefined;

    while (Date.now() < deadline) {
      try {
        const result = await this.getApiClient().getJobResult(jobId, includeBase64);
        const status = typeof result.status === 'string' ? result.status.toLowerCase() : '';

        if (status === 'succeeded' || status === 'completed') {
          return result;
        }

        if (status === 'failed' || status === 'error' || status === 'cancelled') {
          throw new McpError(
            ErrorCode.InternalError,
            `Job ${jobId} failed: ${result.error ?? 'Unknown error'}`
          );
        }

        lastStatus = status;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/404|not found|not ready/i.test(message)) {
          console.warn('[AI Image] Job result polling error', { jobId, err: message });
        }
      }

      await this.delay(pollIntervalMs);
    }

    throw new McpError(
      ErrorCode.InternalError,
      `Job ${jobId} did not complete within ${options.timeoutSeconds ?? 300} seconds (last status: ${lastStatus ?? 'unknown'}).`
    );
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private async downloadImageToBase64(
    url: string,
    options: { timeoutSeconds?: number; maxBytes?: number } = {}
  ): Promise<{ base64: string; mimeType: string; byteLength: number }> {
    const timeoutSeconds = options.timeoutSeconds ?? 30;
    const timeoutMs = Math.max(1000, Math.floor(timeoutSeconds * 1000));
    const maxBytes = options.maxBytes ?? 20 * 1024 * 1024; // default 20MB safeguard

    try {
      const response = await axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: timeoutMs,
        maxContentLength: maxBytes,
        maxBodyLength: maxBytes,
        validateStatus: (status) => typeof status === 'number' && status >= 200 && status < 300,
      });

      const buffer = Buffer.from(response.data);
      if (buffer.length > maxBytes) {
        throw new Error(`Downloaded image exceeds max_bytes (${maxBytes} bytes). Actual size: ${buffer.length} bytes.`);
      }

      const rawContentType = response.headers['content-type'];
      const contentType = Array.isArray(rawContentType)
        ? rawContentType[0]
        : (typeof rawContentType === 'string' ? rawContentType : 'application/octet-stream');
      const mimeType = contentType.split(';')[0].trim() || 'application/octet-stream';

      return {
        base64: buffer.toString('base64'),
        mimeType,
        byteLength: buffer.length,
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.code === 'ECONNABORTED') {
          throw new Error(`Timed out fetching image after ${timeoutMs}ms.`);
        }
        const status = error.response?.status;
        const statusText = error.response?.statusText?.trim();
        const detail = error.response?.data && typeof error.response.data === 'object'
          ? JSON.stringify(error.response.data)
          : undefined;
        const parts = [
          `Failed to download image (${status ?? 'no-status'}${statusText ? ` ${statusText}` : ''}).`,
          error.message,
          detail,
        ].filter(Boolean);
        throw new Error(parts.join(' '));
      }

      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private async handleCaptionImage(params: Record<string, unknown>) {
    const imageUrl = this.sanitizeOptionalString(params.image_url);
    if (imageUrl) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        'image_url is not supported directly. Use store_image_from_url first to register the image.'
      );
    }

    const reference = await this.resolveImageReference(params);
    const request: ImageCaptionRequest = {};

    if (reference.imageToken) {
      request.image_token = reference.imageToken;
    } else {
      let base64 = reference.directBase64;
      if (!base64 && reference.record) {
        base64 = await this.readRecordBase64(reference.record);
      }
      if (!base64) {
        throw new McpError(ErrorCode.InvalidRequest, 'image_base64 is required when image_token is unavailable.');
      }
      request.image_base64 = base64;
    }

    const prompt = this.sanitizeOptionalString(params.prompt);
    if (prompt) {
      request.prompt = prompt;
    }

    const maxNewTokens = this.parseOptionalInteger(params.max_new_tokens, 'max_new_tokens', { min: 1, max: 512 });
    if (maxNewTokens !== undefined) {
      request.max_new_tokens = maxNewTokens;
    }

    const temperature = this.parseOptionalNumber(params.temperature, 'temperature', { min: 0, max: 2 });
    if (temperature !== undefined) {
      request.temperature = temperature;
    }

    const topP = this.parseOptionalNumber(params.top_p, 'top_p', { min: 0, max: 1 });
    if (topP !== undefined) {
      request.top_p = topP;
    }

    const nucleus = this.parseOptionalBoolean(params.use_nucleus_sampling, 'use_nucleus_sampling');
    if (nucleus !== undefined) {
      request.use_nucleus_sampling = nucleus;
    }

    const repetitionPenalty = this.parseOptionalNumber(params.repetition_penalty, 'repetition_penalty', { min: 0.5, max: 2 });
    if (repetitionPenalty !== undefined) {
      request.repetition_penalty = repetitionPenalty;
    }

    const modelId = this.sanitizeOptionalString(params.model_id);
    if (modelId) {
      request.model_id = modelId;
    }

    console.error('[AI Image] Captioning image via Modal');
    const response = await this.getApiClient().captionImage(request);

    const storeToMetadata = this.parseOptionalBoolean(params.store_to_metadata, 'store_to_metadata') === true;
    let storedToMetadata = false;

    if (storeToMetadata) {
      const tokenToPatch = this.sanitizeOptionalString(response.image_token) ?? reference.imageToken;
      if (!tokenToPatch) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          'store_to_metadata requires a resolvable image_token. Caption response did not include one.'
        );
      }

      const patch: ImageMetadataPatch = {
        caption: response.caption,
        caption_model_id: response.model_id,
        captioned_at: Math.floor(Date.now() / 1000),
      };

      await this.getApiClient().patchImageMetadata(tokenToPatch, patch);
      storedToMetadata = true;
    }

    const resourceUri = reference.record ? getResourceUri(reference.record.id) : undefined;

    const payload = this.pruneUndefined({
      caption: response.caption,
      model_id: response.model_id,
      device: response.device,
      dtype: response.dtype,
      metadata: response.metadata,
      image_metadata: response.image_metadata,
      image_token: response.image_token ?? reference.imageToken,
      resource_uri: resourceUri,
      stored_to_metadata: storedToMetadata ? true : undefined,
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload),
        },
      ],
    };
  }

  private async handleUpscaleImage(params: Record<string, unknown>) {
    const reference = await this.resolveImageReference(params);
    const scale = this.parseOptionalInteger(params.scale, 'scale', { min: 1, max: 8 });

    const timeoutSeconds = this.parseOptionalInteger(params.poll_timeout_seconds, 'poll_timeout_seconds', { min: 1, max: 1800 }) ?? 300;
    const intervalSeconds = this.parseOptionalInteger(params.poll_interval_seconds, 'poll_interval_seconds', { min: 1, max: 60 }) ?? 5;

    const derivedFrom = reference.imageToken ? [reference.imageToken] : undefined;
    const ensured = await this.ensureImageToken(reference, {
      uploadIfNeeded: true,
      uploadSource: 'mcp-upscale-upload',
      derivedFrom,
    });

    const request: UpscaleRequest = { image_token: ensured.imageToken };
    if (scale !== undefined) {
      request.scale = scale;
    }

    console.error('[AI Image] Upscaling image via Modal | image_token=%s scale=%s', ensured.imageToken, scale ?? 'default');
    const job: UpscaleJobStatusResponse = await this.getApiClient().upscaleImage(request);

    const jobId = this.sanitizeOptionalString(job.job_id);
    if (!jobId) {
      throw new McpError(ErrorCode.InternalError, 'Upscale API did not return a job_id.');
    }

    const jobResult = await this.waitForJobResult(jobId, {
      includeBase64: true,
      pollIntervalSeconds: intervalSeconds,
      timeoutSeconds,
    });

    let base64 = this.sanitizeOptionalString(jobResult.image_base64);
    if (!base64 && jobResult.image_token) {
      base64 = await this.fetchImageBase64(jobResult.image_token);
    }
    if (!base64) {
      throw new McpError(ErrorCode.InternalError, 'Upscale job completed but did not provide image_base64.');
    }

    const originalPrompt = ensured.record?.prompt ?? '[original prompt unavailable]';
    const metadataRecord = (jobResult.metadata ?? {}) as Record<string, unknown>;

    const savedRecord = await saveImage(base64, {
      prompt: originalPrompt,
      model: 'modal-upscale',
      params: {
        request,
        job_result: jobResult,
      },
      imageToken: jobResult.image_token,
      metadata: {
        ...metadataRecord,
        upscaled_from: ensured.imageToken,
        upscale_scale: scale ?? 2,
      },
      downloadUrl: undefined,
      mimeType: 'image/png',
    });

    const resourceUri = getResourceUri(savedRecord.id);

    const payload = this.pruneUndefined({
      job_id: jobId,
      status: jobResult.status,
      image_token: jobResult.image_token ?? savedRecord.imageToken,
      resource_uri: resourceUri,
      mime_type: savedRecord.mimeType ?? 'image/png',
      created_at: savedRecord.createdAt,
      metadata: metadataRecord,
      original_image_token: ensured.imageToken,
      used_params: { scale: scale ?? 2 },
    });

    return {
      content: [
        {
          type: 'image',
          data: base64,
          mimeType: savedRecord.mimeType ?? 'image/png',
        },
        {
          type: 'text',
          text: JSON.stringify(payload),
        },
      ],
    };
  }

  private async handleImageToImage(params: Record<string, unknown>) {
    const prompt = this.sanitizeOptionalString(params.prompt);
    if (!prompt) {
      throw new McpError(ErrorCode.InvalidRequest, '"prompt" is required and must be a non-empty string.');
    }

    const reference = await this.resolveImageReference(params);
    const includeBase64 = this.parseOptionalBoolean(params.include_base64, 'include_base64');
    const asyncMode = this.parseOptionalBoolean(params.async, 'async') ?? false;
    const timeoutSeconds = this.parseOptionalInteger(params.poll_timeout_seconds, 'poll_timeout_seconds', { min: 1, max: 1800 }) ?? 600;
    const intervalSeconds = this.parseOptionalInteger(params.poll_interval_seconds, 'poll_interval_seconds', { min: 1, max: 60 }) ?? 5;

    const ensured = await this.ensureImageToken(reference, {
      uploadIfNeeded: true,
      uploadSource: 'mcp-image-to-image-upload',
      derivedFrom: reference.imageToken ? [reference.imageToken] : undefined,
      prompt,
    });

    const request: ImageToImageJobRequest = {
      prompt,
      init_image_token: ensured.imageToken,
    };

    const negativePrompt = this.sanitizeOptionalString(params.negative_prompt);
    if (negativePrompt) {
      request.negative_prompt = negativePrompt;
    }

    const modelValue = this.sanitizeOptionalString(params.model);
    if (modelValue) {
      request.model = modelValue;
    }

    const guidanceScale = this.parseOptionalNumber(params.guidance_scale, 'guidance_scale');
    if (guidanceScale !== undefined) {
      request.guidance_scale = guidanceScale;
    }

    const steps = this.parseOptionalInteger(params.steps, 'steps', { min: 1 });
    if (steps !== undefined) {
      request.steps = steps;
    }

    const width = this.parseOptionalDimension(params.width, 'width');
    if (width !== undefined) {
      request.width = width;
    }

    const height = this.parseOptionalDimension(params.height, 'height');
    if (height !== undefined) {
      request.height = height;
    }

    const seed = this.parseOptionalInteger(params.seed, 'seed');
    if (seed !== undefined) {
      request.seed = seed;
    }

    const strength = this.parseOptionalNumber(params.strength, 'strength', { min: 0, max: 1 });
    if (strength !== undefined) {
      request.strength = strength;
    }

    if (asyncMode) {
      console.error('[AI Image] Enqueuing async image-to-image job via Modal');
      const jobResponse = await this.getApiClient().createImageToImageJob(request);
      const jobId = this.sanitizeOptionalString((jobResponse as Record<string, unknown>).job_id);
      if (!jobId) {
        throw new McpError(ErrorCode.InternalError, 'Image-to-image job creation did not return a job_id.');
      }

      const payload = this.pruneUndefined({
        job_id: jobId,
        status: (jobResponse as Record<string, unknown>).status ?? 'queued',
        poll_endpoints: {
          status: `/jobs/${jobId}/status`,
          result: `/jobs/${jobId}/result`,
        },
        request,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload),
          },
        ],
      };
    }

    console.error('[AI Image] Running synchronous image-to-image via Modal');
    const response: ImageToImageJobResponse = await this.getApiClient().imageToImage(request, {
      includeBase64: includeBase64 !== false,
    });

    let base64 = this.sanitizeOptionalString(response.image_base64);
    if (!base64 && response.image_token) {
      base64 = await this.fetchImageBase64(response.image_token);
    }
    if (!base64) {
      throw new McpError(ErrorCode.InternalError, 'Image-to-image response did not include image data.');
    }

    const metadataRecord = (response.metadata ?? {}) as Record<string, unknown>;
    const savedRecord = await saveImage(base64, {
      prompt,
      model: this.sanitizeOptionalString(response.used_params?.model) ?? request.model ?? 'unknown',
      params: {
        request,
        used_params: response.used_params ?? {},
      },
      imageToken: response.image_token,
      metadata: {
        ...metadataRecord,
        source_image_token: ensured.imageToken,
      },
      downloadUrl: undefined,
      mimeType: 'image/png',
    });

    const resourceUri = getResourceUri(savedRecord.id);

    const payload = this.pruneUndefined({
      image_token: response.image_token ?? savedRecord.imageToken,
      resource_uri: resourceUri,
      prompt,
      model: savedRecord.model,
      created_at: savedRecord.createdAt,
      used_params: response.used_params,
      metadata: metadataRecord,
      source_image_token: ensured.imageToken,
    });

    return {
      content: [
        {
          type: 'image',
          data: base64,
          mimeType: savedRecord.mimeType ?? 'image/png',
        },
        {
          type: 'text',
          text: JSON.stringify(payload),
        },
      ],
    };
  }

  private async handleStoreImageFromUrl(params: Record<string, unknown>) {
    const imageUrl = this.sanitizeOptionalString(params.image_url);
    if (!imageUrl) {
      throw new McpError(ErrorCode.InvalidRequest, '"image_url" is required and must be a non-empty string.');
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(imageUrl);
    } catch {
      throw new McpError(ErrorCode.InvalidRequest, '"image_url" must be a valid HTTP or HTTPS URL.');
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new McpError(ErrorCode.InvalidRequest, 'Only HTTP and HTTPS URLs are supported.');
    }

    const request: ImageUrlUploadRequest = { url: imageUrl };

    const source = this.sanitizeOptionalString(params.source);
    if (source) {
      request.source = source;
    }

    const prompt = this.sanitizeOptionalString(params.prompt);
    if (prompt) {
      request.prompt = prompt;
    }

    const negativePrompt = this.sanitizeOptionalString(params.negative_prompt);
    if (negativePrompt) {
      request.negative_prompt = negativePrompt;
    }

    let parameters: Record<string, unknown> | undefined;
    if (this.isPlainObject(params.parameters)) {
      parameters = params.parameters as Record<string, unknown>;
      request.parameters = parameters;
    } else if (params.parameters !== undefined && params.parameters !== null) {
      throw new McpError(ErrorCode.InvalidRequest, '"parameters" must be an object when provided.');
    }

    const derivedFrom = this.parseOptionalStringArray(params.derived_from, 'derived_from');
    if (derivedFrom) {
      request.derived_from = derivedFrom;
    }

    const tags = this.parseOptionalStringArray(params.tags, 'tags');
    if (tags) {
      request.tags = tags;
    }

    let extraObject: Record<string, unknown> | undefined;
    if (this.isPlainObject(params.extra)) {
      extraObject = params.extra as Record<string, unknown>;
      request.extra = extraObject;
    } else if (params.extra !== undefined && params.extra !== null) {
      throw new McpError(ErrorCode.InvalidRequest, '"extra" must be an object when provided.');
    }

    const filename = this.sanitizeOptionalString(params.filename);
    if (filename) {
      request.filename = filename;
    }

    const timeout = this.parseOptionalNumber(params.timeout, 'timeout', { min: 0 });
    if (timeout !== undefined) {
      request.timeout = timeout;
    }

    const maxBytes = this.parseOptionalInteger(params.max_bytes, 'max_bytes', { min: 1 });
    if (maxBytes !== undefined) {
      request.max_bytes = maxBytes;
    }

    const fallbackTimeoutSeconds = typeof timeout === 'number' && timeout > 0 ? timeout : undefined;
    const fallbackMaxBytes = maxBytes;

    console.error('[AI Image] Storing image from URL via Modal | url=%s', imageUrl);

    let storeResponse: ImageUploadResponse | undefined;
    let finalImageToken: string | undefined;
    let metadataRecord: Record<string, unknown> | undefined;
    let base64: string | undefined;
    let mimeType: string | undefined;
    let storeError: unknown;
    let usedFallbackUpload = false;

    try {
      storeResponse = await this.getApiClient().storeImageFromUrl(request);
      finalImageToken = this.sanitizeOptionalString(storeResponse.image_token);
      metadataRecord = storeResponse.metadata ?? {};
    } catch (error) {
      storeError = error;
      console.error('[AI Image] Modal store-from-url failed, attempting fallback', {
        url: imageUrl,
        err: error instanceof Error ? error.message : error,
      });
    }

    if (finalImageToken) {
      base64 = await this.fetchImageBase64(finalImageToken);
      if (!base64) {
        console.warn('[AI Image] Modal store-from-url succeeded but image_base64 missing; downloading locally', {
          imageToken: finalImageToken,
          url: imageUrl,
        });
      }
    }

    if (!base64) {
      let downloaded;
      try {
        downloaded = await this.downloadImageToBase64(imageUrl, {
          timeoutSeconds: fallbackTimeoutSeconds,
          maxBytes: fallbackMaxBytes,
        });
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to download image from URL for caching: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      base64 = downloaded.base64;
      mimeType = downloaded.mimeType;

      if (!finalImageToken) {
        console.error('[AI Image] Uploading image via base64 fallback');
        const uploadRequest: ImageUploadRequest = {
          image_base64: downloaded.base64,
          source: source ?? 'url-import',
        };

        if (prompt) {
          uploadRequest.prompt = prompt;
        }
        if (negativePrompt) {
          uploadRequest.negative_prompt = negativePrompt;
        }
        if (parameters) {
          uploadRequest.parameters = parameters;
        }
        if (derivedFrom) {
          uploadRequest.derived_from = derivedFrom;
        }
        if (tags) {
          uploadRequest.tags = tags;
        }
        if (extraObject) {
          uploadRequest.extra = extraObject;
        }
        if (filename) {
          uploadRequest.filename = filename;
        }

        let uploadResponse: ImageUploadResponse;
        try {
          uploadResponse = await this.getApiClient().uploadImage(uploadRequest);
        } catch (error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Fallback upload to Modal failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }

        finalImageToken = this.sanitizeOptionalString(uploadResponse.image_token);
        if (!finalImageToken) {
          throw new McpError(ErrorCode.InternalError, 'Fallback upload response did not include image_token.');
        }

        metadataRecord = uploadResponse.metadata ?? {};
        storeResponse = storeResponse ?? uploadResponse;
        usedFallbackUpload = true;
      }
    }

    if (!base64 || !finalImageToken) {
      const upstreamMessage = storeError instanceof Error ? storeError.message : 'Unknown Modal error';
      throw new McpError(
        ErrorCode.InternalError,
        `Unable to store image from URL. Modal response: ${upstreamMessage}`
      );
    }

    const metadataForSave: Record<string, unknown> = {
      ...(metadataRecord ?? {}),
      original_url: imageUrl,
    };
    if (usedFallbackUpload) {
      metadataForSave['fallback_upload_used'] = true;
    }

    const paramsForSave = this.pruneUndefined({
      store_request: request,
      store_response: storeResponse,
      fallback_upload_used: usedFallbackUpload ? true : undefined,
      fallback_upload_reason: usedFallbackUpload
        ? (storeError instanceof Error ? storeError.message : storeError)
        : undefined,
    });

    const savedRecord = await saveImage(base64, {
      prompt: prompt ?? `Imported from ${imageUrl}`,
      model: 'url-import',
      params: paramsForSave,
      imageToken: finalImageToken,
      metadata: metadataForSave,
      downloadUrl: imageUrl,
      mimeType: mimeType ?? 'image/png',
    });

    const resourceUri = getResourceUri(savedRecord.id);

    const payload = this.pruneUndefined({
      image_token: finalImageToken,
      resource_uri: resourceUri,
      mime_type: savedRecord.mimeType ?? 'image/png',
      created_at: savedRecord.createdAt,
      metadata: metadataForSave,
      prompt: savedRecord.prompt,
      fallback_upload_used: usedFallbackUpload ? true : undefined,
    });

    return {
      content: [
        {
          type: 'image',
          data: base64,
          mimeType: savedRecord.mimeType ?? 'image/png',
        },
        {
          type: 'text',
          text: JSON.stringify(payload),
        },
      ],
    };
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('AI Image API MCP Server running on stdio');
  }
}
const startServer = async () => {
  try {
    const server = new AiImageMcpServer();
    await server.run();
  } catch (error) {
    console.error('[AI Image] Failed to start MCP server', error);
    process.exit(1);
  }
};

const isCliEntryPoint = (): boolean => {
  const argvPath = process.argv[1];
  if (typeof argvPath !== 'string' || argvPath.length === 0) {
    return false;
  }

  try {
    const cliRealPath = realpathSync(argvPath);
    const moduleRealPath = realpathSync(fileURLToPath(import.meta.url));
    if (process.env.MCP_IMAGE_DEBUG_ENTRY === '1') {
      console.error('[AI Image][debug] cliRealPath=%s moduleRealPath=%s', cliRealPath, moduleRealPath);
    }
    return cliRealPath === moduleRealPath;
  } catch {
    return false;
  }
};

// Start the server when executed directly (including via npm exec/npx symlinks)
if (isCliEntryPoint()) {
  startServer().catch((error) => {
    console.error('[AI Image] Unexpected error while starting MCP server', error);
    process.exit(1);
  });
}