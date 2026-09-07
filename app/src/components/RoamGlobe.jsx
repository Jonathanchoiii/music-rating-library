import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import worldAtlas from "world-atlas/countries-110m.json";
import { mesh } from "topojson-client";
import { COUNTRY_COORDINATES } from "../data/countryCoordinates.js";
import { CountryFlag } from "./CountryFlag.jsx";

const GLOBE_RADIUS = 1.34;
const MARKER_RADIUS = 1.39;
const FALLBACK_COORDINATES = Object.freeze({ XK: [42.6, 20.9] });

function latLonToVector3(latitude, longitude, radius = GLOBE_RADIUS) {
  const lat = THREE.MathUtils.degToRad(latitude);
  const lon = THREE.MathUtils.degToRad(longitude);
  return new THREE.Vector3(
    radius * Math.cos(lat) * Math.sin(lon),
    radius * Math.sin(lat),
    radius * Math.cos(lat) * Math.cos(lon),
  );
}

function geometryLines(geometry) {
  if (!geometry) return [];
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  return [];
}

function createWorldLines() {
  const countryBoundaries = mesh(
    worldAtlas,
    worldAtlas.objects.countries,
    (countryA, countryB) => countryA !== countryB,
  );
  const positions = [];
  geometryLines(countryBoundaries).forEach((ring) => {
    for (let index = 1; index < ring.length; index += 1) {
      const [previousLon, previousLat] = ring[index - 1];
      const [currentLon, currentLat] = ring[index];
      const previous = latLonToVector3(previousLat, previousLon, GLOBE_RADIUS + 0.008);
      const current = latLonToVector3(currentLat, currentLon, GLOBE_RADIUS + 0.008);
      positions.push(previous.x, previous.y, previous.z, current.x, current.y, current.z);
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

function disposeScene(scene) {
  scene.traverse((object) => {
    object.geometry?.dispose?.();
    if (Array.isArray(object.material)) {
      object.material.forEach((material) => material.dispose?.());
    } else {
      object.material?.dispose?.();
    }
  });
}

export function RoamGlobe({ countries = [], onSelectCountry, compact = false }) {
  const hostRef = useRef(null);
  const canvasRef = useRef(null);
  const labelRefs = useRef({});
  const [webglFailed, setWebglFailed] = useState(false);
  const mappedCountries = useMemo(
    () =>
      countries
        .map((country) => ({
          ...country,
          coordinates: COUNTRY_COORDINATES[country.code] ?? FALLBACK_COORDINATES[country.code],
        }))
        .filter((country) => country.coordinates),
    [countries],
  );

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return undefined;

    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      });
    } catch {
      setWebglFailed(true);
      return undefined;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 20);
    const light = new THREE.HemisphereLight(0xffffff, 0xb8b5ae, 2.4);
    scene.add(light);

    const globe = new THREE.Mesh(
      new THREE.SphereGeometry(GLOBE_RADIUS, 64, 48),
      new THREE.MeshStandardMaterial({
        color: 0xf5f3ee,
        roughness: 0.88,
        metalness: 0.02,
      }),
    );
    scene.add(globe);

    const borders = new THREE.LineSegments(
      createWorldLines(),
      new THREE.LineBasicMaterial({
        color: 0x7d7396,
        transparent: true,
        opacity: 0.58,
      }),
    );
    scene.add(borders);

    const markerGeometry = new THREE.SphereGeometry(compact ? 0.052 : 0.046, 20, 14);
    const markerMaterial = new THREE.MeshBasicMaterial({ color: 0x6c3bff });
    const haloGeometry = new THREE.RingGeometry(
      compact ? 0.075 : 0.066,
      compact ? 0.102 : 0.092,
      32,
    );
    const haloMaterial = new THREE.MeshBasicMaterial({
      color: 0x9b7bff,
      transparent: true,
      opacity: 0.56,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const markerPoints = new Map();

    mappedCountries.forEach((country) => {
      const [latitude, longitude] = country.coordinates;
      const point = latLonToVector3(latitude, longitude, MARKER_RADIUS);
      const marker = new THREE.Mesh(markerGeometry, markerMaterial);
      marker.position.copy(point);
      marker.userData.countryCode = country.code;
      scene.add(marker);

      const halo = new THREE.Mesh(haloGeometry, haloMaterial);
      halo.position.copy(point.clone().multiplyScalar(1.002));
      halo.lookAt(point.clone().multiplyScalar(2));
      scene.add(halo);
      markerPoints.set(country.code, point);
    });

    const focus = mappedCountries.reduce((sum, country) => {
      const [latitude, longitude] = country.coordinates;
      return sum.add(latLonToVector3(latitude, longitude, 1));
    }, new THREE.Vector3());
    if (focus.lengthSq() < 0.01) focus.set(0.4, 0.25, 1);
    camera.position.copy(focus.normalize().multiplyScalar(compact ? 5.05 : 5.15));
    camera.lookAt(0, 0, 0);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.055;
    controls.enablePan = false;
    controls.enableZoom = false;
    controls.rotateSpeed = 0.48;
    controls.minPolarAngle = 0.24;
    controls.maxPolarAngle = Math.PI - 0.24;
    controls.autoRotate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    controls.autoRotateSpeed = 0.48;
    controls.cursorStyle = "grab";

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const resize = () => {
      const width = Math.max(host.clientWidth, 1);
      const height = Math.max(host.clientHeight, 1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    const projected = new THREE.Vector3();
    const worldPoint = new THREE.Vector3();
    const surfaceNormal = new THREE.Vector3();
    const cameraDirection = new THREE.Vector3();
    const clock = new THREE.Clock();
    renderer.setAnimationLoop(() => {
      const delta = Math.min(clock.getDelta(), 0.05);
      controls.update(delta);
      cameraDirection.copy(camera.position).normalize();
      const visibleLabelBounds = [];
      markerPoints.forEach((point, countryCode) => {
        const label = labelRefs.current[countryCode];
        if (!label) return;
        worldPoint.copy(point);
        const isFront = surfaceNormal.copy(worldPoint).normalize().dot(cameraDirection) > 0.16;
        projected.copy(worldPoint).project(camera);
        const x = (projected.x * 0.5 + 0.5) * host.clientWidth;
        const y = (-projected.y * 0.5 + 0.5) * host.clientHeight;
        const isInside = x > 42 && x < host.clientWidth - 42 && y > 28 && y < host.clientHeight - 34;
        let placement;
        if (isFront && isInside) {
          const labelWidth = label.offsetWidth || 76;
          const labelHeight = label.offsetHeight || 38;
          const offsets = [[0, 0], [0, -36], [0, 36], [-58, 0], [58, 0]];
          placement = offsets.find(([offsetX, offsetY]) => {
            const centerX = x + offsetX;
            const anchorY = y + offsetY;
            const bounds = {
              left: centerX - labelWidth / 2 - 4,
              right: centerX + labelWidth / 2 + 4,
              top: anchorY - labelHeight * 1.35 - 4,
              bottom: anchorY - labelHeight * 0.35 + 4,
            };
            const withinCanvas = bounds.left > 8
              && bounds.right < host.clientWidth - 8
              && bounds.top > 8
              && bounds.bottom < host.clientHeight - 8;
            const overlaps = visibleLabelBounds.some(
              (other) => bounds.left < other.right
                && bounds.right > other.left
                && bounds.top < other.bottom
                && bounds.bottom > other.top,
            );
            if (withinCanvas && !overlaps) {
              visibleLabelBounds.push(bounds);
              return true;
            }
            return false;
          });
        }
        const [offsetX = 0, offsetY = 0] = placement ?? [];
        label.style.transform = `translate3d(${x + offsetX}px, ${y + offsetY}px, 0) translate(-50%, -135%)`;
        label.style.opacity = placement ? "1" : "0";
        label.style.pointerEvents = placement ? "auto" : "none";
      });
      renderer.render(scene, camera);
    });

    return () => {
      renderer.setAnimationLoop(null);
      resizeObserver.disconnect();
      controls.dispose();
      disposeScene(scene);
      renderer.dispose();
    };
  }, [compact, mappedCountries]);

  return (
    <div
      ref={hostRef}
      className={`roam-globe${compact ? " is-compact" : ""}`}
      aria-label="可拖动的听歌世界地图"
    >
      {webglFailed ? (
        <div className="roam-globe-fallback">
          <strong>互动地球暂不可用</strong>
          <span>仍可在下方按大洲查看已点亮地区。</span>
        </div>
      ) : (
        <canvas ref={canvasRef} aria-hidden="true" />
      )}
      <div className="roam-globe-labels">
        {mappedCountries.map((country) => (
          <button
            key={country.code}
            ref={(node) => {
              if (node) labelRefs.current[country.code] = node;
              else delete labelRefs.current[country.code];
            }}
            type="button"
            className="roam-globe-label"
            onClick={() => onSelectCountry?.(country.code)}
          >
            <CountryFlag code={country.code} name={country.name} variant="label" />
            <strong>{country.name}</strong>
            <small>{country.artists?.length ?? 0} 位艺人</small>
          </button>
        ))}
      </div>
      <span className="roam-globe-hint">拖动旋转 · 自动漫游</span>
    </div>
  );
}
