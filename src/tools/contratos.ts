import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile, appendFile, access } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

type Context = { directory: string; sessionId: string };
type Mail = { id: string; de: string; para: string; asunto: string; fecha: string; cuerpo: string; adjuntos: string[] };
const confidenceKeys = ['id_contrato','cliente','nit_cliente','pais','objeto','valor','moneda','fecha_inicio','fecha_fin','requiere_poliza','tipo_poliza'] as const;
type Confidence = Record<typeof confidenceKeys[number], number>;
const confidenceSchema = z.object(Object.fromEntries(confidenceKeys.map(key => [key, z.number().min(0).max(1)])) as Record<typeof confidenceKeys[number], z.ZodNumber>);
const contractSchema = z.object({
  id_contrato: z.string().nullable(), cliente: z.string().nullable(), nit_cliente: z.string().nullable(),
  pais: z.enum(['CO', 'EC', 'PE', 'PA', 'HN']).nullable(), objeto: z.string().nullable(),
  valor: z.number().nullable(), moneda: z.enum(['COP', 'USD', 'PEN', 'PAB', 'HNL']).nullable(),
  fecha_inicio: z.string().nullable(), fecha_fin: z.string().nullable(), requiere_poliza: z.boolean().nullable(),
  tipo_poliza: z.array(z.string()), estado_poliza: z.enum(['vigente', 'pendiente', 'vencida', 'no_aplica']).nullable(),
  comercial: z.string().nullable(), valor_indeterminado: z.boolean(),
  confianza: confidenceSchema,
});
type Contract = z.infer<typeof contractSchema>;
type MasterRow = Record<string, string>;
type ValidationResult = { clasificacion: string; requiere_revision: string[]; id_contrato_existente?: string; diferencias?: { campo: string; anterior: string | null; nuevo: unknown }[]; conflictos: { campo: typeof confidenceKeys[number]; valor_fuente: unknown; valor_propuesto: unknown }[]; motivo?: string };
const MASTER_COLUMNS = ['id_contrato','cliente','nit_cliente','pais','objeto','valor','moneda','fecha_inicio','fecha_fin','requiere_poliza','tipo_poliza','estado_poliza','comercial','ruta_sharepoint','fecha_registro','fuente'];
const dataRoot = (ctx: Context) => path.join(ctx.directory, 'fixtures', 'reto-02');
const outRoot = (ctx: Context) => path.join(ctx.directory, 'out');
const ok = (data: unknown) => JSON.stringify({ ok: true, data });
const fail = (error: unknown) => JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
function validIsoDate(value: string) { const date = new Date(`${value}T00:00:00Z`); return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value; }

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}
async function log(ctx: Context, herramienta: string, mensaje_id: string | null, isOk: boolean, resumen: string) {
  const folder = outRoot(ctx); await mkdir(folder, { recursive: true });
  await appendFile(path.join(folder, 'log.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), herramienta, mensaje_id, ok: isOk, resumen })}\n`);
}
function parseCsv(text: string): MasterRow[] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted && c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); if (row.some(value => value !== '')) rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const headers = rows.shift() ?? [];
  return rows.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}
function csvEscape(value: string) { return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value; }
function serializeCsv(rows: MasterRow[]) { return `${MASTER_COLUMNS.join(',')}\n${rows.map(row => MASTER_COLUMNS.map(key => csvEscape(row[key] ?? '')).join(',')).join('\n')}\n`; }
async function masterPath(ctx: Context) {
  const file = path.join(outRoot(ctx), 'sharepoint', 'maestro-contratos.csv');
  await mkdir(path.dirname(file), { recursive: true });
  try { await access(file); } catch { await copyFile(path.join(dataRoot(ctx), 'maestro-contratos.csv'), file); }
  return file;
}
async function readMaster(ctx: Context) { return parseCsv(await readFile(await masterPath(ctx), 'utf8')); }
async function writeMaster(ctx: Context, rows: MasterRow[]) { await writeFile(await masterPath(ctx), serializeCsv(rows)); }
async function processed(ctx: Context): Promise<Record<string, unknown>> { return readJson(path.join(outRoot(ctx), 'procesados.json'), {}); }
async function markProcessed(ctx: Context, id: string, status: string) {
  const data = await processed(ctx); data[id] = { estado: status, ts: new Date().toISOString() };
  await writeFile(path.join(outRoot(ctx), 'procesados.json'), `${JSON.stringify(data, null, 2)}\n`);
}
function normalize(value: string | null | undefined) { return (value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function slug(value: string) { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cliente'; }
function cleanParty(value: string) { return value.replace(/^(?:los suscritos,?\s*)/i, '').replace(/\s+/g, ' ').trim().replace(/[.,;]+$/, ''); }
const monthNames: Record<string, string> = { enero:'01', febrero:'02', marzo:'03', abril:'04', mayo:'05', junio:'06', julio:'07', agosto:'08', septiembre:'09', setiembre:'09', octubre:'10', noviembre:'11', diciembre:'12' };
function findDates(text: string): string[] {
  const found: string[] = [];
  const rx = /(?:primero\s*)?(?:\((\d{1,2})\)|\b(\d{1,2})\b)\s*(?:de\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s+(?:de\s+)?(20\d{2})/gi;
  for (const m of text.matchAll(rx)) { const day = Number(m[1] ?? m[2]); const month = monthNames[m[3]!.toLowerCase()]; const value = `${m[4]}-${month}-${String(day).padStart(2, '0')}`; if (!validIsoDate(value)) throw new Error(`Fecha inválida en el contrato: ${m[0]}`); found.push(value); }
  const numeric = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
  for (const m of text.matchAll(numeric)) { const value = `${m[1]}-${m[2]}-${m[3]}`; if (!validIsoDate(value)) throw new Error(`Fecha inválida en el contrato: ${value}`); found.push(value); }
  return [...new Set(found)];
}
function parseAmount(raw: string, currency: string): number {
  const value = raw.replace(/\s/g, '');
  let normalized: string;
  if (value.includes(',') && value.includes('.')) normalized = value.lastIndexOf('.') > value.lastIndexOf(',') ? value.replaceAll(',', '') : value.replaceAll('.', '').replace(',', '.');
  else if (value.includes(',')) normalized = currency === 'COP' || currency === 'PAB' || currency === 'HNL' ? value.replaceAll(',', '') : value.replaceAll(',', '.');
  else if (value.includes('.')) normalized = currency === 'COP' || currency === 'PAB' || currency === 'HNL' ? value.replaceAll('.', '') : value;
  else normalized = value;
  return Number(normalized);
}
function extract(text: string, emailBody: string, comercial: string | null): Contract {
  const confidence: Confidence = { id_contrato:0, cliente:0, nit_cliente:0, pais:0, objeto:0, valor:0, moneda:0, fecha_inicio:0, fecha_fin:0, requiere_poliza:0, tipo_poliza:0 };
  const source = text.replace(/\r/g, '');
  const id = source.match(/\b((?:CT|CM)-[\w.-]+)/i)?.[1] ?? null;
  confidence.id_contrato = id ? 0.98 : 0;
  const party = source.match(/(?:Entre\s+(?:los suscritos,?\s*)?)([^\n,]+(?:\s[^\n,]+){0,6}),\s*(?:identificada|identificado|NIT|RUC)/i)?.[1];
  const client = party ? cleanParty(party) : null; confidence.cliente = client ? 0.9 : 0;
  const nitMatch = source.match(/\b(NIT|RUC)\s*[:.]?\s*([\d. -]{8,20})/i);
  const nitDigits = nitMatch?.[2]?.replace(/\D/g, '');
  const nit = nitDigits && nitMatch?.[1]?.toUpperCase() === 'NIT' && nitDigits.length === 10 ? nitDigits.slice(0, -1) : nitDigits;
  confidence.nit_cliente = nit ? 0.94 : 0;
  const country: Contract['pais'] = /Ecuador|Quito/i.test(source) || /^179/.test(nit ?? '') ? 'EC' : /Per[uú]|Lima/i.test(source) || /^20/.test(nit ?? '') ? 'PE' : /Panam[aá]|Panama|Istmo/i.test(source) ? 'PA' : /Honduras|Sula/i.test(source) ? 'HN' : /Colombia|Bogot[aá]|Medell[ií]n|Barranquilla/i.test(source) ? 'CO' : null;
  confidence.pais = country ? 0.82 : 0;
  const object = source.match(/PRIMERA\.?\s*\.??\s*OBJETO\.?\s*([\s\S]*?)(?=\n\s*(?:SEGUNDA|SEGUNDO)\b)/i)?.[1]?.trim().replace(/\s+/g, ' ').replace(/[".]$/, '') ?? null;
  confidence.objeto = object ? 0.88 : 0;
  const indeterminate = /no tiene un valor determinado|valor por demanda|por demanda/i.test(source);
  const amountText = source.match(/SEGUNDA\.?\s*VALOR[\s\S]{0,300}?\b([A-Z]{3})\s*\$?\s*([\d][\d.,]*)/i);
  const supportedCurrencies = ['COP', 'USD', 'PEN', 'PAB', 'HNL'];
  if (amountText && !supportedCurrencies.includes(amountText[1]!.toUpperCase())) throw new Error(`Moneda no reconocida en el contrato: ${amountText[1]}.`);
  const money = source.match(/\b(COP|USD|PEN|PAB|HNL)\s*\$?\s*([\d][\d.,]*)/i);
  let value: number | null = null, currency: Contract['moneda'] = null;
  if (money) { currency = money[1]!.toUpperCase() as Contract['moneda']; value = parseAmount(money[2]!, currency!); }
  if (indeterminate) { value = 0; confidence.valor = 0.55; } else confidence.valor = value !== null && Number.isFinite(value) ? 0.96 : 0;
  confidence.moneda = currency ? 0.95 : 0;
  const dates = findDates(source);
  let start = dates[0] ?? null, end = dates[1] ?? null;
  if (/otros[ií]/i.test(source)) {
    const explicitEnd = source.match(/(?:se extiende hasta|hasta el)\s+(?:primero\s*)?(?:\((\d{1,2})\)|\b(\d{1,2})\b)\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s+(?:de\s+)?(20\d{2})/i);
    if (explicitEnd) end = `${explicitEnd[4]}-${monthNames[explicitEnd[3]!.toLowerCase()]}-${String(Number(explicitEnd[1] ?? explicitEnd[2])).padStart(2, '0')}`;
  }
  confidence.fecha_inicio = start ? 0.9 : 0;
  confidence.fecha_fin = end ? 0.9 : 0;
  const policySource = `${source}\n${emailBody}`;
  const hasPolicy = /p[oó]liza/i.test(policySource) && !/no pide p[oó]liza|no requiere p[oó]liza/i.test(policySource) && !/no tiene.*p[oó]liza/i.test(policySource);
  const noPolicy = /no pide p[oó]liza|no requiere p[oó]liza|sin p[oó]liza/i.test(policySource);
  const policyKnown = hasPolicy || noPolicy;
  const types = [...new Set([...source.matchAll(/p[oó]liza\s+de\s+(cumplimiento|calidad|responsabilidad civil|salarios y prestaciones)/gi)].map(m => m[1]!.toLowerCase().replaceAll(' ', '_')))];
  confidence.requiere_poliza = policyKnown ? 0.9 : 0;
  confidence.tipo_poliza = policyKnown ? 0.85 : 0;
  return { id_contrato: id, cliente: client, nit_cliente: nit ?? null, pais: country, objeto: object?.slice(0, 200) ?? null,
    valor: value, moneda: currency, fecha_inicio: start, fecha_fin: end, requiere_poliza: noPolicy ? false : hasPolicy ? true : null,
    tipo_poliza: types, estado_poliza: noPolicy ? 'no_aplica' : hasPolicy ? 'pendiente' : null, comercial, valor_indeterminado: indeterminate, confianza: confidence };
}

async function getMessages(ctx: Context) {
  const base = path.join(dataRoot(ctx), 'buzon'); const ids = (await readdir(base, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort();
  const done = await processed(ctx); const output = [];
  for (const id of ids) {
    if (id in done) continue;
    const folder = path.join(base, id); const email = await readJson<Mail | null>(path.join(folder, 'correo.json'), null);
    if (!email) continue;
    const attachments = Array.isArray(email.adjuntos) ? email.adjuntos : [];
    let hasContract = false;
    for (const attachment of attachments) { if (typeof attachment !== 'string' || path.basename(attachment) !== attachment) continue; try { const body = await readFile(path.join(folder, attachment), 'utf8'); if (/contrato|otros[ií]|EL CONTRATANTE/i.test(body)) hasContract = true; } catch { /* missing attachment */ } }
    output.push({ id: email.id, de: email.de, asunto: email.asunto, fecha: email.fecha, adjuntos: attachments, tiene_contrato: hasContract });
  }
  return output;
}
async function messageText(ctx: Context, messageId: string) {
  if (!/^msg-\d{3}$/.test(messageId)) throw new Error('Identificador de mensaje inválido.');
  const folder = path.join(dataRoot(ctx), 'buzon', messageId); const email = await readJson<Mail | null>(path.join(folder, 'correo.json'), null);
  if (!email) throw new Error(`No existe el mensaje ${messageId}.`);
  for (const attachment of email.adjuntos ?? []) {
    if (typeof attachment !== 'string' || path.basename(attachment) !== attachment) continue;
    try { const text = await readFile(path.join(folder, attachment), 'utf8'); if (/contrato|otros[ií]|EL CONTRATANTE/i.test(text)) return { email, text, attachment }; } catch { /* try next */ }
  }
  throw new Error(`El mensaje ${messageId} no tiene texto adjunto que parezca un contrato.`);
}
async function sourceContract(ctx: Context, messageId: string) {
  const { email, text } = await messageText(ctx, messageId);
  const people = await readJson<{ email: string; nombre: string }[]>(path.join(dataRoot(ctx), 'comerciales.json'), []);
  const sender = people.find(person => person.email.toLowerCase() === email.de.toLowerCase());
  return extract(text, email.cuerpo ?? '', sender?.nombre ?? null);
}
function sameValue(a: unknown, b: unknown) {
  if (Array.isArray(a) && Array.isArray(b)) return [...a].sort().join('|') === [...b].sort().join('|');
  if (typeof a === 'string' && typeof b === 'string') return a.trim() === b.trim();
  return a === b;
}
function similarity(a: string, b: string) {
  const left = new Set(normalize(a).match(/.{1,4}/g) ?? []), right = new Set(normalize(b).match(/.{1,4}/g) ?? []);
  if (!left.size || !right.size) return 0; const intersection = [...left].filter(x => right.has(x)).length;
  return intersection / Math.max(left.size, right.size);
}
async function validate(ctx: Context, contract: Contract, messageId: string, allowHumanConfirmed = false): Promise<ValidationResult> {
  const canonical = await sourceContract(ctx, messageId);
  const mismatches = confidenceKeys.filter(field => !sameValue(contract[field], canonical[field]));
  const effective = allowHumanConfirmed ? contract : canonical;
  const confidence: Confidence = { ...canonical.confianza };
  if (allowHumanConfirmed) for (const field of confidenceKeys) confidence[field] = contract[field] === null ? 0 : 1;
  else for (const field of mismatches) confidence[field] = 0;
  const data: Contract = { ...effective, confianza: confidence };
  const rows = await readMaster(ctx);
  const byId = data.id_contrato ? rows.find(row => row.id_contrato === data.id_contrato) : undefined;
  let existing = byId;
  if (!existing && data.nit_cliente && data.objeto) existing = rows.find(row => row.nit_cliente === data.nit_cliente && similarity(row.objeto ?? '', data.objeto!) >= 0.9);
  const issues = [...new Set([
    ...Object.entries(data.confianza).filter(([field, score]) => score < 0.8 && (!existing || !existing[field])).map(([field]) => field),
    ...(!allowHumanConfirmed ? mismatches : []),
  ])];
  let result: Omit<ValidationResult, 'conflictos'>;
  if (!data.cliente || (!data.objeto && !existing)) result = { clasificacion: 'rechazado', requiere_revision: issues, motivo: 'No se identifican claramente el cliente y el objeto contractual.' };
  else if (!existing) result = { clasificacion: 'nuevo', requiere_revision: issues, diferencias: [] };
  else if (byId && String(byId.valor) === String(data.valor ?? '') && byId.fecha_inicio === data.fecha_inicio && byId.fecha_fin === data.fecha_fin) result = { clasificacion: 'duplicado', id_contrato_existente: byId.id_contrato, requiere_revision: [], diferencias: [] };
  else {
    const differences = Object.entries({ valor: data.valor, moneda: data.moneda, fecha_fin: data.fecha_fin, objeto: data.objeto }).filter(([key, value]) => value !== null && String(existing![key] ?? '') !== String(value)).map(([campo, nuevo]) => ({ campo, anterior: existing![campo] ?? null, nuevo }));
    if (differences.length === 0 && !/otros[ií]/i.test(messageId)) result = { clasificacion: 'duplicado', id_contrato_existente: existing.id_contrato, requiere_revision: [], diferencias: [] };
    else result = { clasificacion: 'actualizacion', id_contrato_existente: existing.id_contrato, requiere_revision: issues, diferencias: differences };
  }
  return { ...result, conflictos: mismatches.map(campo => ({ campo, valor_fuente: canonical[campo], valor_propuesto: contract[campo] })) };
}

export const leer_buzon = {
  description: 'Lista los mensajes pendientes del buzón y señala si contienen un adjunto de contrato.', args: z.object({}),
  async execute(_args: {}, ctx: Context) { try { const mensajes = await getMessages(ctx); await log(ctx, 'contratos_leer_buzon', null, true, `${mensajes.length} mensajes pendientes`); return ok({ mensajes }); } catch (err) { await log(ctx, 'contratos_leer_buzon', null, false, String(err)); return fail(err); } },
};
export const extraer = {
  description: 'Extrae los campos estructurados de un contrato adjunto y asigna confianza por campo.', args: { mensaje_id: z.string().describe('Identificador del mensaje del buzón') },
  async execute(args: { mensaje_id: string }, ctx: Context) { try {
    const { email, text } = await messageText(ctx, args.mensaje_id); const people = await readJson<{email:string;nombre:string}[]>(path.join(dataRoot(ctx), 'comerciales.json'), []);
    const sender = people.find(person => person.email.toLowerCase() === String(email.de).toLowerCase());
    const contrato = extract(text, email.cuerpo ?? '', sender?.nombre ?? null); const result = { ...contrato, remitente_desconocido: !sender, remitente: email.de };
    await log(ctx, 'contratos_extraer', args.mensaje_id, true, `Campos extraídos; ${Object.values(contrato.confianza).filter(score => score < 0.8).length} requieren revisión`); return ok(result);
  } catch (err) { await log(ctx, 'contratos_extraer', args.mensaje_id, false, String(err)); return fail(err); } },
};
export const validar = {
  description: 'Clasifica el contrato como nuevo, actualización, duplicado o rechazado y señala campos dudosos.',
  args: { mensaje_id: z.string().describe('Identificador del mensaje'), contrato: contractSchema.describe('Datos extraídos del contrato'), confirmado: z.boolean().optional().describe('Confirmación explícita de los campos dudosos en un turno previo') },
  async execute(args: { mensaje_id: string; contrato: Contract; confirmado?: boolean }, ctx: Context) { try { const result = await validate(ctx, args.contrato, args.mensaje_id, args.confirmado === true); await log(ctx, 'contratos_validar', args.mensaje_id, true, result.clasificacion); return ok(result); } catch (err) { await log(ctx, 'contratos_validar', args.mensaje_id, false, String(err)); return fail(err); } },
};
export const registrar = {
  description: 'Registra una alta o actualización aprobada, o marca como procesado un mensaje rechazado.',
  args: { mensaje_id: z.string().describe('Identificador del mensaje'), contrato: contractSchema.optional().describe('Contrato extraído cuando existe'), confirmado: z.boolean().optional().describe('Confirmación humana de campos dudosos'), clasificacion: z.enum(['nuevo','actualizacion','rechazado']).optional().describe('Clasificación validada'), motivo: z.string().optional().describe('Motivo de rechazo, si aplica') },
  async execute(args: { mensaje_id: string; contrato?: Contract; confirmado?: boolean; clasificacion?: string; motivo?: string }, ctx: Context) { try {
    if (args.clasificacion === 'rechazado') { await markProcessed(ctx, args.mensaje_id, 'rechazado'); await log(ctx, 'contratos_registrar', args.mensaje_id, true, `Rechazado: ${args.motivo ?? 'sin contrato'}`); return ok({ accion: 'rechazado', motivo: args.motivo ?? 'Sin contrato' }); }
    if (!args.contrato) throw new Error('Falta el contrato por registrar.');
    const contract = contractSchema.parse(args.contrato); const result = await validate(ctx, contract, args.mensaje_id, args.confirmado === true);
    if (result.clasificacion === 'duplicado' || result.clasificacion === 'rechazado') throw new Error(`No se puede registrar: clasificación ${result.clasificacion}.`);
    const review = result.requiere_revision;
    if (review.length && !args.confirmado) throw new Error(`requiere revisión: ${review.join(', ')}`);
    const unresolved = review.filter(field => contract[field as keyof Contract] === null || contract[field as keyof Contract] === undefined);
    if (unresolved.length) throw new Error(`No se puede registrar hasta completar los campos: ${unresolved.join(', ')}.`);
    const { email, attachment } = await messageText(ctx, args.mensaje_id); const rows = await readMaster(ctx); const index = rows.findIndex(row => row.id_contrato === result.id_contrato_existente);
    if (index >= 0 && result.clasificacion === 'actualizacion') {
      const prior = rows[index]!; const changes: Record<string, { anterior: string; nuevo: string }> = {};
      for (const field of ['valor','moneda','fecha_fin','objeto'] as const) if (contract[field] !== null && String(prior[field] ?? '') !== String(contract[field])) changes[field] = { anterior: prior[field] ?? '', nuevo: String(contract[field]) };
      const updated = { ...prior };
      for (const [field, pair] of Object.entries(changes)) updated[field] = pair.nuevo;
      if (contract.tipo_poliza.length) updated.tipo_poliza = contract.tipo_poliza.join(';');
      if (contract.requiere_poliza !== null) updated.requiere_poliza = String(contract.requiere_poliza);
      const extension = path.extname(attachment) || '.txt';
      const relFile = `Contratos/${(contract.fecha_inicio ?? prior.fecha_inicio ?? email.fecha).slice(0,4)}/${slug(contract.cliente!)}/${contract.id_contrato}-otrosi${extension}`;
      rows[index] = updated;
      const file = path.join(outRoot(ctx), 'sharepoint', ...relFile.split('/')); await mkdir(path.dirname(file), { recursive: true }); await copyFile(path.join(dataRoot(ctx), 'buzon', args.mensaje_id, attachment), file);
      await writeMaster(ctx, rows); await appendFile(path.join(outRoot(ctx), 'sharepoint', 'historial.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), id_contrato: updated.id_contrato, accion: 'actualizacion', cambios: changes, mensaje_id: args.mensaje_id })}\n`);
      await markProcessed(ctx, args.mensaje_id, 'actualizado'); await log(ctx, 'contratos_registrar', args.mensaje_id, true, `Actualizado ${updated.id_contrato}`); return ok({ id_contrato: updated.id_contrato, accion: 'actualizacion', ruta_archivo: relFile });
    }
    const start = contract.fecha_inicio ?? ''; const extension = path.extname(attachment) || '.txt';
    const relative = `Contratos/${start.slice(0,4)}/${slug(contract.cliente!)}/${contract.id_contrato ?? `AUTO-${start.slice(0,4)}-${createHash('sha1').update(args.mensaje_id).digest('hex').slice(0,6)}`}${extension}`;
    const destination = path.join(outRoot(ctx), 'sharepoint', ...relative.split('/')); await mkdir(path.dirname(destination), { recursive: true }); await copyFile(path.join(dataRoot(ctx), 'buzon', args.mensaje_id, attachment), destination);
    const row: MasterRow = { id_contrato: contract.id_contrato ?? '', cliente: contract.cliente ?? '', nit_cliente: contract.nit_cliente ?? '', pais: contract.pais ?? '', objeto: contract.objeto ?? '', valor: String(contract.valor ?? ''), moneda: contract.moneda ?? '', fecha_inicio: start, fecha_fin: contract.fecha_fin ?? '', requiere_poliza: String(contract.requiere_poliza ?? false), tipo_poliza: contract.tipo_poliza.join(';'), estado_poliza: contract.requiere_poliza ? 'pendiente' : 'no_aplica', comercial: contract.comercial ?? '', ruta_sharepoint: relative, fecha_registro: new Date().toISOString().slice(0,10), fuente: 'buzon' };
    rows.push(row); await writeMaster(ctx, rows); await appendFile(path.join(outRoot(ctx), 'sharepoint', 'historial.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), id_contrato: row.id_contrato, accion: 'nuevo', cambios: {}, mensaje_id: args.mensaje_id })}\n`);
    await markProcessed(ctx, args.mensaje_id, 'registrado'); await log(ctx, 'contratos_registrar', args.mensaje_id, true, `Registrado ${row.id_contrato}`); return ok({ id_contrato: row.id_contrato, accion: 'nuevo', ruta_archivo: relative });
  } catch (err) { await log(ctx, 'contratos_registrar', args.mensaje_id, false, String(err)); return fail(err); } },
};
export const alertas = {
  description: 'Genera un reporte de contratos que vencen pronto, pólizas pendientes y registros desde el corte.',
  args: { hoy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Fecha de referencia YYYY-MM-DD') },
  async execute(args: { hoy: string }, ctx: Context) { try {
    const today = new Date(`${args.hoy}T00:00:00Z`); if (!validIsoDate(args.hoy) || Number.isNaN(today.valueOf())) throw new Error('Fecha de referencia inválida. Use una fecha real en formato YYYY-MM-DD.');
    const rows = await readMaster(ctx); const registered = await readJson<Record<string,{estado:string}>>(path.join(outRoot(ctx), 'procesados.json'), {});
    const due = rows.filter(row => row.fecha_fin && (new Date(`${row.fecha_fin}T00:00:00Z`).valueOf() - today.valueOf()) >= 0 && (new Date(`${row.fecha_fin}T00:00:00Z`).valueOf() - today.valueOf()) <= 60*86400000);
    const policies = rows.filter(row => row.requiere_poliza === 'true' && row.estado_poliza !== 'vigente');
    const afterCutoff = rows.filter(row => (row.fecha_registro ?? '') >= '2026-05-30');
    const md = `# Alertas de contratos\n\nFecha de referencia: ${args.hoy}\n\n## Vencen en 60 días o menos\n${due.length ? due.map(r => `- **${r.id_contrato} — ${r.cliente}**: vence ${r.fecha_fin}.`).join('\n') : '- No hay contratos en la ventana.'}\n\n## Pólizas pendientes o no vigentes\n${policies.length ? policies.map(r => `- **${r.id_contrato} — ${r.cliente}**: estado ${r.estado_poliza}.`).join('\n') : '- No hay pólizas pendientes.'}\n\n## Registrados desde el 2026-05-30\n${afterCutoff.length ? afterCutoff.map(r => `- **${r.id_contrato} — ${r.cliente}**: registro ${r.fecha_registro}.`).join('\n') : '- No hay registros posteriores al corte.'}\n`;
    const file = path.join(outRoot(ctx), 'alertas.md'); await writeFile(file, md); await log(ctx, 'contratos_alertas', null, true, 'Reporte de alertas generado'); return ok({ ruta: 'out/alertas.md', vencen: due, polizas_pendientes: policies, registrados_desde_corte: afterCutoff });
  } catch (err) { await log(ctx, 'contratos_alertas', null, false, String(err)); return fail(err); } },
};

export const tools = { contratos_leer_buzon: leer_buzon, contratos_extraer: extraer, contratos_validar: validar, contratos_registrar: registrar, contratos_alertas: alertas };
export type ToolName = keyof typeof tools;
export async function invokeTool(name: string, rawArgs: unknown, ctx: Context): Promise<string> {
  const tool = tools[name as ToolName] as unknown as { args: z.ZodTypeAny | z.ZodRawShape; execute(args: unknown, ctx: Context): Promise<string> } | undefined;
  if (!tool) return fail(`Herramienta desconocida: ${name}`);
  const argsSchema = tool.args instanceof z.ZodObject ? tool.args : z.object(tool.args as z.ZodRawShape);
  const parsed = argsSchema.safeParse(rawArgs); if (!parsed.success) return fail(`Argumentos inválidos: ${parsed.error.issues.map((issue: z.ZodIssue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  return tool.execute(parsed.data, ctx);
}
export function toolDefinitions() {
  return Object.entries(tools).map(([name, tool]) => {
    const schema = tool.args instanceof z.ZodObject ? tool.args : z.object(tool.args as z.ZodRawShape);
    return { type: 'function' as const, function: { name, description: tool.description, parameters: zodToJsonSchema(schema.shape) } };
  });
}
function zodToJsonSchema(schema: z.ZodRawShape) {
  const properties: Record<string, unknown> = {}; const required: string[] = [];
  for (const [key, field] of Object.entries(schema)) { properties[key] = fieldJson(field); if (!field.isOptional()) required.push(key); }
  return { type: 'object', properties, required, additionalProperties: false };
}
function fieldJson(field: z.ZodTypeAny): Record<string, unknown> {
  if (field instanceof z.ZodOptional || field instanceof z.ZodDefault) return fieldJson(field instanceof z.ZodOptional ? field.unwrap() : field.removeDefault());
  if (field instanceof z.ZodNullable) { const inner = fieldJson(field.unwrap()); const baseType = inner.type; return { ...inner, type: Array.isArray(baseType) ? [...baseType, 'null'] : [baseType, 'null'] }; }
  if (field instanceof z.ZodString) return { type: 'string', ...(field.description ? { description: field.description } : {}) };
  if (field instanceof z.ZodNumber) return { type: 'number', ...(field.description ? { description: field.description } : {}) };
  if (field instanceof z.ZodBoolean) return { type: 'boolean', ...(field.description ? { description: field.description } : {}) };
  if (field instanceof z.ZodEnum) return { type: 'string', enum: field.options, ...(field.description ? { description: field.description } : {}) };
  if (field instanceof z.ZodArray) return { type: 'array', items: fieldJson(field.element), ...(field.description ? { description: field.description } : {}) };
  if (field instanceof z.ZodObject) { const shape = field.shape as z.ZodRawShape; return zodToJsonSchema(shape); }
  if (field instanceof z.ZodRecord) return { type: 'object', additionalProperties: fieldJson(field.valueSchema) };
  return {};
}
