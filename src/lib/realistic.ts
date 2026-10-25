import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

/* --------------------------------------------------------------------------
   External CC0 art: Quaternius characters, Poly Haven props/HDRI/textures.
   Everything here is optional. The scene keeps its procedural stand-ins when a
   file is missing, still loading, or fails to decode.
   -------------------------------------------------------------------------- */

const ASSET_ROOT = `${import.meta.env.BASE_URL}assets/`;

export type PropId =
  | 'sofa'
  | 'coffee-table'
  | 'armchair'
  | 'shelf'
  | 'coffee-cart'
  | 'plant-calathea'
  | 'plant-fern'
  | 'street-lamp'
  | 'cat-statue';

export type TextureId = 'grass' | 'wood' | 'asphalt' | 'concrete';
export type CharacterSourceId = 'female' | 'male';
export type CharacterMode = 'idle' | 'walk' | 'run' | 'type';

export interface CharacterSource {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

export interface PbrTextureSet {
  diffuse: THREE.Texture;
  normal: THREE.Texture | null;
  roughness: THREE.Texture | null;
}

export interface RealisticAssets {
  characters: Partial<Record<CharacterSourceId, CharacterSource>>;
  props: Map<PropId, THREE.Group>;
  textures: Partial<Record<TextureId, PbrTextureSet>>;
  envMap: THREE.Texture | null;
  failed: string[];
}

export interface CharacterRig {
  group: THREE.Group;
  model: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  current: string;
  mode: CharacterMode;
  seed: number;
  materials: THREE.MeshStandardMaterial[];
  bones: {
    upperArmL: THREE.Bone | null;
    upperArmR: THREE.Bone | null;
    lowerArmL: THREE.Bone | null;
    lowerArmR: THREE.Bone | null;
    head: THREE.Bone | null;
  };
}

export interface CharacterOptions {
  height?: number;
  shirt: number;
  pants: number;
  hair: number;
  skin: number;
  seed?: number;
}

export interface PropPlacement {
  x: number;
  y?: number;
  z: number;
  rot?: number;
  size?: number;
  axis?: 'width' | 'height' | 'depth' | 'max';
  inspect?: {
    label: string;
    kind: string;
    detail?: string;
    preset?: string;
  };
}

export type AssetProgress = (done: number, total: number, label: string) => void;

const PROP_FILES: Record<PropId, string> = {
  sofa: 'props/sofa.glb',
  'coffee-table': 'props/coffee-table.glb',
  armchair: 'props/armchair.glb',
  shelf: 'props/shelf.glb',
  'coffee-cart': 'props/coffee-cart.glb',
  'plant-calathea': 'props/plant-calathea.glb',
  'plant-fern': 'props/plant-fern.glb',
  'street-lamp': 'props/street-lamp.glb',
  'cat-statue': 'props/cat-statue.glb',
};

const TEXTURE_FILES: Record<TextureId, { diffuse: string; normal: string; roughness: string }> = {
  grass: {
    diffuse: 'textures/grass-diffuse.jpg',
    normal: 'textures/grass-normal.jpg',
    roughness: 'textures/grass-roughness.jpg',
  },
  wood: {
    diffuse: 'textures/wood-diffuse.jpg',
    normal: 'textures/wood-normal.jpg',
    roughness: 'textures/wood-roughness.jpg',
  },
  asphalt: {
    diffuse: 'textures/asphalt-diffuse.jpg',
    normal: 'textures/asphalt-normal.jpg',
    roughness: 'textures/asphalt-roughness.jpg',
  },
  concrete: {
    diffuse: 'textures/concrete-diffuse.jpg',
    normal: 'textures/concrete-normal.jpg',
    roughness: 'textures/concrete-roughness.jpg',
  },
};

function assetUrl(relative: string): string {
  return `${ASSET_ROOT}${relative}`;
}

async function loadGltf(loader: GLTFLoader, relative: string): Promise<THREE.Group> {
  const gltf = await loader.loadAsync(assetUrl(relative));
  return gltf.scene;
}

function markShared(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.userData['shared'] = true;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      material.userData['shared'] = true;
      const standard = material as THREE.MeshStandardMaterial;
      for (const key of [
        'map',
        'normalMap',
        'roughnessMap',
        'metalnessMap',
        'aoMap',
        'emissiveMap',
        'alphaMap',
      ]) {
        const texture = (standard as unknown as Record<string, THREE.Texture | null>)[key];
        if (texture) texture.userData['shared'] = true;
      }
    }
  });
}

function prepareProp(root: THREE.Group): void {
  markShared(root);
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = true;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      const standard = material as THREE.MeshStandardMaterial;
      if (standard.isMeshStandardMaterial) {
        standard.envMapIntensity = 0.85;
        standard.roughness = Math.max(0.35, standard.roughness);
      }
    }
  });
}

function prepareCharacter(root: THREE.Group): void {
  markShared(root);
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = false;
    object.frustumCulled = false;
  });
}

async function loadTexture(
  loader: THREE.TextureLoader,
  relative: string,
  colorSpace: THREE.ColorSpace,
  anisotropy: number,
): Promise<THREE.Texture> {
  const texture = await loader.loadAsync(assetUrl(relative));
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}

async function loadTextureSet(
  loader: THREE.TextureLoader,
  id: TextureId,
  anisotropy: number,
): Promise<PbrTextureSet> {
  const files = TEXTURE_FILES[id];
  const [diffuse, normal, roughness] = await Promise.all([
    loadTexture(loader, files.diffuse, THREE.SRGBColorSpace, anisotropy),
    loadTexture(loader, files.normal, THREE.NoColorSpace, anisotropy),
    loadTexture(loader, files.roughness, THREE.NoColorSpace, anisotropy),
  ]);
  return { diffuse, normal, roughness };
}

/**
 * Load every optional CC0 asset. Individual failures are recorded and do not
 * reject the whole load, so the scene can keep a partial upgrade.
 */
export async function loadRealisticAssets(
  renderer: THREE.WebGLRenderer,
  onProgress?: AssetProgress,
): Promise<RealisticAssets> {
  const assets: RealisticAssets = {
    characters: {},
    props: new Map(),
    textures: {},
    envMap: null,
    failed: [],
  };

  const gltfLoader = new GLTFLoader();
  const textureLoader = new THREE.TextureLoader();
  textureLoader.setCrossOrigin('anonymous');
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const total = 2 + 1 + Object.keys(PROP_FILES).length + Object.keys(TEXTURE_FILES).length;
  let done = 0;
  const tick = (label: string): void => {
    done += 1;
    onProgress?.(done, total, label);
  };

  const characterJobs: Promise<void>[] = [
    (async () => {
      try {
        const gltf = await new GLTFLoader().loadAsync(assetUrl('characters/Casual_Female.glb'));
        prepareCharacter(gltf.scene);
        assets.characters.female = { scene: gltf.scene, animations: gltf.animations };
      } catch (error) {
        assets.failed.push(`character female: ${(error as Error).message}`);
      }
      tick('female character');
    })(),
    (async () => {
      try {
        const gltf = await new GLTFLoader().loadAsync(assetUrl('characters/Casual_Male.glb'));
        prepareCharacter(gltf.scene);
        assets.characters.male = { scene: gltf.scene, animations: gltf.animations };
      } catch (error) {
        assets.failed.push(`character male: ${(error as Error).message}`);
      }
      tick('male character');
    })(),
  ];

  const hdriJob = (async () => {
    try {
      const hdri = await new HDRLoader().loadAsync(
        assetUrl('hdri/kloofendal_48d_partly_cloudy_puresky_1k.hdr'),
      );
      hdri.mapping = THREE.EquirectangularReflectionMapping;
      const pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      const target = pmrem.fromEquirectangular(hdri);
      assets.envMap = target.texture;
      pmrem.dispose();
      hdri.dispose();
    } catch (error) {
      assets.failed.push(`hdri: ${(error as Error).message}`);
    }
    tick('sky environment');
  })();

  const propJobs = (Object.keys(PROP_FILES) as PropId[]).map(async (id) => {
    try {
      const scene = await loadGltf(gltfLoader, PROP_FILES[id]);
      prepareProp(scene);
      assets.props.set(id, scene);
    } catch (error) {
      assets.failed.push(`prop ${id}: ${(error as Error).message}`);
    }
    tick(id);
  });

  const textureJobs = (Object.keys(TEXTURE_FILES) as TextureId[]).map(async (id) => {
    try {
      assets.textures[id] = await loadTextureSet(textureLoader, id, anisotropy);
    } catch (error) {
      assets.failed.push(`texture ${id}: ${(error as Error).message}`);
    }
    tick(`${id} textures`);
  });

  await Promise.all([...characterJobs, hdriJob, ...propJobs, ...textureJobs]);
  return assets;
}

function tintMaterial(
  material: THREE.MeshStandardMaterial,
  options: CharacterOptions,
): void {
  const name = material.name.toLowerCase();
  if (name === 'shirt') material.color.setHex(options.shirt);
  else if (name === 'pants') material.color.setHex(options.pants);
  else if (name === 'hair') material.color.setHex(options.hair);
  else if (name === 'skin') material.color.setHex(options.skin);
  else if (name === 'belt') material.color.setHex(0x2b2118);
  else if (name === 'face') material.color.setHex(0xffffff);
  material.roughness = name === 'face' ? 0.35 : 0.72;
  material.metalness = 0;
  material.envMapIntensity = 0.85;
  material.needsUpdate = true;
}

function findBone(root: THREE.Object3D, name: string): THREE.Bone | null {
  const object = root.getObjectByName(name);
  return object instanceof THREE.Bone ? object : null;
}

/**
 * Build one animated Quaternius character with a tinted outfit. Geometry and
 * the skeleton source stay shared; only the six material slots are cloned.
 */
export function createCharacterRig(
  source: CharacterSource,
  options: CharacterOptions,
): CharacterRig {
  const height = options.height ?? 2.1;
  const raw = cloneSkeleton(source.scene) as THREE.Group;
  raw.updateMatrixWorld(true);

  const materials: THREE.MeshStandardMaterial[] = [];
  raw.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = true;
    object.receiveShadow = false;
    object.frustumCulled = false;

    const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
    const cloned = sourceMaterials.map((material) => {
      const copy = (material as THREE.MeshStandardMaterial).clone();
      // Material.copy inherits the source userData; this clone is ours, even
      // though its textures and skeleton still come from the shared GLB.
      delete copy.userData['shared'];
      copy.userData['owned'] = true;
      tintMaterial(copy, options);
      materials.push(copy);
      return copy;
    });
    object.material = Array.isArray(object.material) ? cloned : cloned[0]!;
  });

  const bounds = new THREE.Box3().setFromObject(raw);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  bounds.getSize(size);
  bounds.getCenter(center);
  const scale = height / Math.max(0.001, size.y);

  raw.position.set(-center.x, -bounds.min.y, -center.z);

  const pivot = new THREE.Group();
  pivot.add(raw);
  pivot.scale.setScalar(scale);
  // Quaternius characters face +Z in glTF. Keep that convention so the rest of
  // the campus can use atan2(dx, dz) for facing without a correction.
  pivot.rotation.y = 0;

  const group = new THREE.Group();
  group.add(pivot);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 0.65, 32),
    new THREE.MeshBasicMaterial({
      color: options.shirt,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.02;
  group.add(ring);
  group.userData['ring'] = ring;

  const anchor = new THREE.Object3D();
  anchor.position.y = height - 0.2;
  group.add(anchor);
  group.userData['headMesh'] = anchor;

  const mixer = new THREE.AnimationMixer(pivot);
  const actions = new Map<string, THREE.AnimationAction>();
  for (const clip of source.animations) {
    const action = mixer.clipAction(clip);
    action.enabled = true;
    actions.set(clip.name, action);
  }

  const rig: CharacterRig = {
    group,
    model: pivot,
    mixer,
    actions,
    current: '',
    mode: 'idle',
    seed: options.seed ?? 0,
    materials,
    bones: {
      upperArmL: findBone(pivot, 'UpperArmL'),
      upperArmR: findBone(pivot, 'UpperArmR'),
      lowerArmL: findBone(pivot, 'LowerArmL'),
      lowerArmR: findBone(pivot, 'LowerArmR'),
      head: findBone(pivot, 'Head'),
    },
  };
  group.userData['rig'] = rig;
  setRigMode(rig, 'idle', 0);
  return rig;
}

function setRigMode(rig: CharacterRig, mode: CharacterMode, fade: number): void {
  const clipName = mode === 'walk' ? 'Walk' : mode === 'run' ? 'Run' : 'Idle';
  if (rig.current !== clipName) {
    const next = rig.actions.get(clipName);
    const previous = rig.actions.get(rig.current);
    if (next) {
      next.reset();
      next.setEffectiveTimeScale(mode === 'run' ? 1.15 : 1);
      next.setEffectiveWeight(1);
      if (fade > 0) next.fadeIn(fade);
      next.play();
    }
    if (previous && previous !== next) {
      if (fade > 0) previous.fadeOut(fade);
      else previous.stop();
    }
    rig.current = clipName;
  }
  rig.mode = mode;
}

const TYPING_X = new THREE.Vector3(1, 0, 0);
const typingQuat = new THREE.Quaternion();

function applyTypingPose(rig: CharacterRig, time: number): void {
  const wobble = Math.sin(time * 8.5 + rig.seed) * 0.12;
  if (rig.bones.upperArmL) {
    typingQuat.setFromAxisAngle(TYPING_X, 0.42 + wobble);
    rig.bones.upperArmL.quaternion.multiply(typingQuat);
  }
  if (rig.bones.upperArmR) {
    typingQuat.setFromAxisAngle(TYPING_X, 0.42 - wobble);
    rig.bones.upperArmR.quaternion.multiply(typingQuat);
  }
  if (rig.bones.lowerArmL) {
    typingQuat.setFromAxisAngle(TYPING_X, -0.3);
    rig.bones.lowerArmL.quaternion.multiply(typingQuat);
  }
  if (rig.bones.lowerArmR) {
    typingQuat.setFromAxisAngle(TYPING_X, -0.3);
    rig.bones.lowerArmR.quaternion.multiply(typingQuat);
  }
}

export function updateCharacterRig(
  rig: CharacterRig,
  dt: number,
  mode: CharacterMode,
  time: number,
  speed = 0,
): void {
  setRigMode(rig, mode, 0.24);
  if (mode === 'walk' || mode === 'run') {
    // Match the stride to the actual ground speed so feet stop sliding.
    const action = rig.actions.get(rig.current);
    if (action) {
      const reference = mode === 'run' ? 4.2 : 1.35;
      action.setEffectiveTimeScale(THREE.MathUtils.clamp(speed / reference, 0.55, 1.7));
    }
  }
  rig.mixer.update(dt);
  if (mode === 'type') applyTypingPose(rig, time);
}

export function disposeCharacterRig(rig: CharacterRig): void {
  rig.mixer.stopAllAction();
  rig.mixer.uncacheRoot(rig.model);
}

/**
 * Clone a Poly Haven prop, normalize it to a target size and place it with its
 * feet/base at ground level. Returns null when the prop is not loaded.
 */
export function addProp(
  parent: THREE.Object3D,
  assets: RealisticAssets | null,
  id: PropId,
  placement: PropPlacement,
): THREE.Group | null {
  const source = assets?.props.get(id);
  if (!source) return null;

  const model = source.clone(true);
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  bounds.getSize(size);
  bounds.getCenter(center);

  const target = placement.size ?? 1;
  const measured =
    placement.axis === 'height'
      ? size.y
      : placement.axis === 'width'
        ? size.x
        : placement.axis === 'depth'
          ? size.z
          : Math.max(size.x, size.y, size.z);
  const scale = target / Math.max(0.001, measured);

  model.position.set(-center.x, -bounds.min.y, -center.z);

  const pivot = new THREE.Group();
  pivot.add(model);
  pivot.scale.setScalar(scale);
  pivot.position.set(placement.x, placement.y ?? 0, placement.z);
  pivot.rotation.y = placement.rot ?? 0;
  if (placement.inspect) pivot.userData['inspect'] = placement.inspect;
  parent.add(pivot);
  return pivot;
}

/**
 * Build a PBR material from a Poly Haven texture set. Texture clones are owned
 * by this material, so the scene's dispose pass can release them on rebuild.
 */
export function pbrMaterial(
  assets: RealisticAssets | null,
  id: TextureId,
  repeat: [number, number],
  options: {
    color?: number;
    roughness?: number;
    metalness?: number;
    normalScale?: number;
  } = {},
): THREE.MeshStandardMaterial | null {
  const set = assets?.textures[id];
  if (!set) return null;

  const diffuse = set.diffuse.clone();
  diffuse.colorSpace = THREE.SRGBColorSpace;
  diffuse.wrapS = THREE.RepeatWrapping;
  diffuse.wrapT = THREE.RepeatWrapping;
  diffuse.repeat.set(repeat[0], repeat[1]);
  diffuse.needsUpdate = true;

  const normal = set.normal?.clone() ?? null;
  if (normal) {
    normal.colorSpace = THREE.NoColorSpace;
    normal.wrapS = THREE.RepeatWrapping;
    normal.wrapT = THREE.RepeatWrapping;
    normal.repeat.set(repeat[0], repeat[1]);
    normal.needsUpdate = true;
  }

  const roughness = set.roughness?.clone() ?? null;
  if (roughness) {
    roughness.colorSpace = THREE.NoColorSpace;
    roughness.wrapS = THREE.RepeatWrapping;
    roughness.wrapT = THREE.RepeatWrapping;
    roughness.repeat.set(repeat[0], repeat[1]);
    roughness.needsUpdate = true;
  }

  const material = new THREE.MeshStandardMaterial({
    map: diffuse,
    normalMap: normal,
    roughnessMap: roughness,
    color: options.color ?? 0xffffff,
    roughness: options.roughness ?? 0.9,
    metalness: options.metalness ?? 0.02,
    normalScale: new THREE.Vector2(options.normalScale ?? 0.8, options.normalScale ?? 0.8),
    envMapIntensity: 0.9,
  });
  return material;
}
