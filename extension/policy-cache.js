'use strict';

(function exposePolicyCache(root) {
  const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const ACTIONS = new Set(['allow', 'block']);
  const DYNAMIC_RULE_ID_START = 1000;
  const DYNAMIC_RULE_ID_END = 5999;
  const RESOURCE_TYPES = ['main_frame'];

  function evaluateCachedPolicy(input) {
    const url = normalizeUrl(input && input.url);
    const policy = normalizePolicy(input && input.policy);
    const timestamp = parseTimestamp(input && input.timestamp);
    if (!url || !policy) return null;

    const domain = url.hostname.toLowerCase();
    const path = `${url.pathname || '/'}${url.search || ''}`;
    const context = { url, domain, path, timestamp, policy };
    return firstMatch(context, policy.temporaryOverrides, matchOverride)
      || firstMatch(context, policy.allowedDomains, matchDomainRule, 'allow')
      || firstMatch(context, policy.blockedDomains, matchDomainRule, 'block')
      || matchBlockedCategory(context)
      || firstMatch(context, policy.schedules, matchScheduleRule)
      || {
        action: policy.defaultAction,
        allowed: policy.defaultAction === 'allow',
        ruleId: 'default-policy',
        reason: `Default policy ${policy.defaultAction}`,
        domain,
        category: '',
        timestamp: timestamp.toISOString()
      };
  }

  function compileDynamicRules(policy, timestamp = new Date()) {
    const normalized = normalizePolicy(policy);
    if (!normalized) return [];

    const rules = [];
    const allowDomains = new Set();
    const blockDomains = new Set();
    for (const rule of normalized.allowedDomains) addRuleDomain(allowDomains, rule);
    for (const category of normalized.blockedCategories) {
      for (const domain of normalized.categories[category] || []) addDomain(blockDomains, domain);
    }
    for (const rule of normalized.blockedDomains) addRuleDomain(blockDomains, rule);
    for (const rule of normalized.temporaryOverrides) {
      if (!ACTIONS.has(rule.action)) continue;
      if (rule.expiresAt && timestamp > parseTimestamp(rule.expiresAt)) continue;
      const target = rule.action === 'allow' ? allowDomains : blockDomains;
      addRuleDomain(target, rule);
    }

    let ruleId = DYNAMIC_RULE_ID_START;
    for (const domain of allowDomains) {
      rules.push(dynamicRule(ruleId, 40, domain, { type: 'allow' }));
      ruleId += 1;
    }
    for (const domain of blockDomains) {
      if (allowDomains.has(domain)) continue;
      rules.push(dynamicRule(ruleId, 20, domain, {
        type: 'redirect',
        redirect: { extensionPath: '/block.html' }
      }));
      ruleId += 1;
    }
    return rules.slice(0, DYNAMIC_RULE_ID_END - DYNAMIC_RULE_ID_START + 1);
  }

  function dynamicRule(id, priority, domain, action) {
    return {
      id,
      priority,
      action,
      condition: {
        requestDomains: [domain],
        resourceTypes: RESOURCE_TYPES
      }
    };
  }

  function addRuleDomain(target, rule) {
    addDomain(target, rule.value || rule.domain);
  }

  function addDomain(target, value) {
    const domain = normalizeDomain(value);
    if (domain) target.add(domain);
  }

  function normalizePolicy(policy) {
    if (!policy || typeof policy !== 'object') return null;
    return {
      defaultAction: ACTIONS.has(policy.defaultAction) ? policy.defaultAction : 'allow',
      blockedDomains: arrayOfObjects(policy.blockedDomains),
      allowedDomains: arrayOfObjects(policy.allowedDomains),
      categories: normalizeCategories(policy.categories),
      blockedCategories: Array.isArray(policy.blockedCategories)
        ? policy.blockedCategories.filter(item => typeof item === 'string')
        : [],
      schedules: arrayOfObjects(policy.schedules),
      temporaryOverrides: arrayOfObjects(policy.temporaryOverrides)
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
    return decisionForRule(context, rule, forcedAction, rule.reason || `${forcedAction} ${rule.value || rule.domain}`);
  }

  function domainRuleApplies(context, rule) {
    const value = normalizeDomain(rule.value || rule.domain);
    if (!value || !domainMatches(context.domain, value)) return false;
    const pathPrefix = stringOr(rule.pathPrefix, '');
    return !pathPrefix || context.path.startsWith(pathPrefix);
  }

  function matchBlockedCategory(context) {
    for (const category of context.policy.blockedCategories) {
      const domains = context.policy.categories[category] || [];
      const matchedDomain = domains.find(value => domainMatches(context.domain, normalizeDomain(value)));
      if (!matchedDomain) continue;
      return {
        action: 'block',
        allowed: false,
        ruleId: `category:${category}`,
        reason: `Blocked category: ${category}`,
        domain: context.domain,
        category,
        timestamp: context.timestamp.toISOString()
      };
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

  function decisionForRule(context, rule, action, fallbackReason) {
    return {
      action,
      allowed: action === 'allow',
      ruleId: stringOr(rule.id, `${action}:${rule.value || rule.domain || 'rule'}`),
      reason: fallbackReason,
      domain: context.domain,
      category: stringOr(rule.category, ''),
      timestamp: context.timestamp.toISOString()
    };
  }

  function minutesSinceMidnight(value) {
    if (typeof value !== 'string') return null;
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
  }

  function domainMatches(domain, ruleDomain) {
    if (!domain || !ruleDomain) return false;
    const normalized = ruleDomain.replace(/^\*\./, '');
    return domain === normalized || domain.endsWith(`.${normalized}`);
  }

  function normalizeDomain(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/^\*\./, '')
      .replace(/^\.+|\.+$/g, '');
  }

  function stringOr(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  }

  const api = {
    DYNAMIC_RULE_ID_END,
    DYNAMIC_RULE_ID_START,
    compileDynamicRules,
    evaluateCachedPolicy,
    normalizeDomain
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SafeHarborPolicyCache = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
