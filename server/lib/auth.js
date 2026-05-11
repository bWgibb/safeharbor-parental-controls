'use strict';

const crypto = require('crypto');

function hashDeviceToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function tokenMatchesHash(token, expectedHash) {
  if (!token || !expectedHash) return false;
  const actual = Buffer.from(hashDeviceToken(token));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function createAuth({ config, store, defaultDevice, sendJson }) {
  function unauthorized(res) {
    sendJson(res, 401, { ok: false, error: 'missing_or_invalid_token' });
  }

  function forbidden(res, error) {
    sendJson(res, 403, { ok: false, error });
  }

  function bearerToken(req) {
    const value = req.headers.authorization || '';
    const prefix = 'Bearer ';
    if (!value.startsWith(prefix)) return '';
    return value.slice(prefix.length);
  }

  function authScope(req) {
    const token = bearerToken(req);
    if (!token) return '';
    const received = Buffer.from(token);
    const parent = Buffer.from(config.parentToken);
    if (received.length === parent.length && crypto.timingSafeEqual(received, parent)) return 'parent';
    const legacy = Buffer.from(config.token);
    if (received.length === legacy.length && crypto.timingSafeEqual(received, legacy)) return 'parent';
    const device = Buffer.from(config.deviceToken);
    if (received.length === device.length && crypto.timingSafeEqual(received, device)) return 'legacy-device';
    return '';
  }

  function isAuthorized(req) {
    return Boolean(authScope(req));
  }

  function requireAuthorized(req, res) {
    if (isAuthorized(req)) return true;
    unauthorized(res);
    return false;
  }

  function requireParent(req, res) {
    if (authScope(req) === 'parent') return true;
    unauthorized(res);
    return false;
  }

  function requireDeviceOrParent(req, res) {
    if (isAuthorized(req)) return true;
    unauthorized(res);
    return false;
  }

  function requireDeviceForIdOrParent(req, res, deviceId, options = {}) {
    const scope = authScope(req);
    if (scope === 'parent') return true;
    const token = bearerToken(req);
    if (!token) {
      unauthorized(res);
      return false;
    }
    if (!deviceId) {
      sendJson(res, 400, { ok: false, error: 'device_id_required' });
      return false;
    }
    const device = store.getDeviceAuth(deviceId);
    if (!device) {
      sendJson(res, options.unknownStatusCode || 403, { ok: false, error: 'device_not_enrolled' });
      return false;
    }
    if (device.revokedAt) {
      forbidden(res, 'device_revoked');
      return false;
    }
    if (tokenMatchesHash(token, device.deviceTokenHash)) return true;
    if (scope === 'legacy-device' && deviceId === defaultDevice().id) return true;
    forbidden(res, 'device_token_mismatch');
    return false;
  }

  return {
    authScope,
    bearerToken,
    forbidden,
    isAuthorized,
    requireAuthorized,
    requireDeviceForIdOrParent,
    requireDeviceOrParent,
    requireParent,
    unauthorized
  };
}

module.exports = {
  createAuth,
  hashDeviceToken,
  tokenMatchesHash
};
