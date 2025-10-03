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
import { ImageGenerationParams, OptimizeParametersRequest } from './types.js';
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

      return {
        contents: [
          {
            type: 'image',
            data: base64,
            mimeType: 'image/png',
          },
          {
            type: 'text',
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
          text: `画像を生成しました！\n\n**使用されたパラメータ:**\n- プロンプト: ${enhancedPrompt}\n- モデル: ${generateRequest.model}\n- ステップ数: ${generateRequest.steps}\n- ガイダンススケール: ${generateRequest.guidance_scale}\n- サイズ: ${generateRequest.width}x${generateRequest.height}\n- シード: ${generateRequest.seed}\n- リソースURI: ${resourceUri}`,
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

    const optimizationDetails = [
      `**最適化されたプロンプト:**\n${result.prompt}`,
      ``,
      `**ネガティブプロンプト:**\n${result.negative_prompt || 'なし'}`,
      ``,
      `**推奨モデル:** ${result.suggested_model}`,
    ];

    if (result.recommended_params) {
      optimizationDetails.push('', '**推奨パラメータ:**');
      Object.entries(result.recommended_params).forEach(([key, value]) => {
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

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('AI Image API MCP Server running on stdio');
  }
}

// サーバーを開始
const server = new AiImageMcpServer();
server.run().catch(console.error);