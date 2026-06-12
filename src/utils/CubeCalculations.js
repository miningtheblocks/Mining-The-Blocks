/**
 * Utilidades para calcular las posiciones de los cubos en el cubo masivo de 100 capas
 */

export class CubeCalculations {
  /**
   * Calcula el número total de cubos en una capa específica
   * @param {number} layer - Número de capa (1-100)
   * @returns {number} Número total de cubos en esa capa
   */
  static getCubesInLayer(layer) {
    if (layer === 1) return 1;
    
    // Para la capa n, el lado del cubo es (2*n-1)
    const sideLength = 2 * layer - 1;
    const totalCubes = sideLength ** 3;
    
    // Restamos los cubos de la capa interior
    if (layer > 1) {
      const innerSideLength = 2 * (layer - 1) - 1;
      const innerCubes = innerSideLength ** 3;
      return totalCubes - innerCubes;
    }
    
    return totalCubes;
  }

  /**
   * Genera las posiciones de todos los cubos visibles en la capa externa (capa 100)
   * Solo genera cubos que están en la superficie externa
   * @returns {Array} Array de posiciones {x, y, z}
   */
  static generateLayer100Positions() {
    const layer = 100;
    const sideLength = 2 * layer - 1; // 199
    const halfSide = Math.floor(sideLength / 2); // 99
    const positions = [];

    // Solo generamos cubos en las caras externas del cubo
    for (let x = -halfSide; x <= halfSide; x++) {
      for (let y = -halfSide; y <= halfSide; y++) {
        for (let z = -halfSide; z <= halfSide; z++) {
          // Un cubo está en la superficie si al menos una coordenada está en el borde
          const isOnSurface = 
            Math.abs(x) === halfSide || 
            Math.abs(y) === halfSide || 
            Math.abs(z) === halfSide;
          
          if (isOnSurface) {
            positions.push({ x, y, z });
          }
        }
      }
    }

    return positions;
  }

  /**
   * Aplica culling de frustum para renderizar solo cubos visibles
   * @param {Array} positions - Posiciones de todos los cubos
   * @param {Object} camera - Objeto cámara con posición y rotación
   * @param {number} fov - Campo de visión
   * @returns {Array} Posiciones de cubos visibles
   */
  static applyCameraFrustumCulling(positions, camera, fov = 60) {
    // Implementación básica de frustum culling
    // En una implementación real, esto sería más complejo
    const maxDistance = 150; // Distancia máxima de renderizado
    
    return positions.filter(pos => {
      const distance = Math.sqrt(
        (pos.x - camera.x) ** 2 + 
        (pos.y - camera.y) ** 2 + 
        (pos.z - camera.z) ** 2
      );
      
      return distance <= maxDistance;
    });
  }

  /**
   * Calcula qué caras de un cubo son visibles desde una posición de cámara
   * @param {Object} cubePos - Posición del cubo {x, y, z}
   * @param {Object} cameraPos - Posición de la cámara {x, y, z}
   * @returns {Object} Objeto indicando qué caras son visibles
   */
  static getVisibleFaces(cubePos, cameraPos) {
    const dx = cameraPos.x - cubePos.x;
    const dy = cameraPos.y - cubePos.y;
    const dz = cameraPos.z - cubePos.z;

    return {
      front: dz > 0,   // Cara frontal (z+)
      back: dz < 0,    // Cara trasera (z-)
      right: dx > 0,   // Cara derecha (x+)
      left: dx < 0,    // Cara izquierda (x-)
      top: dy > 0,     // Cara superior (y+)
      bottom: dy < 0   // Cara inferior (y-)
    };
  }

  /**
   * Transforma coordenadas 3D a 2D para renderizado
   * @param {Object} pos3d - Posición 3D {x, y, z}
   * @param {Object} camera - Cámara {x, y, z, rotX, rotY, rotZ}
   * @param {number} screenWidth - Ancho de pantalla
   * @param {number} screenHeight - Alto de pantalla
   * @param {number} fov - Campo de visión
   * @returns {Object} Posición 2D {x, y, scale}
   */
  static project3DTo2D(pos3d, camera, screenWidth, screenHeight, fov = 60) {
    // Trasladar al espacio de la cámara
    let x = pos3d.x - camera.x;
    let y = pos3d.y - camera.y;
    let z = pos3d.z - camera.z;

    // Aplicar rotaciones de la cámara
    const cosRotY = Math.cos(camera.rotY);
    const sinRotY = Math.sin(camera.rotY);
    const cosRotX = Math.cos(camera.rotX);
    const sinRotX = Math.sin(camera.rotX);

    // Rotación Y (horizontal)
    const tempX = x * cosRotY - z * sinRotY;
    z = x * sinRotY + z * cosRotY;
    x = tempX;

    // Rotación X (vertical)
    const tempY = y * cosRotX - z * sinRotX;
    z = y * sinRotX + z * cosRotX;
    y = tempY;

    // Proyección perspectiva
    if (z <= 0) return null; // Detrás de la cámara

    const fovRad = (fov * Math.PI) / 180;
    const scale = 1 / Math.tan(fovRad / 2) / z;
    
    const screenX = (x * scale * screenHeight / 2) + screenWidth / 2;
    const screenY = (-y * scale * screenHeight / 2) + screenHeight / 2;

    return {
      x: screenX,
      y: screenY,
      scale: scale,
      depth: z
    };
  }
}
