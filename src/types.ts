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

export interface ImageUploadRequest {
  image_base64: string;
  source?: string;
  prompt?: string;
  negative_prompt?: string;
  parameters?: Record<string, unknown>;
  derived_from?: string[];
  tags?: string[];
  extra?: Record<string, unknown>;
  filename?: string;
}

export interface ImageUploadResponse {
  image_token: string;
  metadata: Record<string, unknown>;
}

export interface ImageUrlUploadRequest {
  url: string;
  source?: string;
  prompt?: string;
  negative_prompt?: string;
  parameters?: Record<string, unknown>;
  derived_from?: string[];
  tags?: string[];
  extra?: Record<string, unknown>;
  filename?: string;
  timeout?: number;
  max_bytes?: number;
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

export interface ImageCaptionRequest {
  image_token?: string;
  image_base64?: string;
  prompt?: string;
  max_new_tokens?: number;
  temperature?: number;
  top_p?: number;
  use_nucleus_sampling?: boolean;
  repetition_penalty?: number;
  model_id?: string;
}

export interface ImageCaptionResponse {
  caption: string;
  model_id: string;
  device: string;
  dtype: string;
  metadata: Record<string, unknown>;
  image_token?: string;
  image_metadata?: Record<string, unknown>;
}

export interface UpscaleRequest {
  image_token: string;
  scale?: number;
}

export interface UpscaleJobStatusResponse {
  job_id: string;
  status: string;
}

export interface JobResultResponse {
  status: string;
  image_token?: string;
  metadata?: Record<string, unknown>;
  image_base64?: string;
  error?: string;
}

export interface ImageToImageJobRequest {
  prompt: string;
  init_image_token: string;
  negative_prompt?: string;
  model?: string;
  guidance_scale?: number;
  steps?: number;
  width?: number;
  height?: number;
  seed?: number;
  strength?: number;
}

export interface ImageToImageJobResponse {
  image_token: string;
  metadata: Record<string, unknown>;
  used_params: Record<string, unknown>;
  image_base64?: string;
}

export interface ImageToImageJobCreationResponse {
  job_id: string;
  status?: string;
  [key: string]: unknown;
}

export interface ImageMetadataPatch {
  prompt?: string;
  negative_prompt?: string;
  parameters?: Record<string, unknown>;
  tags?: string[];
  derived_from?: string[];
  caption?: string;
  caption_model_id?: string;
  captioned_at?: number;
  embedding?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface ImageMetadataResponse {
  metadata: Record<string, unknown>;
}

export interface ImageSearchParams {
  query?: string;
  model?: string;
  limit?: number;
  before?: string;
  after?: string;
}