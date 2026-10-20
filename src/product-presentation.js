'use strict';

function formatPrice(value) {
  return new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP', maximumFractionDigits: 0 }).format(value);
}

function availability(product) {
  if (product.stock === null) return 'Servicio sin inventario.';
  if (product.stock === 0) return 'Sin unidades disponibles.';
  const total = `Disponible: ${product.stock} unidad${product.stock === 1 ? '' : 'es'}.`;
  const locals = product.locales.length ? ` ${product.locales.map((local) => `${local.nombre_local}: ${local.stock}`).join(' · ')}.` : '';
  return total + locals;
}

function productText(product) {
  const recipeNotice = product.receta_retenida === true
    ? ' Requiere receta retenida para su venta.'
    : product.receta_retenida === false ? '' : ' Consulta las condiciones de venta en el local.';
  return `${product.nombre} — ${formatPrice(product.precio_venta)}. ${availability(product)}${recipeNotice}`;
}

module.exports = { productText };
