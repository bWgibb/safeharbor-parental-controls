'use strict';

const ACTIONS = new Set(['allow', 'block']);
const DAY_NAMES = new Set(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);

function validateRawPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return 'policy_object_required';
  if (!nonEmptyString(policy.id)) return 'policy_id_required';
  if (!nonEmptyString(policy.profileId)) return 'policy_profile_id_required';
  if (!nonEmptyString(policy.name)) return 'policy_name_required';
  if (!ACTIONS.has(policy.defaultAction)) return 'invalid_default_action';

  for (const listName of ['blockedDomains', 'allowedDomains', 'temporaryOverrides', 'schedules']) {
    if (!Array.isArray(policy[listName])) return `${listName}_array_required`;
  }
  if (!policy.categories || typeof policy.categories !== 'object' || Array.isArray(policy.categories)) {
    return 'categories_object_required';
  }
  if (!Array.isArray(policy.blockedCategories)) return 'blockedCategories_array_required';

  for (const [category, domains] of Object.entries(policy.categories)) {
    if (!nonEmptyString(category)) return 'category_name_required';
    if (!Array.isArray(domains)) return 'category_domains_array_required';
    for (const domain of domains) {
      if (!validDomain(domain)) return 'category_domain_invalid';
    }
  }

  for (const rule of policy.blockedDomains) {
    const error = validateDomainRule(rule, 'blockedDomains');
    if (error) return error;
  }
  for (const rule of policy.allowedDomains) {
    const error = validateDomainRule(rule, 'allowedDomains');
    if (error) return error;
  }
  for (const rule of policy.temporaryOverrides) {
    const error = validateDomainRule(rule, 'temporaryOverrides');
    if (error) return error;
    if (!ACTIONS.has(rule.action)) return 'temporaryOverrides_action_invalid';
    if (!validIsoDate(rule.expiresAt)) return 'temporaryOverrides_expires_at_invalid';
  }
  for (const rule of policy.schedules) {
    const error = validateScheduleRule(rule);
    if (error) return error;
  }

  return '';
}

function validateNormalizedPolicy(policy) {
  if (!['allow', 'block'].includes(policy.defaultAction)) return 'invalid_default_action';
  if (!policy.id) return 'policy_id_required';
  if (!policy.profileId) return 'policy_profile_id_required';
  const listNames = ['blockedDomains', 'allowedDomains', 'temporaryOverrides'];
  for (const listName of listNames) {
    for (const rule of policy[listName]) {
      if (!rule.value && !rule.domain) return `${listName}_rule_domain_required`;
    }
  }
  for (const rule of policy.schedules) {
    if (!['allow', 'block'].includes(rule.action)) return 'schedule_action_invalid';
    if (!validTime(rule.start)) return 'schedule_start_invalid';
    if (!validTime(rule.end)) return 'schedule_end_invalid';
  }
  return '';
}

function validateDomainRule(rule, listName) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return `${listName}_rule_object_required`;
  if (!nonEmptyString(rule.id)) return `${listName}_rule_id_required`;
  if (!validDomain(rule.value || rule.domain)) return `${listName}_rule_domain_invalid`;
  if (rule.pathPrefix != null && typeof rule.pathPrefix !== 'string') return `${listName}_path_prefix_invalid`;
  return '';
}

function validateScheduleRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return 'schedule_rule_object_required';
  if (!nonEmptyString(rule.id)) return 'schedule_rule_id_required';
  if (!ACTIONS.has(rule.action)) return 'schedule_action_invalid';
  if (!validTime(rule.start)) return 'schedule_start_invalid';
  if (!validTime(rule.end)) return 'schedule_end_invalid';
  if (rule.days != null) {
    if (!Array.isArray(rule.days)) return 'schedule_days_array_required';
    for (const day of rule.days) {
      if (!DAY_NAMES.has(String(day).toLowerCase())) return 'schedule_day_invalid';
    }
  }
  return '';
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validDomain(value) {
  if (!nonEmptyString(value)) return false;
  const domain = value.trim().toLowerCase().replace(/^\*\./, '');
  if (domain.length > 253 || domain.includes('/') || domain.includes(':')) return false;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain);
}

function validIsoDate(value) {
  if (!nonEmptyString(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

function validTime(value) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value || ''));
}

module.exports = {
  validateNormalizedPolicy,
  validateRawPolicy
};
