// tools/verify/fixtures/generate-glb-fixture.js
//
// Generates `tools/verify/fixtures/triangle.glb` — a tiny, VALID binary glTF
// containing exactly one triangle (3 vertices, 3 indices, TRIANGLES mode) —
// plus its sidecar `triangle.glb.meta.json`. Committed as a byte-for-byte
// fixture; re-run this script only if you want to regenerate it:
//   node tools/verify/fixtures/generate-glb-fixture.js
//
// No glTF library is used — every byte is placed by hand per the binary glTF
// 2.0 spec (12-byte header + JSON chunk + BIN chunk, each chunk padded to a
// 4-byte boundary: JSON with 0x20 spaces, BIN with 0x00 bytes).

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// --- geometry: one triangle in the XY plane ---
const positions = new Float32Array([
  0, 0, 0,
  1, 0, 0,
  0, 1, 0
]);
const indices = new Uint16Array([0, 1, 2]);

const positionsBuf = Buffer.from(positions.buffer);
// Indices buffer must start at a 4-byte-aligned offset within the BIN chunk
// for glTF component-type alignment rules; pad if needed.
const indicesOffset = positionsBuf.length + (positionsBuf.length % 4 === 0 ? 0 : 4 - (positionsBuf.length % 4));
const indicesBuf = Buffer.from(indices.buffer);
const binLength = indicesOffset + indicesBuf.length;
const bin = Buffer.alloc(binLength);
positionsBuf.copy(bin, 0);
indicesBuf.copy(bin, indicesOffset);

const gltf = {
  asset: { version: '2.0', generator: 'riptide-arcade tools/verify/fixtures/generate-glb-fixture.js' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{
    primitives: [{
      attributes: { POSITION: 0 },
      indices: 1,
      mode: 4 // TRIANGLES
    }]
  }],
  buffers: [{ byteLength: bin.length }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: positionsBuf.length, target: 34962 },        // ARRAY_BUFFER
    { buffer: 0, byteOffset: indicesOffset, byteLength: indicesBuf.length, target: 34963 } // ELEMENT_ARRAY_BUFFER
  ],
  accessors: [
    {
      bufferView: 0, byteOffset: 0, componentType: 5126 /* FLOAT */, count: 3, type: 'VEC3',
      min: [0, 0, 0], max: [1, 1, 0]
    },
    {
      bufferView: 1, byteOffset: 0, componentType: 5123 /* UNSIGNED_SHORT */, count: 3, type: 'SCALAR'
    }
  ]
};

function pad(buf, alignment, fillByte) {
  const rem = buf.length % alignment;
  if (rem === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(alignment - rem, fillByte)]);
}

const jsonBuf = pad(Buffer.from(JSON.stringify(gltf), 'utf8'), 4, 0x20); // pad with spaces
const binPadded = pad(bin, 4, 0x00);

const GLB_MAGIC = 0x46546c67;
const CHUNK_TYPE_JSON = 0x4e4f534a;
const CHUNK_TYPE_BIN = 0x004e4942;

const jsonChunkHeader = Buffer.alloc(8);
jsonChunkHeader.writeUInt32LE(jsonBuf.length, 0);
jsonChunkHeader.writeUInt32LE(CHUNK_TYPE_JSON, 4);

const binChunkHeader = Buffer.alloc(8);
binChunkHeader.writeUInt32LE(binPadded.length, 0);
binChunkHeader.writeUInt32LE(CHUNK_TYPE_BIN, 4);

const totalLength = 12 + jsonChunkHeader.length + jsonBuf.length + binChunkHeader.length + binPadded.length;

const header = Buffer.alloc(12);
header.writeUInt32LE(GLB_MAGIC, 0);
header.writeUInt32LE(2, 4);           // version 2
header.writeUInt32LE(totalLength, 8);

const glb = Buffer.concat([header, jsonChunkHeader, jsonBuf, binChunkHeader, binPadded]);

const outPath = join(here, 'triangle.glb');
writeFileSync(outPath, glb);

const meta = {
  provenance: {
    tool: 'tools/verify/fixtures/generate-glb-fixture.js',
    prompt: 'hand-authored single-triangle mesh for budget.js unit tests',
    model: 'n/a (hand-written binary, no generative model involved)'
  },
  declaredTriangles: 1,
  rigStatus: 'clean'
};
writeFileSync(join(here, 'triangle.glb.meta.json'), JSON.stringify(meta, null, 2) + '\n');

console.log(`wrote ${outPath} (${glb.length} bytes, 1 triangle) and its .meta.json sidecar`);
