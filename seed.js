'use strict';
/* Datos de partida cargados desde Maquinaria_3.0.xlsx (12/10/2026).
   Solo se usan la primera vez que se abre la app en un móvil; después manda lo guardado en el móvil. */
window.SEED = {
  // nombre, año, valor compra, valor residual, gastos anteriores, horas, coste/hora, subvención
  maquinas: [
    ['Trituradora Cancela TVL 150', 2025, 14500, 3000, 45, 70, 10, 11360],
    ['Tractor Same Frutteto II 85', 2022, 10500, 6000, 797.5, 569.5, 10, 0],
    ['Stihl Combi KM', 2021, 1250, 600, 78, 216, 3, 0],
    ['Trahilla 2,30', 2022, 865, 450, 0, 50, 5, 0],
    ['Pulverizador 500 L', 2020, 1167, 500, 15, 76, 5, 0],
    ["Trahilla piedra 2'20", 2023, 900, 450, 0, 40, 5, 0],
    ['Desbrozadora Fernandez', 2023, 2550, 1020, 100, 141, 5, 0],
    ['Pulverizador Marisan 400 L', 2025, 1340, 750, 0, 27.5, 5, 0],
    ['Atomizador', 2023, 6700, 2500, 705, 136.5, 10, 0],
    ['Gradas 13', 2023, 1300, 800, 145, 15.5, 5, 0],
    ['Pala Estiercol', 2024, 1250, 500, 0, 12.5, 5, 0],
    ['Tractor Same Frutteto3 100', 2026, 22500, 10000, 0, 53.5, 10, 0],
    ['Barra herbicida', 2023, 1140, 400, 100, 6, 5, 0],
  ],
  // nombre, año compra, valor compra, amortizado al vender, año venta, valor venta
  vendidas: [
    ['Cuchilla', 2021, 665, 110, 2023, 600],
    ['Ebro', 2018, 800, 300, 2022, 2200],
    ['Gradas 9', 2018, 550, 200, 2022, 800],
    ['Generador Genergy 4000', 2024, 530, 9, 2025, 500],
  ],
  // fecha, máquina, tipo, horómetro, descripción, coste
  mantenimientos: [
    ['2026-07-01', 'Tractor Same Frutteto3 100', 'Revisión general', 7080, 'Cambio de aceites y filtros', 0],
  ],
};
