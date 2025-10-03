#!/usr/bin/env node
/**
 * AI Image Generation API MCP Server
 * 
 * このサーバはModal.comにデプロイされたAI画像生成APIと連携し、
 * MCPプロトコルを通じて画像生成機能を提供します。
 */

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
import { ImageGenerationParams, ImageSearchParams, OptimizeParametersRequest, OptimizeAndGenerateParams } from './types.js';
import {
  saveImage,
  listImages,
  getImageRecord,
  readImageBase64,
  getResourceUri,
} from './storage.js';

class AiImageMcpServer {
  private server: Server;
  private apiClient: AiImageApiClient;

  constructor() {
    this.server = new Server(
      {
        name: 'ai-image-api-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.apiClient = new AiImageApiClient();
    this.setupToolHandlers();
    this.setupResourceHandlers();
    this.setupErrorHandling();
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
    // ツール一覧の提供
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'generate_image',
            description: '自然言語プロンプトから画像を生成します。Modal.comにデプロイされたStable Diffusion APIを使用。',
            inputSchema: {
              type: 'object',
              properties: {
                prompt: {
                  type: 'string',
                  description: '画像生成のためのプロンプト（自然言語）',
                },
                quality_tier: {
                  type: 'string',
                  enum: ['draft', 'standard', 'premium'],
                  default: 'standard',
                  description: '品質・コスト・速度のバランス選択',
                },
                style_hint: {
                  type: 'string',
                  description: 'スタイル指定のヒント（オプション）',
                },
                size_preference: {
                  type: 'string',
                  enum: ['small', 'medium', 'large'],
                  default: 'medium',
                  description: '画像サイズの希望',
                },
                experimental: {
                  type: 'boolean',
                  default: false,
                  description: '実験的機能の有効化',
                },
              },
              required: ['prompt'],
            },
          },
          {
            name: 'get_available_models',
            description: 'AI画像生成に利用可能なモデルの一覧を取得します。',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'get_model_detail',
            description: '特定のモデルの詳細情報を取得します。',
            inputSchema: {
              type: 'object',
              properties: {
                model_name: {
                  type: 'string',
                  description: '詳細情報を取得するモデル名',
                },
              },
              required: ['model_name'],
            },
          },
          {
            name: 'optimize_prompt',
            description: 'プロンプトを画像生成に最適化し、推奨パラメータを提案します。',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: '最適化したいプロンプトまたは画像の説明',
                },
                target_model: {
                  type: 'string',
                  description: '対象とするモデル（オプション）',
                },
              },
              required: ['query'],
            },
          },
          {
            name: 'search_images',
            description: '保存済みの生成画像をプロンプトやモデルで検索します。',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'プロンプトに含まれるキーワード（部分一致）',
                },
                model: {
                  type: 'string',
                  description: '生成に使用したモデル名での絞り込み',
                },
                limit: {
                  type: 'integer',
                  minimum: 1,
                  maximum: 20,
                  default: 5,
                  description: '取得する結果件数の上限（1-20）',
                },
                before: {
                  type: 'string',
                  description: 'この日時より前に生成された画像に限定 (ISO 8601)',
                },
                after: {
                  type: 'string',
                  description: 'この日時以降に生成された画像に限定 (ISO 8601)',
                },
              },
            },
          },
          {
            name: 'optimize_and_generate',
            description: 'プロンプトを最適化し、その結果を使って画像生成を一括で行います。',
            inputSchema: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: '生成したい内容の説明',
                },
                target_model: {
                  type: 'string',
                  description: '優先的に使用したいモデル名（オプション）',
                },
                quality_tier: {
                  type: 'string',
                  enum: ['draft', 'standard', 'premium'],
                  default: 'standard',
                  description: '品質レベルの希望（最適化されたパラメータで上書きされる場合があります）',
                },
                size_preference: {
                  type: 'string',
                  enum: ['small', 'medium', 'large'],
                  default: 'medium',
                  description: '出力解像度の目安（最適化結果によって調整される場合があります）',
                },
                experimental: {
                  type: 'boolean',
                  default: false,
                  description: '実験的モデル（SDXLなど）を優先的に使用',
                },
                style_hint: {
                  type: 'string',
                  description: '追加したいスタイルやテイスト（オプション）',
                },
              },
              required: ['query'],
            },
          },
        ],
      };
    });

    // ツール実行ハンドラー
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

          case 'search_images':
            return await this.handleSearchImages(args as unknown as ImageSearchParams);

          case 'optimize_and_generate':
            return await this.handleOptimizeAndGenerate(args as unknown as OptimizeAndGenerateParams);

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
          mimeType: 'image/png',
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
      const resourceId = this.extractResourceId(uri);

      const record = await getImageRecord(resourceId);
      if (!record) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Resource not found: ${uri}`
        );
      }

      const base64 = await readImageBase64(record);

      const description = `${new Date(record.createdAt).toISOString()} | ${record.model}`;

      return {
        contents: [
          {
            uri,
            blob: base64,
            mimeType: 'image/png',
            description,
          },
          {
            uri,
            mimeType: 'text/plain',
            text: `Generated: ${record.createdAt}\nModel: ${record.model}\nPrompt: ${record.prompt}`,
          },
        ],
      };
    });
  }

  private extractResourceId(uri: string): string {
    const prefix = 'resource://ai-image-api/image/';
    if (!uri.startsWith(prefix)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Unsupported resource URI: ${uri}`
      );
    }

    const resourceId = uri.slice(prefix.length).trim();
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
            text: '条件に一致する画像は見つかりませんでした。',
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
    const header = 'ローカルに保存された画像キャッシュから検索しました。AI Image API 側には検索用エンドポイントがないため、ローカルメタデータを参照しています。';

    const summary = [
      header,
      '',
      ...lines,
      truncated ? '※ 指定件数を超える一致があるため先頭のみ返しています。' : '',
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
   * 画像生成を処理
   */
  private async handleGenerateImage(params: ImageGenerationParams) {
    const { prompt, quality_tier = 'standard', style_hint, size_preference = 'medium', experimental = false } = params;

    // 品質とサイズ設定のマッピング
    const qualitySettings = {
      draft: { steps: 10, guidance_scale: 5.0 },
      standard: { steps: 20, guidance_scale: 7.5 },
      premium: { steps: 30, guidance_scale: 9.0 },
    };

    const sizeSettings = {
      small: { width: 512, height: 512 },
      medium: { width: 768, height: 768 },
      large: { width: 1024, height: 1024 },
    };

    // プロンプト強化
    let enhancedPrompt = prompt;
    if (style_hint) {
      enhancedPrompt = `${prompt}, ${style_hint}`;
    }
    if (quality_tier === 'premium') {
      enhancedPrompt += ', high quality, detailed, masterpiece';
    }

    const generateRequest = {
      prompt: enhancedPrompt,
      negative_prompt: 'blurry, low quality, bad anatomy, distorted',
      model: experimental ? 'sdxl' : 'dreamshaper8',
      ...qualitySettings[quality_tier],
      ...sizeSettings[size_preference],
      seed: Math.floor(Math.random() * 2147483647),
    };

    console.log(`[AI Image] Generating image with prompt: "${enhancedPrompt}"`);
    
    const result = await this.apiClient.generateImage(generateRequest);

    const record = await saveImage(result.image_base64, {
      prompt: enhancedPrompt,
      model: generateRequest.model,
      params: {
        ...generateRequest,
        used_params: result.used_params ?? {},
        job_id: result.job_id,
      },
    });

    const resourceUri = getResourceUri(record.id);

    return {
      content: [
        {
          type: 'image',
          data: result.image_base64,
          mimeType: 'image/png',
        },
        {
          type: 'text',
          text: `画像を生成しました！\n\n**使用されたパラメータ:**\n- プロンプト: ${enhancedPrompt}\n- モデル: ${generateRequest.model}\n- ステップ数: ${generateRequest.steps}\n- ガイダンススケール: ${generateRequest.guidance_scale}\n- サイズ: ${generateRequest.width}x${generateRequest.height}\n- シード: ${generateRequest.seed}\n- ジョブID: ${result.job_id ?? 'N/A'}\n- リソースURI: ${resourceUri}`,
        },
      ],
    };
  }

  /**
   * 利用可能なモデル一覧を取得
   */
  private async handleGetAvailableModels() {
    console.log('[AI Image] Fetching available models');
    
    const result = await this.apiClient.getModels();

    const modelsList = Object.entries(result.models).map(([name, config]) => 
      `- **${name}**: ${config.repo} - ${config.description}`
    ).join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `利用可能な画像生成モデル:\n\n${modelsList}\n\n合計 ${Object.keys(result.models).length} 個のモデルが利用可能です。`,
        },
      ],
    };
  }

  /**
   * モデルの詳細情報を取得
   */
  private async handleGetModelDetail(params: { model_name: string }) {
    const { model_name } = params;
    
    console.log(`[AI Image] Fetching model detail for: ${model_name}`);
    
    const result = await this.apiClient.getModelDetail(model_name);
    const model = result.model;

    const details = [
      `**モデル名:** ${model_name}`,
      `**リポジトリ:** ${model.repo}`,
      `**説明:** ${model.description}`,
      `**推奨スケジューラ:** ${model.recommended_scheduler}`,
      `**推奨ガイダンススケール:** ${model.recommended_guidance_scale}`,
      `**プロンプト制限:** ${model.prompt_token_limit} トークン`,
      '',
      `**推奨プロンプト:**`,
      model.recommended_prompt,
      '',
      `**推奨ネガティブプロンプト:**`,
      model.recommended_negative_prompt,
      '',
      `**パラメータガイドライン:**`,
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

  /**
   * プロンプト最適化を処理
   */
  private async handleOptimizePrompt(params: OptimizeParametersRequest) {
    const { query, model } = params;
    
    console.log(`[AI Image] Optimizing prompt: "${query}"`);
    
    const result = await this.apiClient.optimizeParameters({ query, model });

    const suggestedModel = result.suggested_model || result.model || '未指定';
    const recommendedParams = result.recommended_params ?? {
      guidance_scale: result.guidance_scale,
      steps: result.steps,
      width: result.width,
      height: result.height,
      seed: result.seed,
    };

    const optimizationDetails = [
      `**最適化されたプロンプト:**\n${result.prompt}`,
      ``,
      `**ネガティブプロンプト:**\n${result.negative_prompt || 'なし'}`,
      ``,
      `**推奨モデル:** ${suggestedModel}`,
    ];

    if (result.reason) {
      optimizationDetails.push('', `**理由:**\n${result.reason}`);
    }

    if (recommendedParams) {
      optimizationDetails.push('', '**推奨パラメータ:**');
      Object.entries(recommendedParams)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .forEach(([key, value]) => {
        optimizationDetails.push(`- ${key}: ${value}`);
      });
    }

    return {
      content: [
        {
          type: 'text',
          text: optimizationDetails.join('\n'),
        },
      ],
    };
  }

  private async handleOptimizeAndGenerate(params: OptimizeAndGenerateParams) {
    const {
      query,
      target_model,
      quality_tier = 'standard',
      size_preference = 'medium',
      experimental = false,
      style_hint,
    } = params;

    console.log(`[AI Image] Optimize & generate workflow started for query: "${query}"`);

    const qualitySettings = {
      draft: { steps: 10, guidance_scale: 5.0 },
      standard: { steps: 20, guidance_scale: 7.5 },
      premium: { steps: 30, guidance_scale: 9.0 },
    } as const;

    const sizeSettings = {
      small: { width: 512, height: 512 },
      medium: { width: 768, height: 768 },
      large: { width: 1024, height: 1024 },
    } as const;

    const optimization = await this.apiClient.optimizeParameters({ query, model: target_model });

    const recommended = optimization.recommended_params ?? {};
    const fallbackModel = experimental ? 'sdxl' : 'dreamshaper8';
    const resolvedModel = optimization.model
      ?? optimization.suggested_model
      ?? target_model
      ?? fallbackModel;

    const basePrompt = optimization.prompt || query;
    const finalPrompt = style_hint ? `${basePrompt}, ${style_hint}` : basePrompt;
    const negativePrompt = optimization.negative_prompt && optimization.negative_prompt.trim().length > 0
      ? optimization.negative_prompt
      : 'blurry, low quality, bad anatomy, distorted';

  const qualityPreset = qualitySettings[quality_tier] ?? qualitySettings.standard;
  const sizePreset = sizeSettings[size_preference] ?? sizeSettings.medium;

    const pickNumber = (...values: Array<number | undefined | null>): number | undefined => {
      for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          return value;
        }
      }
      return undefined;
    };

    const pickInteger = (...values: Array<number | undefined | null>): number | undefined => {
      for (const value of values) {
        if (typeof value === 'number' && Number.isInteger(value)) {
          return value;
        }
      }
      return undefined;
    };

    const generationRequest = {
      prompt: finalPrompt,
      negative_prompt: negativePrompt,
      model: resolvedModel,
      guidance_scale: pickNumber(
        (recommended as Record<string, any>).guidance_scale,
        optimization.guidance_scale,
        qualityPreset.guidance_scale,
      ) ?? qualityPreset.guidance_scale,
      steps: pickInteger(
        (recommended as Record<string, any>).steps,
        optimization.steps,
        qualityPreset.steps,
      ) ?? qualityPreset.steps,
      width: pickInteger(
        (recommended as Record<string, any>).width,
        optimization.width,
        sizePreset.width,
      ) ?? sizePreset.width,
      height: pickInteger(
        (recommended as Record<string, any>).height,
        optimization.height,
        sizePreset.height,
      ) ?? sizePreset.height,
      seed: pickInteger(
        (recommended as Record<string, any>).seed,
        optimization.seed,
      ) ?? Math.floor(Math.random() * 2147483647),
    };

    const generationResult = await this.apiClient.generateImage(generationRequest);

    const record = await saveImage(generationResult.image_base64, {
      prompt: finalPrompt,
      model: generationRequest.model,
      params: {
        ...generationRequest,
        used_params: generationResult.used_params ?? {},
        job_id: generationResult.job_id,
        optimization: {
          request: { query, target_model, quality_tier, size_preference, experimental, style_hint },
          response: optimization,
        },
      },
    });

    const resourceUri = getResourceUri(record.id);

    const parameterLines = [
      `- モデル: ${generationRequest.model}`,
      `- ステップ数: ${generationRequest.steps}`,
      `- ガイダンススケール: ${generationRequest.guidance_scale}`,
      `- サイズ: ${generationRequest.width}x${generationRequest.height}`,
      `- シード: ${generationRequest.seed}`,
      `- ジョブID: ${generationResult.job_id ?? 'N/A'}`,
      `- リソースURI: ${resourceUri}`,
    ];

    const optimizationSummary = [
      `**最適化の結果:**`,
      `- 推奨プロンプト: ${basePrompt}`,
      `- ネガティブプロンプト: ${optimization.negative_prompt || 'なし'}`,
      `- 推奨モデル: ${optimization.model ?? optimization.suggested_model ?? target_model ?? fallbackModel}`,
    ];

    if (optimization.reason) {
      optimizationSummary.push(`- 理由: ${optimization.reason}`);
    }

    if (optimization.recommended_params) {
      optimizationSummary.push('- 推奨パラメータ:');
      Object.entries(optimization.recommended_params)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .forEach(([key, value]) => {
          optimizationSummary.push(`  - ${key}: ${value}`);
        });
    }

    return {
      content: [
        {
          type: 'image',
          data: generationResult.image_base64,
          mimeType: 'image/png',
        },
        {
          type: 'text',
          text: [
            '**最終プロンプト:**',
            finalPrompt,
            '',
            '**生成に使用したパラメータ:**',
            ...parameterLines,
            '',
            ...optimizationSummary,
          ].join('\n'),
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

// サーバーを開始
const server = new AiImageMcpServer();
server.run().catch(console.error);