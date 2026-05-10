'use strict';

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const ACTIONS = new Set(['allow', 'block']);

function evaluatePolicy(input) {
  const url = normalizeUrl(input && input.url);
  const policy = normalizePolicy(input && input.policy);
  const timestamp = parseTimestamp(input && input.timestamp);

  if (!url) {
    return decision({
      action: 'allow',
      ruleId: 'invalid-url',
      reason: 'URL is missing or unsupported',
      timestamp
    });
  }

  const domain = url.hostname.toLowerCase();
  const path = `${url.pathname || '/'}${url.search || ''}`;
  const context = { url, domain, path, timestamp, policy };

  return firstMatch(context, policy.temporaryOverrides, matchOverride)
    || firstMatch(context, policy.allowedDomains, matchDomainRule, 'allow')
    || firstMatch(context, policy.blockedDomains, matchDomainRule, 'block')
    || matchBlockedCategory(context)
    || firstMatch(context, policy.schedules, matchScheduleRule)
    || decision({
      action: policy.defaultAction,
      ruleId: 'default-policy',
      reason: `Default policy ${policy.defaultAction}`,
      domain,
      timestamp
    });
}

function normalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseTimestamp(value) {
  const parsed = value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) return new Date();
  return parsed;
}

function normalizePolicy(policy) {
  const source = policy && typeof policy === 'object' ? policy : {};
  return {
    id: stringOr(source.id, 'local-policy'),
    name: stringOr(source.name, 'Local Policy'),
    profileId: stringOr(source.profileId, 'default-child'),
    defaultAction: ACTIONS.has(source.defaultAction) ? source.defaultAction : 'allow',
    blockedDomains: arrayOfObjects(source.blockedDomains),
    allowedDomains: arrayOfObjects(source.allowedDomains),
    categories: normalizeCategories(source.categories),
    blockedCategories: Array.isArray(source.blockedCategories)
      ? source.blockedCategories.filter(item => typeof item === 'string')
      : [],
    schedules: arrayOfObjects(source.schedules),
    temporaryOverrides: arrayOfObjects(source.temporaryOverrides)
  };
}

function arrayOfObjects(value) {
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [];
}

function normalizeCategories(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const categories = {};
  for (const [name, domains] of Object.entries(value)) {
    if (!Array.isArray(domains)) continue;
    categories[name] = domains.filter(item => typeof item === 'string');
  }
  return categories;
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function firstMatch(context, rules, matcher, forcedAction) {
  for (const rule of rules) {
    const result = matcher(context, rule, forcedAction);
    if (result) return result;
  }
  return null;
}

function matchOverride(context, rule) {
  if (!ACTIONS.has(rule.action)) return null;
  if (rule.expiresAt && context.timestamp > parseTimestamp(rule.expiresAt)) return null;
  if (!domainRuleApplies(context, rule)) return null;
  return decisionForRule(context, rule, rule.action, rule.reason || 'Temporary override');
}

function matchDomainRule(context, rule, forcedAction) {
  if (!domainRuleApplies(context, rule)) return null;
  return decisionForRule(context, rule, forcedAction, rule.reason || `${forcedAction} ${rule.value}`);
}

function domainRuleApplies(context, rule) {
  const value = stringOr(rule.value || rule.domain, '').toLowerCase();
  if (!value || !domainMatches(context.domain, value)) return false;
  const pathPrefix = stringOr(rule.pathPrefix, '');
  return !pathPrefix || context.path.startsWith(pathPrefix);
}

function domainMatches(domain, ruleDomain) {
  const normalized = ruleDomain.replace(/^\*\./, '');
  return domain === normalized || domain.endsWith(`.${normalized}`);
}

function matchBlockedCategory(context) {
  for (const category of context.policy.blockedCategories) {
    const domains = context.policy.categories[category] || [];
    const matchedDomain = domains.find(value => domainMatches(context.domain, value.toLowerCase()));
    if (!matchedDomain) continue;
    return decision({
      action: 'block',
      ruleId: `category:${category}`,
      reason: `Blocked category: ${category}`,
      domain: context.domain,
      category,
      timestamp: context.timestamp
    });
  }
  return null;
}

function matchScheduleRule(context, rule) {
  if (!ACTIONS.has(rule.action)) return null;
  if (!scheduleApplies(context.timestamp, rule)) return null;
  return decisionForRule(context, rule, rule.action, rule.reason || `Scheduled ${rule.action}`);
}

function scheduleApplies(timestamp, rule) {
  const days = Array.isArray(rule.days) ? rule.days.map(day => String(day).toLowerCase()) : [];
  const dayName = DAY_NAMES[timestamp.getDay()];
  if (days.length && !days.includes(dayName)) return false;

  const start = minutesSinceMidnight(rule.start);
  const end = minutesSinceMidnight(rule.end);
  if (start === null || end === null) return false;

  const now = timestamp.getHours() * 60 + timestamp.getMinutes();
  if (start === end) return true;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

function minutesSinceMidnight(value) {
  if (typeof value !== 'string') return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function decisionForRule(context, rule, action, fallbackReason) {
  return decision({
    action,
    ruleId: stringOr(rule.id, `${action}:${rule.value || rule.domain || 'rule'}`),
    reason: fallbackReason,
    domain: context.domain,
    category: stringOr(rule.category, ''),
    timestamp: context.timestamp
  });
}

function decision(result) {
  return {
    action: result.action,
    allowed: result.action === 'allow',
    ruleId: result.ruleId,
    reason: result.reason,
    domain: result.domain || '',
    category: result.category || '',
    timestamp: result.timestamp.toISOString()
  };
}

module.exports = {
  evaluatePolicy,
  normalizePolicy
};
