'use strict';
/* AgroServicios — horas, coste y amortización de la maquinaria, mantenimientos y trabajos externos.
   Todo se guarda en el propio móvil (IndexedDB) y funciona sin conexión. */

const APP_VERSION = '1.0.0';
const TIPOS_MANT = ['Revisión general', 'Cambio de aceite', 'Filtros', 'Reparación', 'Mejora', 'Neumáticos', 'Otros'];

/* ---------- Utilidades ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (n, min = 2, max = 2) => Number(n).toLocaleString('es-ES', { minimumFractionDigits: min, maximumFractionDigits: max, useGrouping: 'always' });
const eur = (n) => nf(n) + ' €';
const eur0 = (n) => nf(n, 0, 0) + ' €';
const hrs = (n) => nf(n, 0, 1) + ' h';
const pctf = (p) => nf(p * 100, 0, 1) + ' %';
const round = (n, d) => { const k = 10 ** d; return Math.round((n + Number.EPSILON * Math.sign(n)) * k) / k; };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const byName = (a, b) => a.nombre.localeCompare(b.nombre, 'es');

function parseNum(s) {
  s = String(s ?? '').trim().replace(/\s/g, '').replace(/[€h%]/gi, '');
  if (!s) return NaN;
  const c = s.lastIndexOf(','), d = s.lastIndexOf('.');
  if (c > -1 && d > -1) s = c > d ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (c > -1) s = s.replace(',', '.');
  return /^-?(\d+\.?\d*|\.\d+)$/.test(s) ? parseFloat(s) : NaN;
}
const fmtIn = (n, d = 4) => (n === '' || n == null || !isFinite(n) ? '' : String(round(n, d)).replace('.', ','));

function todayISO() { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
const thisYear = () => Number(todayISO().slice(0, 4));
const fmtDate = (iso) => iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
const monthOf = (iso) => iso.slice(0, 7);
function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  const s = new Date(y, m - 1, 1).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ---------- Almacenamiento (IndexedDB) ---------- */
let dbp;
function idb() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('agroservicios', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function dbGet(k) {
  const db = await idb();
  return new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
}
async function dbSet(k, v) {
  const db = await idb();
  return new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
}

/* ---------- Estado ---------- */
let state;
let saveChain = Promise.resolve();
function persist() {
  saveChain = saveChain.then(() => dbSet('state', state)).catch((e) => toast('No se pudo guardar en el móvil: ' + (e && e.message || e), true));
  markDirty();
  return saveChain;
}
function seedState() {
  const S = window.SEED;
  const maquinas = S.maquinas.map(([nombre, anio, compra, residual, g0, horas, costeH, subv], i) => ({ id: 'm' + (i + 1), nombre, anio, compra, residual, g0, horas, costeH, subv, horoOff: 0, vendida: null }));
  S.vendidas.forEach(([nombre, anio, compra, amortizado, anioVenta, precio], i) => maquinas.push({
    id: 'v' + (i + 1), nombre, anio, compra, residual: 0, g0: 0, horas: 0, costeH: 0, subv: 0, horoOff: 0,
    vendida: { anio: anioVenta, precio, amortizado, gastos: 0 },
  }));
  const mants = S.mantenimientos.map(([fecha, maqNombre, tipo, horo, desc, coste], i) => ({
    id: 'k' + (i + 1), ts: i, fecha, maq: maquinas.find((m) => m.nombre === maqNombre).id, tipo, horo, desc, coste, proxH: null, taller: '', notas: '',
  }));
  // El horómetro real del tractor nuevo se tomó de la revisión del Excel (7.080 h).
  for (const k of mants) { const m = maquinas.find((x) => x.id === k.maq); if (k.horo != null) m.horoOff = round(k.horo - m.horas, 2); }
  return { v: 1, settings: { avisoH: 20, lastBackup: null }, maquinas, mants, trabajos: [] };
}
const maqById = (id, st = state) => st.maquinas.find((m) => m.id === id);
const activas = (st = state) => st.maquinas.filter((m) => !m.vendida);

/* ---------- Motor de amortización ----------
   Gastos = gastos anteriores + coste de los mantenimientos anotados.
   Amortizable = compra + gastos − residual.
   Amortizado = horas × coste/hora + subvención, con tope en el amortizable.
   Pendiente = amortizable − amortizado.  % = amortizado ÷ amortizable. */
function calc(m, st = state) {
  if (m.vendida) {
    const gastos = m.vendida.gastos, neto = m.compra + gastos - m.vendida.amortizado;
    return { m, gastos, amortizado: m.vendida.amortizado, neto, resultado: m.vendida.precio - neto };
  }
  const gm = st.mants.filter((k) => k.maq === m.id).reduce((t, k) => t + (k.coste || 0), 0);
  const gastos = round(m.g0 + gm, 2);
  const amortizable = Math.max(0, round(m.compra + gastos - m.residual, 2));
  const porHoras = m.horas * m.costeH;
  const amortizado = round(Math.min(Math.max(porHoras + (m.subv || 0), 0), amortizable), 2);
  const pendiente = round(amortizable - amortizado, 2);
  const pct = amortizable > 0 ? amortizado / amortizable : 1;
  return { m, gm, gastos, amortizable, porHoras, amortizado, pendiente, pct, full: pendiente <= 0.005, horometro: round(m.horas + (m.horoOff || 0), 2) };
}
function resumen(st = state) {
  const xs = activas(st).map((m) => calc(m, st));
  const compra = xs.reduce((t, x) => t + x.m.compra, 0);
  const amortizable = xs.reduce((t, x) => t + x.amortizable, 0);
  const amortizado = xs.reduce((t, x) => t + x.amortizado, 0);
  return { xs, n: xs.length, compra, amortizable, amortizado, pendiente: amortizable - amortizado, pct: amortizable > 0 ? amortizado / amortizable : 0, gastos: xs.reduce((t, x) => t + x.gastos, 0) };
}

/* ---------- Avisos de mantenimiento ----------
   Cuenta el último mantenimiento de cada máquina y tipo que tenga «próximo cambio».
   Si después se anota otro del mismo tipo, el anterior queda «hecho». */
function laterSame(k, st = state) {
  return st.mants.some((o) => o.id !== k.id && o.maq === k.maq && o.tipo === k.tipo && (o.fecha > k.fecha || (o.fecha === k.fecha && o.ts > k.ts)));
}
function mantStatus(k, st = state) {
  const m = maqById(k.maq, st);
  if (!m) return { s: 'none' };
  if (laterSame(k, st)) return { s: 'done' };
  if (k.proxH == null || m.vendida) return { s: 'none' };
  const horo = calc(m, st).horometro;
  const resta = round(k.proxH - horo, 2);
  return { s: resta <= 0 ? 'over' : resta <= st.settings.avisoH ? 'soon' : 'ok', resta, horo };
}
function avisos(st = state) {
  return st.mants.map((k) => ({ k, ...mantStatus(k, st) })).filter((a) => a.s === 'over' || a.s === 'soon').sort((a, b) => a.resta - b.resta);
}

/* ---------- Trabajos externos ---------- */
function calcT(t) {
  const importe = round(t.horas * t.precioH, 2);
  const amort = round(t.horas * t.amortH, 2);
  const coste = round(amort + (t.otros || 0), 2);
  const beneficio = round(importe - coste, 2);
  return { importe, amort, coste, beneficio, pct: importe > 0 ? beneficio / importe : 0 };
}

function validate(st) {
  for (const m of st.maquinas) {
    if (!m.nombre) return 'Hay una máquina sin nombre';
    for (const k of ['compra', 'residual', 'g0', 'horas', 'costeH', 'subv']) if (!isFinite(m[k]) || m[k] < 0) return `Revisa los datos de «${m.nombre}»`;
  }
  return null;
}
function commit(mutator) {
  const c = structuredClone(state);
  try { mutator(c); } catch (e) { toast(e.message, true); return false; }
  const err = validate(c);
  if (err) { toast(err, true); return false; }
  state = c; persist(); renderAll();
  return true;
}

/* ---------- UI ---------- */
const ui = { tab: 'inicio', mantMaq: 'todas' };
let toastTimer;
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = ''; }, err ? 4200 : 2200);
}

const sheetRoot = $('#sheetRoot');
let sheetOpen = false;
function openSheet(title, bodyHTML) {
  if (!sheetOpen) history.pushState({ sheet: true }, '');
  sheetOpen = true;
  sheetRoot.innerHTML = `<div class="scrim"></div><section class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header><h2>${esc(title)}</h2><button class="x" aria-label="Cerrar">✕</button></header><div class="sheet-body">${bodyHTML}</div></section>`;
  $('.scrim', sheetRoot).onclick = closeSheet;
  $('.x', sheetRoot).onclick = closeSheet;
  return $('.sheet-body', sheetRoot);
}
function closeSheet() {
  if (!sheetOpen) return;
  sheetOpen = false; sheetRoot.innerHTML = '';
  if (history.state && history.state.sheet) history.back();
}
window.addEventListener('popstate', () => { if (sheetOpen) { sheetOpen = false; sheetRoot.innerHTML = ''; } });

function armDelete(btn, action, label = 'Borrar') {
  let armed = false, timer;
  btn.onclick = () => {
    if (!armed) { armed = true; btn.classList.add('armed'); btn.textContent = 'Pulsa otra vez para confirmar'; timer = setTimeout(() => { armed = false; btn.classList.remove('armed'); btn.textContent = label; }, 3500); }
    else { clearTimeout(timer); action(); }
  };
}
const field = (id, label, value, { mode = 'decimal', ph = '', type = 'text' } = {}) =>
  `<label class="fld"><span>${label}</span><input id="${id}" type="${type}" ${type === 'text' ? `inputmode="${mode}"` : ''} value="${esc(value)}" placeholder="${esc(ph)}" autocomplete="off"></label>`;
const bar = (x) => `<div class="bar ${x.full ? 'full' : ''}"><i style="width:${Math.min(100, Math.max(0, x.pct * 100)).toFixed(1)}%"></i></div>`;

/* ---------- Pestaña: Inicio (dashboard) ---------- */
function headInicio() {
  const r = resumen();
  return `<div class="kpis">
    <div class="k hero"><span>Amortizado del parque</span><strong>${pctf(r.pct)}</strong></div>
    <div class="hbar"><i style="width:${(r.pct * 100).toFixed(1)}%"></i></div>
    <div class="k"><span>Valor de compra</span><strong>${eur0(r.compra)}</strong></div>
    <div class="k"><span>Pendiente de amortizar</span><strong>${eur0(r.pendiente)}</strong></div>
  </div>`;
}
function renderInicio() {
  const r = resumen();
  const xs = [...r.xs].sort((a, b) => b.pct - a.pct || byName(a.m, b.m));
  $('#view').innerHTML = `
    <div class="summary"><span><b>${r.n}</b> máquinas activas</span><span>Amortizado <b>${eur0(r.amortizado)}</b></span><span>Gastos <b>${eur0(r.gastos)}</b></span></div>
    <ul class="list" id="dashList">${xs.map((x) => `
      <li><button class="row" data-id="${x.m.id}" style="display:block">
        <div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline">
          <div class="main"><div class="name">${esc(x.m.nombre)}</div><div class="sub">${x.full ? 'Amortizada' : 'Pendiente ' + eur(x.pendiente)} · ${hrs(x.m.horas)}</div></div>
          <div class="pct ${x.full ? 'full' : ''}">${pctf(x.pct)}</div>
        </div>${bar(x)}
      </button></li>`).join('')}</ul>`;
  $('#dashList').onclick = (e) => { const b = e.target.closest('[data-id]'); if (b) openMaquina(b.dataset.id); };
}

/* ---------- Pestaña: Máquinas (horas y gastos) ---------- */
function renderMaquinas() {
  const xs = activas().map((m) => calc(m)).sort((a, b) => byName(a.m, b.m));
  const vend = state.maquinas.filter((m) => m.vendida).sort((a, b) => b.vendida.anio - a.vendida.anio || byName(a, b));
  $('#view').innerHTML = `
    <p class="hint" style="margin:0 2px 10px">Pulsa <b>+ h</b> para sumar horas, o el total para corregirlo. Pulsa el nombre para ver o editar la máquina y añadir gastos.</p>
    <ul class="list" id="maqList">${xs.map((x) => `
      <li class="mrow">
        <button class="info" data-act="ver" data-id="${x.m.id}"><div class="name">${esc(x.m.nombre)}</div><div class="sub">${eur(x.m.costeH)}/h · ${pctf(x.pct)} amortizado</div></button>
        <button class="hours" data-act="total" data-id="${x.m.id}" aria-label="Editar total de horas"><b>${nf(x.m.horas, 0, 1)}</b><small>h</small></button>
        <button class="plus" data-act="sumar" data-id="${x.m.id}" aria-label="Sumar horas">+ h</button>
      </li>`).join('')}</ul>
    ${vend.length ? `<details class="more"><summary>Vendidas (${vend.length})</summary><ul class="list" id="vendList" style="margin-top:8px">${vend.map((m) => { const x = calc(m); return `
      <li><button class="row" data-id="${m.id}">
        <div class="main"><div class="name">${esc(m.nombre)}</div><div class="sub">Compra ${m.anio} · ${eur0(m.compra)} → venta ${m.vendida.anio} · ${eur0(m.vendida.precio)}</div></div>
        <div class="side"><div class="big ${x.resultado < 0 ? 'neg' : ''}">${eur(x.resultado)}</div><div class="sub">resultado</div></div>
      </button></li>`; }).join('')}</ul></details>` : ''}`;
  $('#maqList').onclick = (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'sumar') openSumar(b.dataset.id);
    else if (b.dataset.act === 'total') openTotal(b.dataset.id);
    else openMaquina(b.dataset.id);
  };
  const vl = $('#vendList'); if (vl) vl.onclick = (e) => { const b = e.target.closest('[data-id]'); if (b) openVendida(b.dataset.id); };
}

function openSumar(id) {
  const m = maqById(id); const x0 = calc(m);
  let v = '';
  const body = openSheet('Sumar horas', `
    <div class="box"><div><span>${esc(m.nombre)}</span><b>${hrs(m.horas)}</b></div></div>
    <label class="fld"><span>Horas trabajadas</span><input id="hQ" type="text" inputmode="decimal" placeholder="0" autocomplete="off"></label>
    <div class="quick" id="hQuick">${[0.5, 1, 2, 3, 4, 6, 8].map((n) => `<button type="button" class="chip" data-n="${n}">${nf(n, 0, 1)}</button>`).join('')}</div>
    <div class="box" id="hPrev"></div>
    <div class="actions"><button class="btn primary" id="hSave">Sumar</button></div>`);
  const q = $('#hQ', body), prev = $('#hPrev', body);
  const draw = () => {
    const n = parseNum(v);
    if (!(n > 0)) { prev.innerHTML = `<div><span>Amortizado ahora</span><b>${eur(x0.amortizado)} · ${pctf(x0.pct)}</b></div>`; return; }
    const x1 = calc({ ...m, horas: m.horas + n });
    prev.innerHTML = `<div><span>Total</span><b>${hrs(m.horas)} → ${hrs(m.horas + n)}</b></div><div><span>Amortiza</span><b>+${eur(x1.amortizado - x0.amortizado)}</b></div><div><span>Quedará</span><b>${pctf(x1.pct)}</b></div>`;
  };
  q.oninput = () => { v = q.value; draw(); };
  $('#hQuick', body).onclick = (e) => { const b = e.target.closest('[data-n]'); if (b) { v = fmtIn(Number(b.dataset.n)); q.value = v; draw(); } };
  const save = () => {
    const n = parseNum(v);
    if (!(n > 0)) return toast('Escribe las horas a sumar (mayor que 0)', true);
    if (commit((c) => { const mm = maqById(id, c); mm.horas = round(mm.horas + n, 2); })) { closeSheet(); toast(`+${hrs(n)} · ${m.nombre}`); }
  };
  $('#hSave', body).onclick = save;
  q.onkeydown = (e) => { if (e.key === 'Enter') save(); };
  draw(); setTimeout(() => q.focus(), 50);
}

function openTotal(id) {
  const m = maqById(id);
  const body = openSheet('Total de horas', `
    <p class="small" style="margin-top:0">${esc(m.nombre)}. Son las horas desde que la compraste: las que cuentan para la amortización.</p>
    ${field('tH', 'Total de horas', fmtIn(m.horas, 2))}
    <div class="actions"><button class="btn primary" id="tSave">Guardar</button></div>`);
  const i = $('#tH', body);
  const save = () => {
    const n = parseNum(i.value);
    if (!(n >= 0)) return toast('Escribe un total válido', true);
    if (commit((c) => { maqById(id, c).horas = round(n, 2); })) { closeSheet(); toast('Total actualizado: ' + hrs(n)); }
  };
  $('#tSave', body).onclick = save;
  i.onkeydown = (e) => { if (e.key === 'Enter') save(); };
  setTimeout(() => { i.focus(); i.select(); }, 50);
}

function openMaquina(id) {
  const isNew = !id;
  const m = isNew ? { nombre: '', anio: thisYear(), compra: '', residual: '', g0: 0, horas: 0, costeH: '', subv: 0, horoOff: 0 } : maqById(id);
  const x = isNew ? null : calc(m);
  const recs = isNew ? [] : state.mants.filter((k) => k.maq === id).sort((a, b) => b.fecha.localeCompare(a.fecha) || b.ts - a.ts);
  const body = openSheet(isNew ? 'Máquina nueva' : m.nombre, `
    ${isNew ? '' : `<div class="box">
      <div><span>Valor de compra</span><b>${eur(m.compra)}</b></div>
      <div><span>Gastos (anteriores ${eur(m.g0)} + anotados ${eur(x.gm)})</span><b>${eur(x.gastos)}</b></div>
      <div><span>Valor residual</span><b>−${eur(m.residual)}</b></div>
      <div class="tot"><span>A amortizar</span><b>${eur(x.amortizable)}</b></div>
      <div><span>Por horas (${hrs(m.horas)} × ${eur(m.costeH)})</span><b>${eur(x.porHoras)}</b></div>
      ${m.subv ? `<div><span>Subvención</span><b>${eur(m.subv)}</b></div>` : ''}
      <div class="tot"><span>Amortizado${x.full && x.porHoras + (m.subv || 0) > x.amortizable ? ' (tope)' : ''}</span><b>${eur(x.amortizado)} · ${pctf(x.pct)}</b></div>
      <div><span>Pendiente</span><b>${eur(x.pendiente)}</b></div>
      <div><span>Horómetro</span><b>${hrs(x.horometro)}</b></div>
    </div>
    <div class="actions"><button class="btn primary" id="mGasto">Añadir gasto o mejora</button></div>
    ${recs.length ? `<h3>Gastos y mantenimientos anotados</h3><ul class="list" id="mRecs">${recs.slice(0, 6).map((k) => `
      <li><button class="row" data-id="${k.id}"><div class="main"><div class="name">${esc(k.tipo)}</div><div class="sub">${fmtDate(k.fecha)}${k.desc ? ' · ' + esc(k.desc) : ''}</div></div><div class="side"><b>${eur(k.coste || 0)}</b></div></button></li>`).join('')}</ul>` : ''}
    <h3>Datos de la máquina</h3>`}
    <label class="fld"><span>Nombre</span><input id="mN" type="text" value="${esc(m.nombre)}" autocomplete="off"></label>
    <div class="grid2">
      ${field('mA', 'Año de compra', m.anio, { mode: 'numeric' })}
      ${field('mCH', 'Coste por hora €', fmtIn(m.costeH))}
    </div>
    <div class="grid2">
      ${field('mC', 'Valor de compra €', fmtIn(m.compra, 2))}
      ${field('mR', 'Valor residual €', fmtIn(m.residual, 2))}
    </div>
    <div class="grid2">
      ${field('mS', 'Subvención €', fmtIn(m.subv, 2), { ph: '0' })}
      ${field('mG', 'Gastos anteriores €', fmtIn(m.g0, 2), { ph: '0' })}
    </div>
    ${isNew ? field('mH', 'Horas ya trabajadas', '0') : field('mHo', 'Horómetro real ahora (h)', fmtIn(x.horometro, 2))}
    <p class="hint">${isNew ? 'Las horas que sumes después cuentan para la amortización.' : 'Si cambias el horómetro, solo se ajusta para los avisos de mantenimiento: no cambia las horas de amortización.'} Los gastos que anotes en Mantenimiento se suman solos.</p>
    <div class="actions"><button class="btn primary" id="mSave">Guardar</button></div>
    ${isNew ? '' : `<div class="sep"></div><div class="actions two"><button class="btn danger" id="mDel" ${recs.length ? 'disabled' : ''}>Borrar</button><button class="btn" id="mSell">Marcar vendida</button></div>
    ${recs.length ? '<p class="hint" style="margin-top:10px">Solo se pueden borrar máquinas sin mantenimientos anotados. Si la vendiste, márcala como vendida.</p>' : ''}`}`);

  const val = (sel) => $(sel, body).value;
  $('#mSave', body).onclick = () => {
    const nombre = val('#mN').trim();
    if (!nombre) return toast('Escribe el nombre', true);
    if (state.maquinas.some((o) => o.id !== id && !o.vendida && o.nombre.toLowerCase() === nombre.toLowerCase())) return toast('Ya hay una máquina con ese nombre', true);
    const anio = parseInt(val('#mA'), 10);
    if (!(anio >= 1950 && anio <= 2100)) return toast('Revisa el año de compra', true);
    const compra = parseNum(val('#mC')), residual = parseNum(val('#mR')), costeH = parseNum(val('#mCH'));
    const subv = val('#mS').trim() ? parseNum(val('#mS')) : 0, g0 = val('#mG').trim() ? parseNum(val('#mG')) : 0;
    if (!(compra >= 0)) return toast('Escribe el valor de compra', true);
    if (!(residual >= 0)) return toast('Escribe el valor residual (0 si no tiene)', true);
    if (!(costeH >= 0)) return toast('Escribe el coste por hora', true);
    if (!(subv >= 0) || !(g0 >= 0)) return toast('Revisa la subvención y los gastos', true);
    let horas = 0, horo = null;
    if (isNew) { horas = val('#mH').trim() ? parseNum(val('#mH')) : 0; if (!(horas >= 0)) return toast('Revisa las horas', true); }
    else { horo = parseNum(val('#mHo')); if (!(horo >= 0)) return toast('Revisa el horómetro', true); }
    const ok = commit((c) => {
      const data = { nombre, anio, compra: round(compra, 2), residual: round(residual, 2), costeH: round(costeH, 4), subv: round(subv, 2), g0: round(g0, 2) };
      if (isNew) c.maquinas.push({ id: 'm' + uid().slice(0, 8), ...data, horas: round(horas, 2), horoOff: 0, vendida: null });
      else { const mm = maqById(id, c); Object.assign(mm, data); mm.horoOff = round(horo - mm.horas, 2); }
    });
    if (ok) { closeSheet(); toast(isNew ? 'Máquina añadida' : 'Máquina actualizada'); }
  };
  if (isNew) return;
  $('#mGasto', body).onclick = () => { closeSheet(); setTimeout(() => openMantForm(null, id), 30); };
  const rl = $('#mRecs', body); if (rl) rl.onclick = (e) => { const b = e.target.closest('[data-id]'); if (b) { closeSheet(); setTimeout(() => openMantForm(state.mants.find((k) => k.id === b.dataset.id)), 30); } };
  $('#mSell', body).onclick = () => { closeSheet(); setTimeout(() => openVender(id), 30); };
  if (!recs.length) armDelete($('#mDel', body), () => { if (commit((c) => { c.maquinas = c.maquinas.filter((o) => o.id !== id); })) { closeSheet(); toast('Máquina borrada'); } });
}

function openVender(id) {
  const m = maqById(id); const x = calc(m);
  const body = openSheet('Marcar vendida', `
    <div class="box"><div><span>${esc(m.nombre)}</span><b></b></div><div><span>Compra + gastos</span><b>${eur(m.compra + x.gastos)}</b></div><div><span>Amortizado</span><b>${eur(x.amortizado)}</b></div><div class="tot"><span>Valor neto</span><b>${eur(m.compra + x.gastos - x.amortizado)}</b></div></div>
    <div class="grid2">${field('vA', 'Año de venta', thisYear(), { mode: 'numeric' })}${field('vP', 'Precio de venta €', '')}</div>
    <div class="box" id="vRes"></div>
    <p class="hint">Resultado = precio de venta − valor neto. Sale del inicio y de la lista de activas; la verás en «Vendidas».</p>
    <div class="actions"><button class="btn primary" id="vSave">Marcar vendida</button></div>`);
  const neto = m.compra + x.gastos - x.amortizado;
  const draw = () => { const p = parseNum($('#vP', body).value); $('#vRes', body).innerHTML = `<div><span>Resultado de la venta</span><b class="${isFinite(p) && p - neto < 0 ? 'neg' : ''}">${isFinite(p) ? eur(p - neto) : '—'}</b></div>`; };
  $('#vP', body).oninput = draw; draw();
  $('#vSave', body).onclick = () => {
    const anio = parseInt($('#vA', body).value, 10), precio = parseNum($('#vP', body).value);
    if (!(anio >= 1950 && anio <= 2100)) return toast('Revisa el año de venta', true);
    if (!(precio >= 0)) return toast('Escribe el precio de venta', true);
    if (commit((c) => { maqById(id, c).vendida = { anio, precio: round(precio, 2), amortizado: x.amortizado, gastos: x.gastos }; })) { closeSheet(); toast('Marcada como vendida'); }
  };
}
function openVendida(id) {
  const m = maqById(id); const x = calc(m);
  const body = openSheet(m.nombre, `
    <div class="box">
      <div><span>Compra (${m.anio})</span><b>${eur(m.compra)}</b></div>
      ${x.gastos ? `<div><span>Gastos</span><b>${eur(x.gastos)}</b></div>` : ''}
      <div><span>Amortizado al vender</span><b>${eur(x.amortizado)}</b></div>
      <div><span>Valor neto</span><b>${eur(x.neto)}</b></div>
      <div><span>Venta (${m.vendida.anio})</span><b>${eur(m.vendida.precio)}</b></div>
      <div class="tot"><span>Resultado</span><b class="${x.resultado < 0 ? 'neg' : ''}">${eur(x.resultado)}</b></div>
    </div>
    <div class="actions two"><button class="btn danger" id="vdDel">Borrar</button><button class="btn" id="vdUndo">Deshacer venta</button></div>`);
  $('#vdUndo', body).onclick = () => {
    if (m.id.startsWith('v')) return toast('Esta venta viene del Excel: no tiene datos de horas para volver a activarla', true);
    if (commit((c) => { maqById(id, c).vendida = null; })) { closeSheet(); toast('Vuelve a estar activa'); }
  };
  armDelete($('#vdDel', body), () => { if (commit((c) => { c.maquinas = c.maquinas.filter((o) => o.id !== id); c.mants = c.mants.filter((k) => k.maq !== id); })) { closeSheet(); toast('Borrada'); } });
}

/* ---------- Pestaña: Mantenimiento ---------- */
const PILL = { over: ['over', 'Vencido'], soon: ['soon', 'Próximo'], ok: ['ok', 'Al día'], done: ['done', 'Hecho'] };
function renderMant() {
  const av = avisos();
  const maqs = state.maquinas.filter((m) => !m.vendida || state.mants.some((k) => k.maq === m.id)).sort(byName);
  const list = state.mants.filter((k) => ui.mantMaq === 'todas' || k.maq === ui.mantMaq).sort((a, b) => b.fecha.localeCompare(a.fecha) || b.ts - a.ts);
  $('#view').innerHTML = `
    <h3 style="margin-top:4px">Avisos</h3>
    ${av.length ? `<ul class="list" id="avList">${av.map((a) => `
      <li><button class="alert ${a.s === 'over' ? 'over' : ''}" data-id="${a.k.id}">
        <div><div class="name">${esc(maqById(a.k.maq).nombre)}</div><div class="sub">${esc(a.k.tipo)} · toca a las ${hrs(a.k.proxH)} · horómetro ${hrs(a.horo)}</div></div>
        <div class="side"><div class="big">${a.s === 'over' ? 'Pasado ' + hrs(-a.resta) : 'Faltan ' + hrs(a.resta)}</div></div>
      </button></li>`).join('')}</ul>` : '<div class="okline">✓ Nada pendiente de mantenimiento</div>'}
    <div class="inline-set"><span>Avisar cuando falten</span><input id="avH" type="text" inputmode="decimal" value="${fmtIn(state.settings.avisoH)}"><span>horas o menos</span></div>
    <h3>Historial</h3>
    <div class="toolbar"><select id="mantMaq" class="grow" aria-label="Máquina"><option value="todas">Todas las máquinas</option>${maqs.map((m) => `<option value="${m.id}" ${ui.mantMaq === m.id ? 'selected' : ''}>${esc(m.nombre)}${m.vendida ? ' (vendida)' : ''}</option>`).join('')}</select></div>
    <div class="summary"><span><b>${list.length}</b> anotaciones</span><span>Coste <b>${eur(list.reduce((t, k) => t + (k.coste || 0), 0))}</b></span></div>
    ${list.length ? `<ul class="list" id="mantList">${list.map((k) => { const st = mantStatus(k); const p = PILL[st.s]; return `
      <li><button class="row" data-id="${k.id}">
        <div class="main"><div class="name">${esc(maqById(k.maq)?.nombre ?? '(borrada)')}</div><div class="sub">${p ? `<span class="pill ${p[0]}">${p[1]}</span>` : ''}${fmtDate(k.fecha)} · ${esc(k.tipo)}${k.desc ? ' · ' + esc(k.desc) : ''}</div></div>
        <div class="side"><div class="big">${eur(k.coste || 0)}</div>${k.horo != null ? `<div class="sub">${hrs(k.horo)}</div>` : ''}</div>
      </button></li>`; }).join('')}</ul>` : '<div class="empty">No hay mantenimientos anotados.<br>Pulsa «Nuevo mantenimiento».</div>'}`;
  const open = (e) => { const b = e.target.closest('[data-id]'); if (b) openMantForm(state.mants.find((k) => k.id === b.dataset.id)); };
  const al = $('#avList'); if (al) al.onclick = open;
  const ml = $('#mantList'); if (ml) ml.onclick = open;
  $('#mantMaq').onchange = (e) => { ui.mantMaq = e.target.value; renderMant(); };
  $('#avH').onchange = (e) => {
    const n = parseNum(e.target.value);
    if (!(n >= 0)) { toast('Escribe un número de horas', true); e.target.value = fmtIn(state.settings.avisoH); return; }
    commit((c) => { c.settings.avisoH = round(n, 1); }); toast(`Aviso con ${hrs(n)} de antelación`);
  };
}

function openMantForm(orig, maqPre) {
  const isNew = !orig;
  const act = activas().sort(byName);
  const f = orig
    ? { fecha: orig.fecha, maq: orig.maq, tipo: orig.tipo, horo: fmtIn(orig.horo, 2), desc: orig.desc, coste: fmtIn(orig.coste, 2), cada: orig.proxH != null && orig.horo != null ? fmtIn(orig.proxH - orig.horo, 2) : '', prox: fmtIn(orig.proxH, 2), taller: orig.taller, notas: orig.notas }
    : { fecha: todayISO(), maq: maqPre || '', tipo: maqPre ? 'Mejora' : TIPOS_MANT[0], horo: '', desc: '', coste: '', cada: '', prox: '', taller: '', notas: '' };
  if (isNew && f.maq) f.horo = fmtIn(calc(maqById(f.maq)).horometro, 2);
  const talleres = [...new Set(state.mants.map((k) => k.taller).filter(Boolean))];
  const body = openSheet(isNew ? 'Nuevo mantenimiento' : 'Editar mantenimiento', '<div id="kf"></div>');
  const box = $('#kf', body);
  const draw = () => {
    const opts = act.map((m) => `<option value="${m.id}" ${f.maq === m.id ? 'selected' : ''}>${esc(m.nombre)}</option>`).join('');
    const extra = f.maq && !act.some((m) => m.id === f.maq) ? `<option value="${f.maq}" selected>${esc(maqById(f.maq)?.nombre ?? '(borrada)')}</option>` : '';
    box.innerHTML = `
      <label class="fld"><span>Fecha</span><input id="kF" type="date" value="${f.fecha}"></label>
      <label class="fld"><span>Máquina</span><select id="kM"><option value="">Elige la máquina…</option>${extra}${opts}</select></label>
      <div class="fld"><span>Tipo</span><div class="chips wrap" id="kT">${TIPOS_MANT.map((t) => `<button type="button" class="chip" data-v="${t}" aria-pressed="${f.tipo === t}">${t}</button>`).join('')}</div></div>
      <label class="fld"><span>Descripción</span><input id="kD" type="text" value="${esc(f.desc)}" placeholder="Por ejemplo: cambio de aceites y filtros" autocomplete="off"></label>
      <div class="grid2">${field('kC', 'Coste €', f.coste, { ph: '0' })}${field('kH', 'Horómetro (h)', f.horo, { ph: 'lectura real' })}</div>
      <p class="hint">El coste se suma a los gastos de la máquina y recalcula su amortización.${f.fecha === todayISO() ? ' Si es de hoy, el horómetro de la máquina se ajusta a esta lectura.' : ''}</p>
      <div class="grid2">${field('kE', 'Próximo: cada (h)', f.cada, { ph: 'p. ej. 250' })}${field('kP', 'Próximo a las (h)', f.prox, { ph: 'horómetro' })}</div>
      <p class="hint">Déjalo vacío si no necesita aviso.</p>
      <label class="fld"><span>Taller / operario</span><input id="kW" type="text" list="kWl" value="${esc(f.taller)}" autocomplete="off"></label>
      <datalist id="kWl">${talleres.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
      <label class="fld"><span>Notas</span><input id="kN" type="text" value="${esc(f.notas)}" autocomplete="off"></label>
      <div class="actions ${isNew ? '' : 'two'}">${isNew ? '' : '<button class="btn danger" id="kDel">Borrar</button>'}<button class="btn primary" id="kSave">Guardar</button></div>`;
    const bindTxt = (sel, k) => { $(sel, box).oninput = (e) => { f[k] = e.target.value; }; };
    bindTxt('#kD', 'desc'); bindTxt('#kC', 'coste'); bindTxt('#kW', 'taller'); bindTxt('#kN', 'notas');
    $('#kF', box).onchange = (e) => { f.fecha = e.target.value; draw(); };
    $('#kM', box).onchange = (e) => { f.maq = e.target.value; const m = maqById(f.maq); if (m && isNew) { f.horo = fmtIn(calc(m).horometro, 2); syncProx('h'); } draw(); };
    $('#kT', box).onclick = (e) => { const b = e.target.closest('[data-v]'); if (b) { f.tipo = b.dataset.v; draw(); } };
    const h = $('#kH', box), e1 = $('#kE', box), p = $('#kP', box);
    const syncProx = (who) => {
      const hv = parseNum(f.horo), ev = parseNum(f.cada), pv = parseNum(f.prox);
      if ((who === 'h' || who === 'e') && isFinite(hv) && isFinite(ev)) f.prox = fmtIn(hv + ev, 2);
      else if (who === 'e' && !f.cada.trim()) f.prox = '';
      else if (who === 'p') f.cada = isFinite(hv) && isFinite(pv) ? fmtIn(pv - hv, 2) : '';
    };
    h.oninput = () => { f.horo = h.value; syncProx('h'); p.value = f.prox; };
    e1.oninput = () => { f.cada = e1.value; syncProx('e'); p.value = f.prox; };
    p.oninput = () => { f.prox = p.value; syncProx('p'); e1.value = f.cada; };
    $('#kSave', box).onclick = save;
    if (!isNew) armDelete($('#kDel', box), () => { if (commit((c) => { c.mants = c.mants.filter((k) => k.id !== orig.id); })) { closeSheet(); toast('Mantenimiento borrado'); } });
  };
  const save = () => {
    if (!f.fecha) return toast('Indica la fecha', true);
    if (!f.maq) return toast('Elige la máquina', true);
    const coste = f.coste.trim() ? parseNum(f.coste) : 0;
    if (!(coste >= 0)) return toast('Revisa el coste', true);
    const horo = f.horo.trim() ? parseNum(f.horo) : null;
    if (horo != null && !(horo >= 0)) return toast('Revisa el horómetro', true);
    const proxH = f.prox.trim() ? parseNum(f.prox) : null;
    if (proxH != null && !(proxH >= 0)) return toast('Revisa el próximo cambio', true);
    if (proxH != null && horo != null && proxH <= horo) return toast('El próximo cambio debe ser mayor que el horómetro', true);
    const data = { fecha: f.fecha, maq: f.maq, tipo: f.tipo, horo: horo == null ? null : round(horo, 2), desc: f.desc.trim(), coste: round(coste, 2), proxH: proxH == null ? null : round(proxH, 2), taller: f.taller.trim(), notas: f.notas.trim() };
    const ok = commit((c) => {
      if (isNew) c.mants.push({ id: uid(), ts: Date.now(), ...data });
      else Object.assign(c.mants.find((k) => k.id === orig.id), data);
      const m = maqById(f.maq, c);
      if (horo != null && f.fecha === todayISO() && m && !m.vendida) m.horoOff = round(horo - m.horas, 2);
    });
    if (ok) { closeSheet(); toast(isNew ? 'Mantenimiento guardado' : 'Mantenimiento actualizado'); }
  };
  draw();
}

/* ---------- Pestaña: Trabajos externos ---------- */
function totYear(y = thisYear()) {
  const ts = state.trabajos.filter((t) => Number(t.fecha.slice(0, 4)) === y).map(calcT);
  const importe = ts.reduce((s, x) => s + x.importe, 0), beneficio = ts.reduce((s, x) => s + x.beneficio, 0);
  const pendiente = state.trabajos.filter((t) => !t.cobrado).reduce((s, t) => s + calcT(t).importe, 0);
  return { y, n: ts.length, importe, beneficio, pct: importe > 0 ? beneficio / importe : 0, pendiente };
}
function headTrabajos() {
  const t = totYear();
  return `<div class="kpis">
    <div class="k"><span>Importe ${t.y}</span><strong>${eur0(t.importe)}</strong></div>
    <div class="k"><span>Beneficio ${t.y}</span><strong>${eur0(t.beneficio)} <small>${t.importe > 0 ? pctf(t.pct) : ''}</small></strong></div>
    <div class="k"><span>Pendiente de cobro</span><strong>${eur0(t.pendiente)}</strong></div>
    <div class="k"><span>Trabajos ${t.y}</span><strong>${t.n}</strong></div>
  </div>`;
}
function renderTrabajos() {
  const list = [...state.trabajos].sort((a, b) => b.fecha.localeCompare(a.fecha) || b.ts - a.ts);
  let lastM = '', html = '';
  for (const t of list) {
    const mm = monthOf(t.fecha);
    if (mm !== lastM) {
      const ms = list.filter((o) => monthOf(o.fecha) === mm).map(calcT);
      html += `<li class="day" style="display:flex;justify-content:space-between;gap:8px;text-transform:none"><span>${monthLabel(mm)}</span><span>${eur0(ms.reduce((s, x) => s + x.importe, 0))} · benef. ${eur0(ms.reduce((s, x) => s + x.beneficio, 0))}</span></li>`;
      lastM = mm;
    }
    const x = calcT(t);
    html += `<li class="trow">
      <button class="top2" data-id="${t.id}">
        <div class="main"><div class="name">${esc(t.cliente)}</div><div class="sub">${fmtDate(t.fecha)}${t.desc ? ' · ' + esc(t.desc) : ''}</div></div>
        <div class="side"><div class="big">${eur(x.importe)}</div><div class="sub">${hrs(t.horas)} × ${eur(t.precioH)}</div></div>
      </button>
      <div class="foot"><span>Beneficio <b class="${x.beneficio < 0 ? 'neg' : ''}">${eur(x.beneficio)}</b> · ${pctf(x.pct)}</span>
        <button class="paid ${t.cobrado ? 'on' : ''}" data-paid="${t.id}" aria-pressed="${!!t.cobrado}">${t.cobrado ? '✓ Cobrado' : 'Pendiente'}</button></div>
    </li>`;
  }
  $('#view').innerHTML = list.length ? `<ul class="list" id="trList">${html}</ul>` : '<div class="empty">Aún no hay trabajos externos.<br>Pulsa «Nuevo trabajo» para anotar el primero.</div>';
  const ul = $('#trList');
  if (ul) ul.onclick = (e) => {
    const p = e.target.closest('[data-paid]');
    if (p) { const id = p.dataset.paid; let now; if (commit((c) => { const t = c.trabajos.find((o) => o.id === id); t.cobrado = !t.cobrado; now = t.cobrado; })) toast(now ? 'Marcado como cobrado' : 'Marcado como pendiente'); return; }
    const b = e.target.closest('[data-id]'); if (b) openTrabajo(state.trabajos.find((t) => t.id === b.dataset.id));
  };
}

function openTrabajo(orig) {
  const isNew = !orig;
  const f = orig
    ? { fecha: orig.fecha, cliente: orig.cliente, desc: orig.desc, horas: fmtIn(orig.horas, 2), precioH: fmtIn(orig.precioH), amortH: fmtIn(orig.amortH), otros: fmtIn(orig.otros, 2), cobrado: !!orig.cobrado }
    : { fecha: todayISO(), cliente: '', desc: '', horas: '', precioH: '', amortH: '', otros: '', cobrado: false };
  const clientes = [...new Set([...state.trabajos].sort((a, b) => b.ts - a.ts).map((t) => t.cliente))];
  const body = openSheet(isNew ? 'Nuevo trabajo' : 'Editar trabajo', `
    <label class="fld"><span>Fecha</span><input id="wF" type="date" value="${f.fecha}"></label>
    <label class="fld"><span>Cliente</span><input id="wC" type="text" list="wCl" value="${esc(f.cliente)}" autocomplete="off"></label>
    <datalist id="wCl">${clientes.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    <label class="fld"><span>Descripción del trabajo</span><input id="wD" type="text" value="${esc(f.desc)}" placeholder="Por ejemplo: triturar poda con tractor y trituradora" autocomplete="off"></label>
    <div class="grid2">${field('wH', 'Horas trabajadas', f.horas, { ph: '0' })}${field('wP', 'Precio por hora €', f.precioH, { ph: '0' })}</div>
    <div class="grid2">${field('wA', 'Amortización por hora €', f.amortH, { ph: 'suma de aperos' })}${field('wO', 'Otros gastos total €', f.otros, { ph: 'gasoil, etc.' })}</div>
    <div class="box" id="wBox"></div>
    <button type="button" class="switch" id="wPaid" role="switch" aria-checked="${f.cobrado}"><span>Cobrado</span><i></i></button>
    <p class="hint">Precios sin IVA. Estas horas no se suman a las de tus máquinas.</p>
    <div class="actions ${isNew ? '' : 'two'}">${isNew ? '' : '<button class="btn danger" id="wDel">Borrar</button>'}<button class="btn primary" id="wSave">Guardar</button></div>`);
  const nums = () => {
    const horas = parseNum(f.horas), precioH = parseNum(f.precioH);
    const amortH = f.amortH.trim() ? parseNum(f.amortH) : 0, otros = f.otros.trim() ? parseNum(f.otros) : 0;
    return { horas, precioH, amortH, otros };
  };
  const draw = () => {
    const n = nums();
    if (![n.horas, n.precioH, n.amortH, n.otros].every(isFinite)) { $('#wBox', body).innerHTML = '<div><span>Importe</span><b>—</b></div><div><span>Beneficio</span><b>—</b></div>'; return; }
    const x = calcT(n);
    $('#wBox', body).innerHTML = `
      <div><span>Importe</span><b>${eur(x.importe)}</b></div>
      <div><span>Amortización (${hrs(n.horas)} × ${eur(n.amortH)})</span><b>−${eur(x.amort)}</b></div>
      <div><span>Otros gastos</span><b>−${eur(n.otros)}</b></div>
      <div class="tot"><span>Beneficio</span><b class="${x.beneficio < 0 ? 'neg' : ''}">${eur(x.beneficio)} · ${pctf(x.pct)}</b></div>`;
  };
  const bind = (sel, k) => { $(sel, body).oninput = (e) => { f[k] = e.target.value; draw(); }; };
  bind('#wC', 'cliente'); bind('#wD', 'desc'); bind('#wH', 'horas'); bind('#wP', 'precioH'); bind('#wA', 'amortH'); bind('#wO', 'otros');
  $('#wF', body).onchange = (e) => { f.fecha = e.target.value; };
  $('#wPaid', body).onclick = (e) => { f.cobrado = !f.cobrado; e.currentTarget.setAttribute('aria-checked', f.cobrado); };
  $('#wSave', body).onclick = () => {
    if (!f.fecha) return toast('Indica la fecha', true);
    const cliente = f.cliente.trim(); if (!cliente) return toast('Escribe el cliente', true);
    const n = nums();
    if (!(n.horas > 0)) return toast('Escribe las horas trabajadas', true);
    if (!(n.precioH >= 0)) return toast('Escribe el precio por hora', true);
    if (!(n.amortH >= 0)) return toast('Revisa la amortización por hora', true);
    if (!(n.otros >= 0)) return toast('Revisa los otros gastos', true);
    const data = { fecha: f.fecha, cliente, desc: f.desc.trim(), horas: round(n.horas, 2), precioH: round(n.precioH, 4), amortH: round(n.amortH, 4), otros: round(n.otros, 2), cobrado: f.cobrado };
    const ok = commit((c) => {
      if (isNew) c.trabajos.push({ id: uid(), ts: Date.now(), ...data });
      else Object.assign(c.trabajos.find((t) => t.id === orig.id), data);
    });
    if (ok) { closeSheet(); toast(isNew ? 'Trabajo guardado' : 'Trabajo actualizado'); }
  };
  if (!isNew) armDelete($('#wDel', body), () => { if (commit((c) => { c.trabajos = c.trabajos.filter((t) => t.id !== orig.id); })) { closeSheet(); toast('Trabajo borrado'); } });
  draw();
}

/* ---------- Copia automática en Google Sheets ----------
   La app envía el estado completo al receptor (Apps Script). La hoja es un espejo de un solo sentido:
   sin conexión queda "pendiente" y se envía al volver la conexión. */
let sync = { url: '', clave: '', enabled: false, dirty: false, lastOk: null, lastError: '' };
let syncRev = 0, syncTimer = null, syncRetry = null, syncRunning = false;
const syncOn = () => !!(sync.enabled && sync.url && sync.clave);
async function loadSync() { try { const s = await dbGet('sync'); if (s) sync = { ...sync, ...s }; } catch (_) { /* nada */ } }
function saveSync() { dbSet('sync', sync).catch(() => {}); }

function markDirty() {
  if (!syncOn()) return;
  sync.dirty = true; syncRev++; saveSync(); renderSyncStatus();
  clearTimeout(syncTimer); syncTimer = setTimeout(() => runSync(), 2500);
}
async function callScript(accion, extra = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    // Sin cabeceras propias: así es una petición simple (text/plain) y Google no exige comprobación previa.
    const res = await fetch(sync.url, { method: 'POST', body: JSON.stringify({ accion, clave: sync.clave, ...extra }), signal: ctrl.signal });
    const txt = await res.text();
    try { return JSON.parse(txt); } catch (_) { throw new Error('La dirección no responde como el receptor (revisa que esté publicado para «Cualquier usuario»)'); }
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Tiempo de espera agotado');
    if (e instanceof TypeError) throw new Error('Sin conexión con Google');
    throw e;
  } finally { clearTimeout(t); }
}
/* Tablas que se escriben en la hoja. fechas = columnas con fecha AAAA-MM-DD. */
function syncPayload() {
  const r = resumen();
  const EUR = '#,##0.00', H = '#,##0.0', P = '0.0%';
  const maq = [...r.xs].sort((a, b) => byName(a.m, b.m)).map((x) => [x.m.nombre, x.m.anio, x.m.compra, x.m.residual, x.gastos, x.m.subv || 0, x.m.horas, x.m.costeH, x.amortizado, x.pendiente, round(x.pct, 4), x.horometro]);
  const vend = state.maquinas.filter((m) => m.vendida).map((m) => { const x = calc(m); return [m.nombre, m.anio, m.compra, x.gastos, x.amortizado, m.vendida.anio, m.vendida.precio, round(x.resultado, 2)]; });
  const mants = [...state.mants].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.ts - b.ts).map((k) => {
    const st = mantStatus(k);
    return [k.fecha, maqById(k.maq)?.nombre ?? '(borrada)', k.tipo, k.horo ?? '', k.desc, k.coste || 0, k.proxH ?? '', k.taller, { over: 'Vencido', soon: 'Próximo', ok: 'Al día', done: 'Hecho' }[st.s] || '', k.notas];
  });
  const trab = [...state.trabajos].sort((a, b) => a.fecha.localeCompare(b.fecha) || a.ts - b.ts).map((t) => {
    const x = calcT(t);
    return [t.fecha, t.cliente, t.desc, t.horas, t.amortH, t.otros || 0, t.precioH, x.importe, x.beneficio, round(x.pct, 4), t.cobrado ? 'Cobrado' : 'Pendiente'];
  });
  const ty = totYear();
  const res = [
    ['Nº máquinas activas', r.n], ['Valor de compra total', round(r.compra, 2)], ['Amortizado', round(r.amortizado, 2)],
    ['Pendiente de amortizar', round(r.pendiente, 2)], ['% amortizado del parque', round(r.pct, 4)], ['Gastos (mantenimiento y mejoras)', round(r.gastos, 2)],
    ['Trabajos externos ' + ty.y + ' · importe', round(ty.importe, 2)], ['Trabajos externos ' + ty.y + ' · beneficio', round(ty.beneficio, 2)], ['Pendiente de cobro', round(ty.pendiente, 2)],
  ];
  const tablas = [
    { nombre: 'Resumen', cabecera: ['Concepto', 'Valor'], filas: res, formatos: [null, null], fechas: [], formatosFila: { 4: P } },
    { nombre: 'Maquinaria', cabecera: ['Máquina', 'Año', 'Valor compra (€)', 'Valor residual (€)', 'Gastos (€)', 'Subvención (€)', 'Horas', 'Coste/hora (€)', 'V. amortizado (€)', 'V. pendiente (€)', '% Amortizado', 'Horómetro (h)'], filas: maq, formatos: [null, '0', EUR, EUR, EUR, EUR, H, EUR, EUR, EUR, P, H], fechas: [] },
    { nombre: 'Vendidas', cabecera: ['Máquina', 'Año compra', 'V. compra (€)', 'Gastos (€)', 'V. amortizado (€)', 'Año venta', 'V. venta (€)', 'Resultado venta (€)'], filas: vend, formatos: [null, '0', EUR, EUR, EUR, '0', EUR, EUR], fechas: [] },
    { nombre: 'Mantenimientos', cabecera: ['Fecha', 'Máquina', 'Tipo', 'Horómetro (h)', 'Descripción', 'Coste (€)', 'Próx. cambio (h)', 'Taller/Operario', 'Estado', 'Notas'], filas: mants, formatos: ['dd/mm/yyyy', null, null, H, null, EUR, H, null, null, null], fechas: [0] },
    { nombre: 'Trabajos externos', cabecera: ['Fecha', 'Cliente', 'Descripción', 'Horas', 'Amortización/h (€)', 'Otros gastos (€)', 'Precio/h (€)', 'Importe (€)', 'Beneficio (€)', '% Beneficio', 'Cobro'], filas: trab, formatos: ['dd/mm/yyyy', null, null, H, EUR, EUR, EUR, EUR, EUR, P, null], fechas: [0] },
  ];
  return { tablas, estado: JSON.stringify(state), version: APP_VERSION };
}
async function runSync() {
  if (!syncOn() || syncRunning) return;
  if (!navigator.onLine) { renderSyncStatus(); return; }
  syncRunning = true; const rev = syncRev; renderSyncStatus();
  try {
    const r = await callScript('sincronizar', syncPayload());
    if (!r.ok) throw new Error(r.error === 'clave' ? 'La clave no coincide con la del script' : (r.error || 'Error del receptor'));
    sync.lastOk = new Date().toISOString(); sync.lastError = '';
    if (syncRev === rev) sync.dirty = false;
  } catch (e) {
    sync.lastError = e.message || String(e); sync.dirty = true;
    clearTimeout(syncRetry); syncRetry = setTimeout(() => runSync(), 60000);
  } finally {
    syncRunning = false; saveSync(); renderSyncStatus();
    if (sync.dirty && !sync.lastError) { clearTimeout(syncTimer); syncTimer = setTimeout(() => runSync(), 800); }
  }
}
function ago(iso) {
  if (!iso) return 'nunca';
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'ahora mismo';
  if (min < 60) return `hace ${min} min`;
  if (min < 1440) return `hace ${Math.round(min / 60)} h`;
  return new Date(iso).toLocaleDateString('es-ES');
}
function syncStatusText() {
  if (!syncOn()) return '';
  if (syncRunning) return '☁ Enviando a Google Sheets…';
  if (sync.lastError) return '☁ No se pudo enviar: ' + sync.lastError;
  if (sync.dirty) return navigator.onLine ? '☁ Pendiente de enviar…' : '☁ Pendiente de enviar (sin conexión)';
  return '☁ Hoja al día · ' + ago(sync.lastOk);
}
function renderSyncStatus() {
  const el = $('#syncStatus'); if (el) { el.textContent = syncStatusText(); el.hidden = !syncOn(); }
  const box = $('#syncLine'); if (box) box.textContent = syncStatusText();
}
function validState(s) { return s && Array.isArray(s.maquinas) && Array.isArray(s.mants) && Array.isArray(s.trabajos) && s.settings; }
const stateInfo = (s) => `${s.maquinas.filter((m) => !m.vendida).length} máquinas, ${s.mants.length} mantenimientos y ${s.trabajos.length} trabajos`;

function drawSync(box) {
  if (syncOn()) {
    box.innerHTML = `
      <p class="small" id="syncLine">${esc(syncStatusText())}</p>
      <p class="small">Cada cambio se envía solo a tu hoja de Google (pestañas Resumen, Maquinaria, Vendidas, Mantenimientos y Trabajos externos). Sin conexión se queda pendiente y se envía al volver.</p>
      <div class="actions">
        <button class="btn primary" id="syNow">Sincronizar ahora</button>
        <button class="btn" id="syRes">Restaurar desde la hoja</button>
        <button class="btn danger" id="syOff">Desactivar</button>
      </div>`;
    $('#syNow', box).onclick = () => { if (!navigator.onLine) return toast('Sin conexión: se enviará al volver', true); sync.lastError = ''; markDirty(); clearTimeout(syncTimer); runSync(); };
    $('#syRes', box).onclick = async () => {
      try {
        const est = await callScript('estado');
        if (!est.ok || !est.estado) throw new Error(est.error === 'sin copia' ? 'La hoja todavía no tiene copia' : (est.error || 'No se pudo leer la copia'));
        const s = JSON.parse(est.estado);
        if (!validState(s)) throw new Error('La copia de la hoja no es válida');
        if (!confirm(`Se reemplazarán los datos de este móvil por los de la hoja (${stateInfo(s)}, copia ${ago(est.fecha)}). ¿Continuar?`)) return;
        state = s; await persist(); closeSheet(); renderAll(); toast('Restaurado desde la hoja');
      } catch (e) { toast(e.message || 'No se pudo restaurar', true); }
    };
    $('#syOff', box).onclick = () => { sync.enabled = false; sync.dirty = false; sync.lastError = ''; saveSync(); renderSyncStatus(); drawSync(box); toast('Copia automática desactivada'); };
  } else {
    box.innerHTML = `
      <p class="small">Envía automáticamente todo a una hoja de Google Sheets de tu Drive (copia de seguridad y datos para consultar). Necesita configurar una vez el script de Google que se explica en el README.</p>
      <label class="fld"><span>Dirección del script (termina en /exec)</span><input id="syU" type="url" value="${esc(sync.url)}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off"></label>
      <label class="fld"><span>Clave</span><input id="syK" type="password" value="${esc(sync.clave)}" autocomplete="off"></label>
      <div class="actions"><button class="btn primary" id="syOn">Probar y activar</button></div>`;
    $('#syOn', box).onclick = () => activateSync($('#syU', box).value.trim(), $('#syK', box).value.trim(), box);
  }
}
async function activateSync(url, clave, box) {
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/\s]+\/exec\/?$/.test(url)) return toast('La dirección debe ser la de la aplicación web del script y terminar en /exec', true);
  if (!clave) return toast('Escribe la clave', true);
  const prev = { ...sync };
  sync.url = url; sync.clave = clave;
  const finish = () => { sync.enabled = true; sync.dirty = true; sync.lastError = ''; syncRev++; saveSync(); renderSyncStatus(); drawSync(box); runSync(); toast('Conectado con Google Sheets'); };
  try {
    const ping = await callScript('ping');
    if (!ping.ok) throw new Error(ping.error === 'clave' ? 'La clave no coincide con la del script' : (ping.error || 'El receptor no responde'));
    const est = await callScript('estado');
    if (est.ok && est.estado) {
      // La hoja ya tiene una copia (por ejemplo, de otro móvil): hay que decidir qué manda.
      let info = null; try { info = JSON.parse(est.estado); } catch (_) { /* nada */ }
      const okInfo = info && validState(info);
      box.innerHTML = `
        <p><b>La hoja ya contiene una copia</b> (${okInfo ? stateInfo(info) : 'datos'}, ${ago(est.fecha)}).</p>
        <p class="small">Si este móvil es nuevo, usa la copia de la hoja. Si lo de este móvil es lo correcto, sobrescribe la hoja.</p>
        <div class="actions">
          <button class="btn primary" id="syUse" ${okInfo ? '' : 'disabled'}>Usar la copia de la hoja en este móvil</button>
          <button class="btn" id="syOver">Sobrescribir la hoja con los datos de este móvil</button>
          <button class="btn" id="syCan">Cancelar</button>
        </div>`;
      $('#syUse', box).onclick = async () => { state = info; await persist(); renderAll(); finish(); };
      $('#syOver', box).onclick = finish;
      $('#syCan', box).onclick = () => { sync = prev; drawSync(box); };
      return;
    }
    finish();
  } catch (e) { sync = prev; toast(e.message || 'No se pudo conectar', true); }
}

/* ---------- Ajustes y copia de seguridad ---------- */
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
async function shareOrDownloadBackup() {
  const name = `agroservicios-copia-${todayISO()}.json`;
  const text = JSON.stringify({ app: 'agroservicios', version: APP_VERSION, exportedAt: new Date().toISOString(), state }, null, 1);
  const file = new File([text], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: 'Copia AgroServicios' });
    else download(name, text, 'application/json');
  } catch (e) { if (e && e.name === 'AbortError') return; download(name, text, 'application/json'); }
  state.settings.lastBackup = new Date().toISOString(); persist(); toast('Copia generada');
}
function openSettings() {
  const body = openSheet('Ajustes', `
    <h3 style="margin-top:4px">Copia automática en Google Sheets</h3>
    <div id="syncBox"></div>
    <div class="sep"></div>
    <h3>Copia de seguridad en fichero</h3>
    <p class="small">Los datos viven en este móvil. Puedes guardar un fichero con todo (por ejemplo en Drive o WhatsApp).${state.settings.lastBackup ? ` Última copia: ${new Date(state.settings.lastBackup).toLocaleString('es-ES')}.` : ' Aún no has hecho ninguna.'}</p>
    <div class="actions">
      <button class="btn primary" id="sBk">Guardar copia / compartir</button>
      <label class="btn" style="display:grid;place-items:center;cursor:pointer">Restaurar desde fichero<input id="sRs" type="file" accept="application/json,.json" hidden></label>
    </div>
    <div class="sep"></div>
    <p class="small">AgroServicios v${APP_VERSION} · datos de partida cargados desde Maquinaria_3.0.xlsx.</p>`);
  drawSync($('#syncBox', body));
  $('#sBk', body).onclick = shareOrDownloadBackup;
  $('#sRs', body).onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const j = JSON.parse(await file.text());
      const s = j && j.state;
      if (!validState(s)) throw new Error('El fichero no es una copia de AgroServicios');
      if (!confirm(`Se reemplazarán todos los datos actuales por los de la copia (${stateInfo(s)}). ¿Continuar?`)) return;
      state = s; await persist(); closeSheet(); renderAll(); toast('Copia restaurada');
    } catch (err) { toast(err.message || 'No se pudo leer la copia', true); }
    e.target.value = '';
  };
}

/* ---------- Render general ---------- */
const TABS = {
  inicio: { title: 'AgroServicios', fab: null, head: headInicio, render: renderInicio },
  maquinas: { title: 'Máquinas', fab: 'Nueva máquina', head: null, render: renderMaquinas },
  mant: { title: 'Mantenimiento', fab: 'Nuevo mantenimiento', head: null, render: renderMant },
  trabajos: { title: 'Trabajos externos', fab: 'Nuevo trabajo', head: headTrabajos, render: renderTrabajos },
};
function renderAll() {
  const t = TABS[ui.tab];
  $('#topTitle').textContent = t.title;
  $('#head').innerHTML = t.head ? t.head() : '';
  document.querySelectorAll('.tab').forEach((b) => { if (b.dataset.tab === ui.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  const av = avisos(), badge = $('#mantBadge');
  badge.hidden = !av.length; badge.textContent = av.length; badge.className = 'badge' + (av.some((a) => a.s === 'over') ? '' : ' warn');
  $('#fab').hidden = !t.fab; if (t.fab) $('#fabLabel').textContent = t.fab;
  renderSyncStatus();
  t.render();
}

async function init() {
  document.querySelectorAll('.tab').forEach((b) => b.onclick = () => { ui.tab = b.dataset.tab; window.scrollTo(0, 0); renderAll(); });
  $('#btnSettings').onclick = openSettings;
  $('#fab').onclick = () => { if (ui.tab === 'maquinas') openMaquina(null); else if (ui.tab === 'mant') openMantForm(null, ui.mantMaq !== 'todas' ? ui.mantMaq : ''); else if (ui.tab === 'trabajos') openTrabajo(null); };
  await loadSync();
  $('#syncStatus').onclick = openSettings;
  window.addEventListener('online', () => { if (sync.dirty) runSync(); else renderSyncStatus(); });
  window.addEventListener('offline', renderSyncStatus);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (sync.dirty) runSync(); if (state) renderAll(); } });
  setInterval(renderSyncStatus, 60000);
  try {
    let s = await dbGet('state');
    if (!s) { s = seedState(); await dbSet('state', s); }
    state = s;
  } catch (e) {
    state = seedState();
    toast('Este navegador no permite guardar datos: lo que anotes se perderá al cerrar', true);
  }
  renderAll();
  if (syncOn() && sync.dirty) setTimeout(runSync, 1500);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
