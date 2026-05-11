'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 6;

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
        revoked_at TEXT,
        revoked_reason TEXT,
        last_sync_at TEXT,
        device_token_hash TEXT,
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
        event_key TEXT,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_domain ON events(domain);
      CREATE INDEX IF NOT EXISTS idx_events_decision ON events(decision);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_event_key ON events(event_key) WHERE event_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_key TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        profile_id TEXT,
        device_id TEXT,
        event_id INTEGER,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        delivered_at TEXT,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
      CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at DESC);

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
    this.ensureColumn('devices', 'revoked_at', 'TEXT');
    this.ensureColumn('devices', 'revoked_reason', 'TEXT');
    this.ensureColumn('devices', 'last_sync_at', 'TEXT');
    this.ensureColumn('devices', 'device_token_hash', 'TEXT');
    this.ensureColumn('events', 'event_key', 'TEXT');
    this.ensureColumn('alerts', 'delivered_at', 'TEXT');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_event_key ON events(event_key) WHERE event_key IS NOT NULL;');
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  ensureColumn(table, column, definition) {
    const exists = this.db.prepare(`PRAGMA table_info(${table})`).all()
      .some(row => row.name === column);
    if (!exists) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
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
      SELECT
        id, name, platform, profile_id AS profileId, created_at AS createdAt,
        last_seen_at AS lastSeenAt, revoked_at AS revokedAt, revoked_reason AS revokedReason,
        last_sync_at AS lastSyncAt
      FROM devices
      ORDER BY name
    `).all().map(device => ({
      ...device,
      status: deviceStatus(device.lastSeenAt, device.revokedAt)
    }));
  }

  getDevice(deviceId) {
    const row = this.db.prepare(`
      SELECT
        id, name, platform, profile_id AS profileId, created_at AS createdAt,
        last_seen_at AS lastSeenAt, revoked_at AS revokedAt, revoked_reason AS revokedReason,
        last_sync_at AS lastSyncAt
      FROM devices
      WHERE id = ?
    `).get(deviceId);
    return row ? { ...row, status: deviceStatus(row.lastSeenAt, row.revokedAt) } : null;
  }

  getDeviceAuth(deviceId) {
    return this.db.prepare(`
      SELECT
        id, revoked_at AS revokedAt, device_token_hash AS deviceTokenHash
      FROM devices
      WHERE id = ?
    `).get(deviceId) || null;
  }

  upsertDevice(device, options = {}) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO devices (
        id, name, platform, profile_id, created_at, last_seen_at,
        revoked_at, revoked_reason, last_sync_at, device_token_hash
      )
      VALUES (
        @id, @name, @platform, @profileId, @createdAt, @lastSeenAt,
        NULL, NULL, @lastSyncAt, @deviceTokenHash
      )
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        platform = excluded.platform,
        profile_id = excluded.profile_id,
        last_seen_at = excluded.last_seen_at,
        revoked_at = CASE WHEN @clearRevocation = 1 THEN NULL ELSE devices.revoked_at END,
        revoked_reason = CASE WHEN @clearRevocation = 1 THEN NULL ELSE devices.revoked_reason END,
        last_sync_at = COALESCE(@lastSyncAt, devices.last_sync_at),
        device_token_hash = COALESCE(@deviceTokenHash, devices.device_token_hash)
    `).run({
      id: device.id,
      name: device.name,
      platform: device.platform,
      profileId: device.profileId,
      createdAt: device.createdAt || now,
      lastSeenAt: device.lastSeenAt || now,
      lastSyncAt: device.lastSyncAt || null,
      deviceTokenHash: device.deviceTokenHash || null,
      clearRevocation: options.clearRevocation ? 1 : 0
    });
  }

  setDeviceTokenHash(deviceId, tokenHash, options = {}) {
    const sql = options.onlyIfMissing
      ? 'UPDATE devices SET device_token_hash = ? WHERE id = ? AND device_token_hash IS NULL'
      : 'UPDATE devices SET device_token_hash = ? WHERE id = ?';
    return this.db.prepare(sql).run(tokenHash, deviceId).changes > 0;
  }

  revokeDevice(deviceId, reason = 'Revoked by parent', timestamp = new Date().toISOString()) {
    const result = this.db.prepare(`
      UPDATE devices
      SET revoked_at = ?, revoked_reason = ?
      WHERE id = ?
    `).run(timestamp, reason, deviceId);
    return result.changes > 0 ? this.getDevice(deviceId) : null;
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
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL').run(timestamp, deviceId);
  }

  markDeviceSynced(deviceId, timestamp = new Date().toISOString()) {
    this.db.prepare('UPDATE devices SET last_sync_at = ? WHERE id = ? AND revoked_at IS NULL').run(timestamp, deviceId);
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

  enrollDevice(codeHash, device, usedAt = new Date().toISOString()) {
    const transaction = this.db.transaction(() => {
      const enrollment = this.db.prepare(`
        SELECT id, profile_id AS profileId, expires_at AS expiresAt, used_at AS usedAt
        FROM enrollment_codes
        WHERE code_hash = ?
          AND used_at IS NULL
          AND expires_at >= ?
      `).get(codeHash, usedAt);
      if (!enrollment) return null;

      this.upsertDevice({
        ...device,
        profileId: enrollment.profileId,
        lastSeenAt: device.lastSeenAt || usedAt
      }, { clearRevocation: true });

      const result = this.db.prepare(`
        UPDATE enrollment_codes
        SET used_at = ?, used_by_device_id = ?
        WHERE id = ? AND used_at IS NULL
      `).run(usedAt, device.id, enrollment.id);
      if (result.changes !== 1) return null;

      return {
        ...enrollment,
        usedAt,
        usedByDeviceId: device.id
      };
    });
    return transaction();
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
    const statement = event.eventKey ? `
      INSERT OR IGNORE INTO events (
        type, timestamp, url, domain, title, profile_id, device_id, decision,
        rule_id, reason, category, source, event_key, metadata_json
      )
      VALUES (
        @type, @timestamp, @url, @domain, @title, @profileId, @deviceId, @decision,
        @ruleId, @reason, @category, @source, @eventKey, @metadataJson
      )
    ` : `
      INSERT INTO events (
        type, timestamp, url, domain, title, profile_id, device_id, decision,
        rule_id, reason, category, source, event_key, metadata_json
      )
      VALUES (
        @type, @timestamp, @url, @domain, @title, @profileId, @deviceId, @decision,
        @ruleId, @reason, @category, @source, @eventKey, @metadataJson
      )
    `;
    const result = this.db.prepare(statement).run({
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
      eventKey: event.eventKey || null,
      metadataJson: JSON.stringify(event.metadata || {})
    });
    return {
      inserted: result.changes > 0,
      id: result.lastInsertRowid
    };
  }

  recentEvents(limit = 50, filters = {}) {
    const filter = buildEventFilter(filters);
    return this.db.prepare(`
      SELECT
        id, type, timestamp, url, domain, title,
        profile_id AS profileId,
        device_id AS deviceId,
        decision, rule_id AS ruleId, reason, category, source
      FROM events
      ${filter.where}
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `).all(...filter.params, limit);
  }

  eventsAfterId(afterId = 0, limit = 100) {
    return this.db.prepare(`
      SELECT
        id, type, timestamp, url, domain, title,
        profile_id AS profileId,
        device_id AS deviceId,
        decision, rule_id AS ruleId, reason, category, source,
        metadata_json AS metadataJson
      FROM events
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(afterId, limit).map(row => ({
      id: row.id,
      type: row.type,
      timestamp: row.timestamp,
      url: row.url,
      domain: row.domain,
      title: row.title,
      profileId: row.profileId,
      deviceId: row.deviceId,
      decision: row.decision,
      ruleId: row.ruleId,
      reason: row.reason,
      category: row.category,
      source: row.source,
      metadata: parseMetadata(row.metadataJson)
    }));
  }

  exportEvents(filters = {}, limit = 1000) {
    const filter = buildEventFilter(filters);
    return this.db.prepare(`
      SELECT
        id, type, timestamp, url, domain, title,
        profile_id AS profileId,
        device_id AS deviceId,
        decision, rule_id AS ruleId, reason, category, source
      FROM events
      ${filter.where}
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `).all(...filter.params, limit);
  }

  reports(filters = {}) {
    const filter = buildEventFilter(filters);
    const counts = this.db.prepare(`
      SELECT
        COUNT(*) AS totalEvents,
        SUM(CASE WHEN decision = 'allow' THEN 1 ELSE 0 END) AS allowedVisits,
        SUM(CASE WHEN decision = 'block' THEN 1 ELSE 0 END) AS blockedVisits,
        SUM(CASE WHEN type = 'tamper_signal' THEN 1 ELSE 0 END) AS tamperSignals
      FROM events
      ${filter.where}
    `).get(...filter.params);

    const topDomains = this.db.prepare(`
      SELECT domain, COUNT(*) AS count
      FROM events
      WHERE domain IS NOT NULL AND domain != ''
        ${filter.and}
      GROUP BY domain
      ORDER BY count DESC, domain ASC
      LIMIT 10
    `).all(...filter.params);

    const categoryCounts = this.db.prepare(`
      SELECT category, COUNT(*) AS count
      FROM events
      WHERE category IS NOT NULL AND category != ''
        ${filter.and}
      GROUP BY category
      ORDER BY count DESC, category ASC
      LIMIT 10
    `).all(...filter.params);

    const blockedAttempts = this.db.prepare(`
      SELECT timestamp, url, domain, title, rule_id AS ruleId, reason, category, device_id AS deviceId
      FROM events
      WHERE decision = 'block'
        ${filter.and}
      ORDER BY timestamp DESC, id DESC
      LIMIT 25
    `).all(...filter.params);

    const dailySummary = this.db.prepare(`
      SELECT
        substr(timestamp, 1, 10) AS day,
        COUNT(*) AS total,
        SUM(CASE WHEN decision = 'allow' THEN 1 ELSE 0 END) AS allowed,
        SUM(CASE WHEN decision = 'block' THEN 1 ELSE 0 END) AS blocked
      FROM events
      WHERE timestamp >= datetime('now', '-14 days')
        ${filter.and}
      GROUP BY day
      ORDER BY day DESC
      LIMIT 14
    `).all(...filter.params).map(row => ({
      day: row.day,
      total: row.total || 0,
      allowed: row.allowed || 0,
      blocked: row.blocked || 0
    }));

    const recentTamperSignals = this.db.prepare(`
      SELECT timestamp, type, reason, source
      FROM events
      WHERE type = 'tamper_signal'
        ${filter.and}
      ORDER BY timestamp DESC, id DESC
      LIMIT 10
    `).all(...filter.params);

    const onlineEstimate = this.db.prepare(`
      SELECT COUNT(DISTINCT substr(timestamp, 1, 16)) AS activeMinutes
      FROM events
      WHERE type = 'visit_decision'
        AND timestamp >= datetime('now', '-7 days')
        ${filter.and}
    `).get(...filter.params);

    const scheduleViolations = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM events
      WHERE decision = 'block'
        ${filter.and}
        AND (
          rule_id LIKE '%schedule%'
          OR reason LIKE '%schedule%'
          OR reason LIKE '%Scheduled%'
        )
    `).get(...filter.params);

    const deviceSummary = this.db.prepare(`
      SELECT
        COALESCE(devices.id, events.device_id, 'unknown') AS deviceId,
        COALESCE(devices.name, events.device_id, 'Unknown Device') AS name,
        COALESCE(devices.platform, 'unknown') AS platform,
        COALESCE(devices.profile_id, events.profile_id, '') AS profileId,
        devices.last_seen_at AS lastSeenAt,
        devices.revoked_at AS revokedAt,
        COUNT(events.id) AS total,
        SUM(CASE WHEN events.decision = 'allow' THEN 1 ELSE 0 END) AS allowed,
        SUM(CASE WHEN events.decision = 'block' THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN events.type = 'tamper_signal' THEN 1 ELSE 0 END) AS tamperSignals
      FROM events
      LEFT JOIN devices ON devices.id = events.device_id
      WHERE events.device_id IS NOT NULL AND events.device_id != ''
        ${filter.and}
      GROUP BY deviceId
      ORDER BY total DESC, name ASC
      LIMIT 25
    `).all(...filter.params).map(row => ({
      deviceId: row.deviceId,
      name: row.name,
      platform: row.platform,
      profileId: row.profileId,
      lastSeenAt: row.lastSeenAt,
      status: deviceStatus(row.lastSeenAt, row.revokedAt),
      total: row.total || 0,
      allowed: row.allowed || 0,
      blocked: row.blocked || 0,
      tamperSignals: row.tamperSignals || 0
    }));

    const profileSummary = this.db.prepare(`
      SELECT
        COALESCE(profiles.id, events.profile_id, 'unknown') AS profileId,
        COALESCE(profiles.name, events.profile_id, 'Unknown Profile') AS name,
        COUNT(events.id) AS total,
        SUM(CASE WHEN events.decision = 'allow' THEN 1 ELSE 0 END) AS allowed,
        SUM(CASE WHEN events.decision = 'block' THEN 1 ELSE 0 END) AS blocked,
        SUM(CASE WHEN events.type = 'tamper_signal' THEN 1 ELSE 0 END) AS tamperSignals
      FROM events
      LEFT JOIN profiles ON profiles.id = events.profile_id
      WHERE events.profile_id IS NOT NULL AND events.profile_id != ''
        ${filter.and}
      GROUP BY profileId
      ORDER BY total DESC, name ASC
      LIMIT 25
    `).all(...filter.params).map(row => ({
      profileId: row.profileId,
      name: row.name,
      total: row.total || 0,
      allowed: row.allowed || 0,
      blocked: row.blocked || 0,
      tamperSignals: row.tamperSignals || 0
    }));

    return {
      counts: {
        totalEvents: counts.totalEvents || 0,
        allowedVisits: counts.allowedVisits || 0,
        blockedVisits: counts.blockedVisits || 0,
        tamperSignals: counts.tamperSignals || 0,
        estimatedOnlineMinutes7d: onlineEstimate.activeMinutes || 0,
        scheduleViolations: scheduleViolations.count || 0,
        openAlerts: this.alerts(1, false).totalOpen
      },
      topDomains,
      categoryCounts,
      blockedAttempts,
      dailySummary,
      recentTamperSignals,
      deviceSummary,
      profileSummary
    };
  }

  generateAlerts(timestamp = new Date().toISOString()) {
    const recentBlocks = this.db.prepare(`
      SELECT device_id AS deviceId, profile_id AS profileId, domain, COUNT(*) AS count, MAX(id) AS eventId
      FROM events
      WHERE decision = 'block'
        AND timestamp >= datetime('now', '-24 hours')
        AND device_id IS NOT NULL
      GROUP BY device_id, domain
      HAVING count >= 3
    `).all();

    for (const row of recentBlocks) {
      this.upsertAlert({
        alertKey: `repeated-block:${row.deviceId}:${row.domain}`,
        type: 'repeated_block',
        severity: 'medium',
        title: 'Repeated blocked attempts',
        message: `${row.domain} was blocked ${row.count} times in the last 24 hours.`,
        profileId: row.profileId,
        deviceId: row.deviceId,
        eventId: row.eventId,
        createdAt: timestamp,
        metadata: { domain: row.domain, count: row.count }
      });
    }

    const scheduleBlocks = this.db.prepare(`
      SELECT device_id AS deviceId, profile_id AS profileId, COUNT(*) AS count, MAX(id) AS eventId
      FROM events
      WHERE decision = 'block'
        AND timestamp >= datetime('now', '-24 hours')
        AND device_id IS NOT NULL
        AND (
          rule_id LIKE '%schedule%'
          OR reason LIKE '%schedule%'
          OR reason LIKE '%Scheduled%'
        )
      GROUP BY device_id
      HAVING count >= 1
    `).all();

    for (const row of scheduleBlocks) {
      this.upsertAlert({
        alertKey: `schedule:${row.deviceId}`,
        type: 'schedule_violation',
        severity: 'medium',
        title: 'Schedule violation',
        message: `${row.count} schedule-blocked attempt${row.count === 1 ? '' : 's'} in the last 24 hours.`,
        profileId: row.profileId,
        deviceId: row.deviceId,
        eventId: row.eventId,
        createdAt: timestamp,
        metadata: { count: row.count }
      });
    }

    const tamperSignals = this.db.prepare(`
      SELECT id, profile_id AS profileId, device_id AS deviceId, reason, timestamp
      FROM events
      WHERE type = 'tamper_signal'
      ORDER BY id DESC
      LIMIT 25
    `).all();

    for (const row of tamperSignals) {
      this.upsertAlert({
        alertKey: `tamper:${row.id}`,
        type: 'tamper_signal',
        severity: 'high',
        title: 'Tamper signal',
        message: row.reason || 'SafeHarbor received a tamper signal.',
        profileId: row.profileId,
        deviceId: row.deviceId,
        eventId: row.id,
        createdAt: row.timestamp || timestamp,
        metadata: {}
      });
    }

    const offlineDevices = this.getDevices().filter(device => device.status === 'offline' && !device.revokedAt);
    for (const device of offlineDevices) {
      this.upsertAlert({
        alertKey: `offline:${device.id}`,
        type: 'device_offline',
        severity: 'medium',
        title: 'Device offline',
        message: `${device.name} has not checked in recently.`,
        profileId: device.profileId,
        deviceId: device.id,
        createdAt: timestamp,
        metadata: { lastSeenAt: device.lastSeenAt }
      });
    }
  }

  upsertAlert(alert) {
    this.db.prepare(`
      INSERT INTO alerts (
        alert_key, type, severity, status, title, message, profile_id, device_id,
        event_id, created_at, metadata_json
      )
      VALUES (
        @alertKey, @type, @severity, 'open', @title, @message, @profileId, @deviceId,
        @eventId, @createdAt, @metadataJson
      )
      ON CONFLICT(alert_key) DO UPDATE SET
        severity = excluded.severity,
        title = excluded.title,
        message = excluded.message,
        metadata_json = excluded.metadata_json
      WHERE alerts.status = 'open'
    `).run({
      alertKey: alert.alertKey,
      type: alert.type,
      severity: alert.severity,
      title: alert.title,
      message: alert.message,
      profileId: alert.profileId || null,
      deviceId: alert.deviceId || null,
      eventId: alert.eventId || null,
      createdAt: alert.createdAt,
      metadataJson: JSON.stringify(alert.metadata || {})
    });
  }

  alerts(limit = 25, includeResolved = false) {
    const rows = this.db.prepare(`
      SELECT
        id, alert_key AS alertKey, type, severity, status, title, message,
        profile_id AS profileId, device_id AS deviceId, event_id AS eventId,
        created_at AS createdAt, resolved_at AS resolvedAt, delivered_at AS deliveredAt,
        metadata_json AS metadataJson
      FROM alerts
      ${includeResolved ? '' : "WHERE status = 'open'"}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(limit).map(row => ({
      ...row,
      metadata: parseMetadata(row.metadataJson),
      metadataJson: undefined
    }));
    const totalOpen = this.db.prepare("SELECT COUNT(*) AS count FROM alerts WHERE status = 'open'").get().count || 0;
    return { rows, totalOpen };
  }

  resolveAlert(alertId, timestamp = new Date().toISOString()) {
    const result = this.db.prepare(`
      UPDATE alerts
      SET status = 'resolved', resolved_at = ?
      WHERE id = ? AND status = 'open'
    `).run(timestamp, alertId);
    return result.changes > 0;
  }

  markAlertDelivered(alertId, timestamp = new Date().toISOString()) {
    const result = this.db.prepare(`
      UPDATE alerts
      SET delivered_at = ?
      WHERE id = ? AND delivered_at IS NULL
    `).run(timestamp, alertId);
    return result.changes > 0;
  }

  backupTo(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    return this.db.backup(filePath);
  }

  close() {
    this.db.close();
  }
}

function deviceStatus(lastSeenAt, revokedAt = null) {
  if (revokedAt) return 'revoked';
  if (!lastSeenAt) return 'never_seen';
  const ageMs = Date.now() - new Date(lastSeenAt).getTime();
  if (Number.isNaN(ageMs)) return 'unknown';
  if (ageMs <= 2 * 60 * 1000) return 'online';
  if (ageMs <= 30 * 60 * 1000) return 'recent';
  return 'offline';
}

function parseMetadata(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

function buildEventFilter(filters = {}) {
  const clauses = [];
  const params = [];
  if (filters.deviceId) {
    clauses.push('events.device_id = ?');
    params.push(filters.deviceId);
  }
  if (filters.profileId) {
    clauses.push('events.profile_id = ?');
    params.push(filters.profileId);
  }
  if (filters.dateFrom) {
    clauses.push('events.timestamp >= ?');
    params.push(filters.dateFrom);
  }
  if (filters.dateTo) {
    clauses.push('events.timestamp <= ?');
    params.push(filters.dateTo);
  }
  return {
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    and: clauses.length ? `AND ${clauses.join(' AND ')}` : '',
    params
  };
}

module.exports = {
  EventStore,
  SCHEMA_VERSION
};
