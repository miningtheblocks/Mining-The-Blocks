import React, { useMemo, useRef, useState, useEffect } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Box } from '@react-three/drei';
import * as THREE from 'three';
import { CubeCalculations } from '../utils/CubeCalculations';

/**
 * Componente individual de cubo optimizado
 */
function SingleCube({ position, visible = true }) {
  const meshRef = useRef();

  if (!visible) return null;

  return (
    <Box
      ref={meshRef}
      position={[position.x, position.y, position.z]}
      args={[0.98, 0.98, 0.98]} // Ligeramente más pequeño para mostrar las aristas
    >
      <meshBasicMaterial color="white" />
      <lineSegments>
        <edgesGeometry args={[new THREE.BoxGeometry(0.98, 0.98, 0.98)]} />
        <lineBasicMaterial color="black" linewidth={1} />
      </lineSegments>
    </Box>
  );
}

/**
 * Componente que maneja la instanciación masiva de cubos
 */
function CubeInstances({ positions, cameraPosition }) {
  const instancedMeshRef = useRef();
  const edgesRef = useRef();
  
  const { geometry, edgesGeometry } = useMemo(() => {
    const boxGeometry = new THREE.BoxGeometry(0.98, 0.98, 0.98);
    const edges = new THREE.EdgesGeometry(boxGeometry);
    return { geometry: boxGeometry, edgesGeometry: edges };
  }, []);

  const { visiblePositions, instanceMatrix, edgeInstanceMatrix } = useMemo(() => {
    // Aplicar culling básico - solo mostrar cubos dentro de un rango
    const maxDistance = 120;
    const filtered = positions.filter(pos => {
      const distance = Math.sqrt(pos.x ** 2 + pos.y ** 2 + pos.z ** 2);
      return distance <= maxDistance;
    });

    // Crear matrices de instancia para los cubos
    const matrix = new THREE.Matrix4();
    const instanceMatrix = new THREE.InstancedBufferAttribute(
      new Float32Array(filtered.length * 16), 16
    );
    
    const edgeMatrix = new THREE.InstancedBufferAttribute(
      new Float32Array(filtered.length * 16), 16
    );

    filtered.forEach((pos, i) => {
      matrix.setPosition(pos.x, pos.y, pos.z);
      matrix.toArray(instanceMatrix.array, i * 16);
      matrix.toArray(edgeMatrix.array, i * 16);
    });

    return {
      visiblePositions: filtered,
      instanceMatrix,
      edgeInstanceMatrix: edgeMatrix
    };
  }, [positions, cameraPosition]);

  useEffect(() => {
    if (instancedMeshRef.current) {
      instancedMeshRef.current.instanceMatrix = instanceMatrix;
      instancedMeshRef.current.instanceMatrix.needsUpdate = true;
    }
    if (edgesRef.current) {
      edgesRef.current.instanceMatrix = edgeInstanceMatrix;
      edgesRef.current.instanceMatrix.needsUpdate = true;
    }
  }, [instanceMatrix, edgeInstanceMatrix]);

  return (
    <group>
      {/* Cubos blancos */}
      <instancedMesh
        ref={instancedMeshRef}
        args={[geometry, null, visiblePositions.length]}
      >
        <meshBasicMaterial color="white" />
      </instancedMesh>
      
      {/* Aristas negras */}
      <instancedMesh
        ref={edgesRef}
        args={[edgesGeometry, null, visiblePositions.length]}
      >
        <lineBasicMaterial color="black" />
      </instancedMesh>
    </group>
  );
}

/**
 * Componente principal del cubo masivo
 */
export default function MassiveCube() {
  const [cameraPosition, setCameraPosition] = useState({ x: 0, y: 0, z: 150 });
  
  // Generar posiciones de la capa 100 (solo superficie externa)
  const cubePositions = useMemo(() => {
    const positions = CubeCalculations.generateLayer100Positions();
    return positions;
  }, []);

  // Componente de cámara que actualiza la posición
  function CameraController() {
    useFrame((state) => {
      const { camera } = state;
      setCameraPosition({
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z
      });
    });
    return null;
  }

  return (
    <Canvas
      camera={{ 
        position: [150, 150, 150], 
        fov: 60,
        near: 0.1,
        far: 1000
      }}
      style={{ width: '100%', height: '100%' }}
    >
      {/* Iluminación */}
      <ambientLight intensity={0.6} />
      <directionalLight position={[10, 10, 5]} intensity={0.8} />
      
      {/* Controles de órbita para rotar la cámara */}
      <OrbitControls
        enablePan={true}
        enableZoom={true}
        enableRotate={true}
        maxDistance={300}
        minDistance={50}
      />
      
      {/* Controlador de cámara */}
      <CameraController />
      
      {/* Renderizar cubos con instanciación */}
      <CubeInstances 
        positions={cubePositions} 
        cameraPosition={cameraPosition}
      />
      
      {/* Cubo de referencia en el centro (opcional) */}
      <Box position={[0, 0, 0]} args={[1, 1, 1]}>
        <meshBasicMaterial color="red" transparent opacity={0.3} />
      </Box>
    </Canvas>
  );
}
