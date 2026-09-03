/**
 * ASTER'S TWO MAP BACKENDS ON A GITHUB-HOSTED RUNNER, one arm per job, three repetitions each.
 *
 * Why it runs here and not on a laptop: the laptop that built the backend runs several other agents'
 * suites at once, so its wall numbers moved by 4x inside one window. A hosted runner is a dedicated
 * machine, and two jobs of one workflow are two such machines with the same shape.
 *
 * What one repetition is: the repository's own suite, plain, then the map under the arm this job was
 * given. The population is what the runner itself ran, taken once from a one-run probe, so both arms
 * map the same test files. `mapBackend: "per-file"` forces the old backend through the same entry
 * point the product uses.
 *
 *   node map-timing.mjs <one-run|per-file> <reps> <abs path to @abloh/engine-aster/dist/index.js>
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const [arm, repsRaw, enginePath] = process.argv.slice(2);
if (arm !== "one-run" && arm !== "per-file") throw new Error(`arm must be one-run or per-file, got ${arm}`);
const reps = Number(repsRaw ?? "3");
const engine = await import(enginePath);

const repoDir = process.cwd();
const plan = { repoDir, runner: "vitest", testCommand: ["./node_modules/.bin/vitest", "run"], executionSubdir: null };
const tmpRoot = process.env.RUNNER_TEMP ?? tmpdir();
const outDir = join(repoDir, ".abloh-timing", "out");
mkdirSync(outDir, { recursive: true });

const sha = (args) => spawnSync("git", args, { cwd: repoDir, encoding: "utf8" }).stdout.trim();
const context = {
  arm,
  reps,
  fakerCommit: sha(["rev-parse", "HEAD"]),
  node: process.version,
  cpus: cpus().length,
  runnerOs: process.env.RUNNER_OS ?? null,
  ablohScratchRef: process.env.ABLOH_SCRATCH_REF ?? null,
  ablohScratchSha: process.env.ABLOH_SCRATCH_SHA ?? null,
};

async function buildMap(mapBackend, testFiles, label) {
  const scratch = mkdtempSync(join(tmpRoot, "aster-timing-"));
  try {
    return await engine.buildLineMap({
      plan,
      testFiles,
      scratchDir: scratch,
      perFileTimeoutMs: 1_800_000,
      suiteTimeoutMs: 1_800_000,
      mapBackend,
      onNote: (line) => console.log(`  [${label}] ${line}`),
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function plainSuite() {
  const started = Date.now();
  const run = spawnSync(plan.testCommand[0], plan.testCommand.slice(1), {
    cwd: repoDir,
    env: { ...process.env, CI: "1" },
    stdio: "ignore",
  });
  return { wallMs: Date.now() - started, exitCode: run.status };
}

function coveredLineCount(map) {
  let total = 0;
  for (const file of map.sourceFiles) total += map.coveredLines(file).size;
  return total;
}

/** file -> line -> sorted covering test files, for the covering-set comparison across the two jobs. */
function coveringSets(map) {
  const out = {};
  for (const file of map.sourceFiles) {
    const lines = {};
    for (const line of [...map.coveredLines(file)].sort((a, b) => a - b)) {
      lines[line] = [...(map.coveringFiles(file, line, line) ?? [])].sort();
    }
    out[file] = lines;
  }
  return out;
}

console.log(`probe: one run of the suite under the hook, to take the population the runner ran (${JSON.stringify(context)})`);
const probe = await buildMap("auto", [], "probe");
const population = [...probe.map.greenTestFiles, ...probe.map.redTestFiles].sort();
console.log(
  `population: ${population.length} test file(s), ${probe.map.greenTestFiles.length} green / ${probe.map.redTestFiles.length} red, ` +
    `probe backend ${probe.backend}${probe.oneRunFallback ? `, FELL BACK: ${probe.oneRunFallback}` : ""}, probe wall ${probe.wallMs} ms`,
);
if (probe.oneRunFallback) throw new Error(`the one-run hook refused on this runner: ${probe.oneRunFallback}`);

const rows = [];
let lastMap = null;
for (let rep = 1; rep <= reps; rep += 1) {
  const plain = plainSuite();
  console.log(`rep ${rep}: plain suite ${plain.wallMs} ms (exit ${plain.exitCode})`);
  const started = Date.now();
  const result = await buildMap(arm === "one-run" ? "auto" : "per-file", population, `${arm} rep ${rep}`);
  const mapWallMs = Date.now() - started;
  const row = {
    rep,
    plainSuiteMs: plain.wallMs,
    plainExit: plain.exitCode,
    mapWallMs,
    backendWallMs: result.wallMs,
    backend: result.backend,
    fellBack: result.oneRunFallback ?? null,
    sourceFiles: result.map.sourceFiles.length,
    coveredLines: coveredLineCount(result.map),
    green: result.map.greenTestFiles.length,
    red: result.map.redTestFiles.length,
    censusComplete: result.census?.complete ?? null,
    censusMissing: result.census?.missing?.length ?? null,
    censusUnattributable: result.census?.unattributable?.length ?? null,
  };
  console.log(`rep ${rep}: ${arm} map ${mapWallMs} ms, ${row.sourceFiles} source files, ${row.coveredLines} covered lines, ${row.green} green / ${row.red} red, census ${row.censusComplete}`);
  rows.push(row);
  lastMap = result.map;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const spread = (values) => `${Math.min(...values)}..${Math.max(...values)}`;
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const summary = [
  `## Aster map timing: ${arm} on a hosted runner`,
  "",
  `faker \`${context.fakerCommit}\`, abloh scratch \`${context.ablohScratchRef ?? "?"}\` at \`${context.ablohScratchSha ?? "?"}\`, ${context.node}, ${context.cpus} cpus, ${context.runnerOs}`,
  "",
  `population ${population.length} test files (${probe.map.greenTestFiles.length} green / ${probe.map.redTestFiles.length} red), taken from what the runner ran`,
  "",
  "| rep | plain suite | map wall | source files | covered lines | green / red | census |",
  "|---:|---:|---:|---:|---:|---|---|",
  ...rows.map((row) => `| ${row.rep} | ${seconds(row.plainSuiteMs)} (exit ${row.plainExit}) | ${seconds(row.mapWallMs)} | ${row.sourceFiles} | ${row.coveredLines} | ${row.green} / ${row.red} | ${row.censusComplete === null ? "n/a" : row.censusComplete} |`),
  "",
  `**median plain suite ${seconds(median(rows.map((r) => r.plainSuiteMs)))}** (spread ${spread(rows.map((r) => r.plainSuiteMs))} ms), ` +
    `**median ${arm} map ${seconds(median(rows.map((r) => r.mapWallMs)))}** (spread ${spread(rows.map((r) => r.mapWallMs))} ms), ` +
    `ratio map / suite ${(median(rows.map((r) => r.mapWallMs)) / median(rows.map((r) => r.plainSuiteMs))).toFixed(2)}x`,
  "",
].join("\n");
console.log(`\n${summary}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
writeFileSync(join(outDir, `${arm}.json`), JSON.stringify({ context, population, rows }, null, 2));
writeFileSync(join(outDir, `${arm}-covering-sets.json.gz`), gzipSync(JSON.stringify(coveringSets(lastMap))));
