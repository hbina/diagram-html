const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildGraph } = require('../index.js');
const script = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/owner-flowchart.mmd'), 'utf8');
const bidirectionalFixture = fs.readFileSync(path.join(__dirname, 'fixtures/bidirectional-flowchart.mmd'), 'utf8');
let checked = 0;
function verify(source) {
  const graph = buildGraph(source);
  for (const edge of graph.edges) {
    assert(edge.points.length >= 2);
    for (let i = 1; i < edge.points.length; i++) {
      const a = edge.points[i - 1], b = edge.points[i];
      assert(a.x === b.x || a.y === b.y, 'Each segment must be orthogonal');
      assert(a.x !== b.x || a.y !== b.y, 'Segments must have length');
      for (const p of [a, b]) {
        assert(p.x >= 0 && p.x <= graph.width && p.y >= 0 && p.y <= graph.height, 'Route must fit in diagram bounds');
      }
      for (const node of graph.nodes) {
        const epsilon = 1e-7;
        const crosses = a.x === b.x
          ? a.x > node.x + epsilon && a.x < node.x + node.w - epsilon && Math.max(a.y, b.y) > node.y + epsilon && Math.min(a.y, b.y) < node.y + node.h - epsilon
          : a.y > node.y + epsilon && a.y < node.y + node.h - epsilon && Math.max(a.x, b.x) > node.x + epsilon && Math.min(a.x, b.x) < node.x + node.w - epsilon;
        assert(!crosses, `${graph.direction}: ${graph.nodes[edge.from].id} -> ${graph.nodes[edge.to].id} crosses ${node.id}`);
      }
      checked++;
    }
  }
  return graph;
}
for (const direction of ['LR', 'RL', 'TB', 'TD', 'BT']) {
  const bidirectional = verify(bidirectionalFixture.replace('flowchart LR', 'flowchart ' + direction));
  assert.equal(bidirectional.nodes.length, 7);
  assert.equal(bidirectional.edges.length, 6);
  assert.equal(bidirectional.nodes[0].label, 'Configuration master / decoder');
  for (const [i, edge] of bidirectional.edges.entries()) {
    assert.equal(edge.from, i);
    assert.equal(edge.to, i + 1);
    assert.equal(edge.startArrow, true);
    assert.equal(edge.arrow, true);
    const a = bidirectional.nodes[edge.from], b = bidirectional.nodes[edge.to];
    if (direction === 'LR') assert(a.x < b.x);
    else if (direction === 'RL') assert(a.x > b.x);
    else if (direction === 'BT') assert(a.y > b.y);
    else assert(a.y < b.y);
  }
  verify(fixture.replace('flowchart TD', 'flowchart ' + direction));
  verify(`flowchart ${direction}\na[Start] --> b{Decision}\nb --> c("Round")\nc --> d[Finish]\na --> d\nb --> b\nx --> y\ny --> x\nx --> x`);
  // Long labels create different node heights; cycles and disconnected nodes
  // exercise channels alongside both wide and tall blocks.
  let source = `flowchart ${direction}\n`;
  for (let i = 0; i < 80; i++) source += `n${i}${i % 3 === 0 ? '{' : '['}"${'Long node label '.repeat(i % 7 + 1)}"${i % 3 === 0 ? '}' : ']'}\n`;
  for (let i = 0; i < 75; i++) {
    source += `n${i} --> n${i + 1}\n`;
    if (i % 4 === 0) source += `n${i} --> n${i + 4}\n`;
    if (i % 9 === 0) source += `n${i + 2} --> n${i}\nn${i} --> n${i}\n`;
  }
  verify(source);
}
const example = verify(fixture);
assert.equal(example.nodes.length, 17);
assert.equal(example.edges.length, 30);
const mixed = verify('flowchart LR\na-b<-->|request / reply|b_c-->c---d-.->e; e<-->e %% loop');
assert.equal(mixed.nodes[0].id, 'a-b');
assert.equal(mixed.edges[0].label, 'request / reply');
assert.deepEqual(Array.from(mixed.edges, e => [e.startArrow, e.arrow, e.dotted]), [
  [true, true, false], [false, true, false], [false, false, false], [false, true, true], [true, true, false]
]);
assert.throws(() => buildGraph('---\nmaxEdges: 1\n---\nflowchart LR\na<-->b<-->c'), /Edge count exceeds maxEdges/);

// Exercise the SVG renderer so parsing support also produces both arrowheads.
const elements = [];
function element(tag, attrs = {}) {
  const result = { tag, attrs, children: [], append(...children) { this.children.push(...children); }, setAttribute(key, value) { this.attrs[key] = value; } };
  elements.push(result);
  return result;
}
const draw = vm.runInNewContext(script.slice(script.indexOf('  function draw('), script.indexOf('  function stop(')) + '\ndraw;', {
  document: { createDocumentFragment: () => element('fragment') }, el: element,
  scene: { replaceChildren() {} }, $: () => ({}), selectNode() {}, fit() {}, selectedId: null
});
draw(mixed);
const paths = elements.filter(e => e.tag === 'path' && 'data-edge' in e.attrs);
assert.equal(paths.length, mixed.edges.length);
for (const [i, path] of paths.entries()) {
  assert.equal(path.attrs['marker-start'], mixed.edges[i].startArrow ? 'url(#arrow)' : undefined);
  assert.equal(path.attrs['marker-end'], mixed.edges[i].arrow ? 'url(#arrow)' : undefined);
}
assert.equal(elements.find(e => e.tag === 'marker').attrs.orient, 'auto-start-reverse');
console.log(`Passed: ${checked} orthogonal segments avoid every block, across all directions, feedback cycles, self-loops, long edges, and varying node sizes.`);
