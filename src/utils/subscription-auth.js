import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function safeParseJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function findExecutable(binary) {
  const command = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(command, [binary]);
    const firstLine = stdout.toString().split(/\r?\n/).find((line) => line.trim().length > 0);
    return firstLine ? firstLine.trim() : null;
  } catch {
    return null;
  }
}

export async function detectCodexSubscriptionAuth() {
  const result = {
    hasTokens: false,
    authPath: null,
    preferredAuthMethod: null,
    error: null,
  };

  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const authPath = path.join(codexHome, 'auth.json');
  const configPath = path.join(codexHome, 'config.toml');

  try {
    const raw = await fs.readFile(authPath, 'utf8');
    const parsed = safeParseJSON(raw);
    if (parsed?.tokens?.access_token || parsed?.tokens?.refresh_token) {
      result.hasTokens = true;
      result.authPath = authPath;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      result.error = error;
    }
  }

  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const match = raw.match(/preferred_auth_method\\s*=\\s*\"([^\\\"]+)\"/);
    if (match) {
      result.preferredAuthMethod = match[1];
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && !result.error) {
      result.error = error;
    }
  }

  return result;
}

export async function detectClaudeSubscriptionAuth() {
  const result = {
    hasAuthToken: false,
    settingsPath: null,
    error: null,
  };

  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const localSettingsPath = path.join(configDir, 'settings.local.json');
  const fallbackSettingsPath = path.join(configDir, 'settings.json');

  try {
    const raw = await fs.readFile(localSettingsPath, 'utf8');
    const parsed = safeParseJSON(raw);
    if (parsed?.authToken || parsed?.sessionToken || parsed?.claudeCodeAuthToken) {
      result.hasAuthToken = true;
      result.settingsPath = localSettingsPath;
      return result;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      result.error = error;
    }
  }

  if (!result.hasAuthToken) {
    try {
      const raw = await fs.readFile(fallbackSettingsPath, 'utf8');
      const parsed = safeParseJSON(raw);
      if (parsed?.authToken || parsed?.sessionToken || parsed?.claudeCodeAuthToken) {
        result.hasAuthToken = true;
        result.settingsPath = fallbackSettingsPath;
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && !result.error) {
        result.error = error;
      }
    }
  }

  return result;
}

export async function verifyClaudeCliLogin(claudeBinary) {
  const candidates = [];
  if (claudeBinary) {
    candidates.push(claudeBinary);
  }
  if (!candidates.includes('claude')) {
    candidates.push('claude');
  }

  const errors = [];

  for (const candidate of candidates) {
    try {
      const { stdout, stderr } = await execFileAsync(candidate, ['-p', '/status', '--output-format', 'json'], {
        env: { ...process.env, CLAUDE_CODE_TELEMETRY_DISABLED: '1' },
        timeout: 5000,
        maxBuffer: 5 * 1024 * 1024,
      });

      const combined = `${stdout || ''}\n${stderr || ''}`;
      if (/Invalid API key/i.test(combined)) {
        errors.push('Invalid CLI session. Run "claude login".');
        continue;
      }

      try {
        const lines = stdout.split(/\r?\n/).filter(Boolean);
        if (lines.length) {
          const payload = JSON.parse(lines[lines.length - 1]);
          if (payload?.is_error) {
            errors.push(payload.result || 'Claude CLI reported an error.');
            continue;
          }
        }
      } catch {
        // ignore parsing errors and treat as success
      }

      return { ok: true, path: candidate };
    } catch (error) {
      const stderr = error?.stderr ? String(error.stderr).trim() : '';
      const stdout = error?.stdout ? String(error.stdout).trim() : '';
      const message = stderr || stdout || error.message;
      errors.push(message);
    }
  }

  return { ok: false, message: errors.filter(Boolean).join(' | ') || 'Claude CLI login not detected.' };
}
