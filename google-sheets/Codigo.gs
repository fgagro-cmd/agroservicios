/**
 * AgroServicios · receptor para Google Sheets
 *
 * Recibe de la app el estado completo y lo refleja en estas pestañas:
 *   Resumen            -> cifras del parque y de los trabajos externos del año
 *   Maquinaria         -> máquinas activas con amortización calculada
 *   Vendidas           -> máquinas vendidas y resultado de la venta
 *   Mantenimientos     -> gastos, revisiones y estado del aviso
 *   Trabajos externos  -> trabajos a terceros con importe, beneficio y cobro
 *   Tareas             -> tareas pendientes de Organización (desde 1.3.0), por semana
 *   Tareas hechas      -> tareas terminadas: semana prevista, día real y si fue en plazo
 *   _copia             -> copia completa para poder restaurar la app (oculta; no tocar)
 *
 * IMPORTANTE: la hoja es un espejo. La app reescribe estas pestañas en cada envío,
 * así que no escribas dentro de ellas. Para tus cálculos copia los datos a otra pestaña u otro archivo.
 *
 * Desde la 1.3.0 las tareas con fecha se copian al calendario de Google «AgroServicios» (un evento de todo el día
 * en su fecha límite, con aviso la víspera a las 8:00). Manda la app: lo que cambies a mano en Calendar se rehace.
 * Permiso: ejecuta una vez «autorizarCalendario» desde el editor.
 */

const CLAVE = 'CAMBIA-ESTA-CLAVE'; // debe ser idéntica a la que escribes en la app (Ajustes)

const PERMITIDAS = ['Resumen', 'Maquinaria', 'Vendidas', 'Mantenimientos', 'Trabajos externos', 'Tareas', 'Tareas hechas'];
const CAL_NOMBRE = 'AgroServicios';
const CAL_AVISO_MIN = 960; // 16 h antes de las 00:00 del día = la víspera a las 8:00
const PRIO_ICONO = { Alta: '🔴', Media: '🟠', Baja: '🟢' };
const CAT_ICONO = { 'Mantenimiento': '🔧', 'Trámites': '📋', 'Labores': '🚜', 'Reparaciones y compras': '🛠️' };
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
  const out = { ok: true, filas: res, fecha: new Date().toISOString() };
  // El calendario va el último y aparte: si falla (por ejemplo, falta el permiso), la hoja ya está guardada
  if (Array.isArray(req.cal)) {
    try { out.calendario = sincronizarCalendario(req.cal); }
    catch (err) { out.calendario = { ok: false, error: String((err && err.message) || err) }; }
  }
  return out;
}

/* ---------- Calendario «AgroServicios» ---------- */
function calendarioAgro() {
  const propios = CalendarApp.getCalendarsByName(CAL_NOMBRE).filter(function (c) { return c.isOwnedByMe(); });
  if (propios.length) return propios[0];
  return CalendarApp.createCalendar(CAL_NOMBRE, { timeZone: Session.getScriptTimeZone(), summary: 'Tareas de maquinaria de la app AgroServicios (las escribe la app; no edites aquí)' });
}

function textoEvento(t) {
  const l = ['Categoría: ' + t.cat];
  if (t.maquina) l.push('Máquina: ' + t.maquina);
  if (t.cliente) l.push('Cliente: ' + t.cliente);
  l.push('Prioridad: ' + t.prioridad);
  if (t.horas > 0) l.push('Horas previstas: ' + t.horas + ' h');
  l.push('');
  l.push('Escrito por AgroServicios. No lo cambies aquí: manda la app.');
  l.push('[ag:' + t.id + ']');
  return l.join('\n');
}

function tituloEvento(t) {
  return (PRIO_ICONO[t.prioridad] || '') + ' ' + (CAT_ICONO[t.cat] || '') + ' ' + t.texto + (t.maquina ? ' · ' + t.maquina : '') + (t.cliente ? ' · ' + t.cliente : '');
}

function sincronizarCalendario(tareas) {
  const cal = calendarioAgro();
  const zona = Session.getScriptTimeZone();
  const ahora = Date.now();
  const existentes = {};
  cal.getEvents(new Date(ahora - 730 * 864e5), new Date(ahora + 730 * 864e5)).forEach(function (ev) {
    const m = /\[ag:([^\]]+)\]/.exec(ev.getDescription() || '');
    if (m) (existentes[m[1]] = existentes[m[1]] || []).push(ev);
  });
  const quiero = {};
  let creados = 0, cambiados = 0, borrados = 0;
  const crear = function (titulo, dia, desc) {
    const ev = cal.createAllDayEvent(titulo, dia, { description: desc });
    ev.removeAllReminders();
    ev.addPopupReminder(CAL_AVISO_MIN);
  };
  tareas.forEach(function (t) {
    if (!t || !t.id || !t.limite) return;
    quiero[t.id] = true;
    const titulo = tituloEvento(t), desc = textoEvento(t);
    const dia = Utilities.parseDate(String(t.limite), zona, 'yyyy-MM-dd');
    const evs = existentes[t.id] || [];
    evs.slice(1).forEach(function (x) { x.deleteEvent(); borrados++; });
    if (!evs.length) { crear(titulo, dia, desc); creados++; return; }
    const ev = evs[0];
    let tocado = false;
    if (ev.getTitle() !== titulo) { ev.setTitle(titulo); tocado = true; }
    if (ev.getDescription() !== desc) { ev.setDescription(desc); tocado = true; }
    const mismoDia = ev.isAllDayEvent() && Utilities.formatDate(ev.getAllDayStartDate(), zona, 'yyyy-MM-dd') === t.limite;
    if (!mismoDia) {
      if (ev.isAllDayEvent()) ev.setAllDayDate(dia); else { ev.deleteEvent(); crear(titulo, dia, desc); }
      tocado = true;
    }
    if (tocado) cambiados++;
  });
  Object.keys(existentes).forEach(function (id) {
    if (!quiero[id]) existentes[id].forEach(function (ev) { ev.deleteEvent(); borrados++; });
  });
  return { ok: true, eventos: Object.keys(quiero).length, creados: creados, cambiados: cambiados, borrados: borrados };
}

/* Ejecútala una vez desde el editor (▶) para dar el permiso de Calendar y crear el calendario «AgroServicios». */
function autorizarCalendario() {
  const c = calendarioAgro();
  Logger.log('Calendario listo: ' + c.getName());
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
