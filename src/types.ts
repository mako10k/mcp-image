// Type definitions for the Modal.com AI image generation API

export interface Txt2ImgRequest {
  prompt: string;
  model?: string;
  negative_prompt?: string;
  guidance_scale?: number;
  steps?: number;
  width?: number;
  height?: number;
  seed?: number;
  scheduler?: string;
  include_base64?: boolean;
  include_metadata?: boolean;
  [key: string]: unknown;
}

export interface Txt2ImgResponse {
  image_token: string;
  metadata: Record<string, unknown>;
  image_base64?: string;
  download_url?: string;
  mime_type?: string;
  used_params?: Record<string, any>;
}

export interface ImageTokenLookupResponse {
  image_token: string;
  metadata: Record<string, unknown>;
  image_base64?: string;
  download_url?: string;
  mime_type?: string;
}

export interface ModelListResponse {
  models: Record<string, ModelConfig>;
}

export interface ModelConfig {
  repo: string;
  prompt_token_limit: number;
  recommended_scheduler: string;
  recommended_guidance_scale: number;
  description: string;
  recommended_prompt: string;
  recommended_negative_prompt: string;
  recommended_parameter_guideline: string;
}

export interface ModelDetailResponse {
  model: ModelConfig;
}

export type ImageGenerationParams = Txt2ImgRequest;

// Prompt optimization parameters
export interface OptimizeParametersRequest {
  query: string;
  model?: string;
}

export interface OptimizeParametersResponse {
  prompt: string;
  negative_prompt?: string;
  model?: string;
  suggested_model?: string;
  guidance_scale?: number;
  steps?: number;
  width?: number;
  height?: number;
  seed?: number | null;
  reason?: string;
  recommended_params?: Record<string, any>;
  recommended_parameters?: Record<string, any>;
}

export interface OptimizeAndGenerateRequest extends OptimizeParametersRequest {
  generation_overrides?: Partial<Txt2ImgRequest>;
  [key: string]: unknown;
}

export interface ImageSearchParams {
  query?: string;
  model?: string;
  limit?: number;
  before?: string;
  after?: string;
}