'use strict';

const REGINA_OFFSET_HOURS = 6;

function parseReportFilters(searchParams, now = new Date()) {
  const dateFrom = asString(searchParams.get('dateFrom'));
  const dateTo = asString(searchParams.get('dateTo'));
  const dailySince = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const onlineSince = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentSince = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  return {
    deviceId: asString(searchParams.get('deviceId')),
    profileId: asString(searchParams.get('profileId')),
    dateFrom: dateFrom ? startOfReginaDay(dateFrom) : '',
    dateTo: dateTo ? endOfReginaDay(dateTo) : '',
    dailySince,
    onlineSince,
    recentSince
  };
}

function startOfReginaDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, REGINA_OFFSET_HOURS, 0, 0, 0)).toISOString();
}

function endOfReginaDay(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1, REGINA_OFFSET_HOURS, 0, 0, 0) - 1).toISOString();
}

function asString(value) {
  return typeof value === 'string' ? value : '';
}

module.exports = {
  endOfReginaDay,
  parseReportFilters,
  startOfReginaDay
};
