// Writes the build's facts, the file the deployed site serves at /build.json: what it was built from and how good
// that build is. Read by the fleet (code metrics, a rule no system is exempt from) and by anyone who asks the site.
//   node tools/metrics.js <out file>   with VERSION, COMMIT, REPOSITORY_URL and BUILD_URL in the environment
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { ESLint } from 'eslint';

const LANGUAGES = { '.js': 'JavaScript', '.css': 'CSS', '.html': 'HTML' };

async function files(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await files(path));
    else found.push(path);
  }
  return found;
}

// Lines that hold something: not blank.
async function code() {
  const languages = new Map();
  for (const file of await files('src')) {
    const name = LANGUAGES[extname(file)];
    if (!name) continue;
    const lines = (await readFile(file, 'utf8')).split('\n').filter((line) => line.trim()).length;
    const language = languages.get(name) || { name, lines: 0, files: 0 };
    language.lines += lines;
    language.files += 1;
    languages.set(name, language);
  }
  const list = [...languages.values()].sort((a, b) => b.lines - a.lines);
  return { linesOfCode: list.reduce((sum, one) => sum + one.lines, 0), files: list.reduce((sum, one) => sum + one.files, 0), languages: list };
}

// The tests of one level, as declared: the build fails when one fails, so a build that got here passed them all.
async function tests(directory) {
  let declared = 0;
  for (const file of await files(directory)) declared += ((await readFile(file, 'utf8')).match(/^test\(/gm) || []).length;
  return declared;
}

// The unit tests' coverage as the test runner wrote it (lcov): lines and branches found and hit.
async function coverage() {
  const text = await readFile('out/lcov.info', 'utf8');
  const sum = (key) => [...text.matchAll(new RegExp(`^${key}:(\\d+)$`, 'gm'))].reduce((total, match) => total + Number(match[1]), 0);
  const percent = (hit, found) => (found ? Math.round((1000 * hit) / found) / 10 : 0);
  return {
    linePercent: percent(sum('LH'), sum('LF')),
    branchPercent: percent(sum('BRH'), sum('BRF')),
    scope: 'src/model.js by the unit tests; src/app.js runs in the browser tests and is not measured',
  };
}

// Cyclomatic complexity of every function of the site: the analyzer's own count, asked for with a limit of zero.
async function complexity() {
  const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: [{ rules: { complexity: ['warn', 0] } }] });
  const values = (await eslint.lintFiles(['src/**/*.js'])).flatMap((result) => result.messages)
    .map((message) => Number(/complexity of (\d+)/.exec(message.message)?.[1])).filter(Number.isFinite);
  const average = values.length ? Math.round((10 * values.reduce((sum, one) => sum + one, 0)) / values.length) / 10 : 0;
  return { average, max: Math.max(0, ...values), methods: values.length };
}

// What the analyzer finds with the repository's own rules. The build fails on any, so a build that got here has none.
async function analysis() {
  const results = await new ESLint().lintFiles(['.']);
  return { tool: `eslint ${ESLint.version}`, problems: results.reduce((sum, result) => sum + result.errorCount + result.warningCount, 0) };
}

const repository = (process.env.REPOSITORY_URL || '').replace(/\/$/, '');
const commit = process.env.COMMIT || '';
const facts = {
  version: process.env.VERSION || '0.0.0-local',
  commit,
  commitUrl: repository && commit ? `${repository}/commit/${commit}` : '',
  builtAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  buildUrl: process.env.BUILD_URL || '',
  code: await code(),
  tests: {
    unit: await tests('test/unit'),
    integration: await tests('test/integration'),
    acceptance: await tests('test/acceptance'),
  },
  coverage: await coverage(),
  complexity: await complexity(),
  analysis: await analysis(),
};
await writeFile(process.argv[2], `${JSON.stringify(facts, null, 2)}\n`);
console.log(`${process.argv[2]}: ${facts.version}, ${facts.code.linesOfCode} lines, ${facts.tests.unit} unit and ${facts.tests.integration} integration tests, ${facts.coverage.linePercent}% of lines, complexity at most ${facts.complexity.max}, ${facts.analysis.problems} analyzer problems`);
