const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildGraph } = require('../index.js');
const script = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/owner-flowchart.mmd'), 'utf8');
const bidirectionalFixture = fs.readFileSync(path.join(__dirname, 'fixtures/bidirectional-flowchart.mmd'), 'utf8');
const ethernetFixture = fs.readFileSync(path.join(__dirname, 'fixtures/ethernet-flowchart.mmd'), 'utf8');
let checked = 0;
function verify(source) {
  const graph = buildGraph(source);
  for (const edge of graph.edges) {
    assert(edge.points.length >= 2);
    const from = graph.nodes[edge.from], to = graph.nodes[edge.to];
    const start = edge.points[0], next = edge.points[1], end = edge.points.at(-1), previous = edge.points.at(-2);
    // Inputs merge on the leading face, outputs on the trailing face.
    // This also applies when cycles put both endpoints in the same layer.
    if (graph.direction === 'LR') {
      assert(Math.abs(start.x - (from.x + from.w)) < 1e-7); assert(Math.abs(end.x - (to.x)) < 1e-7);
      assert(next.x > start.x && previous.x < end.x);
    } else if (graph.direction === 'RL') {
      assert(Math.abs(start.x - (from.x)) < 1e-7); assert(Math.abs(end.x - (to.x + to.w)) < 1e-7);
      assert(next.x < start.x && previous.x > end.x);
    } else if (graph.direction === 'BT') {
      assert(Math.abs(start.y - (from.y)) < 1e-7); assert(Math.abs(end.y - (to.y + to.h)) < 1e-7);
      assert(next.y < start.y && previous.y > end.y);
    } else {
      assert(Math.abs(start.y - (from.y + from.h)) < 1e-7); assert(Math.abs(end.y - (to.y)) < 1e-7);
      assert(next.y > start.y && previous.y < end.y);
    }
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
  const insideK = verify(`flowchart ${direction}
subgraph K["Inside K"]
A["TCP configuration register"]
B["Policy checks current row health"]
C["Governor produces start permission"]
D["TCP produces first SOF offer"]
E["Policy qualifies presentation"]
F["Governor qualifies acceptance/completion"]
G["Governor state/counter register"]
A --> B --> C --> D --> E --> F --> G
end`);
  assert.equal(insideK.nodes.length, 7);
  assert.equal(insideK.edges.length, 6);
  const merging = verify(`flowchart ${direction}\na --> center\nb --> center\ncenter --> c\ncenter --> d\nc --> a\ncenter --> center`);
  const inputs = merging.edges.filter(e => merging.nodes[e.to].id === 'center');
  const outputs = merging.edges.filter(e => merging.nodes[e.from].id === 'center');
  for (const edge of inputs) assert.deepEqual(edge.points.at(-1), inputs[0].points.at(-1), 'Inputs must merge at a common port');
  for (const edge of outputs) assert.deepEqual(edge.points[0], outputs[0].points[0], 'Outputs must split from a common port');
  assert.notDeepEqual(inputs[0].points.at(-1), outputs[0].points[0], 'Input and output ports must be separate');
  const ethernet = verify(ethernetFixture.replace('flowchart TD', 'flowchart ' + direction));
  assert.equal(ethernet.subgraphs.length, 4);
  assert.equal(ethernet.nodes.filter(v => v.style?.fill === '#fff3cd').length, 15);
  assert.equal(ethernet.nodes.filter(v => v.style?.fill === '#eef1f5').length, 9);
  assert.equal(ethernet.edges[1].label, 'TCP packets and exchange replies');
  for (const [i, group] of ethernet.subgraphs.entries()) {
    assert(group.x >= 0 && group.y >= 0 && group.x + group.w <= ethernet.width && group.y + group.h <= ethernet.height);
    for (const node of ethernet.nodes.filter(v => v.group === i)) {
      assert(node.x >= group.x && node.y >= group.y + 30 && node.x + node.w <= group.x + group.w && node.y + node.h <= group.y + group.h);
    }
    for (const other of ethernet.subgraphs.slice(i + 1)) {
      assert(group.x + group.w <= other.x || other.x + other.w <= group.x || group.y + group.h <= other.y || other.y + other.h <= group.y, 'Sibling groups must not overlap');
    }
  }
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
const ethernet = verify(ethernetFixture);
elements.length = 0;
draw(ethernet);
assert.equal(elements.filter(e => e.attrs['data-subgraph']).length, 4);
assert.equal(elements.filter(e => e.tag === 'rect' && e.attrs.fill === '#fff3cd').length, 15);
assert.equal(elements.filter(e => e.tag === 'text' && e.attrs.fill === '#302400').length, 15);
const renderedNodes = elements.filter(e => e.attrs['data-node'] !== undefined);
for (const node of renderedNodes) {
  node.getAttribute = key => node.attrs[key];
  node.querySelector = () => node.children.find(child => child.tag === 'rect' || child.tag === 'polygon');
}
const selectStyled = vm.runInNewContext(script.slice(script.indexOf('  function selectNode('), script.indexOf('  function draw(')) + '\nselectNode;', {
  current: ethernet, selectedId: null, Set,
  scene: { querySelectorAll: selector => selector === '[data-node]' ? renderedNodes : [] }
});
selectStyled('AS');
selectStyled(null);
for (const [i, node] of renderedNodes.entries()) {
  assert.equal(node.querySelector().attrs.fill, ethernet.nodes[i].style?.fill || '#202f44');
  assert.equal(node.querySelector().attrs.stroke, ethernet.nodes[i].style?.stroke || '#87a9d7');
}
const nested = verify('flowchart TD\nsubgraph outer["Outer"]\na\nsubgraph inner["Inner"]\nb --> c\nend\na --> b\nend\nc --> z\nclass a,b tint; classDef tint fill:gold,color:black;');
assert.equal(nested.subgraphs[1].parent, 0);
assert(nested.subgraphs[1].x > nested.subgraphs[0].x);
assert(nested.subgraphs[1].y > nested.subgraphs[0].y);
assert.equal(nested.nodes[1].style.fill, 'gold');
assert.throws(() => buildGraph('flowchart TD\nsubgraph x\na'), /Unclosed subgraph/);
assert.throws(() => buildGraph('flowchart TD\nend\na'), /Unexpected subgraph end/);
assert.throws(() => buildGraph('flowchart TD\na\nclass a missing'), /Unknown class/);
assert.throws(() => buildGraph('flowchart TD\na\nclassDef bad fill:url(javascript:bad)'), /Supported class properties/);
const external = verify('flowchart TD\nexternal[Outside]\nsubgraph group\na --> external\nend');
assert.equal(external.nodes[0].group, undefined, 'Referencing an external node must not move it into a group');
console.log(`Passed: ${checked} orthogonal segments avoid every block, across all directions, feedback cycles, self-loops, long edges, and varying node sizes.`);
