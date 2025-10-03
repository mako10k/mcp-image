// Modal.com AI Image API クライアント

import axios, { AxiosInstance, AxiosError, AxiosResponse } from 'axios';
import {
  Txt2ImgRequest,
  Txt2ImgResponse,
  ModelListResponse,
  ModelDetailResponse,
  OptimizeParametersRequest,
  OptimizeParametersResponse,
  JobSubmissionResponse,
  JobStatusResponse,
  JobResultResponse,
} from './types.js';

class JobManagerUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'JobManagerUnavailableError';
  }
}

class JobExecutionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'JobExecutionError';
  }
}

export class AiImageApiClient {
  private axiosInstance: AxiosInstance;
  private readonly jobManagerUrl: string;
  private readonly jobApiKey?: string;

  private static readonly JOB_POLL_INTERVAL_MS = 1500;
  private static readonly JOB_POLL_TIMEOUT_MS = 300000; // 5 minutes

  // Modal.comのエンドポイントURL（GitHubリポジトリから取得）
  private static readonly BASE_URLS = {
    TEXT_TO_IMAGE: 'https://mako10k--ai-image-api-text-to-image.modal.run',
    GET_MODELS: 'https://mako10k--ai-image-api-get-model-configs.modal.run',
    GET_MODEL_DETAIL: 'https://mako10k--ai-image-api-get-model-detail.modal.run',
    JOB_MANAGER: 'https://mako10k--ai-image-jobapi-serve.modal.run', // Job Manager API（オプション）
  };

  constructor() {
    this.axiosInstance = axios.create({
      timeout: 300000, // 5分タイムアウト（画像生成は時間がかかる場合がある）
      headers: {
        'Content-Type': 'application/json',
      },
    });

    const jobApiUrlCandidates = [
      process.env.JOBAPI_URL,
      process.env.JOB_MANAGER_URL,
      process.env.JOBAPI_BASE_URL,
    ];

    const resolvedJobApiUrl = jobApiUrlCandidates.find((value) => typeof value === 'string' && value.trim().length > 0);
    this.jobManagerUrl = (resolvedJobApiUrl ?? AiImageApiClient.BASE_URLS.JOB_MANAGER).trim();

    const jobApiKeyCandidates = [
      process.env.JOBAPI_API_KEY,
      process.env.WEBUI_JOBAPI_API_KEY,
    ];

    const resolvedJobApiKey = jobApiKeyCandidates.find((value) => typeof value === 'string' && value.trim().length > 0);
    this.jobApiKey = resolvedJobApiKey?.trim();
  }

  /**
   * テキストから画像を生成
   */
  async generateImage(request: Txt2ImgRequest): Promise<Txt2ImgResponse> {
    try {
      return await this.generateViaJobManager(request);
    } catch (error) {
      if (error instanceof JobManagerUnavailableError) {
        console.warn('[AI Image] Job Manager unavailable, falling back to direct Modal API');
        return this.generateViaModalDirect(request);
      }

      if (axios.isAxiosError(error)) {
        const connectionIssue = !error.response && (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND');
        if (connectionIssue) {
          console.warn('[AI Image] Job Manager connection failed, falling back to direct Modal API');
          return this.generateViaModalDirect(request);
        }
      }

      if (error instanceof JobExecutionError) {
        throw error;
      }

      throw this.handleError(error, 'Failed to generate image');
    }
  }

  private async generateViaModalDirect(request: Txt2ImgRequest): Promise<Txt2ImgResponse> {
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

  private async generateViaJobManager(request: Txt2ImgRequest): Promise<Txt2ImgResponse> {
    const jobPayload = this.buildJobPayload(request);

    let submission: AxiosResponse<JobSubmissionResponse>;

    try {
      const headers = this.buildJobHeaders();
      submission = await this.axiosInstance.post(
        `${this.jobManagerUrl}/jobs`,
        jobPayload,
        headers ? { headers } : undefined
      );
    } catch (error) {
      throw this.asJobManagerUnavailable(error);
    }

    const jobId = submission.data?.job_id;
    if (!jobId) {
      throw new JobExecutionError('Job Manager did not return a job_id');
    }

    const startTime = Date.now();

    while (Date.now() - startTime < AiImageApiClient.JOB_POLL_TIMEOUT_MS) {
  const status = await this.fetchJobStatus(jobId);

      if (status.status === 'completed') {
  const result = await this.fetchJobResult(jobId);

        if (result.status === 'completed' && result.image_base64) {
          return {
            image_base64: result.image_base64,
            used_params: result.used_params,
            job_id: jobId,
          };
        }

        if (result.error) {
          throw new JobExecutionError(`Job completed with error: ${result.error}`);
        }

        throw new JobExecutionError('Job completed without image data');
      }

      if (status.status === 'errored' || status.status === 'failed') {
        throw new JobExecutionError(`Job execution failed with status: ${status.status}`);
      }

      await this.delay(AiImageApiClient.JOB_POLL_INTERVAL_MS);
    }

    throw new JobExecutionError('Job polling timed out');
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
    const headers = this.buildJobHeaders();
    const payload = this.buildOptimizePayload(request);

    try {
      const response: AxiosResponse<OptimizeParametersResponse> = await this.axiosInstance.post(
        `${this.jobManagerUrl}/optimize_params_v2`,
        payload,
        headers ? { headers } : undefined
      );
      return this.normalizeOptimizeResponse(response.data, payload.prompt, request);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;

        if (status === 404) {
          console.warn('[AI Image] optimize_params_v2 not found, attempting legacy optimize_params endpoint');
          try {
            const legacyResponse: AxiosResponse<OptimizeParametersResponse> = await this.axiosInstance.post(
              `${this.jobManagerUrl}/optimize_params`,
              { query: request.query, model: request.model },
              headers ? { headers } : undefined
            );
            return this.normalizeOptimizeResponse(legacyResponse.data, payload.prompt, request);
          } catch (legacyError) {
            if (axios.isAxiosError(legacyError)) {
              const legacyUnavailable = !legacyError.response || legacyError.response.status >= 500;
              if (!legacyUnavailable) {
                throw this.handleError(legacyError, 'Failed to optimize prompt');
              }
            } else {
              console.warn('[AI Image] Legacy optimize_params endpoint raised non-Axios error, using basic optimization');
              return this.basicOptimization(request);
            }

            console.warn('[AI Image] Legacy optimize_params endpoint unavailable, using basic optimization');
            return this.basicOptimization(request);
          }
        }

        const isUnavailable = !error.response || (status !== undefined && status >= 500);
        if (!isUnavailable) {
          throw this.handleError(error, 'Failed to optimize prompt');
        }
      }

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
      model: model || 'dreamshaper8',
      guidance_scale: 7.5,
      steps: 20,
      width: 512,
      height: 512,
      seed: null,
      recommended_params: {
        guidance_scale: 7.5,
        steps: 20,
        width: 512,
        height: 512,
        seed: null,
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

  private buildJobPayload(request: Txt2ImgRequest): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      prompt: request.prompt,
      negative_prompt: request.negative_prompt,
      model: request.model,
      guidance_scale: request.guidance_scale,
      steps: request.steps,
      width: request.width,
      height: request.height,
      seed: request.seed,
    };

    Object.keys(payload).forEach((key) => {
      if (payload[key] === undefined || payload[key] === null) {
        delete payload[key];
      }
    });

    return payload;
  }

  private async fetchJobStatus(jobId: string): Promise<JobStatusResponse> {
    try {
      const headers = this.buildJobHeaders();
      const response: AxiosResponse<JobStatusResponse> = await this.axiosInstance.get(
        `${this.jobManagerUrl}/jobs/${jobId}/status`,
        headers ? { headers } : undefined
      );
      return response.data;
    } catch (error) {
      throw this.asJobManagerUnavailable(error);
    }
  }

  private async fetchJobResult(jobId: string): Promise<JobResultResponse> {
    try {
      const headers = this.buildJobHeaders();
      const response: AxiosResponse<JobResultResponse> = await this.axiosInstance.get(
        `${this.jobManagerUrl}/jobs/${jobId}/result`,
        headers ? { headers } : undefined
      );
      return response.data;
    } catch (error) {
      throw this.asJobManagerUnavailable(error);
    }
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private buildOptimizePayload(request: OptimizeParametersRequest): { prompt: string; model: string; max_iter?: number } {
    const prompt = request.query?.trim();
    if (!prompt) {
      throw new Error('OptimizeParametersRequest.query is required');
    }

    const payload: { prompt: string; model: string; max_iter?: number } = {
      prompt,
      model: request.model?.trim() || 'auto',
    };

    const { maxIterations } = request;
    if (maxIterations !== undefined) {
      const numeric = Number(maxIterations);
      if (Number.isFinite(numeric) && numeric > 0) {
        const bounded = Math.min(Math.max(Math.floor(numeric), 1), 20);
        payload.max_iter = bounded;
      }
    }

    if (payload.max_iter === undefined) {
      payload.max_iter = 5;
    }

    return payload;
  }

  private normalizeOptimizeResponse(
    response: any,
    fallbackPrompt: string,
    request: OptimizeParametersRequest,
  ): OptimizeParametersResponse {
    if (!response || typeof response !== 'object') {
      return this.basicOptimization(request);
    }

    const normalized: Record<string, any> = { ...response };

    if (!normalized.prompt) {
      normalized.prompt = fallbackPrompt;
    }

    if (!normalized.model && request.model) {
      normalized.model = request.model;
    }

    if (normalized.recommended_parameters && !normalized.recommended_params) {
      normalized.recommended_params = normalized.recommended_parameters;
      delete normalized.recommended_parameters;
    }

    return normalized as OptimizeParametersResponse;
  }

  private asJobManagerUnavailable(error: unknown): JobManagerUnavailableError {
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;

      if (!axiosError.response) {
        throw new JobManagerUnavailableError('Job Manager is unreachable', { cause: error });
      }

      if (axiosError.response.status >= 500) {
        throw new JobManagerUnavailableError('Job Manager returned server error', { cause: error });
      }

      throw new JobExecutionError(`Job Manager error: ${axiosError.response.status}`, { cause: error });
    }

    throw new JobManagerUnavailableError('Job Manager error', { cause: error });
  }

  private buildJobHeaders(): Record<string, string> | undefined {
    if (!this.jobApiKey) {
      return undefined;
    }

    return {
      'x-api-key': this.jobApiKey,
    };
  }
}