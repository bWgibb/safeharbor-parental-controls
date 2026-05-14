'use strict';

function createPolicyHandlers({
  asString,
  domainFromUrl,
  evaluatePolicy,
  getDefaultContext,
  normalizePolicy,
  nowIso,
  readBody,
  requireDeviceForIdOrParent,
  requireDeviceOrParent,
  requireParent,
  sendJson,
  store,
  validateNormalizedPolicy,
  validateRawPolicy
}) {
  async function handleEvaluate(req, res) {
    const body = await readBody(req);
    const { profile, device, policy } = getDefaultContext();
    const profileId = asString(body.profileId, profile.id);
    const deviceId = asString(body.deviceId, device.id);
    if (!requireDeviceForIdOrParent(req, res, deviceId)) return;

    const activePolicy = store.getPolicy(profileId) || policy;
    const activePolicyRecord = store.getPolicyRecord(profileId);
    const decision = evaluatePolicy({
      url: asString(body.url),
      timestamp: asString(body.timestamp, nowIso()),
      profileId,
      deviceId,
      policy: activePolicy
    });

    store.recordEvent({
      type: 'visit_decision',
      timestamp: decision.timestamp,
      url: asString(body.url),
      domain: decision.domain,
      title: asString(body.title),
      profileId,
      deviceId,
      decision: decision.action,
      ruleId: decision.ruleId,
      reason: decision.reason,
      category: decision.category,
      source: asString(body.source, 'chrome-extension'),
      metadata: { policyId: activePolicy.id }
    });
    store.touchDevice(deviceId, decision.timestamp);

    sendJson(res, 200, {
      ok: true,
      profileId,
      deviceId,
      policyId: activePolicy.id,
      policy: activePolicy,
      policyUpdatedAt: activePolicyRecord ? activePolicyRecord.updatedAt : null,
      policyRevision: activePolicyRecord ? activePolicyRecord.updatedAt : null,
      decision
    });
  }

  async function handlePolicyUpdate(req, res) {
    if (!requireParent(req, res)) return;
    const policy = await readValidPolicy(req, res);
    if (!policy) return;
    store.upsertPolicy(policy);
    sendJson(res, 200, { ok: true, policy });
  }

  async function handlePolicyImport(req, res) {
    if (!requireParent(req, res)) return;
    const policy = await readValidPolicy(req, res);
    if (!policy) return;
    store.upsertPolicy(policy);
    store.recordEvent({
      type: 'policy_imported',
      timestamp: nowIso(),
      profileId: policy.profileId,
      source: 'parent-dashboard',
      metadata: { policyId: policy.id }
    });
    sendJson(res, 200, { ok: true, policy });
  }

  function handlePolicyRead(req, res) {
    if (!requireDeviceOrParent(req, res)) return;
    const { profile, policy } = getDefaultContext();
    const policyRecord = store.getPolicyRecord(profile.id);
    sendJson(res, 200, {
      ok: true,
      profiles: store.getProfiles(),
      devices: store.getDevices(),
      policy: policyRecord ? policyRecord.policy : policy,
      policyUpdatedAt: policyRecord ? policyRecord.updatedAt : null,
      policyRevision: policyRecord ? policyRecord.updatedAt : null
    });
  }

  function handlePolicyExport(req, res) {
    if (!requireParent(req, res)) return;
    sendJson(res, 200, { ok: true, policy: getDefaultContext().policy });
  }

  async function readValidPolicy(req, res) {
    const body = await readBody(req);
    const rawPolicy = body.policy && typeof body.policy === 'object' ? body.policy : body;
    const rawValidationError = validateRawPolicy(rawPolicy);
    if (rawValidationError) {
      sendJson(res, 400, { ok: false, error: rawValidationError });
      return null;
    }
    const policy = normalizePolicy(rawPolicy);
    const validationError = validateNormalizedPolicy(policy);
    if (validationError) {
      sendJson(res, 400, { ok: false, error: validationError });
      return null;
    }
    return policy;
  }

  return {
    handleEvaluate,
    handlePolicyExport,
    handlePolicyImport,
    handlePolicyRead,
    handlePolicyUpdate
  };
}

module.exports = {
  createPolicyHandlers
};
