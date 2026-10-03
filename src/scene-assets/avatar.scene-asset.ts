import { BoxGeometry, CylinderGeometry, IcosahedronGeometry, Mesh, MeshLambertMaterial, TorusGeometry } from '@iwsdk/core';
import { mergeParts } from './lowpoly.js';

/**
 * Stylised crew avatar: head with goggles, gloved hands and a torso placed
 * below the head. This is the stress-test stand-in for a remote player (one
 * draw call); the networked avatar in spike S4 splits head and hands so they
 * can move independently.
 */

export const CREW_COLORS = [0x2f6db3, 0xc0563a, 0x3f8f5a, 0x8a4fb0, 0xd19a2a, 0x2a9a9a, 0x9a3a5a, 0x5a5a5a];
const SKIN = 0xe0b48f;
const LEATHER = 0x6a4a30;
const GLASS = 0x9fd3e8;
const BRASS = 0xc9a03a;

export function createDummyAvatar(index: number): Mesh {
  const coat = CREW_COLORS[index % CREW_COLORS.length];
  const geometry = mergeParts([
    // Head and leather cap.
    { geometry: new IcosahedronGeometry(0.11, 1), color: SKIN, position: [0, 1.62, 0] },
    { geometry: new IcosahedronGeometry(0.115, 1), color: LEATHER, position: [0, 1.66, 0.01], scale: [1, 0.7, 1] },
    // Goggles.
    { geometry: new TorusGeometry(0.035, 0.012, 4, 8), color: BRASS, position: [-0.045, 1.645, -0.1] },
    { geometry: new TorusGeometry(0.035, 0.012, 4, 8), color: BRASS, position: [0.045, 1.645, -0.1] },
    { geometry: new CylinderGeometry(0.03, 0.03, 0.01, 8), color: GLASS, position: [-0.045, 1.645, -0.1], rotation: [Math.PI / 2, 0, 0] },
    { geometry: new CylinderGeometry(0.03, 0.03, 0.01, 8), color: GLASS, position: [0.045, 1.645, -0.1], rotation: [Math.PI / 2, 0, 0] },
    // Torso and scarf.
    { geometry: new CylinderGeometry(0.17, 0.14, 0.55, 7), color: coat, position: [0, 1.22, 0] },
    { geometry: new CylinderGeometry(0.1, 0.15, 0.08, 7), color: 0xe8dcc0, position: [0, 1.49, 0] },
    // Gloved hands held forward.
    { geometry: new BoxGeometry(0.08, 0.05, 0.11), color: LEATHER, position: [-0.22, 1.05, -0.28] },
    { geometry: new BoxGeometry(0.08, 0.05, 0.11), color: LEATHER, position: [0.22, 1.05, -0.28] },
  ]);
  const mesh = new Mesh(geometry, new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
  mesh.name = `Crew Avatar ${index + 1}`;
  return mesh;
}
