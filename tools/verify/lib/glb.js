// tools/verify/lib/glb.js
//
// Minimal binary-glTF (.glb) reader for the budget verifier. Reads ONLY the
// 12-byte header and the JSON chunk (chunk 0). It never touches the BIN chunk
// and never renders anything — glTF accessors carry `count` for every vertex
// attribute and index buffer directly in the JSON, so triangle counts are
// computable from JSON alone. No glTF library, per the order.
//
// GLB layout (spec: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#glb-file-format):
//   uint32 magic ('glTF' = 0x46546C67)   -- bytes 0..3
//   uint32 version                        -- bytes 4..7
//   uint32 length (total file length)     -- bytes 8..11
//   then one or more chunks:
//     uint32 chunkLength
//     uint32 chunkType  ('JSON' = 0x4E4F534A, 'BIN\0' = 0x004E4942)
//     uint8[chunkLength] chunkData
//
// Triangle counting rule (documented here and restated in the order notes):
//   For each primitive in every mesh:
//     - vertexCount = primitive.indices != null
//                       ? accessors[primitive.indices].count
//                       : accessors[primitive.attributes.POSITION].count
//     - mode = primitive.mode ?? 4 (TRIANGLES, the glTF default)
//     - triangles = mode === 4 ? vertexCount / 3
//                 : (mode === 5 || mode === 6) ? Math.max(0, vertexCount - 2)  // STRIP / FAN
//                 : 0   // POINTS/LINES/... contribute no triangles
//   The total is the sum across all primitives of all meshes actually
//   referenced is not computed (we do not walk the scene graph) — we sum
//   every mesh in the `meshes` array, which is the conservative (>=) count
//   and matches "declared tri count" being an asset-level property.

const GLB_MAGIC = 0x46546c67;
const CHUNK_TYPE_JSON = 0x4e4f534a;

/**
 * @param {Buffer} buf full contents of a .glb file
 * @returns {{ json: object }} the parsed JSON chunk
 */
export function readGlbJsonChunk(buf) {
  if (buf.length < 12) throw new Error('not a GLB file: shorter than the 12-byte header');
  const magic = buf.readUInt32LE(0);
  if (magic !== GLB_MAGIC) throw new Error(`not a GLB file: bad magic 0x${magic.toString(16)}`);
  const version = buf.readUInt32LE(4);
  const totalLength = buf.readUInt32LE(8);
  if (totalLength > buf.length) throw new Error(`GLB header declares length ${totalLength} but file is ${buf.length} bytes`);

  let offset = 12;
  let jsonChunk = null;
  while (offset + 8 <= totalLength) {
    const chunkLength = buf.readUInt32LE(offset);
    const chunkType = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    if (dataEnd > buf.length) throw new Error('GLB chunk overruns file bounds');
    if (chunkType === CHUNK_TYPE_JSON) {
      jsonChunk = buf.subarray(dataStart, dataEnd);
      break; // JSON chunk must be first per spec; no need to read BIN.
    }
    offset = dataEnd;
  }
  if (!jsonChunk) throw new Error('GLB file has no JSON chunk');
  let json;
  try {
    json = JSON.parse(jsonChunk.toString('utf8'));
  } catch (e) {
    throw new Error('GLB JSON chunk is not valid JSON: ' + e.message);
  }
  return { json, version };
}

/** Triangles contributed by one primitive, given the document's accessors array. */
function primitiveTriangles(primitive, accessors) {
  const mode = primitive.mode === undefined ? 4 : primitive.mode;
  let vertexCount;
  if (primitive.indices !== undefined && primitive.indices !== null) {
    const acc = accessors[primitive.indices];
    if (!acc) throw new Error(`primitive.indices ${primitive.indices} has no matching accessor`);
    vertexCount = acc.count;
  } else {
    const posIdx = primitive.attributes && primitive.attributes.POSITION;
    if (posIdx === undefined) return 0; // no position, nothing to count
    const acc = accessors[posIdx];
    if (!acc) throw new Error(`POSITION accessor ${posIdx} missing`);
    vertexCount = acc.count;
  }
  if (mode === 4) return vertexCount / 3;
  if (mode === 5 || mode === 6) return Math.max(0, vertexCount - 2);
  return 0;
}

/**
 * Sum triangles across every mesh/primitive in a parsed glTF JSON document.
 * @param {object} gltf parsed JSON chunk
 * @returns {number}
 */
export function countTriangles(gltf) {
  const accessors = gltf.accessors || [];
  const meshes = gltf.meshes || [];
  let total = 0;
  for (const mesh of meshes) {
    for (const primitive of mesh.primitives || []) {
      total += primitiveTriangles(primitive, accessors);
    }
  }
  return total;
}
