// Modal.com AI Image API クライアント

import axios, { AxiosInstance, AxiosResponse } from 'axios';
import {
  Txt2ImgRequest,
  Txt2ImgResponse,
  ModelListResponse,
  ModelDetailResponse,
  OptimizeParametersRequest,
  OptimizeParametersResponse,
} from './types.js';

export class AiImageApiClient {
  private axiosInstance: AxiosInstance;

  // Modal.comのエンドポイントURL（GitHubリポジトリから取得）
  private static readonly BASE_URLS = {
    TEXT_TO_IMAGE: 'https://mako10k--ai-image-api-text-to-image.modal.run',
    GET_MODELS: 'https://mako10k--ai-image-api-get-model-configs.modal.run',
    GET_MODEL_DETAIL: 'https://mako10k--ai-image-api-get-model-detail.modal.run',
    JOB_MANAGER: 'http://localhost:8099', // Job Manager API（オプション）
  };

  constructor() {
    this.axiosInstance = axios.create({
      timeout: 300000, // 5分タイムアウト（画像生成は時間がかかる場合がある）
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  /**
   * テキストから画像を生成
   */
  async generateImage(request: Txt2ImgRequest): Promise<Txt2ImgResponse> {
    try {
      const response: AxiosResponse<Txt2ImgResponse> = await this.axiosInstance.post(
        AiImageApiClient.BASE_URLS.TEXT_TO_IMAGE,
        request
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, 'Failed to generate image');
    }
  }

  /**
   * 利用可能なモデル一覧を取得
   */
  async getModels(): Promise<ModelListResponse> {
    try {
      const response: AxiosResponse<ModelListResponse> = await this.axiosInstance.get(
        AiImageApiClient.BASE_URLS.GET_MODELS
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, 'Failed to get models');
    }
  }

  /**
   * 特定のモデルの詳細情報を取得
   */
  async getModelDetail(modelName: string): Promise<ModelDetailResponse> {
    try {
      // まずモデル一覧を取得
      const modelsResponse = await this.getModels();
      const model = modelsResponse.models[modelName];
      
      if (!model) {
        throw new Error(`Model "${modelName}" not found`);
      }
      
      return { model };
    } catch (error) {
      throw this.handleError(error, `Failed to get model detail for ${modelName}`);
    }
  }

  /**
   * プロンプト最適化（Job Manager経由）
   */
  async optimizeParameters(request: OptimizeParametersRequest): Promise<OptimizeParametersResponse> {
    try {
      const response: AxiosResponse<OptimizeParametersResponse> = await this.axiosInstance.post(
        `${AiImageApiClient.BASE_URLS.JOB_MANAGER}/api/optimize_params`,
        request
      );
      return response.data;
    } catch (error) {
      // Job Managerが利用できない場合は基本的な最適化を返す
      console.warn('Job Manager not available, using basic optimization');
      return this.basicOptimization(request);
    }
  }

  /**
   * 基本的なプロンプト最適化
   */
  private basicOptimization(request: OptimizeParametersRequest): OptimizeParametersResponse {
    const { query, model } = request;
    
    // シンプルなプロンプト強化
    let optimizedPrompt = query;
    if (!query.includes('high quality')) {
      optimizedPrompt += ', high quality';
    }
    if (!query.includes('detailed')) {
      optimizedPrompt += ', detailed';
    }

    return {
      prompt: optimizedPrompt,
      negative_prompt: 'blurry, low quality, bad anatomy',
      suggested_model: model || 'dreamshaper8',
      recommended_params: {
        guidance_scale: 7.5,
        steps: 20,
        width: 512,
        height: 512,
      },
    };
  }

  /**
   * エラーハンドリング
   */
  private handleError(error: any, message: string): Error {
    if (axios.isAxiosError(error)) {
      const statusCode = error.response?.status;
      const errorData = error.response?.data;
      
      if (statusCode === 404) {
        return new Error(`${message}: Endpoint not found - Modal.com関数が見つかりません`);
      } else if (statusCode === 500) {
        return new Error(`${message}: Server error - ${errorData?.detail || 'Modal.comで内部エラーが発生しました'}`);
      } else if (statusCode === 400) {
        return new Error(`${message}: Bad request - ${errorData?.detail || 'リクエストパラメータが無効です'}`);
      } else if (statusCode === 429) {
        return new Error(`${message}: Rate limit exceeded - レート制限に到達しました。しばらく待ってから再試行してください`);
      } else if (error.code === 'ECONNABORTED') {
        return new Error(`${message}: Request timeout - リクエストがタイムアウトしました（画像生成には数分かかる場合があります）`);
      } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        return new Error(`${message}: Service unavailable - Modal.comサービスに接続できません`);
      }
      
      return new Error(`${message}: ${error.message}`);
    }
    
    return new Error(`${message}: ${error.message || 'Unknown error'}`);
  }

  /**
   * 接続テスト
   */
  async testConnection(): Promise<boolean> {
    try {
      // モデル一覧取得で接続テスト
      await this.getModels();
      return true;
    } catch (error) {
      console.warn('Connection test failed:', error);
      return false;
    }
  }
}