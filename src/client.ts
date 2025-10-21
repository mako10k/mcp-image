// Modal.com AI Image API client

import axios, { AxiosInstance, AxiosResponse } from 'axios';
import {
  Txt2ImgRequest,
  Txt2ImgResponse,
  ModelListResponse,
  ModelDetailResponse,
  OptimizeParametersRequest,
  OptimizeParametersResponse,
  ImageTokenLookupResponse,
} from './types.js';

export class AiImageApiClient {
  private axiosInstance: AxiosInstance;
  private readonly jobApiUrl: string;
  private readonly jobApiHeaders: Record<string, string>;

  constructor() {
    this.axiosInstance = axios.create({
      timeout: 300000, // 5-minute timeout (image generation can take some time)
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // JOB API server URL configuration
    const envJobApiUrl = (
      process.env.JOB_API_SERVER_URL
      || process.env.JOBAPI_URL
      || process.env.MODAL_JOB_API_URL
      || ''
    ).trim();

    if (!envJobApiUrl) {
      throw new Error('JOB API server URL is required. Set JOB_API_SERVER_URL or MODAL_JOB_API_URL environment variable.');
    }

    this.jobApiUrl = envJobApiUrl;

    // API key configuration
    const jobApiKey = (
      process.env.JOBAPI_API_KEY
      || process.env.WEBUI_JOBAPI_API_KEY
      || ''
    ).trim();

    this.jobApiHeaders = jobApiKey.length > 0
      ? { 'x-api-key': jobApiKey }
      : {};
  }

  /**
   * Generate an image from text via JOB API
   */
  async generateImage(request: Txt2ImgRequest): Promise<Txt2ImgResponse> {
    try {
      const payload: Txt2ImgRequest = {
        ...request,
      };

      if (payload.include_base64 === undefined) {
        payload.include_base64 = true;
      }
      if (payload.include_metadata === undefined) {
        payload.include_metadata = true;
      }

      const response: AxiosResponse<Txt2ImgResponse> = await this.axiosInstance.post(
        `${this.jobApiUrl}/text-to-image?include_base64=${payload.include_base64 ? 'true' : 'false'}`,
        payload,
        this.jobApiHeaders ? { headers: this.jobApiHeaders } : undefined
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, 'Failed to generate image');
    }
  }

  async getImageByToken(imageToken: string): Promise<ImageTokenLookupResponse> {
    try {
      const response: AxiosResponse<ImageTokenLookupResponse> = await this.axiosInstance.get(
        `${this.jobApiUrl}/images/${encodeURIComponent(imageToken)}`,
        this.jobApiHeaders ? { headers: this.jobApiHeaders } : undefined
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, `Failed to fetch image token ${imageToken}`);
    }
  }

  /**
   * Retrieve the list of available models via JOB API
   */
  async getModels(): Promise<ModelListResponse> {
    try {
      const response: AxiosResponse<ModelListResponse> = await this.axiosInstance.get(
        `${this.jobApiUrl}/model-configs`,
        this.jobApiHeaders ? { headers: this.jobApiHeaders } : undefined
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, 'Failed to get models');
    }
  }

  /**
   * Retrieve detailed information for a specific model via JOB API
   */
  async getModelDetail(modelName: string): Promise<ModelDetailResponse> {
    try {
      const response: AxiosResponse<ModelDetailResponse> = await this.axiosInstance.get(
        `${this.jobApiUrl}/model-configs/${encodeURIComponent(modelName)}`,
        this.jobApiHeaders ? { headers: this.jobApiHeaders } : undefined
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, `Failed to get model detail for ${modelName}`);
    }
  }

  /**
   * Optimize prompt parameters via the Job Manager
   */
  async optimizeParameters(request: OptimizeParametersRequest): Promise<OptimizeParametersResponse> {
    const prompt = request.query?.trim();
    if (!prompt) {
      throw new Error('Invalid optimize prompt request: "query" is required.');
    }

    const payload = {
      prompt,
      model: (request.model ?? 'auto')?.trim() || 'auto',
    };

    try {
      const response: AxiosResponse<OptimizeParametersResponse> = await this.axiosInstance.post(
        `${this.jobApiUrl}/optimize_params_v2`,
        payload,
        this.jobApiHeaders
          ? { 
              headers: this.jobApiHeaders,
              timeout: 600000 // 10-minute timeout for JOBAPI (initial connections can be slow)
            }
          : { timeout: 600000 } // 10-minute timeout for JOBAPI (initial connections can be slow)
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, 'Failed to optimize prompt');
    }
  }

  /**
   * Error handling
   */
  private handleError(error: any, message: string): Error {
    if (axios.isAxiosError(error)) {
      const statusCode = error.response?.status;
      const errorData = error.response?.data;
      
      if (statusCode === 404) {
        return new Error(`${message}: Endpoint not found - Modal.com function not found`);
      } else if (statusCode === 500) {
        return new Error(`${message}: Server error - ${errorData?.detail || 'An internal error occurred in Modal.com'}`);
      } else if (statusCode === 400) {
        return new Error(`${message}: Bad request - ${errorData?.detail || 'Request parameters are invalid'}`);
      } else if (statusCode === 429) {
        return new Error(`${message}: Rate limit exceeded - Rate limit reached. Please wait before retrying.`);
      } else if (error.code === 'ECONNABORTED') {
        if (message.includes('optimize prompt')) {
          return new Error(`${message}: Request timeout - The JOBAPI server connection timed out (initial connections can take up to 10 minutes).`);
        }
        return new Error(`${message}: Request timeout - The request timed out (image generation can take several minutes).`);
      } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
        return new Error(`${message}: Service unavailable - Unable to reach the Modal.com service`);
      }
      
      return new Error(`${message}: ${error.message}`);
    }
    
    return new Error(`${message}: ${error.message || 'Unknown error'}`);
  }

  /**
   * Connection test
   */
  async testConnection(): Promise<boolean> {
    try {
      // Use model retrieval as the connectivity test
      await this.getModels();
      return true;
    } catch (error) {
      console.warn('Connection test failed:', error);
      return false;
    }
  }
}