'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('./paths');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

function buildClaudeArgs({ system, model }) {
  // Journalist questions are untrusted text, so the model must have no tools or permission bypass.
  return ['-p', '--system-prompt', system, '--model', model, '--output-format', 'json',
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', ''];
}

function isCapacityError(err) {
  return /overloaded|rate.?limit|capacity|429|529|usage limit|too many requests/i
    .test(String(err && err.message || err || ''));
}

function runClaude({ system, prompt, model, timeoutMs, cwd }) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const child = spawn(process.env.CLAUDE_BIN || 'claude', buildClaudeArgs({ system, model }), {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const redact = (value) => {
      let text = String(value);
      for (const secret of [prompt, system]) {
        if (secret) text = text.split(secret).join('[redacted]');
      }
      return text;
    };
    const fail = (message, code = child.exitCode, signal = child.signalCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${redact(message)} (exit ${code === null ? 'unknown' : code}${signal ? `, signal ${signal}` : ''}): ${redact(stderr).slice(-300) || 'no stderr'}`));
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => fail(`claude cli: spawn failed (${err.code || 'unknown'})`));
    child.stdin.on('error', (err) => {
      // An early exit closes stdin; the close event supplies the useful exit code and stderr.
      if (err.code !== 'EPIPE') fail(`claude cli: stdin failed (${err.code || 'unknown'})`);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0) return fail('claude cli failed', code, signal);
      let envelope;
      try {
        envelope = JSON.parse(stdout);
      } catch {
        // JSON parser messages can quote model output, including the input prompt.
        return fail('claude cli: invalid JSON envelope', code, signal);
      }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
        return fail('claude cli: invalid JSON envelope', code, signal);
      }
      if (envelope.is_error === true) {
        return fail(`claude cli: ${envelope.subtype || 'error'}`, code, signal);
      }
      settled = true;
      clearTimeout(timer);
      resolve(envelope);
    });
    timer = setTimeout(() => {
      child.kill('SIGTERM');
      fail(`claude cli timed out after ${timeoutMs} ms`, child.exitCode, 'SIGTERM');
    }, timeoutMs);
    child.stdin.end(prompt);
  });
}

async function callClaude({ system, prompt, model = 'sonnet', timeoutMs = 180000,
  stage = 'unspecified', retries = 3, usageLedger = paths.USAGE_LEDGER }) {
  if (!Number.isInteger(retries) || retries < 1) throw new Error('retries must be a positive integer');
  const cwd = path.join(os.tmpdir(), 'featured-agent-llm-cwd');
  fs.mkdirSync(cwd, { recursive: true });
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const envelope = await runClaude({ system, prompt, model, timeoutMs, cwd });
      try {
        paths.appendJsonl(usageLedger, {
          at: new Date().toISOString(), stage, model,
          cost_usd: envelope.total_cost_usd ?? null,
          input_tokens: envelope.usage?.input_tokens ?? null,
          output_tokens: envelope.usage?.output_tokens ?? null,
        });
      } catch {
        // Usage accounting must never discard a successful model response.
      }
      return String(envelope.result ?? '');
    } catch (err) {
      if (attempt === retries) throw err;
      const override = process.env.FEATURED_LLM_RETRY_MS;
      const baseMs = override !== undefined && Number.isFinite(Number(override)) && Number(override) >= 0
        ? Number(override) : (isCapacityError(err) ? 20000 : 3000);
      await new Promise((resolve) => setTimeout(resolve, baseMs * attempt));
    }
  }
}

function extractJsonObject(text) {
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('No JSON object found');
  return JSON.parse(text.slice(first, last + 1));
}

function extractJsonArray(text) {
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first < 0 || last <= first) throw new Error('No JSON array found');
  return JSON.parse(text.slice(first, last + 1));
}

const CHAT_ARTIFACT = /clipboard|cmd\+v|pbcopy|paste it|^\s*(done|here'?s|here is|i'?ve (drafted|written)|drafted (as|it))|\bchars, no em-dashes\b|^\s*```/i;

function parseDraft(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('claude cli returned an empty draft');
  const match = text.match(/\{[\s\S]*\}/);
  // Assistant-register prose is a retryable shape error; other prose is a definitive decline.
  if (!match) {
    if (CHAT_ARTIFACT.test(text)) throw new Error(`claude cli answered in chat register, not JSON: ${text.slice(0, 120)}`);
    return { __decline: text.slice(0, 300) };
  }
  const parsed = JSON.parse(match[0]);
  if (parsed && typeof parsed.decline_reason === 'string' && parsed.decline_reason.trim()) {
    return { __decline: parsed.decline_reason.trim().slice(0, 300) };
  }
  return parsed;
}

module.exports = { CLAUDE_BIN, buildClaudeArgs, callClaude, isCapacityError,
  extractJsonObject, extractJsonArray, parseDraft };
