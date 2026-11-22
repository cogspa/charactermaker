import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

function setupStudioLights(scene) {
  const hemi = new THREE.HemisphereLight(0xf6f8ff, 0x3b3648, 0.55);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xfffaf2, 2.0);
  key.position.set(3.2, 5.5, 4.2);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 18;
  key.shadow.camera.left = -3.2;
  key.shadow.camera.right = 3.2;
  key.shadow.camera.top = 4.5;
  key.shadow.camera.bottom = -1.5;
  key.shadow.bias = -0.0005;
  key.shadow.radius = 3;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xd9e8ff, 0.85);
  fill.position.set(-4.0, 2.8, 2.5);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(0xc9b8ff, 0.9);
  rim.position.set(-1.5, 4.0, -4.5);
  scene.add(rim);

  return { hemi, key, fill, rim };
}

/**
 * Main interactive 3D turntable stage with OrbitControls, pedestal, lighting, and presets.
 */
export class StudioViewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.72;
    pmrem.dispose();

    setupStudioLights(this.scene);

    // Subtle studio turntable plinth + shadow receiver
    const shadowGeo = new THREE.CircleGeometry(3.8, 64);
    this.shadowMat = new THREE.ShadowMaterial({ opacity: 0.36 });
    this.shadowPlane = new THREE.Mesh(shadowGeo, this.shadowMat);
    this.shadowPlane.rotation.x = -Math.PI / 2;
    this.shadowPlane.position.y = 0.001;
    this.shadowPlane.receiveShadow = true;
    this.scene.add(this.shadowPlane);

    const discGeo = new THREE.CylinderGeometry(1.55, 1.65, 0.07, 64);
    this.discMat = new THREE.MeshStandardMaterial({
      color: 0x222634,
      roughness: 0.62,
      metalness: 0.15,
    });
    this.pedestal = new THREE.Mesh(discGeo, this.discMat);
    this.pedestal.position.y = -0.036;
    this.pedestal.receiveShadow = true;
    this.scene.add(this.pedestal);

    const ringGeo = new THREE.RingGeometry(1.53, 1.565, 64);
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0x8b6cf6,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
    });
    this.pedestalRing = new THREE.Mesh(ringGeo, this.ringMat);
    this.pedestalRing.rotation.x = -Math.PI / 2;
    this.pedestalRing.position.y = 0.002;
    this.scene.add(this.pedestalRing);

    this.camera = new THREE.PerspectiveCamera(36, 4 / 3, 0.05, 100);
    this.camera.position.set(1.6, 2.0, 5.2);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.enablePan = true;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 1.35;
    this.controls.minDistance = 1.1;
    this.controls.maxDistance = 16;
    this.controls.maxPolarAngle = Math.PI * 0.54;
    this.controls.target.set(0, 1.5, 0);

    // Pause auto-rotate only while actively dragging? Let OrbitControls handle smoothly,
    // and let user toggle auto-rotate explicitly via button.
    this.characterContainer = new THREE.Group();
    this.scene.add(this.characterContainer);

    this.currentBounds = new THREE.Box3();
    this.defaultDistance = 5.4;
    this.defaultTargetY = 1.5;

    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(canvas.parentElement || canvas);
    this.resize();

    this._rafId = null;
    this._startLoop();
  }

  _startLoop() {
    const tick = () => {
      this._rafId = requestAnimationFrame(tick);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    tick();
  }

  resize() {
    const host = this.canvas.parentElement || this.canvas;
    const width = Math.max(1, Math.round(host.clientWidth));
    const height = Math.max(1, Math.round(host.clientHeight));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  setCharacter(characterGroup, { reframe = true } = {}) {
    while (this.characterContainer.children.length > 0) {
      this.characterContainer.remove(this.characterContainer.children[0]);
    }
    if (!characterGroup) return;

    this.characterContainer.add(characterGroup);
    characterGroup.updateMatrixWorld(true);
    this.currentBounds.setFromObject(characterGroup);

    if (!this.currentBounds.isEmpty()) {
      const size = new THREE.Vector3();
      const center = new THREE.Vector3();
      this.currentBounds.getSize(size);
      this.currentBounds.getCenter(center);

      // Fit pedestal radius gently to character footprint
      const footprint = Math.max(size.x, size.z) * 0.62;
      const pedScale = THREE.MathUtils.clamp(footprint / 1.55, 0.72, 1.6);
      this.pedestal.scale.set(pedScale, 1, pedScale);
      this.pedestalRing.scale.set(pedScale, pedScale, 1);

      const fovRad = THREE.MathUtils.degToRad(this.camera.fov);
      const fitHeightDist = (size.y * 0.56) / Math.tan(fovRad * 0.5);
      const fitWidthDist = (Math.max(size.x, size.z) * 0.62) / (Math.tan(fovRad * 0.5) * Math.max(this.camera.aspect, 0.8));
      this.defaultDistance = Math.max(fitHeightDist, fitWidthDist, 2.2) * 1.18;
      this.defaultTargetY = center.y;

      if (reframe) {
        this.setCameraPreset('three-quarter');
      }
    }
  }

  setCameraPreset(preset) {
    const d = this.defaultDistance;
    const ty = this.defaultTargetY;
    this.controls.target.set(0, ty, 0);

    switch (preset) {
      case 'front':
        this.camera.position.set(0, ty + d * 0.08, d);
        break;
      case 'side':
        this.camera.position.set(d, ty + d * 0.08, 0);
        break;
      case 'back':
        this.camera.position.set(0, ty + d * 0.08, -d);
        break;
      case 'three-quarter':
      default:
        this.camera.position.set(d * 0.42, ty + d * 0.14, d * 0.9);
        break;
    }
    this.controls.update();
  }

  setAutoRotate(enabled) {
    this.controls.autoRotate = Boolean(enabled);
  }

  setBackdrop(mode) {
    if (mode === 'bright') {
      this.discMat.color.setHex(0xe2e6ef);
      this.ringMat.color.setHex(0x6d28d9);
      this.ringMat.opacity = 0.28;
      this.shadowMat.opacity = 0.22;
    } else if (mode === 'gallery') {
      this.discMat.color.setHex(0x3a322c);
      this.ringMat.color.setHex(0xeab308);
      this.ringMat.opacity = 0.35;
      this.shadowMat.opacity = 0.36;
    } else {
      this.discMat.color.setHex(0x222634);
      this.ringMat.color.setHex(0x8b6cf6);
      this.ringMat.opacity = 0.45;
      this.shadowMat.opacity = 0.38;
    }
  }

  capturePngDataUrl() {
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL('image/png');
  }
}

/**
 * Shared single-context offscreen renderer for gallery card thumbnails & live drag-to-rotate on cards.
 */
export class CardRenderer {
  constructor(size = 460) {
    this.size = size;
    this.canvas = document.createElement('canvas');
    this.canvas.width = size;
    this.canvas.height = size;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setSize(size, size, false);
    this.renderer.setPixelRatio(1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;

    this.scene = new THREE.Scene();

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = 0.78;
    pmrem.dispose();

    const hemi = new THREE.HemisphereLight(0xf6f8ff, 0x3b3648, 0.6);
    this.scene.add(hemi);
    const key = new THREE.DirectionalLight(0xfffaf2, 1.9);
    key.position.set(3, 5, 4);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xd9e8ff, 0.85);
    fill.position.set(-4, 2.5, 2.5);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xc9b8ff, 0.85);
    rim.position.set(-1.5, 4, -4.5);
    this.scene.add(rim);

    // Subtle ground disc
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(1.4, 1.48, 0.05, 48),
      new THREE.MeshStandardMaterial({ color: 0x222634, roughness: 0.68, metalness: 0.14 })
    );
    disc.position.y = -0.026;
    this.scene.add(disc);
    this.disc = disc;

    this.holder = new THREE.Group();
    this.scene.add(this.holder);

    this.camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);
  }

  /**
   * Render a full assembled character from a specific azimuth/elevation into a data URL.
   */
  renderCharacter(characterGroup, azimuth = 0.42, elevation = 0.15) {
    while (this.holder.children.length > 0) {
      this.holder.remove(this.holder.children[0]);
    }
    this.holder.add(characterGroup);
    characterGroup.updateMatrixWorld(true);

    const box = new THREE.Box3().setFromObject(characterGroup);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    const footprint = Math.max(size.x, size.z) * 0.62;
    const pedScale = THREE.MathUtils.clamp(footprint / 1.4, 0.72, 1.55);
    this.disc.scale.set(pedScale, 1, pedScale);

    const fovRad = THREE.MathUtils.degToRad(this.camera.fov);
    const maxExtent = Math.max(size.y, size.x, size.z, 1.0);
    const dist = ((maxExtent * 0.56) / Math.tan(fovRad * 0.5)) * 1.15;

    const cosElev = Math.cos(elevation);
    this.camera.position.set(
      center.x + Math.sin(azimuth) * cosElev * dist,
      center.y + Math.sin(elevation) * dist,
      center.z + Math.cos(azimuth) * cosElev * dist
    );
    this.camera.lookAt(center.x, center.y, center.z);

    this.renderer.render(this.scene, this.camera);
    const url = this.canvas.toDataURL('image/webp', 0.92);

    this.holder.remove(characterGroup);
    return url;
  }
}
