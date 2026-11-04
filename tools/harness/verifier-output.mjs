import { redactText } from './evidence-protection.mjs';

// Every captured stream matters: tools such as expo-doctor put the explanation on stdout
// and only a failure count on stderr. Prefix untrusted lines so Actions cannot execute them.
export function verifierDiagnostics(check) {
  const lines = [];
  const singleLine = value => redactText(String(value).replace(/[\r\n]/g, ' '));
  const stream = (name, value) => {
    lines.push(`${name}:`, ...redactText(value || '(empty)').split(/\r?\n/).map(line => `  | ${line}`));
  };
  for (const process of check.processes ?? (check.process ? [check.process] : [])) {
    if (process.ok) continue;
    const command = process.command ?? [];
    lines.push(`Internal check: ${singleLine(check.id)} / ${singleLine(process.phase ?? 'verify')} / ${singleLine(command.join(' ') || '(command unavailable)')}`);
    lines.push(`Command: ${singleLine(JSON.stringify(command))}`, `Exit code: ${process.code ?? 'null'}`);
    if (process.signal) lines.push(`Signal: ${singleLine(process.signal)}`);
    if (process.timedOut) lines.push('Timed out: true');
    if (process.error) stream('Process error', process.error);
    stream('stderr', process.stderr);
    stream('stdout', process.stdout);
  }
  return lines;
}
