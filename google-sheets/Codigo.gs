/**
 * AgroServicios · receptor para Google Sheets
 *
 * Recibe de la app el estado completo y lo refleja en estas pestañas:
 *   Resumen            -> cifras del parque y de los trabajos externos del año
 *   Maquinaria         -> máquinas activas con amortización calculada
 *   Vendidas           -> máquinas vendidas y resultado de la venta
 *   Mantenimientos     -> gastos, revisiones y estado del aviso
 *   Trabajos externos  -> trabajos a terceros con importe, beneficio y cobro
 *   _copia             -> copia completa para poder restaurar la app (oculta; no tocar)
 *
 * IMPORTANTE: la hoja es un espejo. La app reescribe estas pestañas en cada envío,
 * así que no escribas dentro de ellas. Para tus cálculos copia los datos a otra pestaña u otro archivo.
 */

const CLAVE = 'CAMBIA-ESTA-CLAVE'; // debe ser idéntica a la que escribes en la app (Ajustes)

const PERMITIDAS = ['Resumen', 'Maquinaria', 'Vendidas', 'Mantenimientos', 'Trabajos externos'];
const COPIA = '_copia';

function doGet() {
  return salida({ ok: true, mensaje: 'AgroServicios: receptor activo' });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  let bloqueado = false;
  try {
    lock.waitLock(25000);
    bloqueado = true;
    const req = JSON.parse(e.postData.contents);
    if (!req || req.clave !== CLAVE) return salida({ ok: false, error: 'clave' });
    if (req.accion === 'ping') return salida({ ok: true });
    if (req.accion === 'sincronizar') return salida(sincronizar(req));
    if (req.accion === 'estado') return salida(leerEstado());
    return salida({ ok: false, error: 'accion desconocida' });
  } catch (err) {
    return salida({ ok: false, error: String((err && err.message) || err) });
  } finally {
    if (bloqueado) { try { lock.releaseLock(); } catch (_) { /* nada */ } }
  }
}

function salida(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function hoja(nombre) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(nombre) || ss.insertSheet(nombre);
}

function aFecha(iso) {
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  return Utilities.parseDate(String(iso), tz, 'yyyy-MM-dd');
}

function escribirTabla(t) {
  const cab = t.cabecera;
  const filas = (t.filas || []).map(function (r) {
    const x = r.slice();
    (t.fechas || []).forEach(function (i) { if (x[i]) x[i] = aFecha(x[i]); });
    return x;
  });
  const sh = hoja(t.nombre);
  sh.clear();
  sh.getRange(1, 1, 1, cab.length).setValues([cab])
    .setFontWeight('bold').setBackground('#8a4f12').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  if (filas.length) {
    sh.getRange(2, 1, filas.length, cab.length).setValues(filas);
    (t.formatos || []).forEach(function (f, i) { if (f) sh.getRange(2, i + 1, filas.length, 1).setNumberFormat(f); });
    if (t.nombre === 'Resumen') {
      sh.getRange(2, 2, filas.length, 1).setNumberFormat('#,##0.00');
      sh.getRange(2, 2).setNumberFormat('0'); // nº de máquinas
      const ff = t.formatosFila || {};
      Object.keys(ff).forEach(function (k) { sh.getRange(Number(k) + 2, 2).setNumberFormat(ff[k]); });
    }
  }
  sh.autoResizeColumns(1, cab.length);
  return filas.length;
}

function sincronizar(req) {
  const tablas = (req.tablas || []).filter(function (t) { return t && PERMITIDAS.indexOf(t.nombre) > -1 && Array.isArray(t.cabecera); });
  const res = {};
  tablas.forEach(function (t) { res[t.nombre] = escribirTabla(t); });
  guardarCopia(String(req.estado || ''), new Date().toISOString());
  return { ok: true, filas: res, fecha: new Date().toISOString() };
}

function guardarCopia(estado, fecha) {
  const sh = hoja(COPIA);
  sh.clear();
  sh.getRange(1, 1, 1, 2).setValues([['Copia automática de AgroServicios (no editar ni borrar)', fecha]]);
  const trozos = [];
  for (let i = 0; i < estado.length; i += 40000) trozos.push([estado.substr(i, 40000)]);
  if (trozos.length) {
    const rng = sh.getRange(2, 1, trozos.length, 1);
    rng.setNumberFormat('@'); // texto plano: que Sheets no interprete los trozos como números o fórmulas
    rng.setValues(trozos);
  }
  sh.hideSheet();
}

function leerEstado() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(COPIA);
  if (!sh || sh.getLastRow() < 2) return { ok: false, error: 'sin copia' };
  const n = sh.getLastRow() - 1;
  const trozos = sh.getRange(2, 1, n, 1).getValues().map(function (r) { return String(r[0]); });
  const f = sh.getRange(1, 2).getValue();
  return { ok: true, estado: trozos.join(''), fecha: f instanceof Date ? f.toISOString() : String(f) };
}
