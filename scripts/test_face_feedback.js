const assert = require('assert');
const { normalize, selectReferences, referenceScore, pairKey, isSeparatedAmbiguity,
  recordIdentityFeedback, attachFeedbackReferences } = require('../lib/face_feedback');

async function main() {
  assert.strictEqual(normalize([NaN, 1]), null);
  assert.strictEqual(normalize([0, 0]), null);
  const old = { face_id: 1, sample_kind: 'explicit', normalized_embedding: [1, 0] };
  const recent = Array.from({ length: 300 }, (_, index) => ({
    face_id: index + 2, sample_kind: 'group', normalized_embedding: [0, 1],
  }));
  const references = selectReferences([...recent, old]);
  assert.strictEqual(references.length, 16);
  assert.strictEqual(references[0].face_id, 1, 'old explicit feedback cannot be displaced by recent group samples');
  assert.strictEqual(referenceScore([1, 0], references), 1, 'group suggestions must not dilute explicit confirmation');
  assert.strictEqual(referenceScore([1, 0], selectReferences([old])), 1);
  assert.strictEqual(referenceScore([1, 0, 0], selectReferences([old])), -1, 'incompatible embeddings are ignored');
  const profiles = [];
  attachFeedbackReferences(profiles, new Map([[7, selectReferences([old])]]));
  assert.strictEqual(profiles[0].personId, 7, 'feedback can keep an old person eligible without recent automatic references');
  const pairs = new Set([pairKey(1, 2)]);
  assert(isSeparatedAmbiguity([{ personId: 1, score: 0.52 }, { personId: 2, score: 0.49 }], pairs, 0.36));
  assert(!isSeparatedAmbiguity([{ personId: 1, score: 0.72 }, { personId: 2, score: 0.49 }], pairs, 0.36));
  assert(!isSeparatedAmbiguity([{ personId: 1, score: 0.2 }, { personId: 2, score: 0.19 }], pairs, 0.36));
  const writes = [];
  const conn = { query: async (sql, params) => { writes.push({ sql, params }); return [{ insertId: 3 }]; } };
  await recordIdentityFeedback(conn, { orgId: 2, userId: 4, action: 'label', assignments: [{
    face: { id: 8, photo_id: 9, organization_id: 2, person_id: 6, normalized_embedding: [3, 4] },
    personId: 7, kind: 'explicit',
  }] });
  const event = JSON.parse(writes[0].params[4]);
  assert.strictEqual(event.faces[0].fromPersonId, 6);
  assert.strictEqual(event.faces[0].toPersonId, 7);
  assert.deepStrictEqual(JSON.parse(writes[1].params[0][0][5]), [0.6, 0.8]);
  await assert.rejects(recordIdentityFeedback(conn, { orgId: 2, action: 'label', assignments: [{
    face: { organization_id: 3 }, personId: 7,
  }] }), /organization mismatch/);
  assert.strictEqual(writes.length, 2, 'cross-organization feedback is rejected before any write');
  console.log('face feedback: durable references, model dimensions, separation ambiguity, audit trail and organization isolation passed');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
