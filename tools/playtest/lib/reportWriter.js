// tools/playtest/lib/reportWriter.js
//
// Builds `playtest-report/report.json` and `playtest-report/report.md` from
// the two sessions' collected events/snapshots/errors. report.md's structure
// is PRE-FILLED (headings, evidence, guidance) but the subjective judgement
// cells are left as explicit placeholders for the reviewing agent/human — this
// tool observes __test state, not human perception of fun or clarity, and
// NEVER invents a rating scale anywhere.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { snapshotDigest, canonicalJSON } from '../../lib/snapshot.js';

function statesVisited(events, startState) {
  const seq = [startState];
  for (const e of events) {
    if (e.type === 'screenshot' && e.reason === 'transition') seq.push(e.to);
  }
  return seq;
}

function fmtSnapshot(snap) {
  return JSON.stringify(snap, null, 2);
}

export async function writeReports({ reportDir, game, gameDir, scripted, exploratory, exitPolicyText }) {
  const scriptedStates = statesVisited(scripted.events, scripted.startState);
  const exploratoryStates = statesVisited(exploratory.events, exploratory.startState);
  const scriptedDigest = snapshotDigest(scripted.finalSnapshot);
  const exploratoryDigest = snapshotDigest(exploratory.finalSnapshot);

  const expectations = scripted.events.filter((e) => e.type === 'expectState');
  const expectationsPassed = expectations.filter((e) => e.ok).length;

  const screenshots = [
    ...scripted.events.filter((e) => e.type === 'screenshot').map((e) => ({ ...e, segment: 'scripted' })),
    ...exploratory.events.filter((e) => e.type === 'screenshot').map((e) => ({ ...e, segment: 'exploratory' }))
  ];

  const bothClean = scripted.finalErrors.length === 0 && exploratory.finalErrors.length === 0;

  const report = {
    game,
    generatedAt: new Date().toISOString(),
    exitCodePolicy: exitPolicyText,
    scripted: {
      mode: 'ticked (autoClock=false, deterministic)',
      probeName: scripted.probeName,
      probeDescription: scripted.probeDescription,
      seed: scripted.seed,
      statesVisited: scriptedStates,
      expectStateChecks: expectations.map(({ type, ...rest }) => rest),
      finalSnapshot: scripted.finalSnapshot,
      finalSnapshotDigest: scriptedDigest,
      errors: scripted.finalErrors
    },
    exploratory: {
      mode: 'real-time (autoClock=true, seeded action mashing)',
      seed: exploratory.seed,
      requestedDurationMs: exploratory.requestedDurationMs,
      actualDurationMs: exploratory.actualDurationMs,
      actionsAvailable: exploratory.actionsAvailable,
      statesVisited: exploratoryStates,
      fps: exploratory.fps,
      finalSnapshot: exploratory.finalSnapshot,
      finalSnapshotDigest: exploratoryDigest,
      errors: exploratory.finalErrors
    },
    screenshots: screenshots.map(({ type, ...rest }) => rest)
  };

  await writeFile(join(reportDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');

  const md = `# Playtest report — ${game}

Generated ${report.generatedAt} by \`tools/playtest\`. Game directory: \`${gameDir}\`.

**Fun is judged by the human who merges this game, not by this report.** This
report carries evidence — screenshots, numbers, and confusion/clarity findings
— and never a fun score or any rating scale.

## What was played

- **Scripted probe** — "${scripted.probeName}": ${scripted.probeDescription}
  (seed \`${scripted.seed}\`, TICKED/deterministic — \`autoClock\` stayed off).
  States visited, in order: ${scriptedStates.map((s) => `\`${s}\``).join(' → ')}.
  \`expectState\` checks: ${expectationsPassed}/${expectations.length} matched
  (mismatches are advisory per the probe grammar — a probe may legitimately
  branch — see the \`expectStateChecks\` array in report.json for detail).
- **Exploratory session** — bounded, SEEDED random-ish action mashing over
  the game's own \`__test.actions()\` list (seed \`${exploratory.seed}\`,
  REAL-TIME — \`autoClock(true)\` — for ${exploratory.actualDurationMs}ms of the
  ${exploratory.requestedDurationMs}ms requested budget, specifically so FPS
  could be sampled from rAF timestamps).
  States visited, in order: ${exploratoryStates.map((s) => `\`${s}\``).join(' → ')}.

## What worked

_(reviewer: fill in from the screenshots and snapshots below — e.g. did the
scripted probe score real returns, did tracking/response feel immediate in the
screenshots, did the exploratory session survive mashing without breaking.)_

## Confusion / clarity findings

| Severity (blocker/major/minor) | Where | Finding |
|---|---|---|
| _(reviewer: fill in)_ | _(screenshot file or state)_ | _(reviewer: fill in)_ |

This harness observes \`__test\` state, not human perception — it cannot judge
clarity or confusion by itself. A clean technical run (below) is evidence of
correctness, not of clarity; a reviewer should still play the live preview.

## Non-findings (explicit)

| Question | Answer |
|---|---|
| \`__test.errors\` empty across both sessions? | ${bothClean ? 'yes' : 'no — see Errors below'} |
| Scripted probe's \`expectState\` checks all matched? | ${expectationsPassed === expectations.length ? 'yes' : `no (${expectationsPassed}/${expectations.length})`} |
| Controls discoverable without instructions? | _(reviewer: fill in — the harness can list \`__test.actions()\` but cannot judge discoverability)_ |
| Game playable to a real conclusion (reached GAME_OVER or a stable end state)? | ${[...scriptedStates, ...exploratoryStates].includes('GAME_OVER') ? 'yes, at least once' : 'not observed in either session'} |

## Evidence

### FPS (exploratory / real-time segment only)

The scripted segment is TICKED (\`autoClock\` off) — its rAF cadence is an
artifact of the test driver, not the game, so it is intentionally NOT sampled.
FPS below is from the exploratory session's real-time rAF timestamps only:

- sample count: ${exploratory.fps.sampleCount}
- avg fps: ${exploratory.fps.avgFps ?? 'n/a'}
- min fps: ${exploratory.fps.minFps ?? 'n/a'}
- max fps: ${exploratory.fps.maxFps ?? 'n/a'}

### Screenshots

${screenshots.length === 0 ? '_(none captured)_' : screenshots.map((s) => `- \`${s.file}\` — ${s.segment}, ${s.reason}${s.state ? ` (state ${s.state})` : ''}${s.from ? ` (${s.from} → ${s.to})` : ''}`).join('\n')}

### Final snapshots

<details><summary>scripted (digest \`${scriptedDigest}\`)</summary>

\`\`\`json
${fmtSnapshot(scripted.finalSnapshot)}
\`\`\`
</details>

<details><summary>exploratory (digest \`${exploratoryDigest}\`)</summary>

\`\`\`json
${fmtSnapshot(exploratory.finalSnapshot)}
\`\`\`
</details>

### Errors

- scripted: ${scripted.finalErrors.length === 0 ? 'none' : JSON.stringify(scripted.finalErrors)}
- exploratory: ${exploratory.finalErrors.length === 0 ? 'none' : JSON.stringify(exploratory.finalErrors)}

## Exit-code policy for \`npm run playtest\`

${exitPolicyText}
`;

  await writeFile(join(reportDir, 'report.md'), md);
  return { report };
}
