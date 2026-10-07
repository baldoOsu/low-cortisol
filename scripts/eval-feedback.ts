// Usage: npm run eval:feedback -- <low-cortisol-feedback-YYYYMMDD.jsonl>
// Prints a threshold sweep against the owner's labels and the best threshold meeting the Q29 targets.

import { readFileSync } from 'node:fs';
import { TARGET_FPR, TARGET_RECALL, bestThreshold, formatTable, latestLabels, parseJsonl, sweep } from './eval-lib';

const pct = (n: number) => `${Math.round(n * 100)}%`;

function main(argv: string[]): number {
  const file = argv[2];
  if (!file) {
    console.error('Usage: npm run eval:feedback -- <feedback.jsonl>');
    return 1;
  }
  const labels = latestLabels(parseJsonl(readFileSync(file, 'utf8')));
  if (labels.length === 0) {
    console.error(`No feedback labels found in ${file}`);
    return 1;
  }
  const hide = labels.filter((e) => e.label === 'hide').length;
  console.log(`${labels.length} labelled posts (${hide} hide, ${labels.length - hide} keep)\n`);
  const rows = sweep(labels);
  console.log(formatTable(rows));
  console.log('');
  const best = bestThreshold(rows);
  const target = `recall >= ${pct(TARGET_RECALL)} and FPR <= ${pct(TARGET_FPR)}`;
  console.log(
    best
      ? `Best threshold: ${best.threshold.toFixed(2)} (recall ${pct(best.recall)}, FPR ${pct(best.fpr)}; target ${target})`
      : `No threshold meets ${target}.`,
  );
  return 0;
}

process.exitCode = main(process.argv);
