#!/usr/bin/env node
'use strict';

const fs = require('fs');

async function main() {
  const args = process.argv.slice(2);
  if (args[args.indexOf('--tools') + 1] !== '' || !args.includes('--tools') ||
      !args.includes('--system-prompt') || args.some((arg) => /dangerously/.test(arg))) {
    process.stderr.write('bad args');
    process.exitCode = 3;
    return;
  }
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const mode = process.env.FAKE_CLAUDE_MODE;
  if (mode === 'error') {
    console.log(JSON.stringify({ is_error: true, subtype: 'error_during_execution' }));
    return;
  }
  if (mode === 'sleep') await new Promise((resolve) => setTimeout(resolve, 10000));
  if (mode === 'flaky') {
    const file = process.env.FAKE_CLAUDE_COUNTER;
    const calls = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0;
    fs.writeFileSync(file, String(calls + 1));
    if (calls === 0) {
      process.stderr.write('overloaded');
      process.exitCode = 1;
      return;
    }
  }
  console.log(JSON.stringify({ is_error: false, result: `ECHO:${input}`, total_cost_usd: 0.001,
    usage: { input_tokens: 5, output_tokens: 7 } }));
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
