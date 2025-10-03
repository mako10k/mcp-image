// Modal.comにデプロイされたAI画像生成APIの型定義

export interface Txt2ImgRequest {
  model?: string;
  prompt: string;
  negative_prompt?: string;
  guidance_scale?: number;
  steps?: number;
  width?: number;
  height?: number;
  seed?: number;
  scheduler?: string;
}

export interface Txt2ImgResponse {
  image_base64: string;
  used_params?: Record<string, any>;
  job_id?: string;
}

export interface ModelInfo {
  name: string;
  repo: string;
  is_sdxl?: boolean;
  recommended_params?: {
    guidance_scale?: number;
    steps?: number;
    scheduler?: string;
  };
  custom_args?: Record<string, any>;
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

export interface ErrorResponse {
  detail: string;
}

// MCP用の画像生成パラメータ
export interface ImageGenerationParams {
  prompt: string;
  style_hint?: string;
  quality_tier?: 'draft' | 'standard' | 'premium';
  size_preference?: 'small' | 'medium' | 'large';
  experimental?: boolean;
}

// 画像最適化パラメータ
export interface OptimizeParametersRequest {
  query: string;
  model?: string;
  maxIterations?: number;
}

export interface OptimizeParametersResponse {
  prompt: string;
  negative_prompt?: string;
  model?: string;
  guidance_scale?: number;
  steps?: number;
  width?: number;
  height?: number;
  seed?: number | null;
  reason?: string;
  suggested_model?: string;
  recommended_params?: Record<string, any>;
}

export interface ImageSearchParams {
  query?: string;
  model?: string;
  limit?: number;
  before?: string;
  after?: string;
}

export interface JobSubmissionResponse {
  job_id: string;
}

export interface JobStatusResponse {
  status: string;
  progress?: number | null;
  eta?: number | null;
}

export interface JobResultResponse {
  status: string;
  image_base64?: string;
  error?: string;
  used_params?: Record<string, any>;
}

export interface OptimizeAndGenerateParams {
  query: string;
  target_model?: string;
  quality_tier?: 'draft' | 'standard' | 'premium';
  size_preference?: 'small' | 'medium' | 'large';
  experimental?: boolean;
  style_hint?: string;
}