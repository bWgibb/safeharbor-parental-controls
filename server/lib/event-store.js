'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 2;

class EventStore {
  constructor(databaseFile) {
    fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
    this.databaseFile = databaseFile;
    this.db = new Database(databaseFile);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT,
        FOREIGN KEY (profile_id) REFERENCES profiles(id)
      );

      CREATE TABLE IF NOT EXISTS policies (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        name TEXT NOT NULL,
        default_action TEXT NOT NULL,
        config_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (profile_id) REFERENCES profiles(id)
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        url TEXT,
        domain TEXT,
        title TEXT,
        profile_id TEXT,
        device_id TEXT,
        decision TEXT,
        rule_id TEXT,
        reason TEXT,
        category TEXT,
        source TEXT,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_domain ON events(domain);
      CREATE INDEX IF NOT EXISTS idx_events_decision ON events(decision);

      CREATE TABLE IF NOT EXISTS enrollment_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code_hash TEXT NOT NULL UNIQUE,
        profile_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        used_by_device_id TEXT,
        FOREIGN KEY (profile_id) REFERENCES profiles(id),
        FOREIGN KEY (used_by_device_id) REFERENCES devices(id)
      );

      CREATE INDEX IF NOT EXISTS idx_enrollment_codes_expires ON enrollment_codes(expires_at DESC);
    `);
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  seed(defaults) {
    const now = new Date().toISOString();
    const insertProfile = this.db.prepare(`
      INSERT OR IGNORE INTO profiles (id, name, created_at)
      VALUES (@id, @name, @createdAt)
    `);
    const insertDevice = this.db.prepare(`
      INSERT OR IGNORE INTO devices (id, name, platform, profile_id, created_at, last_seen_at)
      VALUES (@id, @name, @platform, @profileId, @createdAt, @lastSeenAt)
    `);
    const insertPolicy = this.db.prepare(`
      INSERT OR IGNORE INTO policies (id, profile_id, name, default_action, config_json, updated_at)
      VALUES (@id, @profileId, @name, @defaultAction, @configJson, @updatedAt)
    `);

    const transaction = this.db.transaction(() => {
      insertProfile.run({
        id: defaults.profile.id,
        name: defaults.profile.name,
        createdAt: now
      });
      insertDevice.run({
        id: defaults.device.id,
        name: defaults.device.name,
        platform: defaults.device.platform,
        profileId: defaults.device.profileId,
        createdAt: now,
        lastSeenAt: now
      });
      insertPolicy.run({
        id: defaults.policy.id,
        profileId: defaults.policy.profileId,
        name: defaults.policy.name,
        defaultAction: defaults.policy.defaultAction,
        configJson: JSON.stringify(defaults.policy),
        updatedAt: now
      });
    });
    transaction();
  }

  getProfiles() {
    return this.db.prepare('SELECT id, name, created_at AS createdAt FROM profiles ORDER BY name').all();
  }

  getDevices() {
    return this.db.prepare(`
      SELECT id, name, platform, profile_id AS profileId, created_at AS createdAt, last_seen_at AS lastSeenAt
      FROM devices
      ORDER BY name
    `).all().map(device => ({
      ...device,
      status: deviceStatus(device.lastSeenAt)
    }));
  }

  getDevice(deviceId) {
    const row = this.db.prepare(`
      SELECT id, name, platform, profile_id AS profileId, created_at AS createdAt, last_seen_at AS lastSeenAt
      FROM devices
      WHERE id = ?
    `).get(deviceId);
    return row ? { ...row, status: deviceStatus(row.lastSeenAt) } : null;
  }

  upsertDevice(device) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO devices (id, name, platform, profile_id, created_at, last_seen_at)
      VALUES (@id, @name, @platform, @profileId, @createdAt, @lastSeenAt)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        platform = excluded.platform,
        profile_id = excluded.profile_id,
        last_seen_at = excluded.last_seen_at
    `).run({
      id: device.id,
      name: device.name,
      platform: device.platform,
      profileId: device.profileId,
      createdAt: device.createdAt || now,
      lastSeenAt: device.lastSeenAt || now
    });
  }

  getPolicy(profileId) {
    const row = this.db.prepare(`
      SELECT config_json AS configJson
      FROM policies
      WHERE profile_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(profileId);
    return row ? JSON.parse(row.configJson) : null;
  }

  getPolicyById(policyId) {
    const row = this.db.prepare('SELECT config_json AS configJson FROM policies WHERE id = ?').get(policyId);
    return row ? JSON.parse(row.configJson) : null;
  }

  getPolicyRecord(profileId) {
    const row = this.db.prepare(`
      SELECT id, config_json AS configJson, updated_at AS updatedAt
      FROM policies
      WHERE profile_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(profileId);
    return row ? { id: row.id, policy: JSON.parse(row.configJson), updatedAt: row.updatedAt } : null;
  }

  upsertPolicy(policy) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO policies (id, profile_id, name, default_action, config_json, updated_at)
      VALUES (@id, @profileId, @name, @defaultAction, @configJson, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET
        profile_id = excluded.profile_id,
        name = excluded.name,
        default_action = excluded.default_action,
        config_json = excluded.config_json,
        updated_at = excluded.updated_at
    `).run({
      id: policy.id,
      profileId: policy.profileId,
      name: policy.name,
      defaultAction: policy.defaultAction,
      configJson: JSON.stringify(policy),
      updatedAt: now
    });
  }

  touchDevice(deviceId, timestamp = new Date().toISOString()) {
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(timestamp, deviceId);
  }

  createEnrollmentCode(enrollment) {
    this.db.prepare(`
      INSERT INTO enrollment_codes (code_hash, profile_id, created_at, expires_at)
      VALUES (@codeHash, @profileId, @createdAt, @expiresAt)
    `).run(enrollment);
  }

  consumeEnrollmentCode(codeHash, deviceId, usedAt = new Date().toISOString()) {
    const row = this.db.prepare(`
      SELECT id, profile_id AS profileId, expires_at AS expiresAt, used_at AS usedAt
      FROM enrollment_codes
      WHERE code_hash = ?
    `).get(codeHash);
    if (!row || row.usedAt || row.expiresAt < usedAt) return null;
    this.db.prepare(`
      UPDATE enrollment_codes
      SET used_at = ?
      WHERE id = ?
    `).run(usedAt, row.id);
    return row;
  }

  completeEnrollmentCode(enrollmentId, deviceId) {
    this.db.prepare(`
      UPDATE enrollment_codes
      SET used_by_device_id = ?
      WHERE id = ?
    `).run(deviceId, enrollmentId);
  }

  recentEnrollmentCodes(limit = 10) {
    return this.db.prepare(`
      SELECT
        id, profile_id AS profileId, created_at AS createdAt, expires_at AS expiresAt,
        used_at AS usedAt, used_by_device_id AS usedByDeviceId
      FROM enrollment_codes
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);
  }

  recordEvent(event) {
    const timestamp = event.timestamp || new Date().toISOString();
    this.db.prepare(`
      INSERT INTO events (
        type, timestamp, url, domain, title, profile_id, device_id, decision,
        rule_id, reason, category, source, metadata_json
      )
      VALUES (
        @type, @timestamp, @url, @domain, @title, @profileId, @deviceId, @decision,
        @ruleId, @reason, @category, @source, @metadataJson
      )
    `).run({
      type: event.type,
      timestamp,
      url: event.url || null,
      domain: event.domain || null,
      title: event.title || null,
      profileId: event.profileId || null,
      deviceId: event.deviceId || null,
      decision: event.decision || null,
      ruleId: event.ruleId || null,
      reason: event.reason || null,
      category: event.category || null,
      source: event.source || null,
      metadataJson: JSON.stringify(event.metadata || {})
    });
  }

  recentEvents(limit = 50) {
    return this.db.prepare(`
      SELECT
        id, type, timestamp, url, domain, title,
        profile_id AS profileId,
        device_id AS deviceId,
        decision, rule_id AS ruleId, reason, category, source
      FROM events
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `).all(limit);
  }

  reports() {
    const counts = this.db.prepare(`
      SELECT
        COUNT(*) AS totalEvents,
        SUM(CASE WHEN decision = 'allow' THEN 1 ELSE 0 END) AS allowedVisits,
        SUM(CASE WHEN decision = 'block' THEN 1 ELSE 0 END) AS blockedVisits,
        SUM(CASE WHEN type = 'tamper_signal' THEN 1 ELSE 0 END) AS tamperSignals
      FROM events
    `).get();

    const topDomains = this.db.prepare(`
      SELECT domain, COUNT(*) AS count
      FROM events
      WHERE domain IS NOT NULL AND domain != ''
      GROUP BY domain
      ORDER BY count DESC, domain ASC
      LIMIT 10
    `).all();

    const categoryCounts = this.db.prepare(`
      SELECT category, COUNT(*) AS count
      FROM events
      WHERE category IS NOT NULL AND category != ''
      GROUP BY category
      ORDER BY count DESC, category ASC
      LIMIT 10
    `).all();

    const blockedAttempts = this.db.prepare(`
      SELECT timestamp, url, domain, title, rule_id AS ruleId, reason, category
      FROM events
      WHERE decision = 'block'
      ORDER BY timestamp DESC, id DESC
      LIMIT 25
    `).all();

    const dailySummary = this.db.prepare(`
      SELECT
        substr(timestamp, 1, 10) AS day,
        COUNT(*) AS total,
        SUM(CASE WHEN decision = 'allow' THEN 1 ELSE 0 END) AS allowed,
        SUM(CASE WHEN decision = 'block' THEN 1 ELSE 0 END) AS blocked
      FROM events
      WHERE timestamp >= datetime('now', '-14 days')
      GROUP BY day
      ORDER BY day DESC
      LIMIT 14
    `).all().map(row => ({
      day: row.day,
      total: row.total || 0,
      allowed: row.allowed || 0,
      blocked: row.blocked || 0
    }));

    const recentTamperSignals = this.db.prepare(`
      SELECT timestamp, type, reason, source
      FROM events
      WHERE type = 'tamper_signal'
      ORDER BY timestamp DESC, id DESC
      LIMIT 10
    `).all();

    const onlineEstimate = this.db.prepare(`
      SELECT COUNT(DISTINCT substr(timestamp, 1, 16)) AS activeMinutes
      FROM events
      WHERE type = 'visit_decision'
        AND timestamp >= datetime('now', '-7 days')
    `).get();

    const scheduleViolations = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM events
      WHERE decision = 'block'
        AND (
          rule_id LIKE '%schedule%'
          OR reason LIKE '%schedule%'
          OR reason LIKE '%Scheduled%'
        )
    `).get();

    return {
      counts: {
        totalEvents: counts.totalEvents || 0,
        allowedVisits: counts.allowedVisits || 0,
        blockedVisits: counts.blockedVisits || 0,
        tamperSignals: counts.tamperSignals || 0,
        estimatedOnlineMinutes7d: onlineEstimate.activeMinutes || 0,
        scheduleViolations: scheduleViolations.count || 0
      },
      topDomains,
      categoryCounts,
      blockedAttempts,
      dailySummary,
      recentTamperSignals
    };
  }

  close() {
    this.db.close();
  }
}

function deviceStatus(lastSeenAt) {
  if (!lastSeenAt) return 'never_seen';
  const ageMs = Date.now() - new Date(lastSeenAt).getTime();
  if (Number.isNaN(ageMs)) return 'unknown';
  if (ageMs <= 2 * 60 * 1000) return 'online';
  if (ageMs <= 30 * 60 * 1000) return 'recent';
  return 'offline';
}

module.exports = {
  EventStore,
  SCHEMA_VERSION
};
