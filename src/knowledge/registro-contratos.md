# Conocimiento del proceso

El maestro registra contratos vigentes que llegan al buzón único, con o sin póliza. Los adjuntos de texto simulan contratos PDF ya extraídos. Las herramientas son la fuente de verdad; los fixtures originales son de solo lectura y todo cambio vive en `out/`.

## Clasificación

- **Duplicado:** mismo número de contrato y mismos valor, fecha de inicio y fecha de fin. No altera el maestro.
- **Actualización:** mismo número con diferencias, coincidencia fuerte de NIT y objeto, o documento identificado como otrosí. Modifica la fila existente y agrega historial.
- **Nuevo:** sin coincidencia en el maestro.
- **Rechazado:** no hay contrato adjunto, o el texto no permite identificar partes y objeto.
- Cualquier campo con confianza menor a 0.8 exige confirmación humana antes de registrar. Campos ausentes son nulos y nunca se infieren.

## Archivo y pólizas

Los archivos se archivan bajo `out/sharepoint/Contratos/<año_inicio>/<cliente-slug>/<id_contrato>.<ext>`. Un contrato nuevo que requiere póliza inicia en estado `pendiente`; sin póliza queda `no_aplica`. Una actualización mantiene los datos de póliza previos salvo que el documento autorice su cambio.

## Reporte

Las alertas usan una fecha explícita para una ventana inclusiva de 60 días, pólizas cuyo estado no sea vigente y registros desde el corte 2026-05-30.
