import { rm } from 'node:fs/promises';
import path from 'node:path';
import { invokeTool } from './src/tools/contratos.js';

const root = process.cwd(); const out = path.join(root, 'out');
await rm(out, { recursive: true, force: true });
const ctx = { directory: root, sessionId: 'demo' };
const read = JSON.parse(await invokeTool('contratos_leer_buzon', {}, ctx)) as { ok: boolean; data?: { mensajes: { id: string; tiene_contrato: boolean }[] }; error?: string };
if (!read.ok || !read.data) throw new Error(read.error ?? 'No se pudo leer el buzón.');
for (const message of read.data.mensajes) {
  if (!message.tiene_contrato) {
    const rejected = JSON.parse(await invokeTool('contratos_registrar', { mensaje_id: message.id, clasificacion: 'rechazado', motivo: 'El adjunto no corresponde a un contrato.' }, ctx));
    console.log(`${message.id}: rechazado; mensaje marcado como procesado. ${JSON.stringify(rejected)}`); continue;
  }
  const extraction = JSON.parse(await invokeTool('contratos_extraer', { mensaje_id: message.id }, ctx));
  if (!extraction.ok) { console.log(`${message.id}: error de extracción; ${extraction.error}`); continue; }
  const contrato = extraction.data;
  const validation = JSON.parse(await invokeTool('contratos_validar', { mensaje_id: message.id, contrato }, ctx));
  if (!validation.ok) { console.log(`${message.id}: error de validación; ${validation.error}`); continue; }
  const result = validation.data;
  console.log(`${message.id}: ${result.clasificacion}; revisión: ${result.requiere_revision.join(', ') || 'ninguna'}`);
  if (result.clasificacion === 'duplicado' || result.clasificacion === 'rechazado') continue;
  if (result.requiere_revision.length) {
    const first = JSON.parse(await invokeTool('contratos_registrar', { mensaje_id: message.id, contrato, confirmado: false }, ctx));
    console.log(`${message.id}: primera llamada sin confirmar; ${first.error}`);
    if (message.id === 'msg-006') {
      const confirmedContract = { ...contrato, valor: 0, fecha_inicio: '2026-08-31', fecha_fin: '2027-08-31', confianza: { ...contrato.confianza, valor: 1, fecha_inicio: 1, fecha_fin: 1 } };
      const second = JSON.parse(await invokeTool('contratos_registrar', { mensaje_id: message.id, contrato: confirmedContract, confirmado: true }, ctx));
      console.log(`${message.id}: segunda llamada con valor 0, fecha de inicio 2026-08-31 y fecha fin 2027-08-31 confirmados; ${JSON.stringify(second)}`);
    }
    continue;
  }
  const registration = JSON.parse(await invokeTool('contratos_registrar', { mensaje_id: message.id, contrato, confirmado: false }, ctx));
  console.log(`${message.id}: ${JSON.stringify(registration)}`);
}
const today = process.argv[2] ?? '2026-09-03';
const alerts = JSON.parse(await invokeTool('contratos_alertas', { hoy: today }, ctx));
console.log(`Alertas: ${alerts.ok ? 'generadas en out/alertas.md' : alerts.error}`);
