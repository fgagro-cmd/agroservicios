# AgroServicios

App para el móvil Android que lleva las horas, el coste y la amortización de la maquinaria, sus mantenimientos con avisos, y los trabajos externos con maquinaria. Funciona sin conexión. Los clientes de los trabajos salen del maestro compartido de Drive (Apps › Maestros).

- **Inicio:** % amortizado del parque, valor de compra, pendiente de amortizar y % de cada máquina.
- **Máquinas:** `+ h` suma horas, el total se puede corregir, y desde aquí se dan de alta, se editan o se marcan como vendidas.
- **Mantenimiento:** gastos, revisiones y mejoras (el coste se suma a la amortización), con aviso por horómetro real.
- **Trabajos:** trabajos a terceros con importe, beneficio y cobrado/pendiente; cabecera con importe y beneficio del año. El cliente se elige del maestro.

Fórmula de amortización: a amortizar = compra + gastos − residual; amortizado = horas × coste/hora + subvención, con tope en lo amortizable.

## Datos de partida
Los datos de las máquinas **no van en el código** (el repositorio es público). Están en Drive › Apps › Copia de seguridad › `agroservicios-maquinaria-excel.json`. En un móvil nuevo: Ajustes → Copia de seguridad en fichero → «Restaurar desde fichero» (o «Restaurar desde la hoja» si ya tienes la copia automática).

## Maestros de clientes
Cada trabajo externo guarda el ID de la ficha de su cliente (C013, C027…). El nombre y las bajas vienen del maestro y se actualizan solos.

- Al elegir cliente salen primero los de **Maquinaria** y después el resto del maestro. Tus fincas propias y los proveedores no aparecen.
- «+ Cliente nuevo…» crea el trabajo y pide el alta en el maestro: entra con el siguiente ID y «Revisar = Sí» (amarillo). Sin conexión queda en cola y se envía al volver. Si el nombre ya existe en el maestro, se enlaza en vez de duplicarlo.
- Los trabajos que ya tenías se enlazan por nombre o alias la primera vez; antes de aplicar se enseña qué cambia. Los que no se reconocen quedan en Ajustes → Maestros → Revisar sin enlazar.
- La app solo lee y da altas; nunca cambia ni borra lo que hay en los maestros.
- Configuración: Ajustes → Maestros → dirección y clave del script de maestros (el mismo para todas las apps).

## Publicar (GitHub Pages)
Settings → Pages → rama `main`, carpeta `/ (root)`. Después abrir la dirección en Edge del móvil → ⋮ → «Añadir a la pantalla de inicio».

## Copia automática en Google Sheets
1. Crea una hoja de Google nueva (por ejemplo «AgroServicios»).
2. Extensiones → Apps Script. Borra lo que haya, pega el contenido de `google-sheets/Codigo.gs` y cambia `CAMBIA-ESTA-CLAVE` por una clave larga propia. Guarda.
3. Implementar → Nueva implementación → tipo «Aplicación web» → Ejecutar como: **Yo** → Quién tiene acceso: **Cualquier usuario** → Implementar. Autoriza los permisos y copia la dirección (termina en `/exec`).
4. En la app: Ajustes → Copia automática en Google Sheets → pega la dirección y la clave → «Probar y activar».

La hoja es un espejo de un solo sentido: la app reescribe las pestañas Resumen, Maquinaria, Vendidas, Mantenimientos y Trabajos externos (con la columna ID cliente) en cada envío. La clave nunca se sube a GitHub: se guarda solo en el móvil y en el script de tu hoja.

## Actualizaciones
Al cambiar cualquier fichero, sube `VERSION` en `sw.js` para que los móviles recojan la nueva versión.

## Organización (1.3.0)
Tareas de maquinaria por semana, en la pestaña **Organización**. La fecha límite es el domingo de la semana (botones «Esta semana», «La que viene», «En 2 semanas» u «Otra fecha» para un día concreto, como una ITV).

- **Categorías**: 🔧 Mantenimiento · 📋 Trámites · 🚜 Labores · 🛠️ Reparaciones y compras. Prioridad Alta, Media o Baja.
- **Datos**: tarea, máquina (obligatoria en Mantenimiento y Reparaciones), cliente (en Labores, del maestro), horas previstas y **Repetir** (cada mes, 3 meses, 6 meses o año): al terminarla aparece la siguiente con su fecha.
- **Desde los avisos**: en Mantenimiento › Avisos, botón «📅 Planificar». Esa tarea se cierra sola cuando anotas otro mantenimiento del mismo tipo en esa máquina.
- **Al terminar**: Mantenimiento → abre el mantenimiento con la máquina y el tipo; Reparaciones y compras → abre un mantenimiento «Reparación» de la máquina (su coste cuenta para la amortización); Labores → abre el trabajo externo con cliente, descripción y horas; Trámites → «✓ Hecho». La tarea se cierra al guardar.
- **Lista** agrupada por semanas (Vencidas, Esta semana, La que viene, Dentro de 2 semanas, Más adelante, Sin fecha) y filtros por categoría, máquina, semana y prioridad. Cabecera: esta semana, vencidas, pendientes y horas previstas.
- Las terminadas quedan en la pestaña **«Tareas hechas»** de la hoja (semana prevista, día real y si fue en plazo); las pendientes, en **«Tareas»**.

### Calendario
Las tareas con fecha se copian al calendario de Google **«AgroServicios»**: un evento de todo el día en su fecha, con aviso la víspera a las 8:00. Título: prioridad (🔴 🟠 🟢) + categoría + tarea + máquina/cliente. Manda la app.

Para activarlo (una vez, en el script de la hoja de AgroServicios):
1. Extensiones → Apps Script → copia tu línea `const CLAVE = '…'`, borra todo, pega el nuevo `google-sheets/Codigo.gs` y vuelve a poner tu clave → Guardar.
2. En el desplegable de funciones elige **autorizarCalendario** → Ejecutar → acepta los permisos (crea el calendario «AgroServicios»).
3. Implementar → Gestionar implementaciones → lápiz ✏ → Versión: **Nueva versión** → Implementar.
4. En la app: Ajustes → «Sincronizar ahora». Debe poner «📅 Calendario «AgroServicios» al día».
