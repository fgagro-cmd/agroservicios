'use strict';
/* Maestros · FG Agro — lógica común para enlazar una app con los maestros de clientes, fincas y productos.
   Sin datos dentro: los maestros se leen del servicio privado (Apps Script) y se guardan en el móvil.
   Sin DOM: se puede probar fuera del navegador. */
(function (root) {
  const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const compacto = (s) => norm(s).replace(/\s+/g, '');

  /* Índices de búsqueda por nombre y alias */
  function indexar(mx) {
    const ix = { cli: new Map(), cliN: new Map(), prod: new Map(), prodN: new Map(), prodFull: new Map(), fin: new Map(), raw: mx };
    for (const c of mx.clientes || []) {
      ix.cli.set(c.id, c);
      for (const n of [c.nombre, ...(c.alias || [])]) { const k = norm(n); if (k && !ix.cliN.has(k)) ix.cliN.set(k, c); }
    }
    for (const p of mx.productos || []) {
      ix.prod.set(p.id, p);
      const nombres = [p.nombre, ...(p.alias || [])];
      for (const n of nombres) {
        const k = norm(n); if (k && !ix.prodN.has(k)) ix.prodN.set(k, p);
        for (const pr of p.presentaciones || []) { const kf = compacto(n + ' ' + pr); if (!ix.prodFull.has(kf)) ix.prodFull.set(kf, { p, pres: pr }); }
      }
    }
    for (const f of mx.fincas || []) ix.fin.set(f.id, f);
    return ix;
  }

  const buscarCliente = (ix, nombre) => ix.cliN.get(norm(nombre)) || null;

  /* Un producto de una app puede llevar la presentación pegada al nombre («Complex AID E/10 L»). */
  function buscarProducto(ix, nombre) {
    const full = ix.prodFull.get(compacto(nombre));
    if (full) return { p: full.p, pres: full.pres };
    const k = norm(nombre);
    if (ix.prodN.has(k)) return { p: ix.prodN.get(k), pres: '' };
    let mejor = null, mejorN = '';
    for (const [n, p] of ix.prodN) if (n.length > mejorN.length && k.startsWith(n + ' ')) { mejor = p; mejorN = n; }
    if (!mejor) return null;
    const resto = String(nombre).trim().split(/\s+/).slice(mejorN.split(' ').length).join(' ');
    return { p: mejor, pres: resto };
  }

  /* Fincas: varias se llaman igual en clientes distintos, así que se busca con un filtro (p. ej. solo las propias). */
  function buscarFinca(ix, nombre, filtro = () => true) {
    const k = norm(nombre);
    for (const f of ix.fin.values()) if (filtro(f) && norm(f.nombre) === k) return f;
    for (const f of ix.fin.values()) if (filtro(f) && (f.alias || []).some((a) => norm(a) === k)) return f;
    return null;
  }

  const nombreProducto = (p, pres) => (pres ? p.nombre + ' ' + pres : p.nombre);
  const esPropio = (c) => norm(c.tipo) === 'propio';
  const deBaja = (c) => norm(c.estado) === 'baja';

  /* Plan de enlace de la app Ventas con los maestros (no cambia nada: solo dice qué se haría). */
  function planVentas(st, ix) {
    const plan = { cli: [], prod: [], unirCli: [], unirProd: [], nuevos: [], sinCli: [], sinProd: [], cambios: 0 };
    const usos = (cid) => st.pedidos.filter((p) => p.cli === cid).length;
    const porMid = new Map();
    for (const c of st.clientes) {
      const m = c.mid ? ix.cli.get(c.mid) : buscarCliente(ix, c.nombre);
      if (!m) { if (!c.mid) plan.sinCli.push(c.id); continue; }
      plan.cli.push({ id: c.id, mid: m.id });
      if (!porMid.has(m.id)) porMid.set(m.id, []);
      porMid.get(m.id).push(c);
    }
    for (const [mid, cs] of porMid) {
      if (cs.length < 2) continue;
      const orden = [...cs].sort((a, b) => usos(b.id) - usos(a.id));
      plan.unirCli.push({ mid, queda: orden[0].id, quita: orden.slice(1).map((c) => ({ id: c.id, nombre: c.nombre, n: usos(c.id) })) });
    }
    const enlazados = new Set(porMid.keys());
    for (const m of ix.cli.values()) if (!enlazados.has(m.id) && norm(m.tipo) !== 'proveedor') plan.nuevos.push(m.id);

    const usosP = (pid) => st.compras.filter((c) => c.prod === pid).length + st.pedidos.reduce((t, o) => t + o.lineas.filter((l) => l.prod === pid).length, 0);
    const porClave = new Map();
    for (const p of st.productos) {
      let r = null;
      if (p.mid && ix.prod.has(p.mid)) r = { p: ix.prod.get(p.mid), pres: p.pres || '' };
      else if (!p.mid) r = buscarProducto(ix, p.nombre);
      if (!r) { if (!p.mid) plan.sinProd.push(p.id); continue; }
      plan.prod.push({ id: p.id, mid: r.p.id, pres: r.pres });
      const k = r.p.id + '|' + compacto(r.pres);
      if (!porClave.has(k)) porClave.set(k, []);
      porClave.get(k).push(p);
    }
    for (const [k, ps] of porClave) {
      if (ps.length < 2) continue;
      const orden = [...ps].sort((a, b) => usosP(b.id) - usosP(a.id));
      plan.unirProd.push({ clave: k, queda: orden[0].id, quita: orden.slice(1).map((p) => ({ id: p.id, nombre: p.nombre, n: usosP(p.id) })) });
    }
    return plan;
  }

  /* Aplica el plan sobre una copia del estado. Devuelve un resumen de lo cambiado. */
  function aplicarVentas(c, plan, ix, { unir = false, crearNuevos = true, nuevoId } = {}) {
    const r = { enlazadosCli: 0, enlazadosProd: 0, renombrados: 0, unidos: 0, nuevos: 0 };
    const cli = new Map(c.clientes.map((x) => [x.id, x]));
    for (const e of plan.cli) {
      const x = cli.get(e.id), m = ix.cli.get(e.mid); if (!x || !m) continue;
      if (x.mid !== m.id) { x.mid = m.id; r.enlazadosCli++; }
      if (x.nombre !== m.nombre) { x.nombre = m.nombre; r.renombrados++; }
      x.propio = esPropio(m);
      x.activo = !deBaja(m);
    }
    if (unir) for (const u of plan.unirCli) {
      const quita = new Set(u.quita.map((q) => q.id));
      c.pedidos.forEach((p) => { if (quita.has(p.cli)) p.cli = u.queda; });
      c.cobros.forEach((cb) => { if (quita.has(cb.cli)) cb.cli = u.queda; });
      c.clientes = c.clientes.filter((x) => !quita.has(x.id));
      r.unidos += quita.size;
    }
    if (crearNuevos) for (const mid of plan.nuevos) {
      const m = ix.cli.get(mid);
      if (c.clientes.some((x) => x.mid === mid)) continue;
      c.clientes.push({ id: nuevoId ? nuevoId('c') : 'c-' + mid, mid, nombre: m.nombre, propio: esPropio(m), activo: !deBaja(m) });
      r.nuevos++;
    }
    const prod = new Map(c.productos.map((x) => [x.id, x]));
    for (const e of plan.prod) {
      const x = prod.get(e.id), m = ix.prod.get(e.mid); if (!x || !m) continue;
      if (x.mid !== m.id) { x.mid = m.id; r.enlazadosProd++; }
      x.pres = e.pres;
      const nn = nombreProducto(m, e.pres);
      if (x.nombre !== nn) { x.nombre = nn; r.renombrados++; }
      if (m.categoria) x.tipo = m.categoria;
      x.subtipo = m.subtipo || '';
      if (m.activo === false) x.activo = false;
    }
    if (unir) for (const u of plan.unirProd) {
      const quita = new Set(u.quita.map((q) => q.id));
      c.compras.forEach((k) => { if (quita.has(k.prod)) k.prod = u.queda; });
      c.pedidos.forEach((o) => o.lineas.forEach((l) => { if (quita.has(l.prod)) l.prod = u.queda; }));
      c.productos = c.productos.filter((x) => !quita.has(x.id));
      r.unidos += quita.size;
    }
    // Comisiones: el texto de cliente y producto pasa al nombre del maestro cuando se reconoce
    for (const m of c.comisiones || []) {
      const mc = buscarCliente(ix, m.cliente); if (mc && mc.nombre !== m.cliente) { m.cliente = mc.nombre; r.renombrados++; }
      const mp = buscarProducto(ix, m.producto);
      if (mp) { const nn = nombreProducto(mp.p, mp.pres); if (nn !== m.producto) { m.producto = nn; r.renombrados++; } }
    }
    return r;
  }

  /* Plan de enlace de AgroServicios (trabajos externos) con el maestro de clientes. Solo dice qué se haría. */
  function planTrabajos(st, ix) {
    const plan = { cli: [], sinCli: [] };
    for (const t of st.trabajos) {
      const m = t.mid ? ix.cli.get(t.mid) : buscarCliente(ix, t.cliente);
      if (m) plan.cli.push({ id: t.id, mid: m.id });
      else if (!t.mid) plan.sinCli.push(t.id);
    }
    return plan;
  }

  /* Aplica el plan sobre una copia del estado: guarda el ID del cliente y pone el nombre del maestro. */
  function aplicarTrabajos(c, plan, ix) {
    const r = { enlazados: 0, renombrados: 0 };
    const por = new Map(c.trabajos.map((t) => [t.id, t]));
    for (const e of plan.cli) {
      const t = por.get(e.id), m = ix.cli.get(e.mid); if (!t || !m) continue;
      if (t.mid !== m.id) { t.mid = m.id; r.enlazados++; }
      if (t.cliente !== m.nombre) { t.cliente = m.nombre; r.renombrados++; }
    }
    return r;
  }

  const api = { norm, compacto, indexar, buscarCliente, buscarProducto, buscarFinca, nombreProducto, esPropio, deBaja, planVentas, aplicarVentas, planTrabajos, aplicarTrabajos };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MX = api;
})(typeof window !== 'undefined' ? window : globalThis);
