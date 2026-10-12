# AgroServicios

App para el móvil Android que lleva las horas, el coste y la amortización de la maquinaria, sus mantenimientos con avisos, y los trabajos externos con maquinaria. Funciona sin conexión.

- **Inicio:** % amortizado del parque, valor de compra, pendiente de amortizar y % de cada máquina.
- **Máquinas:** `+ h` suma horas, el total se puede corregir, y desde aquí se dan de alta, se editan o se marcan como vendidas.
- **Mantenimiento:** gastos, revisiones y mejoras (el coste se suma a la amortización), con aviso por horómetro real.
- **Trabajos:** trabajos a terceros con importe, beneficio y cobrado/pendiente; cabecera con importe y beneficio del año.

Fórmula de amortización: a amortizar = compra + gastos − residual; amortizado = horas × coste/hora + subvención, con tope en lo amortizable.

## Publicar (GitHub Pages)
Settings → Pages → rama `main`, carpeta `/ (root)`. Después abrir la dirección en Chrome del móvil → ⋮ → «Instalar aplicación».

## Copia automática en Google Sheets
1. Crea una hoja de Google nueva (por ejemplo «AgroServicios»).
2. Extensiones → Apps Script. Borra lo que haya, pega el contenido de `google-sheets/Codigo.gs` y cambia `CAMBIA-ESTA-CLAVE` por una clave larga propia. Guarda.
3. Implementar → Nueva implementación → tipo «Aplicación web» → Ejecutar como: **Yo** → Quién tiene acceso: **Cualquier usuario** → Implementar. Autoriza los permisos y copia la dirección (termina en `/exec`).
4. En la app: Ajustes → Copia automática en Google Sheets → pega la dirección y la clave → «Probar y activar».

La hoja es un espejo de un solo sentido: la app reescribe las pestañas Resumen, Maquinaria, Vendidas, Mantenimientos y Trabajos externos en cada envío. La clave nunca se sube a GitHub: se guarda solo en el móvil y en el script de tu hoja.

## Actualizaciones
Al cambiar cualquier fichero, sube `VERSION` en `sw.js` para que los móviles recojan la nueva versión.
