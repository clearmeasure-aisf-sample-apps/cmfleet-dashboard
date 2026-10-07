// The deployed site, asked over HTTP: what the first environment must answer before a release goes further.
//   SITE_URL        the environment's address
//   EXPECT_VERSION  the release that was deployed
import { test } from 'node:test';
import assert from 'node:assert/strict';

const site = (process.env.SITE_URL || '').replace(/\/$/, '');
const version = process.env.EXPECT_VERSION || '';

async function get(path) {
  const response = await fetch(`${site}${path}`, { headers: { 'cache-control': 'no-cache' } });
  return { response, text: await response.text() };
}

test('the address and the release to expect are given', () => {
  assert.match(site, /^https:\/\//, 'SITE_URL');
  assert.ok(version, 'EXPECT_VERSION');
});

test('the page is served and loads its script and its styles', async () => {
  const { response, text } = await get('/');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(text, /<title>Fleet Health Dashboard<\/title>/);
  assert.match(text, /<script type="module" src="app\.js">/);
  assert.match(text, /href="styles\.css"/);
});

test('the script, the model and the styles are served as what they are', async () => {
  for (const [path, type] of [['/app.js', /javascript/], ['/model.js', /javascript/], ['/styles.css', /text\/css/], ['/favicon.svg', /image\/svg/]]) {
    const { response } = await get(path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), type, path);
  }
});

test('the build facts are of this release and any page may read them', async () => {
  const { response, text } = await get('/build.json');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  const facts = JSON.parse(text);
  assert.equal(facts.version, version);
  assert.match(facts.commit, /^[0-9a-f]{40}$/);
  assert.ok(facts.code.linesOfCode > 0);
  assert.ok(facts.tests.unit > 0);
  assert.equal(facts.analysis.problems, 0);
});

test('the health address answers ok', async () => {
  const { response, text } = await get('/health.json');
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(text).status, 'ok');
});

test('the fleet data the page is configured to read is there, readable from another origin', async () => {
  const { text } = await get('/config.json');
  const { dataUrl } = JSON.parse(text);
  assert.match(dataUrl, /^https:\/\/.+\/$/);
  const data = await fetch(`${dataUrl}fleet.json`);
  assert.equal(data.status, 200);
  assert.equal(data.headers.get('access-control-allow-origin'), '*');
  const fleet = await data.json();
  assert.ok(fleet.systems.length > 0);
  const landscape = await fetch(`${dataUrl}${fleet.landscape}`);
  assert.equal(landscape.status, 200);
});
