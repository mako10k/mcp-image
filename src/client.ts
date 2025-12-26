// Modal.com AI Image API client

import axios, { AxiosInstance, AxiosResponse, AxiosRequestConfig } from 'axios';
import {
  Txt2ImgRequest,
  Txt2ImgResponse,
  ModelListResponse,
  ModelDetailResponse,
  OptimizeParametersRequest,
  OptimizeParametersResponse,
  ImageTokenLookupResponse,
  ImageUploadRequest,
  ImageUploadResponse,
  ImageCaptionRequest,
  ImageCaptionResponse,
  UpscaleRequest,
  UpscaleJobStatusResponse,
  JobResultResponse,
  ImageToImageJobRequest,
  ImageToImageJobResponse,
  ImageUrlUploadRequest,
  ImageMetadataPatch,
  ImageMetadataResponse,
  ImageToImageJobCreationResponse,
  SegmentationJobRequest,
  SegmentationJobResponse,
} from './types.js';

export class AiImageApiClient {
  private axiosInstance: AxiosInstance;
  private readonly jobApiUrl: string;
  private readonly jobApiHeaders: Record<string, string>;

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

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

  private buildRequestConfig(extra?: AxiosRequestConfig): AxiosRequestConfig | undefined {
    const hasHeaders = Object.keys(this.jobApiHeaders).length > 0;
    if (!extra && !hasHeaders) {
      return undefined;
    }

    const config: AxiosRequestConfig = { ...(extra ?? {}) };
    if (hasHeaders) {
      const existingHeaders = (extra?.headers ?? {}) as Record<string, string>;
      config.headers = {
        ...this.jobApiHeaders,
        ...existingHeaders,
      };
    }

    return config;
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
        this.buildRequestConfig()
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
        this.buildRequestConfig()
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, `Failed to fetch image token ${imageToken}`);
    }
  }

  /**
   * Download an image token as base64.
   *
   * Some JOBAPI deployments return a JSON payload for `/images/{token}` (with `image_base64`).
   * Others return a binary image (e.g., `image/png`). This helper supports both.
   */
  async downloadImageBase64(imageToken: string): Promise<string> {
    try {
      const isLikelyImageBytes = (buf: Buffer): boolean => {
        // PNG: 89 50 4E 47 0D 0A 1A 0A
        if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
          return true;
        }
        // JPEG: FF D8 FF
        if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
          return true;
        }
        return false;
      };

      const fetchArrayBuffer = async (url: string) => {
        return await this.axiosInstance.get(url, {
          ...this.buildRequestConfig(),
          responseType: 'arraybuffer',
        });
      };

      const fetchWithRetry = async (url: string, attempts = 4): Promise<AxiosResponse<ArrayBuffer>> => {
        let lastError: unknown;
        for (let attempt = 1; attempt <= attempts; attempt++) {
          try {
            return await fetchArrayBuffer(url);
          } catch (err) {
            lastError = err;

            // Segment/SAM results can be eventually-consistent; retry a few times on transient statuses.
            const status = axios.isAxiosError(err) ? err.response?.status : undefined;
            const shouldRetry = status === 404 || (status !== undefined && status >= 500);

            if (!shouldRetry || attempt === attempts) {
              throw err;
            }

            const backoffMs = 200 * Math.pow(2, attempt - 1);
            await this.sleep(backoffMs);
          }
        }

        throw lastError instanceof Error ? lastError : new Error('Failed to fetch image bytes');
      };

      // Prefer explicit binary format first (common JOBAPI behavior)
      const binaryUrl = `${this.jobApiUrl}/images/${encodeURIComponent(imageToken)}?format=binary`;
      const binaryResp = await fetchWithRetry(binaryUrl);
      const binaryContentType = (binaryResp.headers?.['content-type'] ?? '').toString().toLowerCase();
      const binaryBuffer = Buffer.from(binaryResp.data as ArrayBuffer);

      if (binaryContentType.startsWith('image/') || isLikelyImageBytes(binaryBuffer)) {
        return binaryBuffer.toString('base64');
      }

      // If server returned JSON (or anything else), try JSON format with base64 included
      const jsonUrl = `${this.jobApiUrl}/images/${encodeURIComponent(imageToken)}?format=json&include_base64=true`;
      const jsonResp = await fetchWithRetry(jsonUrl);
      const jsonContentType = (jsonResp.headers?.['content-type'] ?? '').toString().toLowerCase();
      const jsonBuffer = Buffer.from(jsonResp.data as ArrayBuffer);

      if (jsonContentType.startsWith('image/') || isLikelyImageBytes(jsonBuffer)) {
        return jsonBuffer.toString('base64');
      }

      const text = jsonBuffer.toString('utf8');
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const base64 = typeof parsed.image_base64 === 'string' ? parsed.image_base64 : undefined;
      if (!base64) {
        throw new Error('JSON response did not include image_base64');
      }
      return base64;
    } catch (error) {
      throw this.handleError(error, `Failed to download image base64 for token ${imageToken}`);
    }
  }
  /**
   * Retrieve the list of available models via JOB API
   */
  async getModels(): Promise<ModelListResponse> {
    try {
      const response: AxiosResponse<ModelListResponse> = await this.axiosInstance.get(
        `${this.jobApiUrl}/model-configs`,
        this.buildRequestConfig()
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
        this.buildRequestConfig()
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
        this.buildRequestConfig({ timeout: 600000 })
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, 'Failed to optimize prompt');
    }
  }

  async captionImage(request: ImageCaptionRequest): Promise<ImageCaptionResponse> {
    try {
      const response: AxiosResponse<ImageCaptionResponse> = await this.axiosInstance.post(
        `${this.jobApiUrl}/images/caption`,
        request,
        this.buildRequestConfig()
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, 'Failed to caption image');
    }
  }

  async uploadImage(request: ImageUploadRequest): Promise<ImageUploadResponse> {
    try {
      const response: AxiosResponse<ImageUploadResponse> = await this.axiosInstance.post(
        `${this.jobApiUrl}/images/store`,
        request,
        this.buildRequestConfig()
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, 'Failed to upload image');
    }
  }

  async storeImageFromUrl(request: ImageUrlUploadRequest): Promise<ImageUploadResponse> {
    try {
      const response: AxiosResponse<ImageUploadResponse> = await this.axiosInstance.post(
        `${this.jobApiUrl}/images/store-from-url`,
        request,
        this.buildRequestConfig()
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, 'Failed to store image from URL');
    }
  }

  async patchImageMetadata(imageToken: string, patch: ImageMetadataPatch): Promise<ImageMetadataResponse> {
    try {
      const response: AxiosResponse<ImageMetadataResponse> = await this.axiosInstance.patch(
        `${this.jobApiUrl}/images/${encodeURIComponent(imageToken)}/meta`,
        patch,
        this.buildRequestConfig()
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, `Failed to patch metadata for image token ${imageToken}`);
    }
  }

  async upscaleImage(request: UpscaleRequest): Promise<UpscaleJobStatusResponse> {
    try {
      const response: AxiosResponse<UpscaleJobStatusResponse> = await this.axiosInstance.post(
        `${this.jobApiUrl}/upscale`,
        request,
        this.buildRequestConfig()
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, 'Failed to upscale image');
    }
  }

  async getJobStatus(jobId: string): Promise<Record<string, unknown>> {
    try {
      const response: AxiosResponse<Record<string, unknown>> = await this.axiosInstance.get(
        `${this.jobApiUrl}/jobs/${encodeURIComponent(jobId)}/status`,
        this.buildRequestConfig()
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, `Failed to fetch job status for ${jobId}`);
    }
  }

  async getJobResult(jobId: string, includeBase64 = false): Promise<JobResultResponse> {
    try {
      const response: AxiosResponse<JobResultResponse> = await this.axiosInstance.get(
        `${this.jobApiUrl}/jobs/${encodeURIComponent(jobId)}/result`,
        this.buildRequestConfig({ params: { include_base64: includeBase64 } })
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, `Failed to fetch job result for ${jobId}`);
    }
  }

  async imageToImage(
    request: ImageToImageJobRequest,
    options?: { includeBase64?: boolean }
  ): Promise<ImageToImageJobResponse> {
    try {
      const includeBase64 = options?.includeBase64 ?? true;
      const response: AxiosResponse<ImageToImageJobResponse> = await this.axiosInstance.post(
        `${this.jobApiUrl}/image-to-image`,
        request,
        this.buildRequestConfig({ params: { include_base64: includeBase64 } })
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, 'Failed to perform image-to-image conversion');
    }
  }

  async createImageToImageJob(request: ImageToImageJobRequest): Promise<ImageToImageJobCreationResponse> {
    try {
      const response: AxiosResponse<ImageToImageJobCreationResponse> = await this.axiosInstance.post(
        `${this.jobApiUrl}/jobs/image-to-image`,
        request,
        this.buildRequestConfig()
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, 'Failed to enqueue image-to-image job');
    }
  }

  async segmentImage(request: SegmentationJobRequest): Promise<SegmentationJobResponse> {
    try {
      const response: AxiosResponse<SegmentationJobResponse> = await this.axiosInstance.post(
        `${this.jobApiUrl}/images/segment`,
        request,
        this.buildRequestConfig()
      );
      return response.data;
    } catch (error) {
      throw this.handleError(error, 'Failed to segment image');
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
        const lower = message.toLowerCase();
        const isImageTokenLookup = lower.includes('image token') || lower.includes('image base64') || lower.includes('metadata for image token');
        if (isImageTokenLookup) {
          return new Error(`${message}: Image not found`);
        }
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