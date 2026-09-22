import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEnvironment } from '../src/runtime/sandbox/env-sanitizer.mjs';

test('sanitizeEnvironment preserves safe allowlisted environment variables', () => {
  const source = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/Users/testuser',
    USER: 'testuser',
    SHELL: '/bin/zsh',
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    NODE_ENV: 'development',
    CARGO_HOME: '/Users/testuser/.cargo',
    NVM_DIR: '/Users/testuser/.nvm',
  };

  const result = sanitizeEnvironment(source);

  assert.equal(result.PATH, '/usr/local/bin:/usr/bin:/bin');
  assert.equal(result.HOME, '/Users/testuser');
  assert.equal(result.USER, 'testuser');
  assert.equal(result.SHELL, '/bin/zsh');
  assert.equal(result.TERM, 'xterm-256color');
  assert.equal(result.LANG, 'en_US.UTF-8');
  assert.equal(result.NODE_ENV, 'development');
  assert.equal(result.CARGO_HOME, '/Users/testuser/.cargo');
  assert.equal(result.NVM_DIR, '/Users/testuser/.nvm');
});

test('sanitizeEnvironment strips API keys, tokens, and cloud secrets', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/Users/testuser',
    OPENAI_API_KEY: 'sk-proj-1234567890',
    ANTHROPIC_API_KEY: 'sk-ant-1234567890',
    GEMINI_API_KEY: 'AIzaSy1234567890',
    AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    GITHUB_TOKEN: 'ghp_1234567890',
    GH_TOKEN: 'gho_1234567890',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    SLACK_BOT_TOKEN: 'xoxb-1234',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    CUPPET_USER_DATA_DIR: '/Users/testuser/.cuppet',
    MY_SECRET_KEY: 'supersecret',
    API_BEARER_TOKEN: 'secretbearer',
    PASSWORD: 'mypassword',
  };

  const result = sanitizeEnvironment(source);

  assert.equal(result.PATH, '/usr/bin');
  assert.equal(result.HOME, '/Users/testuser');
  assert.equal(result.OPENAI_API_KEY, undefined);
  assert.equal(result.ANTHROPIC_API_KEY, undefined);
  assert.equal(result.GEMINI_API_KEY, undefined);
  assert.equal(result.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(result.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(result.GITHUB_TOKEN, undefined);
  assert.equal(result.GH_TOKEN, undefined);
  assert.equal(result.SSH_AUTH_SOCK, undefined);
  assert.equal(result.SLACK_BOT_TOKEN, undefined);
  assert.equal(result.DATABASE_URL, undefined);
  assert.equal(result.CUPPET_USER_DATA_DIR, undefined);
  assert.equal(result.MY_SECRET_KEY, undefined);
  assert.equal(result.API_BEARER_TOKEN, undefined);
  assert.equal(result.PASSWORD, undefined);
});

test('sanitizeEnvironment applies explicit overrides', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/Users/testuser',
  };
  const overrides = {
    PORT: '3000',
    CUSTOM_FLAG: 'true',
  };

  const result = sanitizeEnvironment(source, overrides);

  assert.equal(result.PORT, '3000');
  assert.equal(result.CUSTOM_FLAG, 'true');
});
