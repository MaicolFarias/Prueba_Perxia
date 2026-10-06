# Agente de Registro de Contratos Vigentes

Aplicación independiente para conversar sobre el buzón de contratos de prueba. Incluye interfaz de chat, backend con ciclo de herramientas, extracción determinista, validación, registro en un maestro de salida, archivo local, alertas y una demostración que funciona sin modelo.

## Requisitos

- Node.js 20 o superior y pnpm.
- Para usar el chat con modelo: clave de API de OpenAI. La demo no requiere clave.

## Inicio local

```bash
pnpm install
cp .env.example .env
# Edita .env y configura LLM_API_KEY en el backend.
pnpm dev
```

Abre http://localhost:3000. La clave no se envía al navegador. Si solo quieres procesar fixtures sin llamar a un modelo, ejecuta `pnpm demo`.

La demostración elimina y vuelve a crear `out/` para ser determinista. También se puede indicar fecha de referencia: `pnpm demo -- 2026-09-03`.

## Variables de entorno

| Variable | Uso |
|---|---|
| `LLM_PROVIDER` | Proveedor del adaptador. Actualmente `openai`. |
| `LLM_MODEL` | Modelo de chat; por defecto `gpt-4o-mini`. |
| `LLM_API_KEY` | Clave del backend. Mantener fuera del repositorio y los logs. |
| `PORT` | Puerto HTTP; por defecto `3000`. |
| `MAX_TOOL_ITERATIONS` | Máximo de llamadas a herramientas por turno; por defecto `25`. |
| `MAX_SESSION_TOKENS` | Límite de tokens estimados por sesión según el uso reportado por el proveedor; por defecto `20000`. |
| `MAX_DAILY_TOKENS` | Límite global diario en memoria del proceso; por defecto `200000`. Se reinicia con el día UTC o al reiniciar el servidor. |

## API

- `POST /api/chat` con `{ "sessionId": "opcional", "message": "..." }` devuelve respuesta, llamadas de herramientas y estado de confirmación.
- `GET /api/sessions/:id` devuelve el historial de mensajes y llamadas.
- `GET /api/health` informa el proveedor y modelo configurados sin exponer secretos.

## Estructura

- `agent/prompt.md`: comportamiento del asistente.
- `src/knowledge/registro-contratos.md`: reglas y contexto del proceso.
- `src/tools/contratos.ts`: herramientas deterministas, validación Zod y operaciones de archivos.
- `src/llm/adapter.ts`: interfaz y adaptador OpenAI mediante API HTTP.
- `web/`: interfaz de chat.
- `fixtures/reto-02/`: copia local de los fixtures originales, tratados como solo lectura.
- `out/`: maestro de salida, documentos archivados, historial, log, procesados y alertas.
- `demo.ts`: ejecución directa de las herramientas, sin modelo.

## Enlace de prueba

Despliegue público pendiente. La aplicación queda disponible localmente en `http://localhost:3000` después del arranque.
