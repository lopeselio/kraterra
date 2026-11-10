import * as THREE from 'three';
import { AIR, ASH, BEDROCK, DIRT, GRASS, H, ROCK, SAND, STONE, W, weapon, type SimEvent, type State, type Theme } from '@kraterra/rules';
import { sfx } from './sound.ts';

// The battlefield: the 2D voxel grid extruded into a diorama slab DEPTH voxels deep, seen from the
// front. Terrain is meshed in 16-column chunks (faces only where a cell meets air, runs merged, a
// tiled bevel texture keeps the voxel look), so a blast rebuilds one or two small meshes. Everything
// is procedural; nothing is downloaded.

const DEPTH = 10;
const CHUNK = 16;
const FRONT = DEPTH / 2;

const MAT_COLOR: Record<number, number> = {
  [GRASS]: 0x67c24a, [DIRT]: 0x8d5b34, [ROCK]: 0x6f6878, [BEDROCK]: 0x2a2630, [STONE]: 0xa9b0c2, [ASH]: 0x3e3631, [SAND]: 0xe0cb86,
};
export const SEAT_COLOR = [0x35d6c8, 0xff8a3d];
const SKY: Record<Theme, [number, number]> = {
  hills: [0x8fd3ff, 0xfde7c4], cliffs: [0x7fa8e0, 0xf7d3b0], valley: [0x6fb6e8, 0xffe0b8], islands: [0x6ad1f0, 0xfff0d0], skyreef: [0x6c5fc7, 0xffb7d0],
};

/** a 32px voxel tile: flat face with a darker bevel line, used with UVs in voxel units */
function bevelTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, 32, 32);
  g.fillStyle = 'rgba(0,0,0,0.16)'; g.fillRect(0, 30, 32, 2); g.fillRect(30, 0, 2, 32);
  g.fillStyle = 'rgba(255,255,255,0.5)'; g.fillRect(0, 0, 32, 2); g.fillRect(0, 0, 2, 32);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const hash = (x: number, y: number): number => (((x * 73856093) ^ (y * 19349663)) >>> 0) % 1000 / 1000;

interface Particle { m: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; max: number; color: THREE.Color; size: number }
interface Float { sprite: THREE.Sprite; t: number }

export interface AimDrag { angle: number; power: number }

export class Battlefield {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(38, 1, 1, 2000);
  private grid = new Uint8Array(W * H);
  private chunks: (THREE.Mesh | null)[] = [];
  private terrainMat: THREE.MeshLambertMaterial;
  private terrain = new THREE.Group();
  private water: THREE.Mesh;
  private tanks: THREE.Group[] = [];
  private barrels: THREE.Object3D[] = [];
  private ghostTank: THREE.Group;
  private ghostArc: THREE.Line;
  private shell: THREE.Mesh;
  private trail: THREE.Line;
  private parts: Particle[] = [];
  private partMesh: THREE.InstancedMesh;
  private floats: Float[] = [];
  private flash = new THREE.PointLight(0xffc070, 0, 60, 1.6);
  private shake = 0;
  private skyMat: THREE.ShaderMaterial;
  private clouds: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();
  private clock = new THREE.Clock();
  /** camera: target point and zoom (visible width in voxels) */
  private view = { x: W / 2, y: 36, width: W * 1.04 };
  private want = { x: W / 2, y: 36, width: W * 1.04 };
  private follow: { x: number; y: number } | null = null;
  private userCam = 0;
  /** which seat the local player is (barrel drag), or null */
  me: number | null = null;
  onAim: ((a: AimDrag) => void) | null = null;
  private tankPos: { x: number; y: number }[] = [{ x: 30, y: 30 }, { x: 160, y: 30 }];
  private seatPowers = [60, 60];
  /** bumped by setWorld: an animation of an older world stops */
  private gen = 0;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: window.devicePixelRatio < 2, powerPreference: 'high-performance' });
    // capped pixel ratio: crisp on desktop, cheap on phones
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, matchMedia('(pointer: coarse)').matches ? 1.5 : 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(this.renderer.domElement);

    // sky dome: a vertical gradient
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false,
      uniforms: { top: { value: new THREE.Color(SKY.hills[0]) }, bottom: { value: new THREE.Color(SKY.hills[1]) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float t = clamp(vP.y*1.6+0.35,0.0,1.0); gl_FragColor = vec4(mix(bottom, top, t),1.0); }',
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 24, 12), this.skyMat);
    sky.position.set(W / 2, 0, 0);
    this.scene.add(sky);

    this.scene.add(new THREE.HemisphereLight(0xdff2ff, 0x5a4636, 1.6));
    const sun = new THREE.DirectionalLight(0xfff1d6, 1.9);
    sun.position.set(-60, 140, 120);
    this.scene.add(sun);
    this.scene.add(this.flash);

    this.terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true, map: bevelTexture() });
    this.scene.add(this.terrain);
    this.backdrop();

    this.clouds = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 }), 60);
    this.scene.add(this.clouds);
    this.layoutClouds();

    const wm = new THREE.MeshLambertMaterial({ color: 0x2f8fd8, transparent: true, opacity: 0.62 });
    this.water = new THREE.Mesh(new THREE.BoxGeometry(W + 160, 1, DEPTH + 40), wm);
    this.water.visible = false;
    this.scene.add(this.water);

    for (let s = 0; s < 2; s++) {
      const t = this.tankModel(SEAT_COLOR[s]);
      this.tanks.push(t);
      this.barrels.push(t.getObjectByName('pivot')!);
      this.scene.add(t);
    }
    this.ghostTank = this.tankModel(0xffffff, true);
    this.ghostTank.visible = false;
    this.scene.add(this.ghostTank);
    this.ghostArc = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 1.2, gapSize: 1, transparent: true, opacity: 0.85 }));
    this.ghostArc.visible = false;
    this.scene.add(this.ghostArc);

    this.shell = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 1.1), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.shell.visible = false;
    this.scene.add(this.shell);
    this.trail = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }));
    this.trail.frustumCulled = false;
    this.scene.add(this.trail);

    this.partMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0xffffff }), 700);
    this.partMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.partMesh.count = 0;
    this.partMesh.frustumCulled = false;
    this.scene.add(this.partMesh);

    this.resize();
    window.addEventListener('resize', this.resize);
    this.input();
    this.renderer.setAnimationLoop(this.frame);
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.resize);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---------- world ----------

  private backdrop(): void {
    // distant voxel ranges behind the slab
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshLambertMaterial({ color: 0x9fb4c8 });
    const n = 70;
    const far = new THREE.InstancedMesh(geo, mat, n * 2);
    const c = new THREE.Color();
    for (let i = 0; i < n * 2; i++) {
      const back = i >= n;
      const k = i % n;
      const x = -260 + k * ((W + 520) / n);
      const h = 6 + Math.abs(Math.sin(k * 0.7 + (back ? 2 : 0)) * 16) + (k % 5) * 2 + (back ? 14 : 0);
      this.dummy.position.set(x, h / 2 - 2, back ? -320 : -170);
      this.dummy.scale.set((W + 520) / n + 1, h, 40);
      this.dummy.updateMatrix();
      far.setMatrixAt(i, this.dummy.matrix);
      far.setColorAt(i, c.setHex(back ? 0xc4cfe0 : 0x9cb0a8).offsetHSL(0, 0, (k % 3) * 0.02));
    }
    this.scene.add(far);
    // the ground plane the slab sits on
    const ground = new THREE.Mesh(new THREE.BoxGeometry(W + 900, 2, 420), new THREE.MeshLambertMaterial({ color: 0x5b7a48 }));
    ground.position.set(W / 2, -1.2, -120);
    this.scene.add(ground);
  }

  private layoutClouds(): void {
    let k = 0;
    for (let c = 0; c < 12; c++) {
      const cx = -40 + c * 26 + (c % 3) * 7, cy = 92 + (c % 4) * 8, cz = -40 - (c % 5) * 14;
      for (let b = 0; b < 5; b++) {
        this.dummy.position.set(cx + b * 3 - 6, cy + (b % 2) * 1.5, cz);
        this.dummy.scale.set(6 + (b % 3) * 2, 3 + (b % 2) * 1.5, 4);
        this.dummy.updateMatrix();
        this.clouds.setMatrixAt(k++, this.dummy.matrix);
      }
    }
    this.clouds.count = k;
    this.clouds.instanceMatrix.needsUpdate = true;
  }

  private tankModel(color: number, ghost = false): THREE.Group {
    const g = new THREE.Group();
    const mk = (w: number, h: number, d: number, c: number, x: number, y: number, z = 0): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), ghost ? new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.35, depthWrite: false }) : new THREE.MeshLambertMaterial({ color: c }));
      m.position.set(x, y, z);
      g.add(m);
      return m;
    };
    const dark = new THREE.Color(color).multiplyScalar(0.45).getHex();
    mk(3.4, 0.9, 3.2, 0x26232b, 0, 0.45);
    for (const x of [-1.1, 0, 1.1]) mk(0.6, 0.6, 3.4, 0x45404d, x, 0.4);
    mk(3, 1.1, 2.6, color, 0, 1.4);
    mk(1.8, 0.9, 1.9, dark, 0, 2.3);
    mk(0.5, 0.5, 0.5, 0xfff2b0, 0.7, 2.9, 0.6);
    const pivot = new THREE.Object3D();
    pivot.name = 'pivot';
    pivot.position.set(0, 2.4, 0);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(3, 0.45, 0.45), ghost ? new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }) : new THREE.MeshLambertMaterial({ color: dark }));
    barrel.position.x = 1.5;
    pivot.add(barrel);
    g.add(pivot);
    return g;
  }

  /** Rebuilds everything from a match state (new battlefield, or a resync). */
  setWorld(s: State): void {
    this.gen++;
    this.parts.length = 0;
    this.shell.visible = false;
    this.grid = new Uint8Array(s.grid);
    for (const c of this.chunks) if (c) { this.terrain.remove(c); c.geometry.dispose(); }
    this.chunks = [];
    for (let k = 0; k < W / CHUNK; k++) this.chunks.push(this.buildChunk(k));
    const [top, bottom] = SKY[s.theme] ?? SKY.hills;
    this.skyMat.uniforms.top.value.setHex(top);
    this.skyMat.uniforms.bottom.value.setHex(bottom);
    this.water.visible = s.water > 0;
    this.water.scale.y = s.water;
    this.water.position.set(W / 2, s.water / 2, 0);
    this.setTanks(s);
  }

  setTanks(s: State): void {
    s.tanks.forEach((t, i) => {
      this.tankPos[i] = { x: t.x, y: t.y };
      this.tanks[i].position.set(t.x + 0.5, t.y, 0);
      this.setBarrel(i, t.angle);
      this.seatPowers[i] = t.power;
    });
  }

  setBarrel(seat: number, angle: number): void {
    this.barrels[seat].rotation.z = (angle * Math.PI) / 180;
  }

  /** a translucent tank where a planned drive would end, and/or the practice range's aim guide */
  setGhost(pos: { x: number; y: number } | null, angle: number): void {
    this.ghostTank.visible = !!pos;
    if (pos) {
      this.ghostTank.position.set(pos.x + 0.5, pos.y, 0.2);
      (this.ghostTank.getObjectByName('pivot')!).rotation.z = (angle * Math.PI) / 180;
    }
  }
  setGuide(pts: number[] | null): void {
    this.ghostArc.visible = !!pts;
    if (!pts) return;
    const v: number[] = [];
    for (let i = 0; i < pts.length; i += 2) v.push(pts[i], pts[i + 1], FRONT + 0.3);
    this.ghostArc.geometry.dispose();
    this.ghostArc.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    this.ghostArc.computeLineDistances();
  }

  private buildChunk(k: number): THREE.Mesh | null {
    const pos: number[] = [], nor: number[] = [], col: number[] = [], uv: number[] = [], ind: number[] = [];
    const g = this.grid;
    const at = (x: number, y: number): number => (x < 0 || x >= W || y < 0 || y >= H ? AIR : g[y * W + x]);
    const c = new THREE.Color();
    const quad = (p: number[][], n: number[], color: THREE.Color, uvs: number[][]): void => {
      const b = pos.length / 3;
      for (let i = 0; i < 4; i++) { pos.push(...p[i]); nor.push(...n); col.push(color.r, color.g, color.b); uv.push(...uvs[i]); }
      ind.push(b, b + 1, b + 2, b, b + 2, b + 3);
    };
    const shade = (m: number, x: number, y: number, k2: number): THREE.Color => {
      c.setHex(MAT_COLOR[m] ?? 0xff00ff);
      // strata bands and a little per-voxel noise
      const v = 0.9 + 0.1 * hash(Math.floor(x / 2), y) + (m === ROCK ? ((y % 6) < 2 ? -0.04 : 0) : 0);
      return c.multiplyScalar(v * k2);
    };
    const x0 = k * CHUNK, x1 = Math.min(W, x0 + CHUNK);
    for (let y = 0; y < H; y++) {
      // front and back faces: runs of one material
      let x = x0;
      while (x < x1) {
        const m = at(x, y);
        if (m === AIR) { x++; continue; }
        let e = x + 1;
        while (e < x1 && at(e, y) === m) e++;
        const cl = shade(m, x, y, 1);
        quad([[x, y, FRONT], [e, y, FRONT], [e, y + 1, FRONT], [x, y + 1, FRONT]], [0, 0, 1], cl, [[x, y], [e, y], [e, y + 1], [x, y + 1]]);
        quad([[e, y, -FRONT], [x, y, -FRONT], [x, y + 1, -FRONT], [e, y + 1, -FRONT]], [0, 0, -1], cl, [[e, y], [x, y], [x, y + 1], [e, y + 1]]);
        x = e;
      }
      // tops and bottoms: runs of exposed cells
      for (const up of [true, false]) {
        x = x0;
        while (x < x1) {
          const m = at(x, y);
          const open = m !== AIR && at(x, up ? y + 1 : y - 1) === AIR;
          if (!open) { x++; continue; }
          let e = x + 1;
          while (e < x1 && at(e, y) === m && at(e, up ? y + 1 : y - 1) === AIR) e++;
          const yy = up ? y + 1 : y;
          const cl = shade(m, x, y, up ? 1.12 : 0.6);
          if (up) quad([[x, yy, FRONT], [e, yy, FRONT], [e, yy, -FRONT], [x, yy, -FRONT]], [0, 1, 0], cl, [[x, FRONT], [e, FRONT], [e, -FRONT], [x, -FRONT]]);
          else quad([[x, yy, -FRONT], [e, yy, -FRONT], [e, yy, FRONT], [x, yy, FRONT]], [0, -1, 0], cl, [[x, -FRONT], [e, -FRONT], [e, FRONT], [x, FRONT]]);
          x = e;
        }
      }
      // sides
      for (x = x0; x < x1; x++) {
        const m = at(x, y);
        if (m === AIR) continue;
        if (at(x - 1, y) === AIR) quad([[x, y, -FRONT], [x, y, FRONT], [x, y + 1, FRONT], [x, y + 1, -FRONT]], [-1, 0, 0], shade(m, x, y, 0.78), [[-FRONT, y], [FRONT, y], [FRONT, y + 1], [-FRONT, y + 1]]);
        if (at(x + 1, y) === AIR) quad([[x + 1, y, FRONT], [x + 1, y, -FRONT], [x + 1, y + 1, -FRONT], [x + 1, y + 1, FRONT]], [1, 0, 0], shade(m, x, y, 0.85), [[FRONT, y], [-FRONT, y], [-FRONT, y + 1], [FRONT, y + 1]]);
      }
    }
    if (!ind.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(ind);
    const mesh = new THREE.Mesh(geo, this.terrainMat);
    this.terrain.add(mesh);
    return mesh;
  }

  /** Applies changed cells (index × 8 + material) and rebuilds the chunks they touch. */
  private applyCells(cells: number[]): THREE.Color[] {
    const dirty = new Set<number>();
    const colors: THREE.Color[] = [];
    for (const v of cells) {
      const i = Math.floor(v / 8), m = v % 8;
      const x = i % W;
      if (this.grid[i] !== AIR && colors.length < 40) colors.push(new THREE.Color(MAT_COLOR[this.grid[i]] ?? 0x888888));
      this.grid[i] = m;
      dirty.add(Math.floor(x / CHUNK));
      if (x % CHUNK === 0) dirty.add(Math.floor(x / CHUNK) - 1);
      if (x % CHUNK === CHUNK - 1) dirty.add(Math.floor(x / CHUNK) + 1);
    }
    for (const k of dirty) {
      if (k < 0 || k >= this.chunks.length) continue;
      const old = this.chunks[k];
      if (old) { this.terrain.remove(old); old.geometry.dispose(); }
      this.chunks[k] = this.buildChunk(k);
    }
    return colors;
  }

  // ---------- animating a move ----------

  /** Plays a move's events in order. Resolves when the dust has (mostly) settled. */
  async play(events: SimEvent[], speed = 1): Promise<void> {
    const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms / speed));
    const gen = this.gen;
    for (const e of events) {
      if (gen !== this.gen) return;
      switch (e.t) {
        case 'move': {
          for (let i = 2; i < e.pts.length; i += 2) {
            this.tankPos[e.seat] = { x: e.pts[i], y: e.pts[i + 1] };
            this.tanks[e.seat].position.set(e.pts[i] + 0.5, e.pts[i + 1], 0);
            if (i % 4 === 0) sfx('drive', e.pts[i + 1]);
            this.dust(e.pts[i] + 0.5, e.pts[i + 1], 2, 0x9a7a5a);
            await wait(55);
          }
          break;
        }
        case 'aim': {
          const from = this.barrels[e.seat].rotation.z, to = (e.angle * Math.PI) / 180;
          for (let k = 1; k <= 12; k++) { this.barrels[e.seat].rotation.z = from + ((to - from) * k) / 12; await wait(22); }
          if (this.want.width < W * 0.9) this.focusOn(this.tankPos[e.seat].x, this.tankPos[e.seat].y + 10);
          await wait(180);
          sfx('fire');
          const tp = this.tankPos[e.seat];
          const a = (e.angle * Math.PI) / 180;
          this.burst(tp.x + 0.5 + Math.cos(a) * 4, tp.y + 2.5 + Math.sin(a) * 4, 10, [0xffe2a0, 0xff9a40, 0x777777], 0.6);
          break;
        }
        case 'fly': await this.flyPath(e.pts, weapon(e.weapon).color, e.kind, speed); break;
        case 'boom': {
          const colors = this.applyCells(e.cells);
          if (e.r > 0) {
            sfx(e.r >= 8 ? 'bigboom' : 'boom');
            this.flash.position.set(e.x + 0.5, e.y + 0.5, FRONT + 6);
            this.flash.intensity = 60 + e.r * 25;
            this.shake = Math.min(2.4, 0.4 + e.r * 0.16);
            this.burst(e.x + 0.5, e.y + 0.5, 18 + e.r * 7, [0xfff1b0, 0xffa030, 0xff5a20, ...colors.map((c) => c.getHex())], e.r / 4 + 0.6);
            await wait(140 + e.r * 18);
          }
          break;
        }
        case 'build': {
          sfx('build');
          const sorted = [...e.cells].sort((a, b) => Math.floor(a / 8 / W) - Math.floor(b / 8 / W));
          const steps = e.what === 'wall' ? 7 : 3;
          for (let k = 0; k < steps; k++) {
            this.applyCells(sorted.slice(Math.floor((sorted.length * k) / steps), Math.floor((sorted.length * (k + 1)) / steps)));
            await wait(60);
          }
          this.dust(e.x + 0.5, e.y, 14, e.what === 'wall' ? 0xb0b6c6 : 0x8d5b34);
          break;
        }
        case 'fire': {
          sfx('flame');
          this.applyCells(e.cells);
          const order = [...e.cols].sort((a, b) => Math.abs(a - e.x) - Math.abs(b - e.x));
          for (let i = 0; i < order.length; i++) {
            const x = order[i];
            let y = H - 1;
            while (y > 0 && this.grid[y * W + x] === AIR) y--;
            this.burst(x + 0.5, y + 1.2, 5, [0xffd040, 0xff7a10, 0xff3a10], 0.5, true);
            if (i % 2 === 1) await wait(35);
          }
          await wait(250);
          break;
        }
        case 'splash': sfx('splash'); this.burst(e.x + 0.5, e.y, 24, [0xd8f2ff, 0x7cc6ff, 0x3a8fd8], 0.9); break;
        case 'hit': {
          sfx('hit');
          const tp = this.tankPos[e.seat];
          this.float(tp.x + 0.5, tp.y + 6, `-${e.dmg}`, e.to === this.me ? '#7dffb0' : '#ff9a7a');
          this.tanks[e.seat].position.y = tp.y + 0.6;
          setTimeout(() => { this.tanks[e.seat].position.y = this.tankPos[e.seat].y; }, 120);
          break;
        }
        case 'fall': {
          const from = this.tankPos[e.seat].y;
          for (let k = 1; k <= 10; k++) { this.tanks[e.seat].position.y = from + ((e.y - from) * k) / 10; await wait(30); }
          this.tankPos[e.seat] = { x: this.tankPos[e.seat].x, y: e.y };
          this.dust(this.tankPos[e.seat].x + 0.5, e.y, 8, 0x9a7a5a);
          break;
        }
        case 'pick': sfx('pick', e.weapon); break;
        case 'end': break;
      }
    }
    this.follow = null;
    await wait(250);
  }

  private async flyPath(pts: number[], color: string, kind: 'shell' | 'dig' | 'roll', speed: number): Promise<void> {
    const n = pts.length / 2;
    if (n < 2) return;
    (this.shell.material as THREE.MeshBasicMaterial).color.set(color);
    (this.trail.material as THREE.LineBasicMaterial).color.set(color);
    this.shell.visible = true;
    const trail: number[] = [];
    // shells fly at ~110 steps a second; digs and rolls a little slower
    const rate = (kind === 'shell' ? 110 : 45) * speed;
    const start = performance.now();
    if (kind === 'shell' && n > 60) sfx('whistle');
    if (kind === 'dig') sfx('dig');
    await new Promise<void>((resolve) => {
      const tick = (): void => {
        const f = Math.min(n - 1, ((performance.now() - start) / 1000) * rate);
        const i = Math.floor(f), t = f - i;
        const j = Math.min(n - 1, i + 1);
        const x = pts[i * 2] + (pts[j * 2] - pts[i * 2]) * t, y = pts[i * 2 + 1] + (pts[j * 2 + 1] - pts[i * 2 + 1]) * t;
        this.shell.position.set(x, y, kind === 'dig' ? FRONT + 0.2 : FRONT - 1);
        this.shell.rotation.z += 0.3;
        trail.push(x, y, FRONT - 1);
        if (trail.length > 90) trail.splice(0, 3);
        this.trail.geometry.dispose();
        this.trail.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(trail, 3));
        if (kind !== 'shell') this.dust(x, y, 1, kind === 'dig' ? 0x8d5b34 : 0xb0a080);
        this.follow = { x, y: Math.min(y, H + 10) };
        if (f >= n - 1) resolve(); else requestAnimationFrame(tick);
      };
      tick();
    });
    this.shell.visible = false;
    this.trail.geometry.dispose();
    this.trail.geometry = new THREE.BufferGeometry();
  }

  private burst(x: number, y: number, count: number, palette: number[], power: number, flame = false): void {
    for (let i = 0; i < count && this.parts.length < 680; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (0.2 + Math.random()) * power * 0.5;
      this.parts.push({
        m: 0, x, y, z: FRONT - Math.random() * DEPTH * 0.8,
        vx: Math.cos(a) * sp, vy: flame ? 0.15 + Math.random() * 0.25 : Math.abs(Math.sin(a)) * sp + 0.1, vz: (Math.random() - 0.3) * sp,
        life: 0, max: flame ? 40 + Math.random() * 30 : 40 + Math.random() * 40, color: new THREE.Color(palette[i % palette.length]), size: flame ? 0.7 : 0.45 + Math.random() * 0.6,
      });
    }
  }
  private dust(x: number, y: number, count: number, color: number): void { this.burst(x, y, count, [color, 0xcfc0a8], 0.25); }

  private float(x: number, y: number, text: string, color: string): void {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 96;
    const g = c.getContext('2d')!;
    g.font = '900 64px "Pixelify Sans", system-ui';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 10; g.strokeStyle = 'rgba(20,12,8,.9)'; g.strokeText(text, 128, 48);
    g.fillStyle = color; g.fillText(text, 128, 48);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthTest: false }));
    sp.position.set(x, y, FRONT + 2);
    sp.scale.set(14, 5.25, 1);
    this.scene.add(sp);
    this.floats.push({ sprite: sp, t: 0 });
  }

  // ---------- camera ----------

  focusOn(x: number, y: number, width?: number): void {
    if (Date.now() - this.userCam < 4000) return;
    this.want.x = x; this.want.y = y;
    if (width) this.want.width = width;
  }
  /** frame the whole field (wide screens) or the two tanks (narrow) */
  overview(lift = 0): void {
    const aspect = this.host.clientWidth / Math.max(1, this.host.clientHeight);
    this.want = { x: W / 2, y: (aspect < 1 ? 26 : 36) - lift, width: aspect < 1 ? Math.max(120, W * 0.72) : W * 1.04 };
    this.userCam = 0;
  }

  private resize = (): void => {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  };

  /** screen point to the slab's front plane */
  private toWorld(cx: number, cy: number): THREE.Vector3 | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const p = new THREE.Vector3();
    return ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -FRONT), p);
  }

  private input(): void {
    const el = this.renderer.domElement;
    const pointers = new Map<number, { x: number; y: number }>();
    let mode: 'aim' | 'pan' | null = null;
    let last = { x: 0, y: 0 };
    let pinch = 0;
    const aimFrom = (cx: number, cy: number): void => {
      if (this.me === null || !this.onAim) return;
      const p = this.toWorld(cx, cy);
      if (!p) return;
      const t = this.ghostTank.visible ? { x: this.ghostTank.position.x - 0.5, y: this.ghostTank.position.y } : this.tankPos[this.me];
      const dx = p.x - (t.x + 0.5), dy = p.y - (t.y + 2.4);
      const angle = Math.max(0, Math.min(180, Math.round((Math.atan2(Math.max(dy, 0), dx) * 180) / Math.PI)));
      const power = Math.max(5, Math.min(100, Math.round(Math.hypot(dx, dy) * 2.3)));
      this.onAim({ angle, power });
    };
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      last = { x: e.clientX, y: e.clientY };
      if (pointers.size === 2) { mode = 'pan'; const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); return; }
      // a press near your own tank (or your planned position) aims; anywhere else pans
      const p = this.toWorld(e.clientX, e.clientY);
      const t = this.me !== null ? (this.ghostTank.visible ? { x: this.ghostTank.position.x - 0.5, y: this.ghostTank.position.y } : this.tankPos[this.me]) : null;
      const near = p && t && Math.hypot(p.x - t.x, p.y - (t.y + 2)) < Math.max(9, this.view.width / 14);
      mode = near && this.onAim && e.button === 0 ? 'aim' : 'pan';
      if (mode === 'aim' && e.pointerType === 'mouse') aimFrom(e.clientX, e.clientY);
    });
    el.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0) this.zoom(pinch / d);
        pinch = d;
        this.userCam = Date.now();
        return;
      }
      if (mode === 'aim') { aimFrom(e.clientX, e.clientY); return; }
      if (mode === 'pan') {
        const s = this.view.width / this.host.clientWidth;
        this.want.x -= (e.clientX - last.x) * s;
        this.want.y += (e.clientY - last.y) * s;
        this.view.x = this.want.x; this.view.y = this.want.y;
        this.userCam = Date.now();
      }
      last = { x: e.clientX, y: e.clientY };
    });
    const up = (e: PointerEvent): void => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = 0; if (!pointers.size) mode = null; };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom(e.deltaY > 0 ? 1.1 : 0.9); this.userCam = Date.now(); }, { passive: false });
  }

  zoom(f: number): void {
    this.want.width = Math.max(50, Math.min(W * 1.3, this.want.width * f));
    this.view.width = this.want.width;
  }

  private frame = (): void => {
    const dt = Math.min(0.05, this.clock.getDelta());
    const t = this.clock.elapsedTime;
    // camera: ease toward the wanted view, follow a flying shell when zoomed in
    const tgt = this.follow && this.view.width < W * 0.9 ? { x: this.follow.x, y: this.follow.y, width: this.want.width } : this.want;
    const k = 1 - Math.exp(-dt * 4);
    this.view.x += (tgt.x - this.view.x) * k;
    this.view.y += (tgt.y - this.view.y) * k;
    this.view.width += (tgt.width - this.view.width) * k;
    this.view.x = Math.max(-20, Math.min(W + 20, this.view.x));
    this.view.y = Math.max(10, Math.min(H + 20, this.view.y));
    const hfov = 2 * Math.atan(Math.tan((this.camera.fov * Math.PI) / 360) * this.camera.aspect);
    const dist = this.view.width / 2 / Math.tan(hfov / 2);
    const sx = (Math.random() - 0.5) * this.shake, sy = (Math.random() - 0.5) * this.shake;
    this.shake *= 0.88;
    this.camera.position.set(this.view.x + sx, this.view.y + dist * 0.2 + sy, FRONT + dist);
    this.camera.lookAt(this.view.x + sx * 0.5, this.view.y, 0);
    this.flash.intensity *= 0.86;

    // particles
    let n = 0;
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life++;
      p.vy -= 0.018; p.x += p.vx; p.y += p.vy; p.z += p.vz;
      p.vx *= 0.98; p.vz *= 0.98;
      if (p.life > p.max) { this.parts.splice(i, 1); continue; }
    }
    for (const p of this.parts) {
      const s = p.size * (1 - p.life / p.max * 0.6);
      this.dummy.position.set(p.x, p.y, p.z);
      this.dummy.scale.setScalar(s);
      this.dummy.rotation.set(p.life * 0.1, p.life * 0.13, 0);
      this.dummy.updateMatrix();
      this.partMesh.setMatrixAt(n, this.dummy.matrix);
      this.partMesh.setColorAt(n, p.color);
      n++;
    }
    this.partMesh.count = n;
    this.partMesh.instanceMatrix.needsUpdate = true;
    if (this.partMesh.instanceColor) this.partMesh.instanceColor.needsUpdate = true;

    for (let i = this.floats.length - 1; i >= 0; i--) {
      const f = this.floats[i];
      f.t += dt;
      f.sprite.position.y += dt * 4;
      (f.sprite.material as THREE.SpriteMaterial).opacity = Math.max(0, 1 - f.t / 1.6);
      if (f.t > 1.6) { this.scene.remove(f.sprite); (f.sprite.material as THREE.SpriteMaterial).map?.dispose(); this.floats.splice(i, 1); }
    }
    this.clouds.position.x = Math.sin(t * 0.03) * 20;
    if (this.water.visible) (this.water.material as THREE.MeshLambertMaterial).opacity = 0.58 + Math.sin(t * 1.3) * 0.04;
    this.renderer.render(this.scene, this.camera);
  };
}
