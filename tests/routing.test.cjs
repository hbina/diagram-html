const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(script);
const buildGraph = vm.runInNewContext(script.slice(0, script.indexOf('    const $ =')) + '\nbuildGraph;');
const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/owner-flowchart.mmd'), 'utf8');
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
console.log(`Passed: ${checked} orthogonal segments avoid every block, across all directions, feedback cycles, self-loops, long edges, and varying node sizes.`);
