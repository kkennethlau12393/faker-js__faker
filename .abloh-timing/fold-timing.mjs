/**
 * THE BASELINE IS THE MAP, TIMED ON A GITHUB-HOSTED RUNNER: the stages a pull-request check pays
 * before its first mutant verdict, on the road the fold replaced and on the folded one, three
 * repetitions each, one arm per job.
 *
 * Why it runs here and not on a laptop: the laptop that built the fold runs several other agents'
 * suites at once and its wall numbers move by 4x inside one window (`aster-map-timing` on this fork
 * is the earlier measurement, same reasoning). Two jobs of one workflow are two dedicated machines
 * of the same shape, and each arm is normalised by its own plain suite run.
 *
 * What one repetition is, per arm:
 *
 *   separate  the three-run road the fold replaced. A plain run of the suite with the baseline's
 *             reporter flags (the baseline), `runDiffCoverage` under the repository's own
 *             `@vitest/coverage-v8` restricted to the changed files (the coverage stage), and the
 *             one-run map through `buildLineMap` (the mapping run). Three executions of the suite.
 *   folded    the road since 2026-09-04. One run of the suite carrying the map's instrument, exactly
 *             as `apps/cli/src/baseline-map.ts` hosts it on the baseline (`openHostedLineMap`,
 *             `finish`), then the changed lines classified off that map (`mapDiffCoverage`). One
 *             execution of the suite plus the read.
 *
 * Both arms classify the same changed lines, and the classified lines are written out so the two
 * roads' answers can be compared line by line after the run.
 *
 *   node fold-timing.mjs <folded|separate> <reps> <abs path to the runtime's node_modules>
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";

const [arm, repsRaw, runtime] = process.argv.slice(2);
if (arm !== "folded" && arm !== "separate") throw new Error(`arm must be folded or separate, got ${arm}`);
const reps = Number(repsRaw ?? "3");
const aster = await import(join(runtime, "@abloh/engine-aster/dist/index.js"));
const measure = await import(join(runtime, "@abloh/measure/dist/index.js"));
const core = await import(join(runtime, "@abloh/core/dist/index.js"));

const repoDir = process.cwd();
const plan = { repoDir, runner: "vitest", testCommand: ["./node_modules/.bin/vitest", "run"], executionSubdir: null, env: {} };
const tmpRoot = process.env.RUNNER_TEMP ?? tmpdir();
const outDir = join(repoDir, ".abloh-timing", "out");
mkdirSync(outDir, { recursive: true });

/** THE CHANGED LINES, a pull-request-sized scope over three files every faker test loads through the barrel. */
const SCOPE = [
  { file: "src/internal/mersenne.ts", ranges: [[1, 60]], lines: 60 },
  { file: "src/modules/number/index.ts", ranges: [[1, 80]], lines: 80 },
  { file: "src/modules/string/index.ts", ranges: [[1, 80]], lines: 80 },
];
const scopedFiles = new Set(SCOPE.map((entry) => entry.file));
const changedLines = new Map(SCOPE.map((entry) => [entry.file, new Set(Array.from({ length: entry.lines }, (_, index) => index + 1))]));

const sha = (args) => spawnSync("git", args, { cwd: repoDir, encoding: "utf8" }).stdout.trim();
const context = {
  arm,
  reps,
  fakerCommit: sha(["rev-parse", "HEAD"]),
  node: process.version,
  cpus: cpus().length,
  runnerOs: process.env.RUNNER_OS ?? null,
  ablohBranch: process.env.ABLOH_BRANCH ?? null,
  ablohSha: process.env.ABLOH_SHA ?? null,
};

/** The suite as the baseline runs it: the repository's own command plus the reporter flags. */
function baselineArgs(scratch) {
  return ["--reporter=json", "--includeTaskLocation", `--outputFile=${join(scratch, "baseline-report.json")}`];
}

function runSuite(extraArgs, extraEnv) {
  const started = Date.now();
  const run = spawnSync(plan.testCommand[0], [...plan.testCommand.slice(1), ...extraArgs], {
    cwd: repoDir,
    env: { ...process.env, ...extraEnv, CI: "1" },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return { wallMs: Date.now() - started, exitCode: run.status ?? -1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

function lineStates(classified) {
  return classified.lines.map((line) => `${line.file}:${line.line}:${line.state}`);
}

/* THE POPULATION the map is keyed on, taken once from a one-run probe, as the earlier measurement did. */
console.log(`probe: one run of the suite under the hook, to take the population the runner ran (${JSON.stringify(context)})`);
const probeScratch = mkdtempSync(join(tmpRoot, "aster-fold-probe-"));
const probe = await aster.buildLineMap({ plan, testFiles: [], scratchDir: probeScratch, perFileTimeoutMs: 1_800_000, suiteTimeoutMs: 1_800_000, onNote: (line) => console.log(`  [probe] ${line}`) });
rmSync(probeScratch, { recursive: true, force: true });
const population = [...probe.map.greenTestFiles, ...probe.map.redTestFiles].sort();
console.log(`population: ${population.length} test file(s), ${probe.map.greenTestFiles.length} green / ${probe.map.redTestFiles.length} red, probe backend ${probe.backend}${probe.oneRunFallback ? `, FELL BACK: ${probe.oneRunFallback}` : ""}, probe wall ${probe.wallMs} ms`);
if (probe.oneRunFallback) throw new Error(`the one-run hook refused on this runner: ${probe.oneRunFallback}`);

const rows = [];
let lastLines = null;
for (let rep = 1; rep <= reps; rep += 1) {
  const scratch = mkdtempSync(join(tmpRoot, `aster-fold-${arm}-`));
  try {
    if (arm === "separate") {
      const baseline = runSuite(baselineArgs(scratch), {});
      console.log(`rep ${rep}: baseline (plain suite with the reporter flags) ${baseline.wallMs} ms (exit ${baseline.exitCode})`);
      let coverageMs = null;
      let coverageNote = null;
      let classified = null;
      try {
        const collected = await measure.runDiffCoverage({
          runner: "vitest",
          pm: "pnpm",
          repoDir,
          workDir: repoDir,
          scope: SCOPE,
          subdir: null,
          testCommand: "npx --no-install vitest run",
          packageManagerMajor: 11,
          timeoutMs: 1_800_000,
        });
        coverageMs = collected.wallMs;
        classified = core.classifyDiffCoverage(SCOPE, collected.coverage);
        console.log(`rep ${rep}: coverage run ${coverageMs} ms (${collected.provider.provider} ${collected.provider.providerVersion}), ${JSON.stringify(classified.counts)}`);
      } catch (error) {
        coverageNote = String(error && error.message ? error.message : error);
        console.log(`rep ${rep}: coverage run FAILED: ${coverageNote}`);
      }
      const mapStarted = Date.now();
      const built = await aster.buildLineMap({ plan, testFiles: population, scratchDir: join(scratch, "map"), perFileTimeoutMs: 1_800_000, suiteTimeoutMs: 1_800_000, onNote: (line) => console.log(`  [map rep ${rep}] ${line}`) });
      const mapMs = Date.now() - mapStarted;
      console.log(`rep ${rep}: mapping run ${mapMs} ms, ${built.map.sourceFiles.length} source files, census ${built.census?.complete ?? "n/a"}${built.oneRunFallback ? `, FELL BACK: ${built.oneRunFallback}` : ""}`);
      const row = {
        rep,
        baselineMs: baseline.wallMs,
        baselineExit: baseline.exitCode,
        coverageMs,
        coverageNote,
        mapMs,
        readMs: null,
        classifyMs: null,
        totalMs: baseline.wallMs + (coverageMs ?? 0) + mapMs,
        suiteRuns: coverageMs === null ? 2 : 3,
        sourceFiles: built.map.sourceFiles.length,
        green: built.map.greenTestFiles.length,
        red: built.map.redTestFiles.length,
        censusComplete: built.census?.complete ?? null,
        counts: classified?.counts ?? null,
      };
      rows.push(row);
      if (classified !== null) lastLines = lineStates(classified);
    } else {
      const opened = aster.openHostedLineMap({
        plan,
        testFiles: population,
        scratchDir: join(scratch, "map"),
        coverageScope: (file) => scopedFiles.has(file),
        host: "baseline",
        onNote: (line) => console.log(`  [baseline map rep ${rep}] ${line}`),
      });
      if (opened.kind !== "opened") throw new Error(`the baseline could not host the map: ${opened.reason}`);
      const baseline = runSuite([...baselineArgs(scratch), ...opened.map.instrument.args], aster.hostedEnvironment(plan.env, opened.map.instrument));
      opened.map.dispose();
      console.log(`rep ${rep}: baseline carrying the map's instrument ${baseline.wallMs} ms (exit ${baseline.exitCode})`);
      const readStarted = Date.now();
      const built = opened.finish({ exitCode: baseline.exitCode, timedOut: false, stdout: baseline.stdout, stderr: baseline.stderr, wallMs: baseline.wallMs });
      const readMs = Date.now() - readStarted;
      if ("kind" in built) throw new Error(`the hosted map could not be read: ${built.reason}`);
      const classifyStarted = Date.now();
      const answer = aster.mapDiffCoverage({ map: built.map, census: built.census, changedLines });
      const classified = answer === null ? null : core.classifyDiffCoverage(SCOPE, answer.coverage);
      const classifyMs = Date.now() - classifyStarted;
      console.log(`rep ${rep}: read ${readMs} ms, classify ${classifyMs} ms, ${built.map.sourceFiles.length} source files, census ${built.census?.complete ?? "n/a"}, ${classified === null ? "INCOMPLETE CENSUS, no coverage answer" : JSON.stringify(classified.counts)}`);
      const row = {
        rep,
        baselineMs: baseline.wallMs,
        baselineExit: baseline.exitCode,
        coverageMs: null,
        coverageNote: classified === null ? `incomplete census: ${JSON.stringify(built.census)}` : null,
        mapMs: null,
        readMs,
        classifyMs,
        totalMs: baseline.wallMs + readMs + classifyMs,
        suiteRuns: 1,
        sourceFiles: built.map.sourceFiles.length,
        green: built.map.greenTestFiles.length,
        red: built.map.redTestFiles.length,
        censusComplete: built.census?.complete ?? null,
        counts: classified?.counts ?? null,
      };
      rows.push(row);
      if (classified !== null) lastLines = lineStates(classified);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  /* A plain run beside every repetition, so each arm is normalised by its own machine. */
  const plain = runSuite([], {});
  rows[rows.length - 1].plainSuiteMs = plain.wallMs;
  rows[rows.length - 1].plainExit = plain.exitCode;
  console.log(`rep ${rep}: plain suite ${plain.wallMs} ms (exit ${plain.exitCode})`);
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const seconds = (ms) => (ms === null ? "n/a" : `${(ms / 1000).toFixed(1)} s`);
const plainMedian = median(rows.map((row) => row.plainSuiteMs));
const totalMedian = median(rows.map((row) => row.totalMs));
const summary = [
  `## The baseline is the map, timed: ${arm} on a hosted runner`,
  "",
  `faker \`${context.fakerCommit}\`, abloh \`${context.ablohBranch ?? "?"}\` at \`${context.ablohSha ?? "?"}\`, ${context.node}, ${context.cpus} cpus, ${context.runnerOs}`,
  "",
  `population ${population.length} test files (${probe.map.greenTestFiles.length} green / ${probe.map.redTestFiles.length} red), scope ${SCOPE.length} changed files, ${[...changedLines.values()].reduce((sum, lines) => sum + lines.size, 0)} changed lines`,
  "",
  "| rep | plain suite | baseline | coverage | map | read | classify | stages total | suite runs | census | counts |",
  "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|",
  ...rows.map((row) => `| ${row.rep} | ${seconds(row.plainSuiteMs)} | ${seconds(row.baselineMs)} | ${seconds(row.coverageMs)}${row.coverageNote ? " (FAILED)" : ""} | ${seconds(row.mapMs)} | ${seconds(row.readMs)} | ${seconds(row.classifyMs)} | **${seconds(row.totalMs)}** | ${row.suiteRuns} | ${row.censusComplete} | ${row.counts ? JSON.stringify(row.counts) : "n/a"} |`),
  "",
  `**median plain suite ${seconds(plainMedian)}**, **median stages total ${seconds(totalMedian)}**, ratio total / suite ${(totalMedian / plainMedian).toFixed(2)}x`,
  "",
].join("\n");
console.log(`\n${summary}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
writeFileSync(join(outDir, `${arm}.json`), JSON.stringify({ context, population, scope: SCOPE, rows }, null, 2));
if (lastLines !== null) writeFileSync(join(outDir, `${arm}-lines.json`), JSON.stringify(lastLines, null, 2));
