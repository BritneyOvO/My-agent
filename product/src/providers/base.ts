export type LLMResponse = {
  text: string;
  model: string;
  usage: Record<string, unknown>;
  raw?: Record<string, unknown>;
};

export interface BaseProvider {
  readonly name: string;
  complete(prompt: string, system?: string, maxTokens?: number): Promise<LLMResponse> | LLMResponse;
  available(): boolean;
}

export class LocalAgentProvider implements BaseProvider {
  readonly name = "local_agent";

  available() {
    return true;
  }

  complete(): LLMResponse {
    return {
      text: "[local agent mode: reasoning handled by calling agent, not via API]",
      model: "local-claude-code",
      usage: {}
    };
  }
}

export class OpenAICompatibleProvider implements BaseProvider {
  readonly name = "openai_compatible";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(
    apiKey = process.env.Z3GH0NE_OPENAI_KEY ?? "",
    baseUrl = process.env.Z3GH0NE_OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    model = process.env.Z3GH0NE_OPENAI_MODEL ?? "gpt-4o"
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.model = model;
  }

  available() {
    return Boolean(this.apiKey);
  }

  async complete(prompt: string, system = "", maxTokens = 4096): Promise<LLMResponse> {
    if (!this.available()) {
      return { text: "[provider not configured]", model: this.model, usage: {} };
    }

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: system || "You are z3gh0ne, a security analysis assistant." },
            { role: "user", content: prompt }
          ]
        })
      });
      const data = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: Record<string, unknown>;
      };
      return {
        text: data.choices?.[0]?.message?.content ?? "",
        model: this.model,
        usage: data.usage ?? {},
        raw: data as Record<string, unknown>
      };
    } catch (error) {
      return { text: `[error: ${String(error).slice(0, 200)}]`, model: this.model, usage: {} };
    }
  }
}

export class AnthropicProvider implements BaseProvider {
  readonly name = "anthropic";
  private readonly apiKey: string;
  private readonly model: string;

  constructor(
    apiKey = process.env.Z3GH0NE_ANTHROPIC_KEY ?? "",
    model = process.env.Z3GH0NE_ANTHROPIC_MODEL ?? "claude-sonnet-4-6"
  ) {
    this.apiKey = apiKey;
    this.model = model;
  }

  available() {
    return Boolean(this.apiKey);
  }

  async complete(prompt: string, system = "", maxTokens = 4096): Promise<LLMResponse> {
    if (!this.available()) {
      return { text: "[provider not configured]", model: this.model, usage: {} };
    }

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: maxTokens,
          system: system || "You are z3gh0ne, a security analysis assistant.",
          messages: [{ role: "user", content: prompt }]
        })
      });
      const data = await response.json() as {
        content?: Array<{ text?: string }>;
        usage?: Record<string, unknown>;
      };
      return {
        text: data.content?.map((block) => block.text ?? "").join("") ?? "",
        model: this.model,
        usage: data.usage ?? {},
        raw: data as Record<string, unknown>
      };
    } catch (error) {
      return { text: `[error: ${String(error).slice(0, 200)}]`, model: this.model, usage: {} };
    }
  }
}

export class ProviderRegistry {
  private readonly providers = new Map<string, BaseProvider>();
  private defaultProvider: string | null = null;

  register(provider: BaseProvider, options: { default?: boolean } = {}) {
    this.providers.set(provider.name, provider);
    if (options.default || !this.defaultProvider) {
      this.defaultProvider = provider.name;
    }
  }

  get(name?: string) {
    const key = name ?? this.defaultProvider;
    return key ? this.providers.get(key) : undefined;
  }

  listAvailable() {
    return [...this.providers.values()].filter((provider) => provider.available()).map((provider) => provider.name);
  }

  static createDefault() {
    const registry = new ProviderRegistry();
    registry.register(new LocalAgentProvider(), { default: true });
    registry.register(new AnthropicProvider());
    registry.register(new OpenAICompatibleProvider());
    return registry;
  }
}
