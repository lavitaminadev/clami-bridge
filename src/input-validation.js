'use strict';

const { ERROR_CODES, HttpError } = require('./error-catalog');
const BODY_LIMIT_BYTES = 8 * 1024;

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT_BYTES) throw new HttpError(413, 'Solicitud demasiado grande.', {}, ERROR_CODES.REQUEST_BODY_TOO_LARGE);
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  if (!body) throw new HttpError(400, 'Falta cuerpo JSON.', {}, ERROR_CODES.REQUEST_BODY_MISSING);
  try {
    const parsed = JSON.parse(body);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('invalid');
    return parsed;
  } catch {
    throw new HttpError(400, 'JSON inválido.', {}, ERROR_CODES.REQUEST_JSON_INVALID);
  }
}

function validateSearchBody(body) {
  if (Object.keys(body).some((key) => !['q', 'canal'].includes(key))) throw new HttpError(400, 'Campos no permitidos.', {}, ERROR_CODES.REQUEST_VALIDATION_FAILED);
  if (typeof body.q !== 'string') throw new HttpError(400, 'q debe ser texto.', {}, ERROR_CODES.REQUEST_VALIDATION_FAILED);
  const q = body.q.trim();
  if (q.length < 3 || q.length > 120) throw new HttpError(400, 'q debe tener entre 3 y 120 caracteres.', {}, ERROR_CODES.REQUEST_VALIDATION_FAILED);
  const channel = typeof body.canal === 'string' ? body.canal.toLowerCase() : 'desconocido';
  if (!['whatsapp', 'instagram', 'desconocido'].includes(channel)) throw new HttpError(400, 'Canal inválido.', {}, ERROR_CODES.REQUEST_VALIDATION_FAILED);
  return { q, channel, isBarcode: /^\d+$/.test(q) };
}

function validateProductBody(body) {
  if (Object.keys(body).some((key) => key !== 'ref')) throw new HttpError(400, 'Campos no permitidos.', {}, ERROR_CODES.REQUEST_VALIDATION_FAILED);
  if (typeof body.ref !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.ref)) throw new HttpError(400, 'ref inválido.', {}, ERROR_CODES.REQUEST_VALIDATION_FAILED);
  return body.ref;
}

module.exports = { readJsonBody, validateSearchBody, validateProductBody };
