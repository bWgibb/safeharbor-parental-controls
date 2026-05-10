'use strict';

const DEFAULT_PROFILE_ID = 'default-child';
const DEFAULT_DEVICE_ID = 'local-device';
const DEFAULT_POLICY_ID = 'default-policy';

function defaultProfile() {
  return {
    id: DEFAULT_PROFILE_ID,
    name: 'Default Child'
  };
}

function defaultDevice() {
  return {
    id: DEFAULT_DEVICE_ID,
    name: 'Local Test Device',
    platform: process.platform,
    profileId: DEFAULT_PROFILE_ID
  };
}

function defaultPolicy() {
  return {
    id: DEFAULT_POLICY_ID,
    name: 'Default Local Policy',
    profileId: DEFAULT_PROFILE_ID,
    defaultAction: 'allow',
    blockedDomains: [
      {
        id: 'block-example',
        value: 'example.com',
        reason: 'Demo blocked domain for SafeHarbor test drives',
        category: 'demo'
      }
    ],
    allowedDomains: [
      {
        id: 'allow-wikipedia',
        value: 'wikipedia.org',
        reason: 'Default educational allow-list example',
        category: 'education'
      }
    ],
    categories: {
      social: ['facebook.com', 'instagram.com', 'tiktok.com'],
      video: ['youtube.com', 'netflix.com'],
      games: ['roblox.com', 'epicgames.com']
    },
    blockedCategories: [],
    schedules: [],
    temporaryOverrides: []
  };
}

module.exports = {
  DEFAULT_DEVICE_ID,
  DEFAULT_POLICY_ID,
  DEFAULT_PROFILE_ID,
  defaultDevice,
  defaultPolicy,
  defaultProfile
};
