/* スロットカー・グランプリ
 * three.js (r128) を使った 2 台対戦のスロットカーゲーム。
 * 操作はアクセル（トリガー）1 つのみ。押し込み量で目標速度が決まり、離すとモーターブレーキがかかる。
 */
(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const TRACK_W = 4.4;          // コース幅
  const HW = TRACK_W / 2;
  const LANE_OFF = 1.1;         // センターからスロットまでの距離
  const N = 1600;               // コース 1 周のサンプル数
  const UP = new THREE.Vector3(0, 1, 0);

  // 物理パラメータ（単位：m, 秒）
  const PHYS = {
    vmax: 34,        // トリガー全開時の最高速
    kAcc: 1.15,      // 加速の応答（大きいほど速く目標速度へ）
    kBrake: 2.4,     // モーターブレーキの強さ
    grip: 56,        // 横G の限界
    g: 14,           // 坂道の影響
    slipGain: 4,     // 限界を超えたときスライドが溜まる速さ
    slipDecay: 3,    // スライドが戻る速さ
    maxYaw: 0.55,    // テールスライド時の最大角度
  };

  const LEVELS = {
    // factor: コーナー限界速度に対する割合 / top: 直線でのトリガー上限 / mistake: 1周でミスする確率
    1: { name: 'よわい', factor: 0.80, top: 1, noise: 0.04, react: 0.30, mistake: 0.30 },
    2: { name: 'ふつう', factor: 0.90, top: 1, noise: 0.03, react: 0.18, mistake: 0.15 },
    3: { name: 'つよい', factor: 0.975, top: 1, noise: 0.012, react: 0.08, mistake: 0.05 },
  };

  const COURSES = [
    {
      id: 'fig8', name: 'フィギュア8',
      desc: '中央で立体交差する定番の8の字。左右のコーナーが交互に来るので2レーンの長さは同じ。',
      fn(u) {
        const t = Math.PI + 0.5 + TAU * u, R = 26, h = 4.5;
        return [R * Math.sin(t), h * (1 + Math.cos(t)) / 2, R * Math.sin(t) * Math.cos(t)];
      },
    },
    {
      id: 'oval', name: 'オーバル',
      desc: '高速オーバル。バックストレートに小さな丘あり。2か所のクロスオーバーで内と外が入れ替わるので、どちらのレーンも同じ距離。',
      fn(u) {
        const L = 44, r = 13, P = 2 * L + TAU * r;
        let s = (u * P + L / 2) % P;
        if (s < L) return [-L / 2 + s, 0, -r];
        s -= L;
        if (s < Math.PI * r) { const a = -Math.PI / 2 + s / r; return [L / 2 + r * Math.cos(a), 0, r * Math.sin(a)]; }
        s -= Math.PI * r;
        if (s < L) { const k = s / L; return [L / 2 - s, 1.6 * Math.sin(Math.PI * k) ** 2, r]; }
        s -= L;
        const a = Math.PI / 2 + s / r;
        return [-L / 2 + r * Math.cos(a), 0, r * Math.sin(a)];
      },
    },
    {
      id: 'trefoil', name: 'トリプルクロス',
      desc: '3か所で立体交差するアップダウンの激しいテクニカルコース。2か所のクロスオーバーで内と外が入れ替わる。下り坂のコーナーに注意。',
      fn(u) {
        const t = TAU * (u + 0.1), S = 10, H = 3;
        return [S * (Math.sin(t) + 2 * Math.sin(2 * t)), H * (1 - Math.sin(3 * t)), S * (Math.cos(t) - 2 * Math.cos(2 * t))];
      },
    },
  ];

  // ---------------------------------------------------------------- 保存データ
  const store = {
    get(key, def) {
      try { const v = localStorage.getItem('slotcar.' + key); return v ? JSON.parse(v) : def; } catch (e) { return def; }
    },
    set(key, v) {
      try { localStorage.setItem('slotcar.' + key, JSON.stringify(v)); } catch (e) { /* 保存できなくても続行 */ }
    },
  };
  const settings = Object.assign({ course: 'fig8', level: 2, laps: 3, lane: 0 }, store.get('settings', {}));
  const records = store.get('records', {});

  // ---------------------------------------------------------------- コース生成
  function buildCourse(def) {
    const M = 8000;
    const dense = [];
    for (let i = 0; i < M; i++) dense.push(new THREE.Vector3(...def.fn(i / M)));
    const cum = [0];
    for (let i = 1; i < M; i++) cum[i] = cum[i - 1] + dense[i].distanceTo(dense[i - 1]);
    const total = cum[M - 1] + dense[0].distanceTo(dense[M - 1]);

    // 弧長で等間隔に再サンプル
    const center = [];
    let j = 0;
    for (let k = 0; k < N; k++) {
      const target = k * total / N;
      while (j < M - 1 && cum[j + 1] < target) j++;
      const segEnd = j + 1 < M ? cum[j + 1] : total;
      const f = (target - cum[j]) / (segEnd - cum[j]);
      center.push(dense[j].clone().lerp(dense[(j + 1) % M], f));
    }
    const T = [], X = [];
    for (let i = 0; i < N; i++) {
      const t = center[(i + 1) % N].clone().sub(center[(i - 1 + N) % N]).normalize();
      T.push(t);
      X.push(new THREE.Vector3(t.z, 0, -t.x).normalize());
    }
    const offA = laneOffsets(T, X, total);
    const offs = [offA, offA.map(o => -o)];
    const lanes = offs.map(off => buildLane(center, X, off));
    const box = new THREE.Box3().setFromPoints(center);
    return { def, center, T, X, length: total, lanes, offs, box };
  }

  // レーンAのオフセット（サンプルごと）。同じ向きのカーブばかりのコースでは内側レーンが有利になるので、
  // 1周に2か所クロスオーバー（レーンの入れ替え）を入れて、両レーンの曲がる量＝長さを等しくする
  const XOVER_LEN = 20;   // クロスオーバーの長さ（m）
  function laneOffsets(T, X, total) {
    const ds = total / N;
    const K = [0];        // センターラインの累積旋回角（符号付き）
    for (let i = 0; i < N; i++) {
      const dT = T[(i + 1) % N].clone().sub(T[(i - 1 + N) % N]);
      K[i + 1] = K[i] + dT.dot(X[i]) / 2;
    }
    const total_turn = K[N];
    const off = new Array(N).fill(LANE_OFF);
    if (Math.abs(total_turn) < 0.5) return off;   // フィギュア8のように左右が釣り合っていれば不要

    const kAbs = i => Math.abs(K[(i + 1) % N] + (i + 1 >= N ? total_turn : 0) - K[i]) / ds;
    const half = Math.ceil(XOVER_LEN / 2 / ds);
    const startGap = half + Math.ceil(6 / ds);    // スタートラインには重ねない
    const cyc = (a, b) => { const d = Math.abs(a - b) % N; return Math.min(d, N - d); };
    const windowMax = c => { let m = 0; for (let k = -half; k <= half; k++) m = Math.max(m, kAbs((c + k + N) % N)); return m; };
    const Kw = i => K[i % N] + Math.floor(i / N) * total_turn;

    let best = null;
    for (let i1 = 0; i1 < N; i1 += 4) {
      if (cyc(i1, 0) < startGap) continue;
      const target = Kw(i1) + total_turn / 2;
      let i2 = -1;
      for (let i = i1 + 1; i < i1 + N; i++) {
        if ((Kw(i) - target) * (Kw(i - 1) - target) <= 0) { i2 = i % N; break; }
      }
      if (i2 < 0 || cyc(i2, 0) < startGap || cyc(i1, i2) < 2 * half + 2) continue;
      const score = Math.max(windowMax(i1), windowMax(i2));
      if (!best || score < best.score) best = { i1, i2, score };
    }
    if (!best) return off;

    // i1 で + → −、i2 で − → + に、なめらか（コサイン）に入れ替える
    const inside = i => ((i - best.i1 + N) % N) < ((best.i2 - best.i1 + N) % N);
    for (let i = 0; i < N; i++) off[i] = inside(i) ? -LANE_OFF : LANE_OFF;
    for (const [c, from] of [[best.i1, LANE_OFF], [best.i2, -LANE_OFF]]) {
      for (let k = -half; k <= half; k++) {
        const t = (k + half) / (2 * half);
        off[(c + k + N) % N] = from + (-2 * from) * (1 - Math.cos(Math.PI * t)) / 2;
      }
    }
    return off;
  }

  function buildLane(center, X, off) {
    const p = center.map((c, i) => c.clone().addScaledVector(X[i], off[i]));
    const seg = [], cum = [0];
    for (let i = 0; i < N; i++) {
      seg[i] = p[i].distanceTo(p[(i + 1) % N]);
      cum[i + 1] = cum[i] + seg[i];
    }
    const length = cum[N];
    const tan = [];
    for (let i = 0; i < N; i++) tan.push(p[(i + 1) % N].clone().sub(p[(i - 1 + N) % N]).normalize());

    // 符号付き水平曲率（+ はローカルX側に曲がる）
    const raw = [];
    for (let i = 0; i < N; i++) {
      const a = (i - 1 + N) % N, b = (i + 1) % N;
      const dT = tan[b].clone().sub(tan[a]);
      raw[i] = dT.dot(X[i]) / (seg[a] + seg[i]);
    }
    const kappa = [];
    const W = 6;
    for (let i = 0; i < N; i++) {
      let s = 0;
      for (let k = -W; k <= W; k++) s += raw[(i + k + N) % N];
      kappa[i] = s / (2 * W + 1);
    }

    // CPU 用の速度プロファイル（コーナー限界速度 + ブレーキ距離）
    const prof = kappa.map(k => Math.min(PHYS.vmax, Math.sqrt(PHYS.grip / Math.max(Math.abs(k), 1e-4))));
    for (let pass = 0; pass < 3; pass++) {
      for (let i = N - 1; i >= 0; i--) {
        const v1 = prof[(i + 1) % N];
        const dec = Math.max(PHYS.kBrake * 0.3, PHYS.kBrake + PHYS.g * tan[i].y / Math.max(v1, 4));
        prof[i] = Math.min(prof[i], v1 + dec * seg[i]);
      }
    }
    return { p, seg, cum, length, tan, kappa, prof };
  }

  function sampleLane(lane, s) {
    const L = lane.length;
    let sm = s % L;
    if (sm < 0) sm += L;
    let lo = 0, hi = N;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (lane.cum[mid] <= sm) lo = mid; else hi = mid;
    }
    const i = lo, j = (lo + 1) % N;
    const f = (sm - lane.cum[i]) / lane.seg[i];
    const tan = lane.tan[i].clone().lerp(lane.tan[j], f).normalize();
    return {
      i, pos: lane.p[i].clone().lerp(lane.p[j], f), tan,
      kappa: lane.kappa[i] * (1 - f) + lane.kappa[j] * f,
    };
  }

  // ---------------------------------------------------------------- three.js 初期化
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputEncoding = THREE.sRGBEncoding;
  document.getElementById('view').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a2433);
  scene.fog = new THREE.Fog(0x1a2433, 150, 750);
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1200);

  const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x2a3326, 0.75);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(30, 60, 25);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -55, right: 55, top: 55, bottom: -55, near: 1, far: 150 });
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(2000, 2000),
    new THREE.MeshStandardMaterial({ color: 0x2c4a36, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.receiveShadow = true;
  scene.add(ground);

  // 空のグラデーション（霧の色と地平線の色をそろえる）
  const sky = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color() }, bottom: { value: new THREE.Color() } },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h = clamp(vP.y * 2.2, 0.0, 1.0); gl_FragColor = vec4(mix(bottom, top, pow(h, 0.7)), 1.0); }',
  }));
  scene.add(sky);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // ---------------------------------------------------------------- コースのメッシュ
  const MAT = {
    road: new THREE.MeshStandardMaterial({ color: 0x2b2e34, roughness: 0.85, side: THREE.DoubleSide }),
    slot: new THREE.MeshBasicMaterial({ color: 0x050505, side: THREE.DoubleSide }),
    rail: new THREE.MeshStandardMaterial({ color: 0xc88a4a, metalness: 0.8, roughness: 0.35, side: THREE.DoubleSide }),
    wall: new THREE.MeshStandardMaterial({ color: 0xe6e6e6, roughness: 0.6, side: THREE.DoubleSide }),
    skirt: new THREE.MeshStandardMaterial({ color: 0x5a5f69, roughness: 0.8, side: THREE.DoubleSide }),
    pillar: new THREE.MeshStandardMaterial({ color: 0x8b93a1, roughness: 0.7 }),
  };

  // 閉じた帯状ジオメトリ。pair(i) が [a, b] の 2 点を返す
  function strip(pair, mat) {
    const pos = new Float32Array((N + 1) * 6);
    for (let i = 0; i <= N; i++) {
      const [a, b] = pair(i % N);
      pos.set([a.x, a.y, a.z, b.x, b.y, b.z], i * 6);
    }
    const idx = [];
    for (let i = 0; i < N; i++) {
      const a0 = i * 2, b0 = a0 + 1, a1 = a0 + 2, b1 = a0 + 3;
      idx.push(a0, b0, a1, b0, b1, a1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    return m;
  }

  function orient(obj, X, T) {
    const Y = new THREE.Vector3().crossVectors(T, X).normalize();
    obj.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, T));
  }

  function checkerTexture(cols, rows) {
    const c = document.createElement('canvas');
    c.width = cols * 16; c.height = rows * 16;
    const g = c.getContext('2d');
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      g.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4';
      g.fillRect(x * 16, y * 16, 16, 16);
    }
    const t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    return t;
  }

  let trackGroup = null;
  let startLights = [];

  function buildTrackMesh(course) {
    if (trackGroup) {
      scene.remove(trackGroup);
      trackGroup.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material && !Object.values(MAT).includes(o.material)) {
          if (o.material.map) o.material.map.dispose();
          o.material.dispose();
        }
      });
    }
    const G = new THREE.Group();
    const { center: C, X } = course;
    const at = (i, off, dy = 0) => C[i].clone().addScaledVector(X[i], off).add(new THREE.Vector3(0, dy, 0));

    const road = strip(i => [at(i, HW), at(i, -HW)], MAT.road);
    road.castShadow = true;
    G.add(road);
    G.add(strip(i => [at(i, HW, -0.4), at(i, -HW, -0.4)], MAT.skirt));
    for (const side of [HW, -HW]) {
      G.add(strip(i => [at(i, side), at(i, side, 0.35)], MAT.wall));
      G.add(strip(i => [at(i, side), at(i, side, -0.4)], MAT.skirt));
    }
    for (const off of course.offs) {
      G.add(strip(i => [at(i, off[i] - 0.06, 0.015), at(i, off[i] + 0.06, 0.015)], MAT.slot));
      for (const r of [-0.2, 0.2]) G.add(strip(i => [at(i, off[i] + r - 0.045, 0.01), at(i, off[i] + r + 0.045, 0.01)], MAT.rail));
    }

    // 橋脚（下を通るコースの上には立てない）
    const step = Math.round(N / course.length * 6);
    for (let i = 0; i < N; i += step) {
      const c = C[i];
      if (c.y < 0.9) continue;
      let blocked = false;
      for (let k = 0; k < N; k += 2) {
        const d = C[k];
        if (d.y < c.y - 1.5 && Math.hypot(d.x - c.x, d.z - c.z) < HW + 0.8) { blocked = true; break; }
      }
      if (blocked) continue;
      const h = c.y - 0.4;
      const pil = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, h, 10), MAT.pillar);
      pil.position.set(c.x, h / 2, c.z);
      pil.castShadow = true;
      G.add(pil);
    }

    // スタート／フィニッシュライン + ゲート
    const line = new THREE.Mesh(new THREE.PlaneGeometry(TRACK_W, 0.8),
      new THREE.MeshStandardMaterial({ map: checkerTexture(11, 2), side: THREE.DoubleSide }));
    line.geometry.rotateX(-Math.PI / 2);
    line.position.copy(C[0]).add(new THREE.Vector3(0, 0.02, 0));
    orient(line, X[0], course.T[0]);
    G.add(line);

    const gate = new THREE.Group();
    gate.position.copy(C[0]);
    orient(gate, X[0], new THREE.Vector3(course.T[0].x, 0, course.T[0].z).normalize());
    const postMat = new THREE.MeshStandardMaterial({ color: 0x30353f, metalness: 0.4, roughness: 0.5 });
    for (const sx of [HW + 0.5, -HW - 0.5]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, 3.8, 0.3), postMat);
      post.position.set(sx, 1.9, 0);
      post.castShadow = true;
      gate.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(TRACK_W + 1.3, 0.7, 0.35),
      new THREE.MeshStandardMaterial({ map: checkerTexture(16, 2) }));
    beam.position.set(0, 3.6, 0);
    beam.castShadow = true;
    gate.add(beam);
    startLights = [];
    for (let k = 0; k < 3; k++) {
      const lm = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0x000000 });
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), lm);
      l.position.set((k - 1) * 0.7, 3.0, -0.25);
      gate.add(l);
      startLights.push(lm);
    }
    G.add(gate);

    // レーン色の目印（スタート直後）
    course.lanes.forEach((lane, k) => {
      const mark = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5),
        new THREE.MeshBasicMaterial({ color: k === 0 ? 0xffcc33 : 0x33ddff, side: THREE.DoubleSide }));
      mark.geometry.rotateX(-Math.PI / 2);
      const s = sampleLane(lane, 1.6);
      mark.position.copy(s.pos).addScaledVector(X[0], k === 0 ? 0.55 : -0.55).add(new THREE.Vector3(0, 0.02, 0));
      orient(mark, X[0], course.T[0]);
      G.add(mark);
    });

    buildScenery(course, G);
    trackGroup = G;
    scene.add(G);
  }

  // ---------------------------------------------------------------- 背景（コースごとのテーマ）
  const THEMES = {
    // フィギュア8：昼の田園と山
    fig8: {
      skyTop: 0x3f86d6, skyBottom: 0xd4e8f5, ground: 0x5d9446,
      sun: [0xfff3dc, 1.0, [40, 70, 30]], hemi: [0xe3f0ff, 0x56663f, 0.7],
      mountain: [0x5f8a62, 0x7d9a77], snowCaps: 0.4, hills: 0x6ea255,
      trees: 'round', treeCount: 220, houses: 14, houseRoofs: [0xc0392b, 0x2e6fb0, 0x8e5a2b, 0x3f7f4f],
      clouds: 0xffffff, pond: 0x4f86b0,
    },
    // オーバル：夕暮れのスタジアムと街
    oval: {
      skyTop: 0x262a5a, skyBottom: 0xf3955a, ground: 0x47703e,
      sun: [0xffb47a, 0.85, [-60, 35, 20]], hemi: [0x9a8ac8, 0x3a4a30, 0.75],
      mountain: [0x5a4a66, 0x6a5672], snowCaps: 0, city: 70,
      trees: 'round', treeCount: 70, stands: true, towers: true,
    },
    // トリプルクロス：雪山
    trefoil: {
      skyTop: 0x6f9fd8, skyBottom: 0xeef4fa, ground: 0xe9eff4,
      sun: [0xffffff, 0.95, [30, 60, -40]], hemi: [0xeaf3ff, 0x9aa8b6, 0.7],
      mountain: [0x7a8494, 0x8d96a3], snowCaps: 1, peaksNear: true,
      trees: 'pine', treeCount: 260, houses: 8, houseWall: 0x7a4a2a, houseRoofs: [0xf4f7fa],
      pond: 0x9fd3ee,
    },
  };

  function mulberry32(a) {
    return () => {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const lin = hex => new THREE.Color(hex).convertSRGBToLinear();

  function windowTexture(rand) {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#2a2f3c';
    g.fillRect(0, 0, 64, 128);
    for (let y = 4; y < 128; y += 12) for (let x = 4; x < 64; x += 10) {
      g.fillStyle = rand() < 0.55 ? '#ffd88a' : '#151821';
      g.fillRect(x, y, 6, 7);
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.encoding = THREE.sRGBEncoding;
    return t;
  }

  function crowdTexture(rand) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#3a3f4a';
    g.fillRect(0, 0, 256, 64);
    const cols = ['#e74c3c', '#f1c40f', '#3498db', '#ecf0f1', '#2ecc71', '#e67e22', '#9b59b6', '#1abc9c'];
    for (let y = 3; y < 64; y += 8) for (let x = 2; x < 256; x += 5) {
      if (rand() < 0.15) continue;
      g.fillStyle = cols[Math.floor(rand() * cols.length)];
      g.fillRect(x + rand() * 2, y + rand() * 2, 3, 5);
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = THREE.RepeatWrapping;
    t.encoding = THREE.sRGBEncoding;
    return t;
  }

  function buildScenery(course, G) {
    const th = THEMES[course.def.id] || THEMES.fig8;
    const rand = mulberry32(course.def.id.length * 977 + 13);
    const rr = (a, b) => a + rand() * (b - a);

    // 空・霧・光・地面
    const horizon = new THREE.Color(th.skyBottom);
    sky.material.uniforms.top.value.set(th.skyTop);
    sky.material.uniforms.bottom.value.copy(horizon);
    scene.fog.color.copy(horizon).convertSRGBToLinear();
    scene.background.copy(horizon);
    ground.material.color.copy(lin(th.ground));
    sun.color.set(th.sun[0]);
    sun.intensity = th.sun[1];
    sun.position.set(...th.sun[2]);
    hemi.color.set(th.hemi[0]);
    hemi.groundColor.set(th.hemi[1]);
    hemi.intensity = th.hemi[2];

    const ctr = course.box.getCenter(new THREE.Vector3());
    const C = course.center;
    // コース（とスタートゲート）から r 以上離れているか
    const blocked = [];   // [x, z, 半径] 物を置かない場所
    const clearOf = (x, z, r) => {
      for (const [bx, bz, br] of blocked) if (Math.hypot(bx - x, bz - z) < br + r) return false;
      for (let i = 0; i < N; i += 6) {
        if (Math.hypot(C[i].x - x, C[i].z - z) < HW + r + 1.5) return false;
      }
      return true;
    };
    const scatter = (count, rMin, rMax, clear, fn, tries = 8) => {
      for (let n = 0; n < count; n++) {
        for (let t = 0; t < tries; t++) {
          const a = rand() * TAU, r = Math.sqrt(rr(rMin * rMin, rMax * rMax));
          const x = ctr.x + Math.cos(a) * r, z = ctr.z + Math.sin(a) * r;
          if (clearOf(x, z, clear)) { fn(x, z, a, r); break; }
        }
      }
    };
    // スタンドの位置（スタートラインの外側）を先に決めて、木などを置かないようにする
    let standOut = null;
    if (th.stands) {
      standOut = course.X[0].clone();
      if (C[0].clone().add(standOut).distanceTo(ctr) < C[0].distanceTo(ctr)) standOut.negate();
      const p = C[0].clone().addScaledVector(standOut, HW + 9);
      blocked.push([p.x, p.z, 24]);
    }
    const mesh = (geo, mat, shadow = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = shadow;
      m.receiveShadow = shadow;
      G.add(m);
      return m;
    };

    // 遠くの山
    const mMats = th.mountain.map(c => new THREE.MeshStandardMaterial({ color: lin(c), flatShading: true, roughness: 1 }));
    const snowMat = new THREE.MeshStandardMaterial({ color: lin(0xf6f9fc), flatShading: true, roughness: 0.9 });
    const addMountain = (x, z, h, r) => {
      const m = mesh(new THREE.ConeGeometry(r, h, 7, 1), mMats[Math.floor(rand() * mMats.length)], false);
      m.position.set(x, h / 2 - 1, z);
      m.rotation.y = rand() * TAU;
      if (rand() < th.snowCaps) {
        const k = 0.32;
        const cap = mesh(new THREE.ConeGeometry(r * k * 1.03, h * k, 7, 1), snowMat, false);
        cap.position.set(x, h - 1 - h * k / 2 + 0.2, z);
        cap.rotation.y = m.rotation.y;
      }
    };
    for (let n = 0; n < 26; n++) {
      const a = n / 26 * TAU + rr(-0.1, 0.1), r = rr(320, 480);
      addMountain(ctr.x + Math.cos(a) * r, ctr.z + Math.sin(a) * r, rr(70, 170), rr(70, 130));
    }
    if (th.peaksNear) {
      for (let n = 0; n < 10; n++) {
        const a = rand() * TAU, r = rr(150, 230);
        addMountain(ctr.x + Math.cos(a) * r, ctr.z + Math.sin(a) * r, rr(45, 90), rr(30, 55));
      }
    }

    // なだらかな丘
    if (th.hills) {
      const hm = new THREE.MeshStandardMaterial({ color: lin(th.hills), flatShading: true, roughness: 1 });
      for (let n = 0; n < 14; n++) {
        const a = rand() * TAU, r = rr(170, 270);
        const h = mesh(new THREE.IcosahedronGeometry(1, 1), hm, false);
        const s = rr(18, 34);
        h.scale.set(s, s * rr(0.25, 0.4), s * rr(0.8, 1.3));
        h.position.set(ctr.x + Math.cos(a) * r, 0, ctr.z + Math.sin(a) * r);
      }
    }

    // 池・凍った湖
    if (th.pond) {
      const pm = new THREE.MeshStandardMaterial({ color: lin(th.pond), roughness: 0.15, metalness: 0.2 });
      scatter(1, 25, 70, 12, (x, z) => {
        const p = mesh(new THREE.CircleGeometry(10, 32), pm, false);
        p.rotation.x = -Math.PI / 2;
        p.scale.set(1.3, 0.9, 1);
        p.position.set(x, -0.03, z);
        p.receiveShadow = true;
      }, 40);
    }

    // 木（インスタンス描画）
    const spots = [];
    scatter(th.treeCount, 0, 140, 1.5, (x, z) => spots.push([x, z, rr(0.7, 1.4)]));
    const trunkM = new THREE.MeshStandardMaterial({ color: lin(0x6b4a2f), roughness: 1 });
    const parts = th.trees === 'pine'
      ? [[new THREE.CylinderGeometry(0.35, 0.45, 2, 6), trunkM, 1],
         [new THREE.ConeGeometry(2.6, 5, 7), new THREE.MeshStandardMaterial({ color: lin(0x2d5a3c), flatShading: true }), 4],
         [new THREE.ConeGeometry(1.6, 2.4, 7), snowMat, 6.6]]
      : [[new THREE.CylinderGeometry(0.35, 0.45, 2.4, 6), trunkM, 1.2],
         [new THREE.IcosahedronGeometry(2.2, 0), new THREE.MeshStandardMaterial({ color: lin(0x3f7d3a), flatShading: true }), 3.8]];
    const mtx = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), ps = new THREE.Vector3();
    const tint = new THREE.Color();
    parts.forEach(([geo, mat, y], pi) => {
      const im = new THREE.InstancedMesh(geo, mat, spots.length);
      im.castShadow = true;
      spots.forEach(([x, z, s], k) => {
        q.setFromAxisAngle(UP, k * 1.7);
        mtx.compose(ps.set(x, y * s, z), q, sc.set(s, s, s));
        im.setMatrixAt(k, mtx);
        if (pi === 1) im.setColorAt(k, tint.setHSL(0, 0, 0.8 + ((k * 37) % 10) / 25));
      });
      G.add(im);
    });

    // 家・山小屋
    if (th.houses) {
      const wall = new THREE.MeshStandardMaterial({ color: lin(th.houseWall || 0xf1e7d2), roughness: 0.9 });
      const roofs = th.houseRoofs.map(c => new THREE.MeshStandardMaterial({ color: lin(c), flatShading: true }));
      scatter(th.houses, 30, 110, 5, (x, z) => {
        const w = rr(4, 7), h = rr(2.8, 4), d = rr(4, 6), rot = rand() * TAU;
        const b = mesh(new THREE.BoxGeometry(w, h, d), wall);
        b.position.set(x, h / 2, z);
        b.rotation.y = rot;
        const roof = mesh(new THREE.ConeGeometry(1, 2.4, 4), roofs[Math.floor(rand() * roofs.length)]);
        roof.rotation.y = rot + Math.PI / 4;
        roof.scale.set(w * 0.8, 1, d * 0.8);
        roof.position.set(x, h + 1.2, z);
      }, 30);
    }

    // 雲
    if (th.clouds) {
      const cm = new THREE.MeshStandardMaterial({ color: th.clouds, flatShading: true, roughness: 1, emissive: 0x666666 });
      for (let n = 0; n < 12; n++) {
        const a = rand() * TAU, r = rr(80, 300), y = rr(55, 95);
        const cx = ctr.x + Math.cos(a) * r, cz = ctr.z + Math.sin(a) * r;
        for (let k = 0; k < 4; k++) {
          const c = mesh(new THREE.IcosahedronGeometry(rr(6, 11), 0), cm, false);
          c.position.set(cx + rr(-12, 12), y + rr(-2, 2), cz + rr(-6, 6));
          c.scale.y = 0.55;
        }
      }
    }

    // 街のビル（夕暮れで窓が光る）
    if (th.city) {
      const tex = windowTexture(rand);
      for (let n = 0; n < th.city; n++) {
        const a = rand() * TAU, r = rr(110, 210);
        const w = rr(8, 18), h = rr(14, 70), d = rr(8, 18);
        const geo = new THREE.BoxGeometry(w, h, d);
        const uv = geo.attributes.uv;
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / 6, uv.getY(i) * h / 12);
        const b = mesh(geo, new THREE.MeshStandardMaterial({
          map: tex, emissive: 0xffc070, emissiveMap: tex, emissiveIntensity: 0.55, roughness: 0.7,
        }), false);
        b.position.set(ctr.x + Math.cos(a) * r, h / 2, ctr.z + Math.sin(a) * r);
        b.rotation.y = rand() * TAU;
      }
    }

    // メインスタンド（スタートラインの外側）
    if (standOut) {
      const out = standOut;
      const st = new THREE.Group();
      st.position.copy(C[0]).addScaledVector(out, HW + 3.5);
      st.position.y = 0;
      orient(st, out, new THREE.Vector3().crossVectors(out, UP));   // ローカルX = 外向き、Y = 上
      const gray = new THREE.MeshStandardMaterial({ color: lin(0x9aa0aa), roughness: 0.9 });
      const LEN = 40, TIERS = 7;
      const crowd = new THREE.MeshStandardMaterial({ map: crowdTexture(rand) });
      crowd.map.repeat.set(4, 1);
      for (let k = 0; k < TIERS; k++) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.8 * (k + 1), LEN), gray);
        b.position.set(k * 1.4 + 0.7, 0.4 * (k + 1), 0);
        b.castShadow = b.receiveShadow = true;
        st.add(b);
        const p = new THREE.Mesh(new THREE.PlaneGeometry(LEN, 0.8), crowd);
        p.rotation.y = -Math.PI / 2;
        p.position.set(k * 1.4 - 0.01, 0.8 * (k + 1) - 0.4, 0);
        st.add(p);
      }
      const roof = new THREE.Mesh(new THREE.BoxGeometry(TIERS * 1.4 + 1.5, 0.3, LEN + 2),
        new THREE.MeshStandardMaterial({ color: lin(0xd8dde4) }));
      roof.position.set(TIERS * 1.4 / 2, 0.8 * TIERS + 3.2, 0);
      roof.rotation.z = -0.08;
      roof.castShadow = true;
      st.add(roof);
      for (const z of [-LEN / 2, 0, LEN / 2]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.8 * TIERS + 3.2, 0.4), gray);
        post.position.set(TIERS * 1.4 + 0.4, (0.8 * TIERS + 3.2) / 2, z);
        st.add(post);
      }
      G.add(st);
    }

    // 照明塔
    if (th.towers) {
      const pm = new THREE.MeshStandardMaterial({ color: lin(0x777d88), metalness: 0.5 });
      const lm = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff3c8, emissiveIntensity: 1 });
      const size = course.box.getSize(new THREE.Vector3());
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const x = ctr.x + sx * (size.x / 2 + 8), z = ctr.z + sz * (size.z / 2 + 8);
        const pole = mesh(new THREE.CylinderGeometry(0.35, 0.5, 22, 8), pm);
        pole.position.set(x, 11, z);
        const lamp = mesh(new THREE.BoxGeometry(4, 2, 0.6), lm, false);
        lamp.position.set(x, 22.5, z);
        lamp.lookAt(ctr.x, 0, ctr.z);
      }
    }
  }

  function setStartLights(nOn, green) {
    startLights.forEach((m, k) => {
      if (green) { m.color.set(0x003300); m.emissive.set(0x22ff44); }
      else if (k < nOn) { m.color.set(0x330000); m.emissive.set(0xff2a1a); }
      else { m.color.set(0x220000); m.emissive.set(0x000000); }
    });
  }

  // ---------------------------------------------------------------- 車
  function numberTexture(num, color) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.beginPath(); g.arc(32, 32, 30, 0, TAU); g.fill();
    g.fillStyle = color;
    g.font = 'bold 44px sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(num, 32, 35);
    const t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    return t;
  }

  function makeCarMesh(color, num) {
    const pivot = new THREE.Group();     // スロットのガイド位置（車の先端付近）
    const yaw = new THREE.Group();       // テールスライド用
    pivot.add(yaw);
    const paint = new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x141a24, metalness: 0.6, roughness: 0.2 });
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
    const tire = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
    const rim = new THREE.MeshStandardMaterial({ color: 0xbfc5cc, metalness: 0.8, roughness: 0.3 });
    const add = (geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      yaw.add(m);
      return m;
    };
    add(new THREE.BoxGeometry(1.15, 0.3, 2.1), paint, 0, 0.32, -0.95);
    add(new THREE.BoxGeometry(1.05, 0.12, 0.5), paint, 0, 0.42, -0.05).rotation.x = 0.25;
    add(new THREE.BoxGeometry(0.86, 0.32, 0.95), dark, 0, 0.62, -1.12);
    add(new THREE.BoxGeometry(0.28, 0.02, 2.12), white, 0, 0.475, -0.95);
    add(new THREE.BoxGeometry(1.2, 0.06, 0.32), paint, 0, 0.82, -1.92);
    for (const sx of [0.4, -0.4]) add(new THREE.BoxGeometry(0.06, 0.3, 0.12), dark, sx, 0.62, -1.9);
    for (const sx of [0.35, -0.35]) {
      add(new THREE.BoxGeometry(0.22, 0.08, 0.04), new THREE.MeshStandardMaterial({ color: 0xfff6c0, emissive: 0x665e30 }), sx, 0.34, 0.11);
    }
    const plate = add(new THREE.PlaneGeometry(0.5, 0.5),
      new THREE.MeshStandardMaterial({ map: numberTexture(num, '#' + color.toString(16).padStart(6, '0')), transparent: true }), 0, 0.49, -0.5);
    plate.rotation.x = -Math.PI / 2;
    plate.rotation.z = Math.PI;
    plate.castShadow = false;

    const wheels = [];
    for (const z of [-0.35, -1.6]) for (const sx of [0.62, -0.62]) {
      const w = new THREE.Group();
      w.position.set(sx, 0.25, z);
      const t = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.22, 18), tire);
      t.rotation.z = Math.PI / 2;
      t.castShadow = true;
      const r = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.24, 8), rim);
      r.rotation.z = Math.PI / 2;
      w.add(t, r);
      yaw.add(w);
      wheels.push(w);
    }
    scene.add(pivot);
    return { pivot, yaw, wheels };
  }

  class Car {
    constructor(name, color, num, isCPU) {
      this.name = name;
      this.isCPU = isCPU;
      this.mesh = makeCarMesh(color, num);
      this.reset(0);
    }
    reset(lane) {
      this.lane = lane;
      this.s = 0; this.v = 0; this.throttle = 0;
      this.slip = 0; this.slipSign = 1;
      this.state = 'run'; this.offT = 0; this.blink = 0;
      this.lap = 0; this.lapStart = 0; this.lapTimes = [];
      this.finished = false; this.finishTime = 0;
      this.deslots = 0;
      this.checkTimes = [];
      this.aiFactor = 1; this.mistakeAt = -1;
      this.mesh.pivot.visible = true;
    }
  }

  const player = new Car('YOU', 0xe0312b, '1', false);
  const cpu = new Car('CPU', 0x2f6fe0, '2', true);
  const cars = [player, cpu];

  // ---------------------------------------------------------------- 入力
  const keys = new Set();
  let kbThrottle = 0;
  const THROTTLE_KEYS = ['Space', 'ArrowUp', 'KeyW'];
  window.addEventListener('keydown', e => {
    if (THROTTLE_KEYS.includes(e.code)) e.preventDefault();
    if (e.repeat) return;
    keys.add(e.code);
    onKey(e.code);
  });
  window.addEventListener('keyup', e => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  const pad = { trigger: 0, prev: [], connected: false, name: '' };
  function pollPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null;
    for (const p of pads) if (p && p.connected) { gp = p; break; }
    if (!gp) {
      if (pad.connected) { pad.connected = false; updatePadInfo(); }
      pad.trigger = 0;
      return;
    }
    if (!pad.connected || pad.name !== gp.id) { pad.connected = true; pad.name = gp.id; updatePadInfo(); }
    const b = gp.buttons;
    pad.trigger = b[7] ? b[7].value : 0;     // 右トリガー（標準マッピング）
    const pressed = i => b[i] && b[i].pressed && !pad.prev[i];
    if (pressed(0)) onKey('PadA');
    if (pressed(1)) onKey('PadB');
    if (pressed(3)) onKey('KeyC');
    if (pressed(9)) onKey('Escape');
    pad.prev = b.map(x => x.pressed);
  }
  function updatePadInfo() {
    document.getElementById('padInfo').textContent = pad.connected
      ? 'ゲームパッド接続中：' + pad.name + '（右トリガーでアクセル）'
      : 'ゲームパッド未接続（ボタンを押すと認識します）';
  }

  // スマホ用の仮想ボタン。アクセルは押す位置で強さが変わる（下端 30% ～ 上端 100%）
  const touch = { throttle: 0, id: null };
  function initTouch() {
    const markTouch = () => document.body.classList.add('touch');
    if (window.matchMedia && matchMedia('(pointer: coarse)').matches) markTouch();
    window.addEventListener('touchstart', markTouch, { once: true, passive: true });

    const pedal = document.getElementById('pedal');
    const fill = document.getElementById('pedalFill');
    const setFrom = e => {
      const r = pedal.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (r.bottom - e.clientY) / r.height));
      touch.throttle = 0.3 + 0.7 * Math.min(1, f * 1.1);
      fill.style.height = (touch.throttle * 100) + '%';
    };
    const release = e => {
      if (e.pointerId !== touch.id) return;
      touch.id = null; touch.throttle = 0;
      fill.style.height = '0';
      pedal.classList.remove('on');
    };
    pedal.addEventListener('pointerdown', e => {
      e.preventDefault();
      touch.id = e.pointerId;
      pedal.setPointerCapture(e.pointerId);
      pedal.classList.add('on');
      setFrom(e);
    });
    pedal.addEventListener('pointermove', e => { if (e.pointerId === touch.id) setFrom(e); });
    pedal.addEventListener('pointerup', release);
    pedal.addEventListener('pointercancel', release);
    pedal.addEventListener('lostpointercapture', release);
    pedal.addEventListener('contextmenu', e => e.preventDefault());

    document.querySelectorAll('#touchBtns button').forEach(b => b.addEventListener('click', () => onKey(b.dataset.k)));
    updateSoundIcon();

    // レース中に縦向きにされたら一時停止する（横画面前提）
    if (window.matchMedia) matchMedia('(orientation: portrait)').addEventListener('change', e => {
      if (e.matches && document.body.classList.contains('touch') && (state === 'race' || state === 'countdown')) togglePause();
    });
  }
  function updateSoundIcon() {
    document.getElementById('touchSound').textContent = audio.on ? '🔊' : '🔇';
  }

  function readThrottle(dt) {
    const held = THROTTLE_KEYS.some(k => keys.has(k));
    // キーボードはオン／オフなので少しだけなめらかにする
    kbThrottle = held ? Math.min(1, kbThrottle + dt * 6) : Math.max(0, kbThrottle - dt * 10);
    const t = Math.max(kbThrottle, pad.trigger < 0.03 ? 0 : pad.trigger, touch.throttle);
    return Math.min(1, t);
  }

  // ---------------------------------------------------------------- サウンド
  const audio = { ctx: null, on: store.get('sound', true), voices: [], skid: null };
  function initAudio() {
    if (audio.ctx) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const master = ctx.createGain();
      master.gain.value = 0.6;
      master.connect(ctx.destination);
      for (let k = 0; k < 2; k++) {
        const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
        o1.type = 'sawtooth'; o2.type = 'square';
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass'; f.frequency.value = 1100;
        const g = ctx.createGain();
        g.gain.value = 0;
        o1.connect(f); o2.connect(f); f.connect(g); g.connect(master);
        o1.start(); o2.start();
        audio.voices.push({ o1, o2, g });
      }
      const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 2400; bp.Q.value = 2;
      const sg = ctx.createGain();
      sg.gain.value = 0;
      src.connect(bp); bp.connect(sg); sg.connect(master);
      src.start();
      audio.skid = sg;
      audio.ctx = ctx;
    } catch (e) { audio.ctx = null; }
  }
  function updateAudio(active) {
    if (!audio.ctx) return;
    const t = audio.ctx.currentTime;
    cars.forEach((car, k) => {
      const v = audio.voices[k];
      const f = 45 + car.v * 9;
      v.o1.frequency.setTargetAtTime(f, t, 0.03);
      v.o2.frequency.setTargetAtTime(f * 1.505, t, 0.03);
      const on = audio.on && active && car.state === 'run';
      const vol = on ? (car === player ? 0.05 : 0.025) * (0.2 + 0.8 * Math.max(car.throttle, car.v / PHYS.vmax * 0.5)) : 0;
      v.g.gain.setTargetAtTime(vol, t, 0.05);
    });
    const skid = audio.on && active && player.state === 'run' ? Math.min(1, player.slip) * 0.12 : 0;
    audio.skid.gain.setTargetAtTime(skid, t, 0.03);
  }

  // ---------------------------------------------------------------- ゲーム状態
  let course = null;
  let state = 'menu';         // menu | countdown | race | paused | result
  let pausedFrom = null;
  let raceTime = 0;
  let countdown = 0;
  let resultDelay = -1;
  let camMode = 1;
  const CAM_MODES = ['tv', 'chase', 'top'];
  const CHECKPOINTS = 20;
  let level = LEVELS[2];
  let msgTimer = 0;

  const $ = id => document.getElementById(id);
  const el = {
    hud: $('hud'), menu: $('menu'), pause: $('pause'), result: $('result'),
    lapP: $('hudLapP'), lapC: $('hudLapC'), time: $('hudTime'), lapTime: $('hudLapTime'), best: $('hudBest'),
    speed: $('hudSpeed'), thr: $('throttleBar'), slip: $('slipBar'), gap: $('hudGap'), pos: $('hudPos'),
    cpuLevel: $('hudCpuLevel'), lapLog: $('lapLog'), big: $('bigMsg'),
  };

  function fmt(t) {
    if (!isFinite(t) || t <= 0) return '--:--.---';
    const m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(3);
  }

  function showMsg(text, dur, small) {
    el.big.textContent = text;
    el.big.className = small ? 'small' : '';
    msgTimer = dur;
  }

  function loadCourse(id) {
    const def = COURSES.find(c => c.id === id) || COURSES[0];
    course = buildCourse(def);
    buildTrackMesh(course);
    placeCarsAtStart();
  }

  function placeCarsAtStart() {
    player.reset(settings.lane);
    cpu.reset(1 - settings.lane);
    for (const car of cars) updateCarMesh(car, 0);
    setStartLights(0, false);
  }

  function startRace() {
    initAudio();
    if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
    level = LEVELS[settings.level];
    placeCarsAtStart();
    rollAi(cpu);
    raceTime = 0;
    countdown = 0;
    resultDelay = -1;
    kbThrottle = 0;
    state = 'countdown';
    el.menu.classList.add('hidden');
    el.result.classList.add('hidden');
    el.pause.classList.add('hidden');
    el.hud.classList.remove('hidden');
    el.cpuLevel.textContent = 'CPU：' + level.name;
    el.lapLog.innerHTML = '';
    el.big.textContent = '';
    snapCamera = true;
  }

  function toMenu() {
    state = 'menu';
    el.hud.classList.add('hidden');
    el.result.classList.add('hidden');
    el.pause.classList.add('hidden');
    el.menu.classList.remove('hidden');
    placeCarsAtStart();
    renderMenu();
    showAds();
  }

  function togglePause() {
    if (state === 'countdown' || state === 'race') {
      pausedFrom = state;
      state = 'paused';
      el.pause.classList.remove('hidden');
    } else if (state === 'paused') {
      state = pausedFrom;
      el.pause.classList.add('hidden');
    }
  }

  function onKey(code) {
    if (code === 'KeyM') { audio.on = !audio.on; store.set('sound', audio.on); updateSoundIcon(); }
    if (code === 'KeyC' && state !== 'menu') { camMode = (camMode + 1) % CAM_MODES.length; snapCamera = true; }
    if (state === 'menu' && (code === 'Enter' || code === 'PadA')) startRace();
    else if (state === 'result') {
      if (code === 'KeyR' || code === 'Enter' || code === 'PadA') startRace();
      else if (code === 'Escape' || code === 'PadB') toMenu();
    } else if (code === 'Escape') togglePause();
    else if (state === 'paused' && code === 'PadB') toMenu();
  }

  // ---------------------------------------------------------------- CPU
  function rollAi(car) {
    car.aiFactor = level.factor * (1 + (Math.random() * 2 - 1) * level.noise);
    car.mistakeAt = Math.random() < level.mistake ? Math.random() * course.lanes[car.lane].length : -1;
  }

  function aiThrottle(car, factor) {
    const lane = course.lanes[car.lane];
    const L = lane.length;
    const sm = ((car.s % L) + L) % L;
    const info = sampleLane(lane, car.s);
    const look = car.v * level.react + 0.8;
    let vt = Infinity, d = 0, i = info.i;
    while (d < look) {
      vt = Math.min(vt, lane.prof[i]);
      d += lane.seg[i];
      i = (i + 1) % N;
    }
    let f = factor;
    if (car.mistakeAt >= 0) {
      const dd = ((sm - car.mistakeAt) % L + L) % L;
      if (dd < 30) f *= 1.13;     // 突っ込みすぎるミス
    }
    vt *= f;
    const top = car === player ? 1 : level.top;
    return Math.max(0, Math.min(top, vt / PHYS.vmax + (vt - car.v) * 0.15));
  }

  // ---------------------------------------------------------------- 物理
  const tmpQ = new THREE.Quaternion();

  function stepCar(car, dt, throttle) {
    if (car.state === 'off') {
      stepOff(car, dt);
      return;
    }
    if (car.blink > 0) car.blink -= dt;
    const lane = course.lanes[car.lane];
    const info = sampleLane(lane, car.s);
    car.throttle = throttle;
    const target = throttle * PHYS.vmax;
    const k = target > car.v ? PHYS.kAcc : PHYS.kBrake;
    const a = (target - car.v) * k - PHYS.g * info.tan.y;
    car.v = Math.max(0, car.v + a * dt);
    car.s += car.v * dt;

    const lat = car.v * car.v * Math.abs(info.kappa);
    const ex = (lat - PHYS.grip) / PHYS.grip;
    if (ex > 0) {
      car.slip += ex * PHYS.slipGain * dt;
      car.slipSign = Math.sign(info.kappa) || 1;
    } else {
      car.slip = Math.max(0, car.slip - PHYS.slipDecay * dt);
    }
    if (car.slip >= 1) deslot(car, info);
  }

  function deslot(car, info) {
    car.state = 'off';
    car.offT = 0;
    car.deslots++;
    const out = info.tan.clone().multiplyScalar(car.v * 0.85);
    out.y += 3 + car.v * 0.08;
    car.fly = {
      pos: car.mesh.pivot.position.clone(),
      vel: out,
      spin: new THREE.Vector3((Math.random() - 0.5) * 8, car.slipSign * (6 + Math.random() * 6), (Math.random() - 0.5) * 10),
    };
    if (car.mistakeAt >= 0) car.mistakeAt = -1;
    car.v = 0;
    car.slip = 0;
    if (car === player) showMsg('コースアウト！', 1.4, true);
  }

  function stepOff(car, dt) {
    const f = car.fly;
    car.offT += dt;
    f.vel.y -= 28 * dt;
    f.pos.addScaledVector(f.vel, dt);
    if (f.pos.y < 0) {
      f.pos.y = 0;
      f.vel.y = Math.abs(f.vel.y) * 0.3;
      f.vel.x *= 0.55; f.vel.z *= 0.55;
      f.spin.multiplyScalar(0.6);
    }
    const p = car.mesh.pivot;
    p.position.copy(f.pos);
    const ang = f.spin.length() * dt;
    if (ang > 1e-5) {
      tmpQ.setFromAxisAngle(f.spin.clone().normalize(), ang);
      p.quaternion.premultiply(tmpQ);
    }
    if (car.offT > 1.8) {
      // コースマーシャルが車を戻す
      car.state = 'run';
      car.blink = 1.0;
      car.mesh.yaw.rotation.y = 0;
      updateCarMesh(car, 0);
    }
  }

  function updateCarMesh(car, dt) {
    if (car.state === 'off') return;
    const info = sampleLane(course.lanes[car.lane], car.s);
    const p = car.mesh.pivot;
    p.position.copy(info.pos);
    p.lookAt(info.pos.clone().add(info.tan));
    const yawT = Math.min(1, car.slip) * PHYS.maxYaw * car.slipSign;
    car.mesh.yaw.rotation.y += (yawT - car.mesh.yaw.rotation.y) * Math.min(1, dt * 20);
    for (const w of car.mesh.wheels) w.rotation.x = car.s / 0.25;
    p.visible = car.blink > 0 ? Math.floor(car.blink * 12) % 2 === 0 : true;
  }

  function progressOf(car) {
    const L = course.lanes[car.lane].length;
    return car.s / L;
  }

  function updateLaps(car) {
    const L = course.lanes[car.lane].length;
    const prog = car.s / L;
    const cp = Math.floor(prog * CHECKPOINTS);
    while (car.checkTimes.length <= cp) car.checkTimes.push(raceTime);
    const done = Math.floor(prog);
    if (done > car.lap && !car.finished) {
      const over = (car.s - done * L) / Math.max(car.v, 0.01);
      const tCross = raceTime - Math.min(over, 0.1);
      car.lapTimes.push(tCross - car.lapStart);
      car.lapStart = tCross;
      car.lap = done;
      if (car === player) logLap();
      if (car.lap >= settings.laps) {
        car.finished = true;
        car.finishTime = tCross;
        if (car === player) showMsg(cpu.finished ? 'FINISH' : 'WIN!', 2.5);
        else if (!player.finished) showMsg('CPU ゴール', 1.5, true);
      } else {
        if (car.isCPU) rollAi(car);
        if (car === player && car.lap === settings.laps - 1) showMsg('FINAL LAP', 1.4, true);
      }
    }
  }

  function logLap() {
    const best = Math.min(...player.lapTimes);
    el.lapLog.innerHTML = player.lapTimes.map((t, k) =>
      `<div class="${t === best ? 'best' : ''}">L${k + 1}　${fmt(t)}</div>`).slice(-8).join('');
  }

  // ---------------------------------------------------------------- メインループ
  let last = performance.now();
  let snapCamera = true;
  let menuAngle = 0;

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    pollPad();
    const throttleIn = readThrottle(dt);

    if (state === 'countdown') {
      countdown += dt;
      const n = Math.min(3, Math.floor(countdown / 0.8));
      setStartLights(n, false);
      if (countdown < 2.4) {
        const label = String(3 - n);
        if (el.big.textContent !== label) showMsg(label, 1);
      } else {
        setStartLights(3, true);
        showMsg('GO!', 0.8);
        state = 'race';
      }
      player.throttle = throttleIn;
    } else if (state === 'race') {
      const SUB = 4, h = dt / SUB;
      for (let k = 0; k < SUB; k++) {
        raceTime += h;
        stepCar(player, h, player.finished ? aiThrottle(player, 0.7) : throttleIn);
        stepCar(cpu, h, aiThrottle(cpu, cpu.finished ? 0.75 : cpu.aiFactor));
        updateLaps(player);
        updateLaps(cpu);
      }
      if (raceTime > 3) setStartLights(0, false);
      if (player.finished && cpu.finished && resultDelay < 0) resultDelay = 1.8;
      if (resultDelay >= 0) {
        resultDelay -= dt;
        if (resultDelay < 0) showResult();
      }
    }

    if (state !== 'paused') {
      for (const car of cars) updateCarMesh(car, dt);
    }
    if (msgTimer > 0) {
      msgTimer -= dt;
      if (msgTimer <= 0) el.big.textContent = '';
    }
    updateCamera(dt);
    if (state === 'race' || state === 'countdown' || state === 'paused') updateHud(throttleIn);
    updateAudio(state === 'race' || state === 'countdown');
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }

  function updateHud(throttleIn) {
    const total = settings.laps;
    el.lapP.textContent = `LAP ${Math.min(player.lap + 1, total)}/${total}`;
    el.lapC.textContent = `LAP ${Math.min(cpu.lap + 1, total)}/${total}`;
    const t = player.finished ? player.finishTime : raceTime;
    el.time.textContent = fmt(t) === '--:--.---' ? '0:00.000' : fmt(t);
    el.lapTime.textContent = player.finished ? fmt(player.lapTimes[player.lapTimes.length - 1]) : fmt(raceTime - player.lapStart);
    el.best.textContent = player.lapTimes.length ? fmt(Math.min(...player.lapTimes)) : '--:--.---';
    el.speed.textContent = Math.round(player.v * 3.6);
    el.thr.style.width = (player.finished ? 0 : (state === 'race' ? player.throttle : throttleIn) * 100) + '%';
    el.slip.style.width = Math.min(100, player.slip * 100) + '%';

    const k = Math.min(player.checkTimes.length, cpu.checkTimes.length) - 1;
    if (k >= 1 && state === 'race') {
      const g = player.checkTimes[k] - cpu.checkTimes[k];
      el.gap.textContent = (g > 0 ? '+' : g < 0 ? '−' : '±') + Math.abs(g).toFixed(2) + '秒';
    } else el.gap.textContent = '--';
    let first;
    if (player.finished || cpu.finished) first = !cpu.finished || (player.finished && player.finishTime <= cpu.finishTime);
    else first = progressOf(player) >= progressOf(cpu);
    el.pos.textContent = first ? 'あなた 1位' : 'あなた 2位';
  }

  // ---------------------------------------------------------------- カメラ
  const camLook = new THREE.Vector3();
  function updateCamera(dt) {
    const box = course.box;
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const R = Math.max(size.x, size.z);
    const p = player.mesh.pivot.position;
    const smooth = snapCamera ? 1 : 1 - Math.exp(-dt * 4);
    let pos, look;

    // メニュー表示中は左のパネルを避けて、コースを画面右寄りに描く
    const shift = state === 'menu' ? Math.min(260, window.innerWidth * 0.2) : 0;
    if (shift) camera.setViewOffset(window.innerWidth, window.innerHeight, -shift, 0, window.innerWidth, window.innerHeight);
    else if (camera.view && camera.view.enabled) camera.clearViewOffset();

    if (state === 'menu') {
      menuAngle += dt * 0.12;
      pos = new THREE.Vector3(c.x + Math.cos(menuAngle) * R * 0.85, R * 0.55, c.z + Math.sin(menuAngle) * R * 0.85);
      look = c.clone();
    } else {
      const mode = CAM_MODES[camMode];
      if (mode === 'chase' && player.state === 'run') {
        const info = sampleLane(course.lanes[player.lane], player.s);
        const flat = new THREE.Vector3(info.tan.x, 0, info.tan.z).normalize();
        pos = p.clone().addScaledVector(flat, -7.5).add(new THREE.Vector3(0, 3.6, 0));
        look = p.clone().addScaledVector(flat, 4).add(new THREE.Vector3(0, 0.5, 0));
      } else if (mode === 'top') {
        pos = new THREE.Vector3(c.x, R * 1.05, c.z + R * 0.25);
        look = c.clone();
      } else {
        pos = new THREE.Vector3(c.x, R * 0.55, c.z + R * 0.8);
        look = c.clone().lerp(p, 0.35);
      }
      if (mode === 'chase' && player.state === 'off') {
        pos = camera.position.clone();
        look = p.clone();
      }
    }
    camera.position.lerp(pos, smooth);
    camLook.lerp(look, smooth);
    camera.lookAt(camLook);
    snapCamera = false;
  }

  // ---------------------------------------------------------------- 結果
  function showResult() {
    state = 'result';
    const rec = records[course.def.id] || (records[course.def.id] = { bestLap: 0, total: {} });
    const pBest = Math.min(...player.lapTimes);
    const cBest = Math.min(...cpu.lapTimes);
    const msgs = [];
    if (!rec.bestLap || pBest < rec.bestLap) { rec.bestLap = pBest; msgs.push('ベストラップ新記録！'); }
    const prevTotal = rec.total[settings.laps];
    if (!prevTotal || player.finishTime < prevTotal) { rec.total[settings.laps] = player.finishTime; msgs.push(settings.laps + '周の新記録！'); }
    store.set('records', records);

    const win = player.finishTime <= cpu.finishTime;
    $('resultTitle').textContent = win ? '🏆 あなたの勝ち！' : 'CPU の勝ち…';
    const rows = [player, cpu].sort((a, b) => a.finishTime - b.finishTime).map((car, k) => `
      <tr><td>${k + 1}. ${car === player ? 'あなた' : 'CPU（' + level.name + '）'}</td>
      <td>${fmt(car.finishTime)}</td><td>${fmt(Math.min(...car.lapTimes))}</td><td>${car.deslots}</td></tr>`).join('');
    const lapList = car => {
      const best = Math.min(...car.lapTimes);
      return car.lapTimes.map((t, k) => `<div class="${t === best ? 'best' : ''}">L${k + 1}　${fmt(t)}</div>`).join('');
    };
    $('resultBody').innerHTML = `
      <div style="opacity:.75;font-size:13px;margin-bottom:8px">${course.def.name}・${settings.laps}周・レーン${settings.lane === 0 ? 'A' : 'B'}</div>
      <table class="res"><tr><th>順位</th><th>合計</th><th>ベストラップ</th><th>コースアウト</th></tr>${rows}</table>
      <div class="laps-detail"><div><b>あなた</b>${lapList(player)}</div><div><b>CPU</b>${lapList(cpu)}</div></div>
      ${msgs.map(m => `<div class="newrec">${m}</div>`).join('')}
      <div style="opacity:.6;font-size:12px;margin-top:6px">CPUのベスト ${fmt(cBest)}</div>`;
    showAds();
    el.result.classList.remove('hidden');
  }

  // ---------------------------------------------------------------- メニュー
  // renderAds は ads.js にある。ファイルが無くてもゲームは動く（広告が出ないだけ）
  function showAds() {
    if (typeof renderAds === 'function') renderAds([$('adsTitle'), $('adsResult')]);
  }

  function renderMenu() {
    document.querySelectorAll('.opts').forEach(group => {
      const key = group.dataset.key;
      group.querySelectorAll('button').forEach(b => b.classList.toggle('sel', String(settings[key]) === b.dataset.v));
    });
    const def = COURSES.find(c => c.id === settings.course);
    const [la, lb] = course.lanes.map(l => l.length.toFixed(1));
    $('courseDesc').textContent = `${def.desc}（1周 レーンA ${la}m / レーンB ${lb}m）`;
    const rec = records[settings.course];
    const best = rec && rec.bestLap ? fmt(rec.bestLap) : '--:--.---';
    const total = rec && rec.total[settings.laps] ? fmt(rec.total[settings.laps]) : '--:--.---';
    $('records').textContent = `自己ベスト（${def.name}）　ラップ ${best}　／　${settings.laps}周 ${total}`;
  }

  function initMenu() {
    const courseOpts = document.querySelector('.opts[data-key="course"]');
    courseOpts.innerHTML = COURSES.map(c => `<button data-v="${c.id}">${c.name}</button>`).join('');
    document.querySelectorAll('.opts').forEach(group => {
      group.addEventListener('click', e => {
        const b = e.target.closest('button');
        if (!b) return;
        const key = group.dataset.key;
        settings[key] = key === 'course' ? b.dataset.v : Number(b.dataset.v);
        store.set('settings', settings);
        if (key === 'course') loadCourse(settings.course);
        else if (key === 'lane') placeCarsAtStart();
        renderMenu();
      });
    });
    $('startBtn').addEventListener('click', startRace);
    $('resumeBtn').addEventListener('click', togglePause);
    $('retireBtn').addEventListener('click', toMenu);
    $('retryBtn').addEventListener('click', startRace);
    $('menuBtn').addEventListener('click', toMenu);
  }

  // ---------------------------------------------------------------- 起動
  if (!COURSES.some(c => c.id === settings.course)) settings.course = 'fig8';
  if (!LEVELS[settings.level]) settings.level = 2;
  if (settings.lane !== 0 && settings.lane !== 1) settings.lane = 0;
  initMenu();
  initTouch();
  loadCourse(settings.course);
  renderMenu();
  showAds();
  requestAnimationFrame(frame);
})();
