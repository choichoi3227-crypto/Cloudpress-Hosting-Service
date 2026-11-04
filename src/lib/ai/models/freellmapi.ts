import { D1Like } from '../../db';

export interface FreeLLMAPIConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
}

export interface FreeLLMAPIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_calls?: any[];
  tool_call_id?: string;
}

export interface FreeLLMAPIRequest {
  model: string;
  messages: FreeLLMAPIMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: any[];
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  response_format?: { type: 'json_object' } | { type: 'text' };
}

export interface FreeLLMAPIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: FreeLLMAPIMessage;
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface StreamChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Partial<FreeLLMAPIMessage>;
    finish_reason: string | null;
  }>;
}

export class FreeLLMAPIProvider {
  private config: FreeLLMAPIConfig;
  private db?: D1Like;

  constructor(config: FreeLLMAPIConfig, db?: D1Like) {
    this.config = config;
    this.db = db;
  }

  async complete(request: FreeLLMAPIRequest): Promise<FreeLLMAPIResponse> {
    const startTime = Date.now();
    
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(request.stream ? 300000 : 120000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`FreeLLMAPI Error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as FreeLLMAPIResponse;
    
    // Log usage for cost tracking
    if (this.db && data.usage) {
      await this.logUsage({
        model: request.model,
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
        latencyMs: Date.now() - startTime,
        success: true,
      });
    }

    return data;
  }

  async *stream(request: FreeLLMAPIRequest): AsyncGenerator<StreamChunk, void, unknown> {
    const startTime = Date.now();
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({ ...request, stream: true }),
      signal: AbortSignal.timeout(300000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`FreeLLMAPI Stream Error ${response.status}: ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              if (this.db && totalOutputTokens > 0) {
                await this.logUsage({
                  model: request.model,
                  inputTokens: totalInputTokens,
                  outputTokens: totalOutputTokens,
                  latencyMs: Date.now() - startTime,
                  success: true,
                });
              }
              return;
            }
            try {
              const chunk = JSON.parse(data) as StreamChunk;
              // Estimate tokens from streaming (rough approximation)
              if (chunk.choices[0]?.delta?.content) {
                totalOutputTokens += chunk.choices[0].delta.content.length / 4;
              }
              yield chunk;
            } catch (e) {
              // Skip invalid JSON
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async logUsage(data: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    success: boolean;
  }) {
    if (!this.db) return;
    try {
      const { newId, nowIso } = await import('../../workforce');
      await this.db.prepare(
        'INSERT INTO ai_model_usage(id, model, input_tokens, output_tokens, latency_ms, success, created_at) VALUES(?,?,?,?,?,?,?)'
      ).bind(newId('usage'), data.model, data.inputTokens, data.outputTokens, data.latencyMs, data.success ? 1 : 0, nowIso(Date.now())).run();
    } catch {
      // Table might not exist yet, ignore
    }
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.config.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${this.config.apiKey}` },
      });
      if (!response.ok) return [];
      const data = await response.json() as { data: Array<{ id: string }> };
      return data.data?.map(m => m.id) || [];
    } catch {
      return [];
    }
  }
}

export function createFreeLLMAPIProvider(db?: D1Like): FreeLLMAPIProvider {
  const baseUrl = process.env.FREELLM_API_URL || 'http://127.0.0.1:31415/v1';
  const apiKey = process.env.FREELLM_API_KEY || '';
  
  if (!apiKey) {
    throw new Error('FREELLM_API_KEY environment variable is required');
  }

  return new FreeLLMAPIProvider({ baseUrl, apiKey }, db);
}
