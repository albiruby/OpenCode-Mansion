#!/usr/bin/env node
/**
 * Vendor the CC0 art used by the OpenCode Mansion campus.
 *
 * Sources:
 *   - Poly Haven models, HDRIs and textures (CC0)
 *   - Quaternius animated characters, hosted as single GLBs by Cinevva (CC0)
 *
 * Poly Haven models are published as .gltf + external .bin/.jpg files. This
 * script downloads every file listed by the Poly Haven API and packs each model
 * into one self-contained .glb with @gltf-transform/cli.
 *
 * Usage:
 *   node scripts/fetch-assets.mjs            # download missing files
 *   node scripts/fetch-assets.mjs --force    # redownload everything
 */
import { execSync } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'public', 'assets');
const WORK = join(tmpdir(), 'opencode-mansion-assets');
const FORCE = process.argv.includes('--force');
const USER_AGENT = 'opencode-mansion-asset-fetcher/1.0';

const CHARACTERS = [
  {
    file: 'Casual_Female.glb',
    title: 'Casual Female',
    url: 'https://cdn.cinevva.com/assets/packs/quaternius/ultimate-animated-characters/Casual_Female.glb',
  },
  {
    file: 'Casual_Male.glb',
    title: 'Casual Male',
    url: 'https://cdn.cinevva.com/assets/packs/quaternius/ultimate-animated-characters/Casual_Male.glb',
  },
];

const HDRI = {
  file: 'kloofendal_48d_partly_cloudy_puresky_1k.hdr',
  title: 'Kloofendal 48d Partly Cloudy (Pure Sky)',
  url: 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/kloofendal_48d_partly_cloudy_puresky_1k.hdr',
  page: 'https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky',
};

/** Poly Haven model id -> local prop id used by src/lib/realistic.ts */
const PROPS = [
  { id: 'sofa', asset: 'Sofa_01', title: 'Sofa 01' },
  { id: 'coffee-table', asset: 'CoffeeTable_01', title: 'Coffee Table 01' },
  { id: 'armchair', asset: 'ArmChair_01', title: 'Arm Chair 01' },
  { id: 'shelf', asset: 'Shelf_01', title: 'Shelf 01' },
  { id: 'coffee-cart', asset: 'CoffeeCart_01', title: 'Coffee Cart 01' },
  { id: 'plant-calathea', asset: 'calathea_orbifolia_01', title: 'Calathea Orbifolia' },
  { id: 'plant-fern', asset: 'fern_02', title: 'Fern 02' },
  { id: 'street-lamp', asset: 'street_lamp_01', title: 'Street Lamp 01' },
  { id: 'cat-statue', asset: 'concrete_cat_statue', title: 'Concrete Cat Statue' },
];

/** Poly Haven texture id -> local texture id + Poly Haven map keys */
const TEXTURES = [
  {
    id: 'grass',
    asset: 'grass_ground',
    title: 'Grass Ground',
    maps: { diffuse: 'Diffuse', normal: 'nor_gl', roughness: 'Rough' },
  },
  {
    id: 'wood',
    asset: 'wood_floor',
    title: 'Wood Floor',
    maps: { diffuse: 'Diffuse', normal: 'nor_gl', roughness: 'Rough' },
  },
  {
    id: 'asphalt',
    asset: 'asphalt_02',
    title: 'Asphalt 02',
    maps: { diffuse: 'Diffuse', normal: 'nor_gl', roughness: 'Rough' },
  },
  {
    id: 'concrete',
    asset: 'concrete_floor_02',
    title: 'Concrete Floor 02',
    maps: { diffuse: 'Diffuse', normal: 'nor_gl', roughness: 'Rough' },
  },
];

const NPM = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const quote = (value) => `"${value.replace(/"/g, '\\"')}"`;

async function exists(path) {
  try {
    const info = await stat(path);
    return info.size > 0;
  } catch {
    return false;
  }
}

async function download(url, target, options = {}) {
  if (!options.force && (await exists(target))) {
    console.log(`  skip ${target}`);
    return false;
  }
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, buffer);
  console.log(`  ${(buffer.length / 1048576).toFixed(2)} MB  ${target}`);
  return true;
}

async function polyFiles(asset) {
  const response = await fetch(`https://api.polyhaven.com/files/${asset}`, {
    headers: { 'user-agent': USER_AGENT },
  });
  if (!response.ok) throw new Error(`Poly Haven files ${asset}: HTTP ${response.status}`);
  return response.json();
}

async function fetchCharacter(character) {
  const target = join(ASSETS, 'characters', character.file);
  if (!FORCE && (await exists(target))) {
    console.log(`[character] ${character.title} already present`);
    return;
  }
  console.log(`[character] ${character.title}`);
  await download(character.url, target);
}

async function fetchHdri() {
  const target = join(ASSETS, 'hdri', HDRI.file);
  if (!FORCE && (await exists(target))) {
    console.log(`[hdri] ${HDRI.title} already present`);
    return;
  }
  console.log(`[hdri] ${HDRI.title}`);
  await download(HDRI.url, target);
}

async function fetchTexture(texture) {
  const files = await polyFiles(texture.asset);
  for (const [slot, mapKey] of Object.entries(texture.maps)) {
    const entry = files?.[mapKey]?.['1k']?.jpg;
    if (!entry?.url) throw new Error(`${texture.asset}: missing ${mapKey} 1k JPG`);
    const target = join(ASSETS, 'textures', `${texture.id}-${slot}.jpg`);
    if (!FORCE && (await exists(target))) {
      console.log(`[texture] ${texture.id}-${slot} already present`);
      continue;
    }
    console.log(`[texture] ${texture.title} ${slot}`);
    await download(entry.url, target);
  }
}

async function fetchProp(prop) {
  const output = join(ASSETS, 'props', `${prop.id}.glb`);
  if (!FORCE && (await exists(output))) {
    console.log(`[prop] ${prop.title} already present`);
    return;
  }

  console.log(`[prop] ${prop.title}`);
  const files = await polyFiles(prop.asset);
  const entry = files?.gltf?.['1k']?.gltf ?? files?.gltf?.['2k']?.gltf;
  if (!entry?.url) throw new Error(`${prop.asset}: no GLTF files`);

  const work = join(WORK, 'props', prop.id);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  for (const [relative, meta] of Object.entries(entry.include ?? {})) {
    if (!meta?.url) continue;
    await download(meta.url, join(work, relative), { force: true });
  }

  const gltfName = basename(decodeURIComponent(new URL(entry.url).pathname));
  const gltfPath = join(work, gltfName);
  await download(entry.url, gltfPath, { force: true });

  await mkdir(dirname(output), { recursive: true });
  console.log(`  packing -> ${output}`);
  execSync(
    `${NPM} --yes @gltf-transform/cli copy ${quote(gltfPath)} ${quote(output)}`,
    { stdio: 'inherit', cwd: ROOT },
  );
}

async function writeAttribution() {
  const lines = [
    '# External CC0 assets',
    '',
    'Every external model, texture and HDRI below is released under **CC0 1.0 Universal**.',
    'CC0 does not require attribution, but this file records the original sources so the',
    'provenance of the campus art stays clear.',
    '',
    'Generated by `scripts/fetch-assets.mjs`. Re-run it to refresh the files.',
    '',
    '## Characters',
    '',
    '| Local file | Asset | Author | License | Source |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const character of CHARACTERS) {
    lines.push(
      `| \`characters/${character.file}\` | ${character.title} | Quaternius | CC0 1.0 | [Quaternius Ultimate Animated Characters](https://quaternius.com/packs/ultimateanimatedcharacters.html) via [Cinevva](https://app.cinevva.com/game-assets/free-3d-character-models) |`,
    );
  }

  lines.push('', '## HDRI', '', '| Local file | Asset | Author | License | Source |', '| --- | --- | --- | --- | --- |');
  lines.push(
    `| \`hdri/${HDRI.file}\` | ${HDRI.title} | Greg Zaal / Poly Haven | CC0 1.0 | [${HDRI.page}](${HDRI.page}) |`,
  );

  lines.push('', '## Props', '', '| Local file | Asset | Author | License | Source |', '| --- | --- | --- | --- | --- |');
  for (const prop of PROPS) {
    const page = `https://polyhaven.com/a/${prop.asset}`;
    lines.push(
      `| \`props/${prop.id}.glb\` | ${prop.title} | Poly Haven contributors | CC0 1.0 | [${page}](${page}) |`,
    );
  }

  lines.push('', '## Textures', '', '| Local files | Asset | Author | License | Source |', '| --- | --- | --- | --- | --- |');
  for (const texture of TEXTURES) {
    const page = `https://polyhaven.com/a/${texture.asset}`;
    lines.push(
      `| \`textures/${texture.id}-*.jpg\` | ${texture.title} | Poly Haven contributors | CC0 1.0 | [${page}](${page}) |`,
    );
  }

  lines.push(
    '',
    '## Fallbacks',
    '',
    'If an asset is missing or fails to load, the scene keeps its procedural Three.js',
    'stand-in. The live OpenCode data path is independent of these files.',
    '',
  );
  await writeFile(join(ASSETS, 'ATTRIBUTION.md'), lines.join('\n'), 'utf8');
  console.log(`[attribution] ${join(ASSETS, 'ATTRIBUTION.md')}`);
}

async function main() {
  console.log(`Vendoring CC0 assets into ${ASSETS}`);
  console.log(FORCE ? 'Mode: force redownload' : 'Mode: fill missing files');
  await mkdir(join(ASSETS, 'characters'), { recursive: true });
  await mkdir(join(ASSETS, 'hdri'), { recursive: true });
  await mkdir(join(ASSETS, 'props'), { recursive: true });
  await mkdir(join(ASSETS, 'textures'), { recursive: true });

  const failures = [];
  for (const character of CHARACTERS) {
    try {
      await fetchCharacter(character);
    } catch (error) {
      failures.push(`character ${character.title}: ${error.message}`);
    }
  }
  try {
    await fetchHdri();
  } catch (error) {
    failures.push(`hdri ${HDRI.title}: ${error.message}`);
  }
  for (const prop of PROPS) {
    try {
      await fetchProp(prop);
    } catch (error) {
      failures.push(`prop ${prop.title}: ${error.message}`);
    }
  }
  for (const texture of TEXTURES) {
    try {
      await fetchTexture(texture);
    } catch (error) {
      failures.push(`texture ${texture.title}: ${error.message}`);
    }
  }

  await writeAttribution();

  if (failures.length > 0) {
    console.error('\nSome assets failed:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nAll CC0 assets are present.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
