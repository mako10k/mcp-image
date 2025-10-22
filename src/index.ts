#!/usr/bin/env node
/**
 * AI Image Generation API MCP Server
 *
 * This server proxies requests to the AI image generation APIs deployed on Modal.com
 * and exposes them through the MCP protocol.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
import { ImageGenerationParams, ImageSearchParams, OptimizeAndGenerateRequest, OptimizeParametersRequest, Txt2ImgRequest } from './types.js';
import {
  saveImage,
  listImages,
  getImageRecord,
  getImageRecordByToken,
  readImageBase64,
  getResourceUri,
  RESOURCE_URI_PREFIX,
} from './storage.js';

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
          mimeType: 'text/plain',
          text: textLines.join('\n'),
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

    if (limited.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'No images matched the specified filters.',
          },
        ],
      };
    }

    const lines = limited.map((record, index) => {
      const timestamp = new Date(record.createdAt).toLocaleString();
      const preview = record.prompt.length > 120 ? `${record.prompt.slice(0, 117)}...` : record.prompt;
      return [
        `${index + 1}. ${timestamp} | ${record.model}`,
        `   Prompt: ${preview}`,
        `   URI: ${getResourceUri(record.id)}`,
      ].join('\n');
    });

    const truncated = images.length > limited.length;
    const header = 'Results are served from the locally cached image metadata. The Modal AI Image API does not expose search endpoints, so this uses local metadata only.';

    const summary = [
      header,
      '',
      ...lines,
      truncated ? 'Note: More matches exist beyond the requested limit; only the first results are shown.' : '',
    ].filter(Boolean).join('\n');

    return {
      content: [
        {
          type: 'text',
          text: summary,
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

    const textSummary = [
      `Image Token: ${record.imageToken}`,
      `Resource URI: ${resourceUri}`,
      `Prompt: ${record.prompt}`,
      `Model: ${record.model}`,
      `Created: ${record.createdAt}`,
    ];

    if (record.downloadUrl) {
      textSummary.push(`Download URL: ${record.downloadUrl}`);
    }

    if (record.metadata) {
      const metaSnippet = JSON.stringify(record.metadata).slice(0, 300);
      textSummary.push(`Metadata (truncated): ${metaSnippet}`);
    }

    const content: Array<Record<string, unknown>> = [
      {
        type: 'text',
        text: JSON.stringify(responseData, null, 2),
      },
    ];

    if (base64 && base64.length > 0) {
      content.unshift({
        type: 'image',
        data: base64,
        mimeType,
      });
    }

    content.push({
      type: 'text',
      text: textSummary.join('\n'),
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

    console.log(`[AI Image] Generating image via Modal | model=${sanitized.model ?? 'default'} prompt="${promptValue}"`);

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

    return {
      content: [
        {
          type: 'image',
          data: base64Payload,
          mimeType: record.mimeType ?? 'image/png',
        },
        {
          type: 'text',
          text: summaryParts.join('\n'),
        },
      ],
    };
  }

  /**
   * Retrieve the list of available models
   */
  private async handleGetAvailableModels() {
    console.log('[AI Image] Fetching available models');
    
    const result = await this.getApiClient().getModels();

    const modelsList = Object.entries(result.models).map(([name, config]) => 
      `- **${name}**: ${config.repo} - ${config.description}`
    ).join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `Available image generation models:\n\n${modelsList}\n\nTotal models available: ${Object.keys(result.models).length}.`,
        },
      ],
    };
  }

  /**
   * Retrieve detailed information about a model
   */
  private async handleGetModelDetail(params: { model_name: string }) {
    const { model_name } = params;
    
    console.log(`[AI Image] Fetching model detail for: ${model_name}`);
    
    const result = await this.getApiClient().getModelDetail(model_name);
    const model = result.model;

    const details = [
      `**Model name:** ${model_name}`,
      `**Repository:** ${model.repo}`,
      `**Description:** ${model.description}`,
      `**Recommended scheduler:** ${model.recommended_scheduler}`,
      `**Recommended guidance scale:** ${model.recommended_guidance_scale}`,
      `**Prompt limit:** ${model.prompt_token_limit} tokens`,
      '',
      `**Recommended prompt:**`,
      model.recommended_prompt,
      '',
      `**Recommended negative prompt:**`,
      model.recommended_negative_prompt,
      '',
      `**Parameter guidelines:**`,
      model.recommended_parameter_guideline,
    ];

    return {
      content: [
        {
          type: 'text',
          text: details.join('\n'),
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

    console.log('[AI Image] Optimizing prompt: "%s" model=%s', queryValue, selectedModel ?? 'auto');

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

    console.log('[AI Image] Optimize & Generate | query="%s" model=%s', queryValue, optimizeModel ?? 'auto');
    console.log('[AI Image] Note: This process involves two steps (optimization + generation) and may take up to 15 minutes total, especially on first connection to JOBAPI server');

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

    console.log('[AI Image] Optimization complete, now generating image with optimized parameters...');
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