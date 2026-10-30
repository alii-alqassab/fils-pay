import { useEffect, useRef, useState } from "react";
import type * as THREE_NS from "three";
import {
  BALL_HEIGHT, CACTUS_HEIGHT, DESPAWN_Z, JUMP_SPEED, LANE_COUNT, SPAWN_Z, advance, clampLane, collides, grabs, laneX,
  spawnGap, spawnRow, speedFor, stepJump, type Thing,
} from "../utils/duckGame.js";

type Three = typeof THREE_NS;
const BEST_KEY = "fp-duck-best";

function readBest(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0;
  }
}

/** Builds one little 3D character/prop. Everything is made from simple shapes, no model files. */
function makeDuck(T: Three): THREE_NS.Group {
  const g = new T.Group();
  const yellow = new T.MeshStandardMaterial({ color: 0xffd45e, roughness: 0.55 });
  const orange = new T.MeshStandardMaterial({ color: 0xff8a2b, roughness: 0.6 });
  const dark = new T.MeshStandardMaterial({ color: 0x241a1a, roughness: 0.3 });
  const white = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
  const body = new T.Mesh(new T.SphereGeometry(0.8, 28, 20), yellow);
  body.scale.set(1, 0.9, 1.15);
  body.position.y = 0.8;
  const head = new T.Mesh(new T.SphereGeometry(0.5, 24, 18), yellow);
  head.position.set(0, 1.65, -0.35);
  const beak = new T.Mesh(new T.BoxGeometry(0.46, 0.14, 0.4), orange);
  beak.position.set(0, 1.55, -0.85);
  const glasses = new T.Mesh(new T.BoxGeometry(0.9, 0.2, 0.1), dark);
  glasses.position.set(0, 1.78, -0.7);
  const tail = new T.Mesh(new T.ConeGeometry(0.28, 0.5, 12), yellow);
  tail.position.set(0, 1.0, 0.95);
  tail.rotation.x = Math.PI / 2.6;
  const wingL = new T.Mesh(new T.SphereGeometry(0.32, 14, 10), yellow);
  wingL.scale.set(0.4, 0.8, 1.1);
  wingL.position.set(-0.82, 0.85, 0.05);
  wingL.name = "wingL";
  const wingR = wingL.clone();
  wingR.position.x = 0.82;
  wingR.name = "wingR";
  const shine = new T.Mesh(new T.SphereGeometry(0.06, 8, 6), white);
  shine.position.set(-0.22, 1.82, -0.77);
  // A propeller beanie, because why not: visible from behind, and it spins while the duck runs.
  const beanie = new T.Mesh(
    new T.SphereGeometry(0.46, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    new T.MeshStandardMaterial({ color: 0xff4b47, roughness: 0.5 }),
  );
  beanie.position.set(0, 1.92, -0.35);
  const prop = new T.Group();
  prop.name = "prop";
  prop.position.set(0, 2.42, -0.35);
  const bladeMat = new T.MeshStandardMaterial({ color: 0x2b5fd0, roughness: 0.4 });
  const bladeA = new T.Mesh(new T.BoxGeometry(1.1, 0.04, 0.16), bladeMat);
  const bladeB = bladeA.clone();
  bladeB.rotation.y = Math.PI / 2;
  const stem = new T.Mesh(new T.CylinderGeometry(0.03, 0.03, 0.16, 8), new T.MeshStandardMaterial({ color: 0x241a1a }));
  stem.position.set(0, 2.35, -0.35);
  prop.add(bladeA, bladeB);
  g.add(body, head, beak, glasses, tail, wingL, wingR, shine, beanie, prop, stem);
  g.scale.setScalar(0.85);
  g.traverse((o) => {
    if ((o as THREE_NS.Mesh).isMesh) (o as THREE_NS.Mesh).castShadow = true;
  });
  return g;
}

function googlyEyes(T: Three, y: number, z: number, spread: number): THREE_NS.Group {
  const eyes = new T.Group();
  const white = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
  const black = new T.MeshStandardMaterial({ color: 0x111111, roughness: 0.2 });
  for (const sx of [-spread, spread]) {
    const w = new T.Mesh(new T.SphereGeometry(0.26, 16, 12), white);
    w.position.set(sx, y, z);
    const p = new T.Mesh(new T.SphereGeometry(0.11, 12, 8), black);
    p.position.set(sx + (sx > 0 ? -0.04 : 0.04), y - 0.03, z + 0.2);
    eyes.add(w, p);
  }
  return eyes;
}

function makeCactus(T: Three): THREE_NS.Group {
  const g = new T.Group();
  const green = new T.MeshStandardMaterial({ color: 0x3fae5a, roughness: 0.7 });
  const body = new T.Mesh(new T.CapsuleGeometry(0.55, 1.9, 8, 16), green);
  body.position.y = 1.5;
  const armL = new T.Mesh(new T.CapsuleGeometry(0.2, 0.7, 6, 10), green);
  armL.position.set(-0.75, 1.9, 0);
  armL.rotation.z = 0.5;
  const armR = armL.clone();
  armR.position.x = 0.75;
  armR.rotation.z = -0.5;
  const eyes = googlyEyes(T, 2.1, 0.42, 0.28);
  g.add(body, armL, armR, eyes);
  g.traverse((o) => {
    if ((o as THREE_NS.Mesh).isMesh) (o as THREE_NS.Mesh).castShadow = true;
  });
  return g;
}

function makeBall(T: Three): THREE_NS.Group {
  const g = new T.Group();
  const ball = new T.Mesh(new T.SphereGeometry(0.5, 24, 18), new T.MeshStandardMaterial({ color: 0xff4b47, roughness: 0.35 }));
  const band = new T.Mesh(new T.TorusGeometry(0.5, 0.07, 10, 28), new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }));
  band.rotation.x = Math.PI / 2;
  const band2 = band.clone();
  band2.rotation.set(0, Math.PI / 2, 0);
  g.add(ball, band, band2, googlyEyes(T, 0.12, 0.38, 0.18));
  g.position.y = 0.5;
  g.traverse((o) => {
    if ((o as THREE_NS.Mesh).isMesh) (o as THREE_NS.Mesh).castShadow = true;
  });
  const wrap = new T.Group();
  wrap.add(g);
  return wrap;
}

function makeDonut(T: Three): THREE_NS.Group {
  const g = new T.Group();
  const dough = new T.Mesh(new T.TorusGeometry(0.45, 0.22, 14, 28), new T.MeshStandardMaterial({ color: 0xd9a05b, roughness: 0.6 }));
  const icing = new T.Mesh(new T.TorusGeometry(0.45, 0.19, 14, 28), new T.MeshStandardMaterial({ color: 0xff7eb6, roughness: 0.35 }));
  icing.position.z = 0.06;
  icing.scale.set(1, 1, 0.6);
  g.add(dough, icing);
  g.position.y = 1.2;
  const wrap = new T.Group();
  wrap.add(g);
  return wrap;
}

function makeTree(T: Three): THREE_NS.Group {
  const g = new T.Group();
  const trunk = new T.Mesh(new T.CylinderGeometry(0.25, 0.35, 1.4, 8), new T.MeshStandardMaterial({ color: 0x8a5a2b }));
  trunk.position.y = 0.7;
  const top = new T.Mesh(new T.ConeGeometry(1.2, 3, 10), new T.MeshStandardMaterial({ color: 0x2f9e57, roughness: 0.8 }));
  top.position.y = 2.7;
  g.add(trunk, top);
  g.traverse((o) => {
    if ((o as THREE_NS.Mesh).isMesh) (o as THREE_NS.Mesh).castShadow = true;
  });
  return g;
}

interface Live extends Thing {
  node: THREE_NS.Group;
}

/**
 * "Duck Dash": a small 3D endless runner. A duck in sunglasses runs down a three-lane road, dodging
 * grumpy cacti and beach balls (hop over the balls) and grabbing donuts. Arrow keys / A D to change
 * lane, Space or Up to jump; on a phone swipe sideways or tap to jump. Three.js loads only when the game
 * opens and everything is disposed when it closes.
 */
export function DuckDashGame() {
  const mount = useRef<HTMLDivElement>(null);
  const api = useRef<{ left: () => void; right: () => void; jump: () => void; restart: () => void; start: () => void } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [score, setScore] = useState(0);
  const [donuts, setDonuts] = useState(0);
  const [best, setBest] = useState(readBest);
  const [over, setOver] = useState(false);
  const [started, setStarted] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    const host = mount.current;
    if (!host) return;
    let disposed = false;
    let raf = 0;
    const cleanups: Array<() => void> = [];

    void (async () => {
      let T: Three;
      try {
        T = await import("three");
      } catch {
        if (!disposed) setFailed("The game could not load.");
        return;
      }
      if (disposed) return;

      let renderer: THREE_NS.WebGLRenderer;
      try {
        renderer = new T.WebGLRenderer({ antialias: true, alpha: false });
      } catch {
        setFailed("Your browser cannot show the 3D game.");
        return;
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = T.PCFSoftShadowMap;
      host.appendChild(renderer.domElement);
      renderer.domElement.style.display = "block";
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      renderer.domElement.style.touchAction = "none";

      const scene = new T.Scene();
      const SKY = 0x9fd8ff;
      scene.background = new T.Color(SKY);
      scene.fog = new T.Fog(SKY, 28, 72);
      const camera = new T.PerspectiveCamera(56, 4 / 3, 0.1, 120);
      camera.position.set(0, 6.2, 10.8);

      scene.add(new T.HemisphereLight(0xffffff, 0x88aa77, 1.15));
      const sun = new T.DirectionalLight(0xfff2cc, 2.2);
      sun.position.set(6, 14, 6);
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);
      Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -34, near: 1, far: 50 });
      scene.add(sun, sun.target);
      sun.target.position.set(0, 0, -10);

      // Ground: grass, a cream road, and scrolling lane dashes.
      const grass = new T.Mesh(new T.PlaneGeometry(120, 160), new T.MeshStandardMaterial({ color: 0x6fd081, roughness: 1 }));
      grass.rotation.x = -Math.PI / 2;
      grass.position.set(0, -0.02, -40);
      grass.receiveShadow = true;
      const road = new T.Mesh(new T.PlaneGeometry(LANE_COUNT * 2.4 + 0.8, 160), new T.MeshStandardMaterial({ color: 0xfff1d0, roughness: 0.9 }));
      road.rotation.x = -Math.PI / 2;
      road.position.set(0, 0, -40);
      road.receiveShadow = true;
      scene.add(grass, road);

      const dashMat = new T.MeshStandardMaterial({ color: 0xff4b47, roughness: 0.8 });
      const dashGeo = new T.BoxGeometry(0.12, 0.02, 1.6);
      const dashes: THREE_NS.Mesh[] = [];
      for (let i = 0; i < 16; i++) {
        for (const x of [-1.2, 1.2]) {
          const d = new T.Mesh(dashGeo, dashMat);
          d.position.set(x, 0.02, 6 - i * 5);
          dashes.push(d);
          scene.add(d);
        }
      }

      // Scenery trees on both sides, recycled as they pass.
      const trees: THREE_NS.Group[] = [];
      for (let i = 0; i < 14; i++) {
        const tr = makeTree(T);
        const side = i % 2 === 0 ? -1 : 1;
        tr.position.set(side * (6 + Math.random() * 6), 0, 6 - i * 6);
        tr.scale.setScalar(0.8 + Math.random() * 0.7);
        trees.push(tr);
        scene.add(tr);
      }

      // Clouds drifting by.
      const cloudMat = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.95 });
      const clouds: THREE_NS.Group[] = [];
      for (let i = 0; i < 6; i++) {
        const c = new T.Group();
        for (let k = 0; k < 3; k++) {
          const puff = new T.Mesh(new T.SphereGeometry(1.4 - k * 0.2, 12, 10), cloudMat);
          puff.position.set(k * 1.5 - 1.5, k === 1 ? 0.5 : 0, 0);
          c.add(puff);
        }
        c.position.set((Math.random() - 0.5) * 50, 11 + Math.random() * 5, -20 - i * 12);
        clouds.push(c);
        scene.add(c);
      }

      const duck = makeDuck(T);
      scene.add(duck);

      // --- game state ---
      let lane = 1;
      let laneVisual = laneX(1);
      let height = 0;
      let velocity = 0;
      let distance = 0;
      let donutCount = 0;
      let nextId = 1;
      let sinceSpawn = 0;
      let alive = true;
      let running = false;
      let hitFlash = 0;
      let live: Live[] = [];
      let last = performance.now();
      let clock = 0;

      const clearThings = () => {
        for (const l of live) scene.remove(l.node);
        live = [];
      };
      const restart = () => {
        clearThings();
        lane = 1;
        height = 0;
        velocity = 0;
        distance = 0;
        donutCount = 0;
        sinceSpawn = 0;
        alive = true;
        running = true;
        hitFlash = 0;
        duck.rotation.set(0, 0, 0);
        setStarted(true);
        setScore(0);
        setDonuts(0);
        setOver(false);
      };

      const spawn = () => {
        for (const t of spawnRow(nextId, distance, Math.random)) {
          nextId = Math.max(nextId, t.id + 1);
          const node = t.kind === "cactus" ? makeCactus(T) : t.kind === "ball" ? makeBall(T) : makeDonut(T);
          node.position.set(laneX(t.lane), 0, t.z);
          scene.add(node);
          live.push({ ...t, node });
        }
      };

      api.current = {
        left: () => alive && running && (lane = clampLane(lane - 1)),
        right: () => alive && running && (lane = clampLane(lane + 1)),
        jump: () => {
          if (alive && running && height <= 0.001) velocity = JUMP_SPEED;
        },
        restart,
        start: restart,
      };

      // --- input: keys are handled by the game box itself (see onKeyDown below), never the whole page ---
      let startX = 0;
      let startY = 0;
      const el = renderer.domElement;
      const onDown = (e: PointerEvent) => {
        startX = e.clientX;
        startY = e.clientY;
      };
      const onUp = (e: PointerEvent) => {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (Math.abs(dx) > 28 && Math.abs(dx) > Math.abs(dy)) (dx < 0 ? api.current?.left : api.current?.right)?.();
        else api.current?.jump();
      };
      el.addEventListener("pointerdown", onDown);
      el.addEventListener("pointerup", onUp);
      cleanups.push(() => {
        el.removeEventListener("pointerdown", onDown);
        el.removeEventListener("pointerup", onUp);
      });

      // --- sizing ---
      const resize = () => {
        const w = host.clientWidth || 400;
        const h = Math.round(w * 0.75);
        renderer.setSize(w, h, false);
        host.style.height = `${h}px`;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(host);
      cleanups.push(() => ro.disconnect());

      // --- loop ---
      let lastShownScore = -1;
      const frame = (now: number) => {
        const dt = Math.min((now - last) / 1000, 0.05);
        last = now;
        clock += dt;

        if (alive && running) {
          const speed = speedFor(distance);
          distance += speed * dt;
          sinceSpawn += dt;
          if (sinceSpawn >= spawnGap(distance)) {
            sinceSpawn = 0;
            spawn();
          }
          live = live.filter((l) => {
            if (l.z + speed * dt < DESPAWN_Z) return true;
            scene.remove(l.node);
            return false;
          });
          const moved = advance(live, speed * dt);
          live = live.map((l, i) => ({ ...l, z: moved[i]?.z ?? l.z }));
          const j = stepJump(height, velocity, dt);
          height = j.height;
          velocity = j.velocity;

          for (const l of [...live]) {
            if (grabs(lane, height, l)) {
              donutCount += 1;
              scene.remove(l.node);
              live = live.filter((x) => x.id !== l.id);
              setDonuts(donutCount);
            } else if (collides(lane, height, l)) {
              alive = false;
              hitFlash = 1;
              const finalScore = Math.floor(distance) + donutCount * 25;
              setScore(finalScore);
              setOver(true);
              setBest((b) => {
                const nb = Math.max(b, finalScore);
                try {
                  localStorage.setItem(BEST_KEY, String(nb));
                } catch {
                  /* ignore */
                }
                return nb;
              });
              break;
            }
          }
          const shown = Math.floor(distance) + donutCount * 25;
          if (shown !== lastShownScore) {
            lastShownScore = shown;
            setScore(shown);
          }
          // Scroll the world.
          for (const d of dashes) {
            d.position.z += speed * dt;
            if (d.position.z > 8) d.position.z -= 80;
          }
          for (const tr of trees) {
            tr.position.z += speed * dt;
            if (tr.position.z > 10) {
              tr.position.z -= 84;
              tr.position.x = (tr.position.x < 0 ? -1 : 1) * (6 + Math.random() * 6);
            }
          }
          for (const c of clouds) {
            c.position.z += speed * dt * 0.15;
            if (c.position.z > 6) c.position.z -= 80;
          }
        }

        // Things bob, donuts spin, the duck waddles.
        for (const l of live) {
          l.node.position.z = l.z;
          if (l.kind === "donut") {
            l.node.rotation.y = clock * 3;
            l.node.position.y = Math.sin(clock * 4 + l.id) * 0.12;
          } else if (l.kind === "ball") {
            l.node.rotation.x -= dt * 5;
            l.node.position.y = Math.abs(Math.sin(clock * 5 + l.id)) * 0.35;
          } else {
            l.node.rotation.z = Math.sin(clock * 3 + l.id) * 0.06;
          }
        }
        laneVisual += (laneX(lane) - laneVisual) * Math.min(1, dt * 14);
        duck.position.set(laneVisual, height, 0);
        const prop = duck.getObjectByName("prop");
        if (prop) prop.rotation.y += dt * (alive ? 26 : 8);
        if (alive) {
          const run = clock * 14;
          duck.position.y += height <= 0.001 ? Math.abs(Math.sin(run)) * 0.18 : 0;
          duck.rotation.z = (laneX(lane) - laneVisual) * 0.35 + Math.sin(run) * 0.06;
          duck.rotation.x = height > 0.001 ? -0.25 : 0;
          const wl = duck.getObjectByName("wingL");
          const wr = duck.getObjectByName("wingR");
          const flap = height > 0.001 ? 0.9 : Math.sin(run) * 0.25;
          if (wl) wl.rotation.z = flap;
          if (wr) wr.rotation.z = -flap;
        } else {
          // Silly crash: the duck tips over and spins.
          duck.rotation.z += dt * 6;
          duck.rotation.y += dt * 4;
          hitFlash = Math.max(0, hitFlash - dt * 2);
        }
        camera.position.x += (laneVisual * 0.4 - camera.position.x) * Math.min(1, dt * 6);
        camera.lookAt(laneVisual * 0.2, 0.9, -9);

        renderer.render(scene, camera);
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);

      cleanups.push(() => {
        cancelAnimationFrame(raf);
        scene.traverse((o) => {
          const m = o as THREE_NS.Mesh;
          if (m.isMesh) {
            m.geometry.dispose();
            const mat = m.material as THREE_NS.Material | THREE_NS.Material[];
            (Array.isArray(mat) ? mat : [mat]).forEach((x) => x.dispose());
          }
        });
        renderer.dispose();
        renderer.domElement.remove();
        api.current = null;
      });
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      cleanups.forEach((fn) => fn());
    };
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    // Only when the game box itself has focus: arrow keys and Space keep scrolling the page everywhere else,
    // and keep working normally on the buttons inside the game.
    if (e.target !== e.currentTarget) return;
    const a = api.current;
    if (!a) return;
    const k = e.key;
    if (k === "ArrowLeft" || k === "a" || k === "A") a.left();
    else if (k === "ArrowRight" || k === "d" || k === "D") a.right();
    else if (k === "ArrowUp" || k === "w" || k === "W" || k === " ") {
      if (!started || over) a.start();
      else a.jump();
    } else if (k === "Enter" && (!started || over)) a.start();
    else return;
    e.preventDefault();
  }

  function begin(): void {
    api.current?.start();
    box.current?.focus({ preventScroll: true });
  }

  if (failed) return <p className="dash-muted" role="status">{failed}</p>;

  return (
    <div className="duck-game" ref={box} tabIndex={0} onKeyDown={onKeyDown} aria-label="Duck Dash game. Click it, then use the arrow keys and Space.">
      <div className="duck-hud" aria-live="off">
        <span>Score <b>{score}</b></span>
        <span>🍩 <b>{donuts}</b></span>
        <span>Best <b>{best}</b></span>
      </div>
      <div className="duck-stage">
        <div ref={mount} className="duck-canvas" aria-label="Duck Dash: a 3D game. Arrow keys move, space jumps." />
        {!started ? (
          <div className="duck-over" role="status">
            <strong>Duck Dash</strong>
            <span>Dodge, hop and snack your way along.</span>
            <button type="button" className="dash-button" onClick={begin}>Start</button>
          </div>
        ) : null}
        {over ? (
          <div className="duck-over" role="status">
            <strong>Quack! Game over</strong>
            <span>Score {score}{score >= best && score > 0 ? " · new best!" : ""}</span>
            <button type="button" className="dash-button" onClick={begin}>Play again</button>
          </div>
        ) : null}
      </div>
      <div className="duck-controls">
        <button type="button" className="dash-button" aria-label="Move left" onClick={() => api.current?.left()}>◀</button>
        <button type="button" className="dash-button" aria-label="Jump" onClick={() => api.current?.jump()}>Jump</button>
        <button type="button" className="dash-button" aria-label="Move right" onClick={() => api.current?.right()}>▶</button>
      </div>
      <p className="duck-help">Click the game, then use the left and right arrow keys to move and Space to jump. On a phone, swipe sideways or tap.</p>
    </div>
  );
}

// Unused heights are exported by the rules module for tests and tuning; reference them so a rename is caught here.
void BALL_HEIGHT;
void CACTUS_HEIGHT;
void SPAWN_Z;
