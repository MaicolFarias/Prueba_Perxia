# Solución — Registro de Contratos Vigentes

## 1. Problema

Administración necesita un flujo repetible que lea contratos que llegan a un buzón común, evite registros duplicados, archive documentos y alerte sobre vencimientos y pólizas pendientes.

## 2. Arquitectura

```text
Chat web (web/) → API HTTP y ciclo (src/server.ts) → adaptador LLM (src/llm/adapter.ts)
                                           ↓ llamadas tipadas
                            herramientas Zod (src/tools/contratos.ts)
                                  ↙                    ↘
                   fixtures/ (solo lectura)          out/ (escritura)
```

El comportamiento conversacional está en `agent/prompt.md`; el conocimiento del proceso está separado en `src/knowledge/registro-contratos.md`; la ejecución determinista está separada en `src/tools/contratos.ts`. El chat muestra cada llamada y su resultado. Las sesiones se mantienen en memoria mientras vive el proceso.

## 3. Ciclo del agente

El servidor entrega mensajes y definiciones JSON de herramientas al adaptador. Ejecuta las llamadas que devuelve el modelo, agrega los resultados al contexto y repite hasta obtener una respuesta o alcanzar `MAX_TOOL_ITERATIONS`. El proveedor limita la sesión con `MAX_SESSION_TOKENS` y el proceso comparte `MAX_DAILY_TOKENS`. Una validación con campos bajo el umbral activa el estado visible de revisión; el backend solo permite registrar con `confirmado: true` cuando existe aprobación explícita previa en esa sesión. El validador vuelve a extraer los datos del fixture para impedir que el modelo eleve la confianza o modifique silenciosamente campos. Errores de herramientas y proveedor se devuelven en lenguaje legible sin detener el servidor.

## 4. Modelo y costo

Se eligió OpenAI Chat Completions con `gpt-4o-mini` como valor inicial configurable. La clave se lee de `LLM_API_KEY` solo en el backend. `demo.ts` no usa modelo y su costo de inferencia es cero. Como estimación de orden de magnitud para procesar un lote de seis mensajes, se suponen 10.000 tokens de entrada y 2.000 de salida: a las tarifas publicadas de USD 0,15/M entrada y USD 0,60/M salida, el costo aproximado sería **USD 0,0027 por lote**. Es un supuesto, no una medición; el historial del chat y las iteraciones pueden modificarlo. Precios consultados el 2026-10-06 en la [ficha oficial del modelo](https://developers.openai.com/api/docs/models/gpt-4o-mini). Se registra el uso reportado por el proveedor y se limita por sesión.

## 5. Extracción y confianza

La extracción P0 usa expresiones regulares y heurísticas deterministas sobre el texto de los adjuntos: identificador, contraparte, NIT/RUC, objeto, moneda, valor, fechas, pólizas y remitente. Las fechas faltantes quedan nulas y con confianza cero. Los valores por demanda se representan provisionalmente como cero y requieren revisión. La confianza alta se reserva a patrones explícitos; campos inferidos o ausentes bajan de 0.8. Toda escritura vuelve a pasar por `contratos_validar`; el modelo no es fuente para rellenar datos contractuales.

## 6. Regla de gobierno propuesta

**Canal único.** Crear `contratos@periferia.com` como buzón compartido. Administración es responsable del buzón y del maestro; operaciones TI mantiene el acceso y la automatización. El equipo comercial envía allí todos los documentos firmados, haya o no póliza.

**Obligación del comercial.** Dentro del día hábil siguiente a la firma, enviar el PDF firmado, sus otrosíes y actas de terminación. Usar el asunto `CONTRATO | Cliente | Número | tipo de documento`. Cuando un dato no conste (valor, fecha, póliza), indicarlo explícitamente en el cuerpo, sin completar el contrato por suposición.

**Acuse automático.** El sistema acusa recibo en cinco minutos con el identificador del mensaje y estado: recibido, registrado, requiere revisión o rechazado. Un registro dudoso no se confirma hasta la respuesta de una analista administrativa. Contratos sin firma se etiquetan como pendientes y no entran al maestro de vigentes.

**Excepciones y escalamiento.** Si falta firma, número, objeto, valor o fecha, el agente asigna estado de revisión. La analista solicita corrección al comercial; si en un día hábil no hay respuesta, escala al líder comercial y al responsable administrativo. Si el texto contradice el maestro, no sobrescribe sin aprobación y deja el conflicto en el historial. No se hace revisión jurídica automática.

**Cierre del gap junio–agosto de 2026.** Ejecutar una campaña única con cada líder comercial y administración: cruzar contratos firmados, facturación y actas del periodo; recolectar documentos y cargarlos por el mismo buzón; comparar con el maestro; revisar duplicados y excepciones con aprobación humana. Cerrar la campaña cuando cada contrato facturado tenga registro o un motivo de excepción asignado.

**Indicador mensual.** `Contratos facturados presentes en el maestro / total de contratos facturados del mes × 100`, con meta inicial ≥ 98 %. Administración reconcilia la cifra mensualmente con Finanzas y reporta los casos de excepción.

## 7. Decisiones y trade-offs

1. **Extracción determinista primero.** Evita depender del modelo para valores del registro y funciona en la demo; sacrifica cobertura ante redacciones muy distintas. Se puede añadir lectura asistida como propuesta, manteniendo validación y confirmación.
2. **CSV y archivos locales.** Cumple la simulación de SharePoint sin infraestructura adicional; no resuelve concurrencia ni permisos de producción. La integración real requeriría almacenamiento transaccional y Microsoft Graph.
3. **HTML sin framework.** Reduce tiempo de arranque y dependencias para la interfaz; a cambio, no incluye componentes reutilizables ni streaming.
4. **Sesiones en memoria.** Mantiene simple la demo; al reiniciar el servidor se pierde el historial conversacional. Para producción se requeriría persistencia y expiración de sesiones.

## 8. Supuestos

- Se entregan los seis mensajes y el maestro congelado especificados en los fixtures.
- Los adjuntos de texto representan PDF con texto extraído; no se implementa OCR.
- La primera ejecución copia el maestro a `out/sharepoint/` y conserva el fixture sin modificar.
- La fecha de alertas se recibe explícitamente; la demo usa `2026-09-03` por defecto.
- NIT colombiano de diez dígitos incluye dígito de verificación y se guarda sin el último dígito, según el esquema del PRD.

## 9. Cobertura y brechas para producción

| Historia | Estado | Brecha de producción |
|---|---|---|
| HU-1 Leer buzón | Hecho | Sustituir carpeta simulada por Exchange. |
| HU-2 Extraer | Hecho | OCR y evaluación sobre contratos variados. |
| HU-3 Validar | Hecho | Afinar deduplicación semántica con revisión humana. |
| HU-4 Registrar y archivar | Hecho | Sustituir CSV/carpeta por almacenamiento transaccional y SharePoint. |
| HU-5 Alertar | Hecho | Programar envío recurrente del reporte. |
| HU-6 Errores | Hecho | Mantener pruebas de robustez con más formatos de contratos y fallos del proveedor. |

## 10. Uso de IA

Se utilizó OpenAI Codex para interpretar el PRD, proponer la separación entre prompt, conocimiento y herramientas, y redactar la implementación inicial y documentación. Se mantuvieron decisiones deterministas para extracción, clasificación y escritura. Las sugerencias de inferir datos faltantes con el modelo se descartaron porque el PRD exige no inventar valores y requerir revisión humana bajo 0.8.

## 11. Riesgos y mitigaciones

- **Falsa extracción o duplicado:** exigir confianza mínima, conservar evidencia por campo y permitir revisión humana.
- **Pérdida o corrupción del maestro:** fixtures intactos, salidas separadas y registro de cambios; para producción usar copias de seguridad y escrituras transaccionales.
- **Clave o costo de API:** secreto solo en entorno backend, límites de turno, sesión y uso diario en memoria, y no imprimir cuerpos de autenticación. En producción el límite diario debe persistir y aplicarse por identidad.
- **Acceso público sin identidad:** el reto no exige autenticación; antes de producción proteger acceso, limitar datos personales y auditar usuarios.
- **Documento adversarial:** el texto del contrato se trata como dato, nunca como instrucciones para el agente.

## 12. Módulo reutilizable (bonus)

`modulo/agent.md` define el agente independiente con permisos de edición y shell denegados. `modulo/tools/contratos.ts` reexporta la misma implementación usada por el servidor, y `modulo/skill/registro-contratos/SKILL.md` contiene el conocimiento operativo. No hay una segunda copia de las herramientas que pueda divergir.
