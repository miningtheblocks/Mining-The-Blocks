import React, { useEffect, useMemo, useState, useRef } from 'react';
import { View, Dimensions, PanResponder, StyleSheet, Text, TouchableOpacity } from 'react-native';
import { useI18n } from '../utils/i18n';
import Svg, { Line, Polygon, G } from 'react-native-svg';

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');
const SCREEN_PAD = 30;

function project(x, y, z, camera) {
  const cy = Math.cos(camera.rotY);
  const sy = Math.sin(camera.rotY);
  const cx = Math.cos(camera.rotX);
  const sx = Math.sin(camera.rotX);

  const wx = x - (camera.tx || 0);
  const wy = y - (camera.ty || 0);
  const wz = z;

  let px = wx * cy - wz * sy;
  let pz = wx * sy + wz * cy;
  let py = wy * cx - pz * sx;
  pz = wy * sx + pz * cx;

  pz += camera.z;
  if (pz <= 1) return null;

  const s = camera.scale / pz;
  return {
    x: px * s + screenWidth / 2,
    y: -py * s + screenHeight / 2,
    z: pz,
  };
}

const HALF = 100;

function rotateNormal(nx, ny, nz, camera) {
  const cy = Math.cos(camera.rotY);
  const sy = Math.sin(camera.rotY);
  const cx = Math.cos(camera.rotX);
  const sx = Math.sin(camera.rotX);

  let rx = nx * cy - nz * sy;
  let rz = nx * sy + nz * cy;
  let ry = ny;
  const rY2 = ry * cx - rz * sx;
  const rZ2 = ry * sx + rz * cx;
  ry = rY2; rz = rZ2;
  return { nx: rx, ny: ry, nz: rz };
}

function cameraSpace(x, y, z, camera) {
  const cy = Math.cos(camera.rotY);
  const sy = Math.sin(camera.rotY);
  const cx = Math.cos(camera.rotX);
  const sx = Math.sin(camera.rotX);

  let px = x * cy - z * sy;
  let pz = x * sy + z * cy;
  let py = y * cx - pz * sx;
  pz = y * sx + pz * cx;

  pz += camera.z;
  return { x: px, y: py, z: pz };
}

function faceVisible(face, camera) {
  const normals = {
    front:  { nx: 0,  ny: 0,  nz: 1 },
    back:   { nx: 0,  ny: 0,  nz: -1 },
    right:  { nx: 1,  ny: 0,  nz: 0 },
    left:   { nx: -1, ny: 0,  nz: 0 },
    top:    { nx: 0,  ny: 1,  nz: 0 },
    bottom: { nx: 0,  ny: -1, nz: 0 },
  };
  const { nx, ny, nz } = normals[face];
  const r = rotateNormal(nx, ny, nz, camera);
  const c = faceCenter(face);
  const pc = cameraSpace(c.x, c.y, c.z, camera);
  if (pc.z <= 1) return false;
  const dot = r.nx * pc.x + r.ny * pc.y + r.nz * pc.z;
  return dot < -1e-6;
}

function faceCenter(face) {
  if (face === 'front') return { x: 0, y: 0, z: HALF };
  if (face === 'right') return { x: HALF, y: 0, z: 0 };
  return { x: 0, y: HALF, z: 0 };
}

// Trivial-reject: skip line if both endpoints are off-screen in the same direction
function onScreen(p1, p2) {
  if (!p1 || !p2) return false;
  if (p1.x < -SCREEN_PAD && p2.x < -SCREEN_PAD) return false;
  if (p1.x > screenWidth + SCREEN_PAD && p2.x > screenWidth + SCREEN_PAD) return false;
  if (p1.y < -SCREEN_PAD && p2.y < -SCREEN_PAD) return false;
  if (p1.y > screenHeight + SCREEN_PAD && p2.y > screenHeight + SCREEN_PAD) return false;
  return true;
}

function FaceGrid({ camera, face }) {
  const elements = useMemo(() => {
    const items = [];

    const corners3D =
      face === 'front'
        ? [
            { x: -HALF, y: -HALF, z: HALF },
            { x: HALF, y: -HALF, z: HALF },
            { x: HALF, y: HALF, z: HALF },
            { x: -HALF, y: HALF, z: HALF },
          ]
        : face === 'right'
        ? [
            { x: HALF, y: -HALF, z: -HALF },
            { x: HALF, y: -HALF, z: HALF },
            { x: HALF, y: HALF, z: HALF },
            { x: HALF, y: HALF, z: -HALF },
          ]
        : face === 'top'
        ? [
            { x: -HALF, y: HALF, z: -HALF },
            { x: HALF, y: HALF, z: -HALF },
            { x: HALF, y: HALF, z: HALF },
            { x: -HALF, y: HALF, z: HALF },
          ]
        : face === 'back'
        ? [
            { x: -HALF, y: -HALF, z: -HALF },
            { x: HALF, y: -HALF, z: -HALF },
            { x: HALF, y: HALF, z: -HALF },
            { x: -HALF, y: HALF, z: -HALF },
          ]
        : face === 'left'
        ? [
            { x: -HALF, y: -HALF, z: -HALF },
            { x: -HALF, y: -HALF, z: HALF },
            { x: -HALF, y: HALF, z: HALF },
            { x: -HALF, y: HALF, z: -HALF },
          ]
        : [
            { x: -HALF, y: -HALF, z: -HALF },
            { x: HALF, y: -HALF, z: -HALF },
            { x: HALF, y: -HALF, z: HALF },
            { x: -HALF, y: -HALF, z: HALF },
          ];

    const projectedCorners = corners3D.map((c) => project(c.x, c.y, c.z, camera)).filter(Boolean);
    if (projectedCorners.length !== 4) return items;
    const pointsAttr = projectedCorners.map((p) => `${p.x},${p.y}`).join(' ');

    items.push(
      <Polygon
        key={`${face}-bg`}
        points={pointsAttr}
        fill="#ffffff"
        stroke="#000000"
        strokeWidth={1.2}
        strokeLinejoin="round"
        shapeRendering="crispEdges"
        vectorEffect="non-scaling-stroke"
      />
    );

    if (face === 'front') {
      for (let k = -HALF; k <= HALF; k += 1) {
        const p1 = project(k, -HALF, HALF, camera);
        const p2 = project(k, HALF, HALF, camera);
        if (onScreen(p1, p2))
          items.push(
            <Line key={`f-v-${k}`} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="#000" strokeWidth={0.6} shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
          );
        const p3 = project(-HALF, k, HALF, camera);
        const p4 = project(HALF, k, HALF, camera);
        if (onScreen(p3, p4))
          items.push(
            <Line key={`f-h-${k}`} x1={p3.x} y1={p3.y} x2={p4.x} y2={p4.y} stroke="#000" strokeWidth={0.6} shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
          );
      }
    } else if (face === 'right') {
      for (let k = -HALF; k <= HALF; k += 1) {
        const p1 = project(HALF, k, -HALF, camera);
        const p2 = project(HALF, k, HALF, camera);
        if (onScreen(p1, p2))
          items.push(
            <Line key={`r-v-${k}`} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="#000" strokeWidth={0.6} shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
          );
        const p3 = project(HALF, -HALF, k, camera);
        const p4 = project(HALF, HALF, k, camera);
        if (onScreen(p3, p4))
          items.push(
            <Line key={`r-h-${k}`} x1={p3.x} y1={p3.y} x2={p4.x} y2={p4.y} stroke="#000" strokeWidth={0.6} shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
          );
      }
    } else if (face === 'top') {
      for (let k = -HALF; k <= HALF; k += 1) {
        const p1 = project(k, HALF, -HALF, camera);
        const p2 = project(k, HALF, HALF, camera);
        if (onScreen(p1, p2))
          items.push(
            <Line key={`t-v-${k}`} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="#000" strokeWidth={0.6} shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
          );
        const p3 = project(-HALF, HALF, k, camera);
        const p4 = project(HALF, HALF, k, camera);
        if (onScreen(p3, p4))
          items.push(
            <Line key={`t-h-${k}`} x1={p3.x} y1={p3.y} x2={p4.x} y2={p4.y} stroke="#000" strokeWidth={0.6} shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
          );
      }
    } else if (face === 'back') {
      for (let k = -HALF; k <= HALF; k += 1) {
        const p1 = project(k, -HALF, -HALF, camera);
        const p2 = project(k, HALF, -HALF, camera);
        if (onScreen(p1, p2))
          items.push(
            <Line key={`b-v-${k}`} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="#000" strokeWidth={0.6} shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
          );
        const p3 = project(-HALF, k, -HALF, camera);
        const p4 = project(HALF, k, -HALF, camera);
        if (onScreen(p3, p4))
          items.push(
            <Line key={`b-h-${k}`} x1={p3.x} y1={p3.y} x2={p4.x} y2={p4.y} stroke="#000" strokeWidth={0.6} shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
          );
      }
    } else if (face === 'left') {
      for (let k = -HALF; k <= HALF; k += 1) {
        const p1 = project(-HALF, k, -HALF, camera);
        const p2 = project(-HALF, k, HALF, camera);
        if (onScreen(p1, p2))
          items.push(
            <Line key={`l-v-${k}`} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="#000" strokeWidth={0.6} shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
          );
        const p3 = project(-HALF, -HALF, k, camera);
        const p4 = project(-HALF, HALF, k, camera);
        if (onScreen(p3, p4))
          items.push(
            <Line key={`l-h-${k}`} x1={p3.x} y1={p3.y} x2={p4.x} y2={p4.y} stroke="#000" strokeWidth={0.6} shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
          );
      }
    } else {
      for (let k = -HALF; k <= HALF; k += 1) {
        const p1 = project(k, -HALF, -HALF, camera);
        const p2 = project(k, -HALF, HALF, camera);
        if (onScreen(p1, p2))
          items.push(
            <Line key={`btm-v-${k}`} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke="#000" strokeWidth={0.6} shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
          );
        const p3 = project(-HALF, -HALF, k, camera);
        const p4 = project(HALF, -HALF, k, camera);
        if (onScreen(p3, p4))
          items.push(
            <Line key={`btm-h-${k}`} x1={p3.x} y1={p3.y} x2={p4.x} y2={p4.y} stroke="#000" strokeWidth={0.6} shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
          );
      }
    }

    return items;
  }, [camera, face]);

  return <G>{elements}</G>;
}

const INITIAL_CAMERA = { x: 0, y: 0, z: 450, rotX: -0.615, rotY: 0.785, scale: 320, tx: 0, ty: 0 };

export default function FaceGrid201() {
  const { t } = useI18n();
  const [camera, setCamera] = useState(INITIAL_CAMERA);
  const cameraRef = useRef(INITIAL_CAMERA);
  const rafRef = useRef(null);

  const lastPinchDistRef = useRef(null);
  const panStartRef = useRef({ tx: 0, ty: 0 });

  const scheduleRender = () => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setCamera({ ...cameraRef.current });
    });
  };

  // BAJO-MEDIO-39: cancelar el RAF en unmount para evitar setCamera() después
  // de desmontar (warning React) y leak del callback hasta el próximo frame.
  useEffect(() => () => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (evt) => evt.nativeEvent.touches.length <= 2,
        onPanResponderGrant: (evt) => {
          const touches = evt.nativeEvent.touches;
          if (touches.length === 2) {
            const dx = touches[1].pageX - touches[0].pageX;
            const dy = touches[1].pageY - touches[0].pageY;
            lastPinchDistRef.current = Math.hypot(dx, dy);
          } else {
            lastPinchDistRef.current = null;
            panStartRef.current = { tx: cameraRef.current.tx || 0, ty: cameraRef.current.ty || 0 };
          }
        },
        onPanResponderMove: (evt, gestureState) => {
          const touches = evt.nativeEvent.touches;
          if (touches.length === 1) {
            const { z, scale } = cameraRef.current;
            const unitsPerPixel = z / scale;
            const nx = panStartRef.current.tx - gestureState.dx * unitsPerPixel;
            const ny = panStartRef.current.ty + gestureState.dy * unitsPerPixel;
            cameraRef.current = { ...cameraRef.current, tx: nx, ty: ny };
            scheduleRender();
          } else if (touches.length === 2) {
            const dx = touches[1].pageX - touches[0].pageX;
            const dy = touches[1].pageY - touches[0].pageY;
            const dist = Math.hypot(dx, dy);
            const last = lastPinchDistRef.current ?? dist;
            const ratio = dist / (last || dist);
            const zoomIn = ratio > 1.005;
            const zoomOut = ratio < 0.995;
            if (zoomIn || zoomOut) {
              const factor = zoomIn ? 0.975 : 1.025;
              const { z, scale } = cameraRef.current;
              const newZ = Math.max(10, Math.min(900, z * factor));
              const inv = 2 - factor;
              const newScale = Math.max(220, Math.min(700, scale * inv));
              cameraRef.current = { ...cameraRef.current, z: newZ, scale: newScale };
              scheduleRender();
              lastPinchDistRef.current = dist;
            }
          }
        },
        onPanResponderRelease: () => {
          lastPinchDistRef.current = null;
        },
        onPanResponderTerminationRequest: () => true,
        onPanResponderTerminate: () => {
          lastPinchDistRef.current = null;
        },
      }),
    []
  );

  function projectedCorners(face) {
    const map = {
      front:  [ {x:-HALF,y:-HALF,z: HALF}, {x: HALF,y:-HALF,z: HALF}, {x: HALF,y: HALF,z: HALF}, {x:-HALF,y: HALF,z: HALF} ],
      back:   [ {x:-HALF,y:-HALF,z:-HALF}, {x: HALF,y:-HALF,z:-HALF}, {x: HALF,y: HALF,z:-HALF}, {x:-HALF,y: HALF,z:-HALF} ],
      right:  [ {x: HALF,y:-HALF,z:-HALF}, {x: HALF,y:-HALF,z: HALF}, {x: HALF,y: HALF,z: HALF}, {x: HALF,y: HALF,z:-HALF} ],
      left:   [ {x:-HALF,y:-HALF,z:-HALF}, {x:-HALF,y:-HALF,z: HALF}, {x:-HALF,y: HALF,z: HALF}, {x:-HALF,y: HALF,z:-HALF} ],
      top:    [ {x:-HALF,y: HALF,z:-HALF}, {x: HALF,y: HALF,z:-HALF}, {x: HALF,y: HALF,z: HALF}, {x:-HALF,y: HALF,z: HALF} ],
      bottom: [ {x:-HALF,y:-HALF,z:-HALF}, {x: HALF,y:-HALF,z:-HALF}, {x: HALF,y:-HALF,z: HALF}, {x:-HALF,y:-HALF,z: HALF} ],
    };
    return map[face].map(c => project(c.x, c.y, c.z, camera)).filter(Boolean);
  }

  function signedArea(points) {
    let a = 0;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const q = points[(i + 1) % points.length];
      a += p.x * q.y - q.x * p.y;
    }
    return a * 0.5;
  }

  function pickFacesByAngles() {
    const pairs = [ ['front','back'], ['right','left'], ['top','bottom'] ];
    const chosen = [];
    for (const [a, b] of pairs) {
      const ac = projectedCorners(a);
      const bc = projectedCorners(b);
      const ap = project(faceCenter(a).x, faceCenter(a).y, faceCenter(a).z, camera);
      const bp = project(faceCenter(b).x, faceCenter(b).y, faceCenter(b).z, camera);
      const aInFront = ap && ap.z > 1;
      const bInFront = bp && bp.z > 1;
      const aVisible = aInFront && ac.length === 4 && signedArea(ac) > 0;
      const bVisible = bInFront && bc.length === 4 && signedArea(bc) > 0;
      if (aVisible && !bVisible) chosen.push(a);
      else if (!aVisible && bVisible) chosen.push(b);
      else if (aVisible && bVisible) chosen.push(ap.z < bp.z ? a : b);
      else chosen.push(aInFront ? a : b);
    }
    return chosen;
  }

  const handleZoomIn = () => {
    const step = cameraRef.current.z < 50 ? 5 : 25;
    const newZ = Math.max(10, cameraRef.current.z - step);
    cameraRef.current = { ...cameraRef.current, z: newZ };
    setCamera({ ...cameraRef.current });
  };

  const handleZoomOut = () => {
    const step = cameraRef.current.z < 50 ? 5 : 25;
    const newZ = Math.min(900, cameraRef.current.z + step);
    cameraRef.current = { ...cameraRef.current, z: newZ };
    setCamera({ ...cameraRef.current });
  };

  const faces = pickFacesByAngles();

  const sortedFaces = faces
    .map(f => {
      const c = faceCenter(f);
      const p = project(c.x, c.y, c.z, camera);
      const bias = f === 'front' || f === 'top' || f === 'right' ? 0.0005 : 0;
      return { face: f, depth: p ? p.z + bias : 0 };
    })
    .sort((a, b) => b.depth - a.depth)
    .map(o => o.face);

  return (
    <View style={styles.container} {...panResponder.panHandlers}>
      <Svg width={screenWidth} height={screenHeight}>
        {sortedFaces.map(f => (
          <FaceGrid key={f} camera={camera} face={f} />
        ))}
      </Svg>

      <View style={styles.info}>
        <Text style={styles.txt}>{t('demo.faceGridInfo1')}</Text>
        <Text style={styles.txt}>{t('demo.faceGridInfo2')}</Text>
        <Text style={styles.txtSmall}>Faces: {sortedFaces.join(' / ')} | rotX: {camera.rotX.toFixed(3)} | rotY: {camera.rotY.toFixed(3)}</Text>
      </View>

      <View style={styles.zoomRow}>
        <TouchableOpacity onPress={handleZoomOut} style={styles.zoomBtn} activeOpacity={0.7}>
          <Text style={styles.zoomTxt}>−</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => {
            cameraRef.current = { ...INITIAL_CAMERA };
            setCamera({ ...INITIAL_CAMERA });
          }}
          style={styles.centerBtn}
          activeOpacity={0.7}
        >
          <Text style={styles.centerTxt}>{t('demo.center')}</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleZoomIn} style={styles.zoomBtn} activeOpacity={0.7}>
          <Text style={styles.zoomTxt}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  info: { position: 'absolute', top: 30, left: 12, right: 12 },
  txt: { color: '#000', fontSize: 12, marginBottom: 3 },
  txtSmall: { color: '#444', fontSize: 11, marginTop: 2 },
  zoomRow: {
    position: 'absolute',
    right: 14,
    bottom: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  zoomBtn: {
    width: 36,
    height: 36,
    backgroundColor: 'rgba(0,0,0,0.06)',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomTxt: { color: '#000', fontSize: 22, fontWeight: '400', lineHeight: 26 },
  centerBtn: {
    backgroundColor: 'rgba(0,0,0,0.06)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.2)',
  },
  centerTxt: { color: '#000', fontSize: 12, fontWeight: '600' },
});
