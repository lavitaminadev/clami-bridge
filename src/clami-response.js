'use strict';

const { ERROR_CODES, HttpError } = require('./error-catalog');

function validStock(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function normalizeProduct(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.ref !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.ref)) return null;
  if (typeof value.nombre !== 'string' || !value.nombre.trim()) return null;
  if (!Number.isInteger(value.precio_venta) || value.precio_venta < 0) return null;
  if (!validStock(value.stock) || !Array.isArray(value.locales)) return null;
  const locales = [];
  for (const local of value.locales) {
    if (!local || typeof local.nombre_local !== 'string' || !local.nombre_local.trim() || !validStock(local.stock) || local.stock === null) return null;
    locales.push({ nombre_local: local.nombre_local.trim(), stock: local.stock });
  }
  if (value.receta_retenida !== undefined && value.receta_retenida !== null && typeof value.receta_retenida !== 'boolean') return null;
  return {
    ref: value.ref,
    nombre: value.nombre.trim(),
    tipo: typeof value.tipo === 'string' ? value.tipo : null,
    marca: typeof value.marca === 'string' ? value.marca : null,
    stock: value.stock,
    locales,
    precio_venta: value.precio_venta,
    receta_retenida: value.receta_retenida
  };
}

function requireProduct(value) {
  const normalized = normalizeProduct(value);
  if (!normalized) throw new HttpError(502, 'El catálogo devolvió datos incompletos.', {}, ERROR_CODES.CLAMI_RESPONSE_INVALID);
  return normalized;
}

function requireSearchResults(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.resultados)) {
    throw new HttpError(502, 'El catálogo devolvió datos incompletos.', {}, ERROR_CODES.CLAMI_RESPONSE_INVALID);
  }
  // Do not silently discard one malformed upstream candidate: partial output
  // hides a contract break and can make ManyChat save an inconsistent ref.
  const products = value.resultados.map(normalizeProduct);
  if (products.some((product) => !product)) {
    throw new HttpError(502, 'El catálogo devolvió datos incompletos.', {}, ERROR_CODES.CLAMI_RESPONSE_INVALID);
  }
  return products.slice(0, 10);
}

module.exports = { requireProduct, requireSearchResults };
