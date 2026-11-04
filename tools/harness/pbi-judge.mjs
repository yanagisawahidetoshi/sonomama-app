// Deterministic PBI Completion Judge. Inputs come from trusted adapters, never from agent self-reports:
// - sbis: [{ id, kind, dependsOn }] of one PBI. A validation SBI exists only when the PBI needs Integration / E2E.
// - results[sbiId]: implementation → { merged, requiredVerifiers: 'PASS' | ..., e2e: null | { status, api } };
//   validation → { e2e: { status, api }, evidenceDigest }. Missing means not run yet.
// - evidenceDigest: without a validation SBI, the adapter's digest of the merged implementation evidence (e.g. merge commit SHAs).
// - pbiState / pbiStateReason: the GitHub Issue must be closed as completed after manual acceptance. No local approval command is required.
// - blockers: [{ url, state }] the Issues the PBI is blocked by, of any label; anything but closed blocks it.
const e2eApis = Object.freeze({ implementation: 'mock', validation: 'real' });
export const e2eApi = kind => e2eApis[kind];

function implementationStatus(id, result, reasons) {
  if (!result) { reasons.push(`実装SBI ${id} の結果がありません`); return 'PENDING'; }
  if (result.e2e && result.e2e.api !== 'mock') { reasons.push(`実装SBI ${id} のE2Eがモック以外（${result.e2e.api}）に接続しています`); return 'FAILED'; }
  if (result.e2e && result.e2e.status !== 'PASS') { reasons.push(`実装SBI ${id} のE2E（モックAPI）が${result.e2e.status}です`); return 'FAILED'; }
  if (result.requiredVerifiers !== 'PASS') { reasons.push(`実装SBI ${id} の必須Verifierが${result.requiredVerifiers ?? '未実行'}です`); return 'FAILED'; }
  if (result.merged !== true) { reasons.push(`実装SBI ${id} のPRがmainへmergeされていません`); return 'PENDING'; }
  return 'DONE';
}
function validationStatus(id, result, reasons) {
  if (!result?.e2e) { reasons.push(`最終確認SBI ${id} のE2E結果がありません`); return 'PENDING'; }
  if (result.e2e.api !== 'real') { reasons.push(`最終確認SBI ${id} のE2Eが実API以外（${result.e2e.api}）に接続しています`); return 'FAILED'; }
  if (result.e2e.status !== 'PASS') { reasons.push(`最終確認SBI ${id} のE2E（実API + Rails + DB）が${result.e2e.status}です`); return 'FAILED'; }
  if (!/^[0-9a-f]{64}$/.test(result.evidenceDigest ?? '')) { reasons.push(`最終確認SBI ${id} のEvidence digestがありません`); return 'FAILED'; }
  return 'DONE';
}
function evaluate({ pbiState, pbiStateReason, sbis, results = {}, blockers = [] }) {
  const reasons = [], status = {};
  const of = kind => sbis.filter(s => s.kind === kind);
  for (const sbi of of('implementation')) status[sbi.id] = implementationStatus(sbi.id, results[sbi.id], reasons);
  const implementationsDone = of('implementation').length > 0 && of('implementation').every(s => status[s.id] === 'DONE');
  for (const sbi of of('validation')) status[sbi.id] = implementationsDone ? validationStatus(sbi.id, results[sbi.id], reasons) : 'PENDING';
  const validations = of('validation');
  if (validations.length > 1) reasons.push(`最終確認SBIが${validations.length}件です（1件まで）`);
  for (const sbi of sbis.filter(s => !(s.kind in e2eApis))) reasons.push(`SBI ${sbi.id} の種類 ${sbi.kind} は使えません`);
  // The human confirms the evidence of the whole PBI, so the gate opens only after every SBI is done.
  const ready = implementationsDone && validations.length <= 1 && validations.every(s => status[s.id] === 'DONE');
  const acceptance = ready && pbiState === 'closed' && pbiStateReason === 'completed' ? 'APPROVED' : 'PENDING';
  if (acceptance !== 'APPROVED') reasons.push('PBIの動作確認結果をGitHubに記録し、PBI Issueを完了として閉じてください');
  for (const blocker of blockers) if (blocker.state !== 'closed') reasons.push(`未解決のblocker ${blocker.url} がPBIをブロックしています`);
  return { status, acceptance, reasons };
}

// Validation waits for every implementation SBI of the PBI, not only the declared dependencies.
export function canStart(input, sbiId) {
  const sbi = input.sbis.find(s => s.id === sbiId);
  if (!sbi) return { allowed: false, reasons: [`SBI ${sbiId} はこのPBIにありません`] };
  const { status } = evaluate(input);
  const waiting = sbi.kind === 'validation' ? input.sbis.filter(s => s.kind === 'implementation' && status[s.id] !== 'DONE').map(s => s.id)
    : sbi.dependsOn.filter(id => status[id] !== 'DONE');
  return { allowed: waiting.length === 0, reasons: waiting.map(id => `${id} が完了していません`) };
}

export function judgePbi(input) {
  const { status, acceptance, reasons } = evaluate(input);
  const done = reasons.length === 0 && acceptance === 'APPROVED' && input.sbis.every(s => status[s.id] === 'DONE');
  return { status: done ? 'DONE' : 'NOT_DONE', sbis: status, acceptance, reasons };
}
