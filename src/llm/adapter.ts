export type ChatMessage = { role: 'system'|'user'|'assistant'|'tool'; content: string | null; name?: string; tool_call_id?: string; tool_calls?: ToolCall[] };
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type LlmReply = { message: ChatMessage; usage?: { total_tokens?: number } };
export interface LlmAdapter { enviar(mensajes: ChatMessage[], herramientas: unknown[]): Promise<LlmReply> }

export class OpenAiAdapter implements LlmAdapter {
  constructor(private apiKey: string, private model: string, private timeoutMs = 45000) {}
  async enviar(mensajes: ChatMessage[], herramientas: unknown[]): Promise<LlmReply> {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, messages: mensajes, tools: herramientas, tool_choice: 'auto', max_tokens: 1800 }),
      });
      if (!response.ok) { const detail = await response.text(); throw new Error(`Proveedor LLM respondió ${response.status}: ${detail.slice(0, 500)}`); }
      const data = await response.json() as { choices?: { message?: ChatMessage }[]; usage?: { total_tokens?: number } };
      const message = data.choices?.[0]?.message; if (!message) throw new Error('El proveedor no devolvió respuesta.');
      return { message, usage: data.usage };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('Tiempo de espera agotado al consultar el modelo.');
      throw error;
    } finally { clearTimeout(timeout); }
  }
}

export function createAdapter(): LlmAdapter {
  const provider = process.env.LLM_PROVIDER ?? 'openai';
  if (provider !== 'openai') throw new Error(`Proveedor no implementado: ${provider}. Configure LLM_PROVIDER=openai.`);
  const key = process.env.LLM_API_KEY; if (!key) throw new Error('Falta LLM_API_KEY. Configure la clave en el entorno del backend.');
  return new OpenAiAdapter(key, process.env.LLM_MODEL ?? 'gpt-4o-mini');
}
