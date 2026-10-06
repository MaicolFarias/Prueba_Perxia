import { createServer } from 'node:http';
import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAdapter, type ChatMessage, type ToolCall } from './llm/adapter.js';
import { invokeTool, toolDefinitions } from './tools/contratos.js';

const root = process.cwd();
try {
  const envFile = readFileSync(path.join(root, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]!] === undefined) process.env[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
} catch { /* .env is optional when environment variables are already supplied by the host. */ }
const port = Number(process.env.PORT ?? 3000);
type ToolEvent = { name: string; arguments: unknown; result: unknown; ok: boolean };
type Session = { id: string; messages: ChatMessage[]; tools: ToolEvent[]; pending: Set<string>; approved: Set<string>; tokens: number; needsConfirmation: boolean; updated: string };
const sessions = new Map<string, Session>();
const prompt = await readFile(path.join(root, 'agent', 'prompt.md'), 'utf8');
const maxIterations = Math.max(1, Number(process.env.MAX_TOOL_ITERATIONS ?? 25));
const maxTokens = Math.max(1000, Number(process.env.MAX_SESSION_TOKENS ?? 20000));
const maxDailyTokens = Math.max(1000, Number(process.env.MAX_DAILY_TOKENS ?? 200000));
let dailyTokens = 0; let budgetDay = new Date().toISOString().slice(0, 10);
const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)); };
async function bodyJson(req: import('node:http').IncomingMessage) { let raw = ''; for await (const chunk of req) raw += chunk; if (raw.length > 1_000_000) throw new Error('Solicitud demasiado grande.'); return JSON.parse(raw || '{}') as Record<string, unknown>; }
function summarize(result: unknown) { const text = typeof result === 'string' ? result : JSON.stringify(result); return text.length > 900 ? `${text.slice(0, 900)}…` : text; }
function affirmative(text: string) { return /\b(confirmo|confirmamos|confirmado|confirmada|apruebo|autorizo|acepto|s[ií],? (confirmo|adelante|procede)|procede|registrar)\b/i.test(text); }

async function chat(session: Session, text: string) {
  session.updated = new Date().toISOString(); const clean = text.trim();
  if (!clean) throw new Error('Escribe un mensaje para iniciar.');
  if (session.pending.size && affirmative(clean)) for (const id of session.pending) session.approved.add(id);
  session.messages.push({ role: 'user', content: clean });
  const events: ToolEvent[] = []; let reply = ''; let iterations = 0; let addedTokens = 0;
  let adapter;
  try { adapter = createAdapter(); } catch (err) { session.messages.pop(); throw err; }
  while (iterations < maxIterations) {
    const result = await adapter.enviar(session.messages, toolDefinitions());
    const usage = result.usage?.total_tokens ?? 0;
    const currentDay = new Date().toISOString().slice(0, 10); if (currentDay !== budgetDay) { budgetDay = currentDay; dailyTokens = 0; }
    if (usage && dailyTokens + usage > maxDailyTokens) { reply = 'Se alcanzó el límite diario de uso del agente. Intenta de nuevo más tarde.'; break; }
    if (usage && session.tokens + addedTokens + usage > maxTokens) { reply = 'Se alcanzó el límite de tokens de esta sesión. Inicia una sesión nueva para continuar.'; break; }
    dailyTokens += usage;
    addedTokens += usage;
    session.messages.push(result.message);
    const calls: ToolCall[] = result.message.tool_calls ?? [];
    if (!calls.length) { reply = result.message.content ?? ''; break; }
    for (const call of calls) {
      iterations++;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.function.arguments) as Record<string, unknown>; } catch { args = {}; }
      let rawResult: string;
      const requiresApproval = ['contratos_registrar', 'contratos_validar'].includes(call.function.name) && args.confirmado === true && !session.approved.has(String(args.mensaje_id));
      if (requiresApproval) {
        rawResult = JSON.stringify({ ok: false, error: 'Se requiere confirmación explícita de la analista en un mensaje previo.' });
      } else rawResult = await invokeTool(call.function.name, args, { directory: root, sessionId: session.id });
      let parsed: unknown; try { parsed = JSON.parse(rawResult); } catch { parsed = rawResult; }
      const isOk = Boolean((parsed as {ok?: boolean})?.ok);
      const event = { name: call.function.name, arguments: args, result: parsed, ok: isOk }; events.push(event); session.tools.push(event);
      if (call.function.name === 'contratos_validar' && isOk) {
        const data = (parsed as {data?: {requiere_revision?: string[]; clasificacion?: string}}).data;
        const id = String(args.mensaje_id ?? '');
        if ((data?.requiere_revision?.length ?? 0) > 0 && data?.clasificacion !== 'duplicado' && id) { session.pending.add(id); session.needsConfirmation = true; }
        else { session.pending.delete(id); }
      }
      if (call.function.name === 'contratos_registrar' && isOk) {
        const id = String(args.mensaje_id ?? ''); session.pending.delete(id); session.approved.delete(id); session.needsConfirmation = session.pending.size > 0;
      }
      session.messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: rawResult });
      if (iterations >= maxIterations) break;
    }
    if (iterations >= maxIterations) { reply = 'Alcancé el límite de pasos de herramientas. Revisa los resultados mostrados y dime cómo deseas continuar.'; break; }
  }
  if (addedTokens + session.tokens > maxTokens) {
    const err = new Error('Se alcanzó el límite de tokens de esta sesión. Inicia una sesión nueva para continuar.');
    session.messages.pop(); throw err;
  }
  session.tokens += addedTokens; session.updated = new Date().toISOString();
  if (reply) session.messages.push({ role: 'assistant', content: reply });
  await mkdir(path.join(root, 'out'), { recursive: true });
  await appendFile(path.join(root, 'out', 'log.jsonl'), `${JSON.stringify({ ts: session.updated, herramienta: 'chat', mensaje_id: session.id, ok: true, resumen: `turno; ${events.length} llamadas` })}\n`);
  return { reply, toolCalls: events, needsConfirmation: session.needsConfirmation, sessionId: session.id, tokenUsage: session.tokens };
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' }); res.end(); return; }
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/api/health') { json(res, 200, { ok: true, provider: process.env.LLM_PROVIDER ?? 'openai', model: process.env.LLM_MODEL ?? 'gpt-4o-mini' }); return; }
    if (req.method === 'GET' && url.pathname.startsWith('/api/sessions/')) {
      const session = sessions.get(decodeURIComponent(url.pathname.slice('/api/sessions/'.length)));
      if (!session) { json(res, 404, { error: 'Sesión no encontrada.' }); return; }
      json(res, 200, { sessionId: session.id, messages: session.messages.filter(m => m.role === 'user' || m.role === 'assistant'), toolCalls: session.tools, needsConfirmation: session.needsConfirmation }); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const body = await bodyJson(req); const id = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : randomUUID();
      let session = sessions.get(id);
      if (!session) { session = { id, messages: [{ role: 'system', content: prompt }], tools: [], pending: new Set(), approved: new Set(), tokens: 0, needsConfirmation: false, updated: new Date().toISOString() }; sessions.set(id, session); }
      if (typeof body.message !== 'string') { json(res, 400, { error: 'El campo message debe ser texto.' }); return; }
      try { json(res, 200, await chat(session, body.message)); } catch (err) { json(res, 200, { reply: err instanceof Error ? err.message : 'Error al procesar el mensaje.', toolCalls: [], needsConfirmation: session.needsConfirmation, sessionId: session.id }); }
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/web/'))) {
      const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice('/web/'.length);
      const target = path.resolve(root, 'web', relative); if (!target.startsWith(path.resolve(root, 'web') + path.sep)) { json(res, 403, { error: 'Ruta no permitida.' }); return; }
      const content = await readFile(target); const type = target.endsWith('.html') ? 'text/html; charset=utf-8' : target.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8'; res.writeHead(200, { 'content-type': type }); res.end(content); return;
    }
    json(res, 404, { error: 'Ruta no encontrada.' });
  } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : 'Error interno.' }); }
});
server.listen(port, '0.0.0.0', () => console.log(`Registro de contratos disponible en http://localhost:${port}`));
