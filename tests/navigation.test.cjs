'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isDiscordURL, isExternalURL } = require('../navigation');

test('embedded navigation only allows the exact secure Discord host', () => {
  for (const url of ['https://discord.com/login', 'https://discord.com/channels/@me', 'https://discord.com:443/channels/123/456']) assert.equal(isDiscordURL(url), true, url);
  for (const url of ['http://discord.com/login', 'https://discord.com.evil.test/', 'https://discord.com@evil.test/', 'https://name:password@discord.com/', 'https://discord.com:8443/', 'javascript:alert(1)', 'file:///C:/Windows', 'https://discordapp.com/', 'invalid']) assert.equal(isDiscordURL(url), false, url);
});

test('external links cannot launch arbitrary local protocols', () => {
  for (const url of ['https://example.com/', 'http://example.com/']) assert.equal(isExternalURL(url), true);
  for (const url of ['file:///C:/Windows', 'javascript:alert(1)', 'ms-settings:privacy', 'discord://abc', 'https://user:password@example.com/']) assert.equal(isExternalURL(url), false);
});
