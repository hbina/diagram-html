'use strict';
// This function is also the worker program. It has no dependencies on the page.
function buildGraph(source) {
  function fail(line, message) { throw new Error('Line ' + line + ': ' + message); }
  let maxEdges = 20000, maxTextSize = 1000000;
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  let first = 0;
  while (first < lines.length && !lines[first].trim()) first++;
  if (lines[first]?.trim() === '---') {
    let end = first + 1;
    for (; end < lines.length && lines[end].trim() !== '---'; end++) {
      const m = lines[end].match(/^\s*(maxEdges|maxTextSize)\s*:\s*(\d+)\s*(?:#.*)?$/);
      if (m) {
        const value = Number(m[2]);
        if (!Number.isSafeInteger(value) || value < 1) fail(end + 1, 'Limit must be a positive integer.');
        if (m[1] === 'maxEdges') maxEdges = value; else maxTextSize = value;
      }
    }
    if (end === lines.length) fail(first + 1, 'Unclosed configuration header.');
    first = end + 1;
  }
  if (source.length > maxTextSize) throw new Error('Source exceeds maxTextSize (' + maxTextSize + ').');
  const nodes = [], edges = [], ids = new Map(), subgraphs = [], groupStack = [], groupIds = new Set();
  const classDefs = new Map(), assignments = [];
  let direction = null, stateDiagram = false;
  function node(id, label, shape) {
    const created = !ids.has(id);
    if (created) { ids.set(id, nodes.length); nodes.push({ id, label: id, shape: stateDiagram ? 'round' : 'rect' }); }
    const index = ids.get(id);
    if (label !== undefined) Object.assign(nodes[index], { label, shape });
    if (groupStack.length && nodes[index].group === undefined && (created || label !== undefined)) nodes[index].group = groupStack[groupStack.length - 1];
    return index;
  }
  function unquote(label) {
    return label.startsWith('"') && label.endsWith('"') ? label.slice(1, -1).replace(/\\(["\\])/g, '$1') : label;
  }
  // Labels store line breaks as newlines. Breaks are split before entities are
  // decoded, so an escaped &lt;br&gt; stays visible text. Mermaid entity codes
  // (#lt; #60;) and common HTML entities (&lt; &amp;) are decoded.
  const named = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: '\u00a0' };
  function decodeLabel(label) {
    return label.split(/<\/?br\s*\/?\s*>|\\n/i).map(line => line.replace(/&([a-z]+);|#([a-z0-9]+);/gi, (entity, html, code) => {
      const name = (html || code).toLowerCase();
      if (Object.hasOwn(named, name)) return named[name];
      if (html || !/^(x[0-9a-f]+|\d+)$/.test(name)) return entity;
      const value = name[0] === 'x' ? parseInt(name.slice(1), 16) : Number(name);
      return value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : entity;
    })).join('\n');
  }
  for (let li = first; li < lines.length; li++) {
    const text = lines[li]; let p = 0;
    const skip = () => { while (/\s/.test(text[p] || '') && p < text.length) p++; };
    skip(); if (!text.slice(p) || text.startsWith('%%', p)) continue;
    if (!direction) {
      const h = text.slice(p).match(/^(?:(?:flowchart|graph)\s+(LR|RL|TB|TD|BT)|(stateDiagram-v2))\s*(?=;|%%|$)/);
      if (!h) fail(li + 1, 'Expected flowchart LR (or RL, TB, TD, BT) or stateDiagram-v2.');
      stateDiagram = Boolean(h[2]);
      direction = stateDiagram || h[1] === 'TD' ? 'TB' : h[1]; p += h[0].length;
    }
    if (stateDiagram) {
      // State transition labels run to the end of the line. In particular,
      // semicolons in Mermaid entity codes must not split statements.
      const body = text.slice(p).split('%%')[0].trim();
      if (!body || body === ';') continue;
      const endpoint = (id, start) => id === '[*]'
        ? node(start ? ':start' : ':end', start ? 'Start' : 'End', start ? 'start' : 'end')
        : node(id);
      let match;
      if ((match = body.match(/^direction\s+(LR|RL|TB|TD|BT)\s*;?$/))) {
        direction = match[1] === 'TD' ? 'TB' : match[1];
      } else if ((match = body.match(/^state\s+("(?:\\.|[^"\\])*")\s+as\s+([A-Za-z0-9_-]+)\s*;?$/))) {
        node(match[2], decodeLabel(unquote(match[1])), 'round');
      } else if ((match = body.match(/^(\[\*\]|[A-Za-z0-9_-]+)\s*-->\s*(\[\*\]|[A-Za-z0-9_-]+)(?:\s*:\s*(.*)|\s*;?)$/))) {
        edges.push({ from: endpoint(match[1], true), to: endpoint(match[2], false), label: decodeLabel((match[3] || '').trim()), arrow: true, startArrow: false, dotted: false });
        if (edges.length > maxEdges) fail(li + 1, 'Edge count exceeds maxEdges (' + maxEdges + ').');
      } else if ((match = body.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)$/))) {
        node(match[1], decodeLabel(match[2]), 'round');
      } else if ((match = body.match(/^([A-Za-z0-9_-]+)\s*;?$/))) {
        node(match[1]);
      } else {
        fail(li + 1, 'Unsupported state diagram syntax near ' + body.slice(0, 60));
      }
      continue;
    }
    function readLabel(close) {
      skip(); let result = '';
      if (text[p] === '"') {
        p++; let closed = false;
        while (p < text.length) {
          if (text[p] === '\\' && (text[p + 1] === '"' || text[p + 1] === '\\')) { result += text[p + 1]; p += 2; }
          else if (text[p] === '"') { p++; closed = true; break; }
          else result += text[p++];
        }
        if (!closed) fail(li + 1, 'Unclosed quoted label.');
        skip();
      } else {
        const start = p;
        while (p < text.length && text[p] !== close) p++;
        result = text.slice(start, p).trim();
      }
      if (text[p] !== close) fail(li + 1, 'Expected ' + close + ' after label.');
      p++; return result;
    }
    function readNode() {
      skip(); const m = text.slice(p).match(/^[A-Za-z0-9_]+(?:-(?!->)[A-Za-z0-9_]+)*/);
      if (!m) fail(li + 1, 'Expected node ID near ' + text.slice(p, p + 40));
      const id = m[0]; p += id.length; skip();
      const opening = text[p], close = { '[': ']', '(': ')', '{': '}' }[opening];
      if (close) {
        p++;
        const circle = opening === '(' && text[p] === '(', cylinder = opening === '[' && text[p] === '(';
        if (circle || cylinder) p++;
        const label = readLabel(cylinder ? ')' : close);
        if (circle || cylinder) {
          if (text[p] !== close) fail(li + 1, circle ? 'Expected )) after circle label.' : 'Expected )] after cylinder label.');
          p++;
        }
        return node(id, decodeLabel(label), circle ? 'circle' : cylinder ? 'cylinder' : opening === '(' ? 'round' : opening === '{' ? 'diamond' : 'rect');
      }
      return node(id);
    }
    while (p < text.length) {
      skip(); if (text.startsWith('%%', p)) break;
      if (text[p] === ';') { p++; continue; }
      const directive = text.slice(p).match(/^(subgraph|end|classDef|class|direction)\b/);
      if (directive) {
        const kind = directive[1]; p += kind.length; skip();
        if (kind === 'subgraph') {
          const match = text.slice(p).match(/^([A-Za-z0-9_-]+)(?:\s*\[\s*("(?:\\.|[^"\\])*"|[^\]]*)\s*\])?\s*(?=;|%%|$)/);
          if (!match) fail(li + 1, 'Expected subgraph ID["Label"].');
          if (groupIds.has(match[1])) fail(li + 1, 'Duplicate subgraph ID: ' + match[1]);
          groupIds.add(match[1]);
          subgraphs.push({ id: match[1], label: decodeLabel(unquote((match[2] ?? match[1]).trim())).replace(/\n/g, ' '), parent: groupStack.at(-1), line: li + 1 });
          groupStack.push(subgraphs.length - 1); p += match[0].length;
        } else if (kind === 'direction') {
          const match = text.slice(p).match(/^(LR|RL|TB|TD|BT)\s*(?=;|%%|$)/);
          if (!match) fail(li + 1, 'Expected direction LR (or RL, TB, TD, BT).');
          if (!groupStack.length) fail(li + 1, 'Flowchart direction directives must be inside a subgraph.');
          // The band layout uses the root direction for every group. Accept
          // local declarations without changing the enclosing graph's direction.
          subgraphs[groupStack.at(-1)].direction = match[1] === 'TD' ? 'TB' : match[1];
          p += match[0].length;
        } else if (kind === 'end') {
          if (!groupStack.length) fail(li + 1, 'Unexpected subgraph end.');
          groupStack.pop();
        } else {
          const end = text.indexOf(';', p), comment = text.indexOf('%%', p);
          const stop = Math.min(end < 0 ? text.length : end, comment < 0 ? text.length : comment);
          const body = text.slice(p, stop).trim();
          if (kind === 'classDef') {
            const match = body.match(/^([A-Za-z0-9_-]+)\s+(.+)$/);
            if (!match) fail(li + 1, 'Expected classDef name fill:color,stroke:color,color:color.');
            const style = {};
            for (const entry of match[2].split(',')) {
              const property = entry.trim().match(/^(fill|stroke|color)\s*:\s*(#[0-9a-fA-F]{3,8}|[A-Za-z]+)$/);
              if (!property) fail(li + 1, 'Supported class properties: fill, stroke, color with hex or named colors.');
              style[property[1]] = property[2];
            }
            classDefs.set(match[1], style);
          } else {
            const match = body.match(/^([A-Za-z0-9_-]+(?:\s*,\s*[A-Za-z0-9_-]+)*)\s+([A-Za-z0-9_-]+)$/);
            if (!match) fail(li + 1, 'Expected class node1,node2 className.');
            assignments.push({ ids: match[1].split(/\s*,\s*/), name: match[2], line: li + 1 });
          }
          p = stop;
        }
        skip();
        if (p < text.length && text[p] !== ';' && !text.startsWith('%%', p)) fail(li + 1, 'Unsupported syntax near ' + text.slice(p));
        continue;
      }
      let from = readNode(); skip();
      while (text.startsWith('<-->', p) || text.startsWith('--', p) || text.startsWith('-.', p)) {
        let arrow = true, startArrow = false, dotted = false, label = '';
        if (text.startsWith('<-->', p)) { startArrow = true; p += 4; }
        else if (text.startsWith('-.', p)) {
          dotted = true;
          if (text.startsWith('-.->', p)) p += 4;
          else if (text.startsWith('-.-', p)) { arrow = false; p += 3; }
          else {
            // Mermaid-style dotted edges can enclose a plain text label.
            const match = text.slice(p).match(/^-\.\s+(.+?)\s+\.(->|-)/);
            if (!match) fail(li + 1, 'Expected dotted edge: -.-> or -. label .->');
            label = match[1].trim(); arrow = match[2] === '->'; p += match[0].length;
          }
        } else if (text.startsWith('-->', p) || text.startsWith('---', p)) {
          arrow = text.startsWith('-->', p); p += 3;
        } else {
          const match = text.slice(p).match(/^--\s+("(?:\\.|[^"\\])*"|.+?)\s+-->/);
          if (!match) fail(li + 1, 'Expected labeled edge: -- "label" -->');
          label = match[1]; p += match[0].length;
        }
        skip();
        if (text[p] === '|') {
          if (label) fail(li + 1, 'Use either an inline label or a |label| on an edge.');
          p++; const end = text.indexOf('|', p); if (end < 0) fail(li + 1, 'Unclosed edge label.'); label = text.slice(p, end); p = end + 1;
        }
        label = decodeLabel(unquote(label.trim()));
        const to = readNode(); edges.push({ from, to, label, arrow, startArrow, dotted });
        if (edges.length > maxEdges) fail(li + 1, 'Edge count exceeds maxEdges (' + maxEdges + ').');
        from = to; skip();
      }
      if (p < text.length && text[p] !== ';' && !text.startsWith('%%', p)) fail(li + 1, 'Unsupported syntax near ' + text.slice(p, p + 60));
    }
  }
  if (groupStack.length) fail(subgraphs[groupStack[0]].line, 'Unclosed subgraph. Expected end.');
  for (const assignment of assignments) {
    const style = classDefs.get(assignment.name);
    if (!style) fail(assignment.line, 'Unknown class: ' + assignment.name);
    for (const id of assignment.ids) {
      const target = ids.has(id) ? nodes[ids.get(id)] : subgraphs.find(group => group.id === id);
      if (!target) fail(assignment.line, 'Unknown class target: ' + id);
      target.style = { ...target.style, ...style };
    }
  }
  if (!direction || !nodes.length) throw new Error('Enter a flowchart or stateDiagram-v2 header and at least one node.');
  // Iterative Kosaraju groups cycles without exhausting the call stack.
  const n = nodes.length, out = Array.from({ length: n }, () => []), incoming = Array.from({ length: n }, () => []);
  for (const e of edges) { out[e.from].push(e.to); incoming[e.to].push(e.from); }
  const seen = new Uint8Array(n), finish = [];
  for (let i = 0; i < n; i++) {
    if (seen[i]) continue;
    seen[i] = 1; const stack = [[i, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1], adjacent = out[top[0]];
      if (top[1] < adjacent.length) { const v = adjacent[top[1]++]; if (!seen[v]) { seen[v] = 1; stack.push([v, 0]); } }
      else { finish.push(top[0]); stack.pop(); }
    }
  }
  const component = new Int32Array(n).fill(-1); let count = 0;
  for (let k = finish.length - 1; k >= 0; k--) {
    const v = finish[k]; if (component[v] !== -1) continue;
    const stack = [v]; component[v] = count;
    while (stack.length) { const u = stack.pop(); for (const w of incoming[u]) if (component[w] === -1) { component[w] = count; stack.push(w); } }
    count++;
  }
  const successors = Array.from({ length: count }, () => new Set()), indegree = new Int32Array(count), ranks = new Int32Array(count);
  for (const e of edges) { const a = component[e.from], b = component[e.to]; if (a !== b && !successors[a].has(b)) { successors[a].add(b); indegree[b]++; } }
  const queue = []; for (let c = 0; c < count; c++) if (!indegree[c]) queue.push(c);
  for (let q = 0; q < queue.length; q++) { const c = queue[q]; for (const d of successors[c]) { ranks[d] = Math.max(ranks[d], ranks[c] + 1); if (!--indegree[d]) queue.push(d); } }
  const layers = [];
  nodes.forEach((v, i) => { v.rank = ranks[component[i]]; (layers[v.rank] ||= []).push(i); });
  if (subgraphs.length) {
    // Keep each group's contents in consecutive bands, including nested groups.
    // Bounded rows keep large ownership diagrams usable at ordinary zoom levels.
    layers.length = 0;
    function bands(parent) {
      const members = nodes.map((v, i) => i).filter(i => nodes[i].group === parent);
      for (let i = 0; i < members.length; i += 4) layers.push(members.slice(i, i + 4));
      subgraphs.forEach((group, i) => { if (group.parent === parent) bands(i); });
    }
    bands(undefined);
    layers.forEach((layer, rank) => layer.forEach(i => { nodes[i].rank = rank; }));
  }
  const order = new Float64Array(n); layers.forEach(layer => layer.forEach((v, i) => order[v] = i));
  for (let pass = 0; pass < 4; pass++) {
    const forward = pass % 2 === 0;
    for (let step = 0; step < layers.length; step++) {
      const r = forward ? step : layers.length - 1 - step, layer = layers[r], scores = new Map();
      for (const v of layer) { const neighbors = (forward ? incoming[v] : out[v]).filter(w => forward ? nodes[w].rank < r : nodes[w].rank > r); scores.set(v, neighbors.length ? neighbors.reduce((sum, w) => sum + order[w], 0) / neighbors.length : order[v]); }
      layer.sort((a, b) => scores.get(a) - scores.get(b) || a - b); layer.forEach((v, i) => order[v] = i);
    }
  }
  function wrap(label) {
    const result = [];
    for (const paragraph of label.split('\n')) {
      let rest = paragraph;
      while (rest.length > 28) { let cut = rest.lastIndexOf(' ', 28); if (cut < 8) cut = 28; result.push(rest.slice(0, cut)); rest = rest.slice(cut).trimStart(); }
      result.push(rest);
    }
    return result;
  }
  const horizontal = direction === 'LR' || direction === 'RL';
  for (const v of nodes) { v.lines = wrap(v.label); v.w = 240; v.h = Math.max(64, v.lines.length * 17 + 28); if (v.shape === 'diamond') { v.w = 300; v.h *= 1.65; } if (v.shape === 'cylinder') v.h += 20; }
  for (const v of nodes) if (v.shape === 'start' || v.shape === 'end') { v.w = v.h = 24; v.lines = []; }
  for (const v of nodes) if (v.shape === 'circle') v.w = v.h = Math.max(64, v.lines.length * 17 + 28, ...v.lines.map(line => Array.from(line).length * 9 + 28));
  const layerSizes = layers.map(layer => ({ depth: layer.reduce((m, i) => Math.max(m, horizontal ? nodes[i].w : nodes[i].h), 0), breadth: layer.reduce((sum, i) => sum + (horizontal ? nodes[i].h : nodes[i].w) + 32, 0) - 32 }));
  const outgoingLanes = new Int32Array(layers.length), incomingLanes = new Int32Array(layers.length);
  let longEdges = 0;
  for (const e of edges) {
    const from = nodes[e.from].rank, to = nodes[e.to].rank;
    outgoingLanes[from]++;
    incomingLanes[to]++;
    if (to !== from + 1) longEdges++;
  }
  const groupDepth = subgraphs.reduce((max, group) => {
    let depth = 1, parent = group.parent;
    while (parent !== undefined) { depth++; parent = subgraphs[parent].parent; }
    return Math.max(max, depth);
  }, 0);
  const groupPadding = groupDepth * 48;
  const outerMargin = 40 + longEdges * 16 + groupPadding;
  const breadth = layerSizes.reduce((m, s) => Math.max(m, s.breadth), 0);
  let depth = 40 + groupPadding + 16 * incomingLanes[0], depthEnd = depth;
  layers.forEach((layer, r) => {
    let b = outerMargin + (breadth - layerSizes[r].breadth) / 2;
    for (const i of layer) {
      const v = nodes[i]; v.x = horizontal ? depth : b; v.y = horizontal ? b : depth;
      b += (horizontal ? v.h : v.w) + 32;
    }
    depthEnd = depth + layerSizes[r].depth;
    // Reserve separate tracks for outgoing and incoming connections.
    depth = depthEnd + Math.max(150, 64 + 16 * (outgoingLanes[r] + (incomingLanes[r + 1] || 0))) + groupPadding * 2;
  });
  const fullDepth = depthEnd + 40 + groupPadding + 16 * outgoingLanes[layers.length - 1];
  const width = horizontal ? fullDepth : breadth + outerMargin + 40 + groupPadding;
  const height = horizontal ? breadth + outerMargin + 40 + groupPadding : fullDepth;
  // Route in depth/breadth coordinates before mirroring the diagram. Every
  // layer has an empty channel after its widest node. Long edges use the
  // outer margin, so they cannot cut through intervening layers.
  const boxes = nodes.map(v => ({
    u: horizontal ? v.x : v.y, v: horizontal ? v.y : v.x,
    depth: horizontal ? v.w : v.h, breadth: horizontal ? v.h : v.w
  }));
  const channels = layers.map(layer => ({
    before: boxes[layer[0]].u - 24,
    after: layer.reduce((end, i) => Math.max(end, boxes[i].u + boxes[i].depth), 0) + 24
  }));
  function point(u, v) {
    let x = horizontal ? u : v, y = horizontal ? v : u;
    if (direction === 'RL') x = width - x;
    if (direction === 'BT') y = height - y;
    return { x, y };
  }
  const usedOutgoing = new Int32Array(layers.length), usedIncoming = new Int32Array(layers.length);
  // All connections of a node share one output bus and one input bus.
  // Input buses stay before the layer; output buses stay after it, even
  // for feedback, self-loops and connections within the same layer.
  const outputBus = new Map(), inputBus = new Map();
  for (const e of edges) {
    const fromRank = nodes[e.from].rank, toRank = nodes[e.to].rank;
    if (!outputBus.has(e.from)) outputBus.set(e.from, channels[fromRank].after + 16 * usedOutgoing[fromRank]++);
    if (!inputBus.has(e.to)) inputBus.set(e.to, channels[toRank].before - 16 * usedIncoming[toRank]++);
  }
  let usedOuter = 0;
  for (const e of edges) {
    const a = boxes[e.from], b = boxes[e.to];
    const fromRank = nodes[e.from].rank, toRank = nodes[e.to].rank;
    const av = a.v + a.breadth / 2, bv = b.v + b.breadth / 2;
    const exit = outputBus.get(e.from), entry = inputBus.get(e.to);
    let route;
    if (toRank === fromRank + 1) {
      // Bridge the two buses in the empty inter-layer channel.
      route = [[a.u + a.depth, av], [exit, av], [exit, bv], [entry, bv], [b.u, bv]];
    } else {
      const outer = 16 + 16 * usedOuter++;
      route = [[a.u + a.depth, av], [exit, av], [exit, outer],
      [entry, outer], [entry, bv], [b.u, bv]];
    }
    // Drop redundant points while keeping each turn exactly 90 degrees.
    const points = [];
    for (const [u, v] of route) {
      const p = point(u, v), last = points[points.length - 1];
      if (last && last.x === p.x && last.y === p.y) continue;
      while (points.length > 1) {
        const a = points[points.length - 2], b = points[points.length - 1];
        if (!((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y))) break;
        points.pop();
      }
      points.push(p);
    }
    e.points = points;
    // Place labels on the longest segment, away from the node ports.
    let longest = -1;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      if (length > longest) { longest = length; e.labelX = (a.x + b.x) / 2; e.labelY = (a.y + b.y) / 2; }
    }
  }
  for (const v of nodes) { if (direction === 'RL') v.x = width - v.x - v.w; if (direction === 'BT') v.y = height - v.y - v.h; }
  for (let i = subgraphs.length - 1; i >= 0; i--) {
    const group = subgraphs[i], contents = [...nodes.filter(v => v.group === i), ...subgraphs.filter(g => g.parent === i && g.w !== undefined)];
    if (!contents.length) continue;
    group.x = Math.min(...contents.map(v => v.x)) - 20;
    group.y = Math.min(...contents.map(v => v.y)) - 42;
    group.w = Math.max(...contents.map(v => v.x + v.w)) + 20 - group.x;
    group.h = Math.max(...contents.map(v => v.y + v.h)) + 20 - group.y;
  }
  return { nodes, edges, subgraphs, direction, width, height };
}
// Keep DOM setup separate so Node tests can load the graph builder directly.
function initializeEditor() {
  const $ = id => document.getElementById(id), source = $('source'), viewport = $('viewport'), scene = $('scene');
  const NS = 'http://www.w3.org/2000/svg';
  let worker = null, current = null, version = 0, view = { x: 0, y: 0, scale: 1 }, drag = null, renderTimer = null, selectedId = null;
  const example = `---
config:
  maxEdges: 20000
  maxTextSize: 1000000
---
flowchart LR
  %% A small expression graph
  n8["i_instruction / 32 bits"]
  n10["slice offset 28 / 4 bits"]
  n13["constant 1 / 4 bits"]
  n14["Eq / 1 bits"]
  n5["i_scratch / 64 bits"]
  n101["constant 1 / 64 bits"]
  n112["MUX / 64 bits"]
  out0["o_next_scratch / 64 bits"]
  n8 -->|value| n10
  n10 -->|lhs| n14
  n13 -->|rhs| n14
  n14 -->|select| n112
  n5 -->|true| n112
  n101 -->|false| n112
  n112 --> out0`;
  source.value = example;
  function el(tag, attrs = {}, text) { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; return e; }
  function error(message) { $('error').textContent = message; $('error').hidden = false; }
  function busy(value) { $('cancel').disabled = !value; }
  function updateView() { scene.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.scale})`); $('zoomLabel').textContent = (view.scale * 100 < 1 ? (view.scale * 100).toFixed(2) : Math.round(view.scale * 100)) + '%'; }
  function fit() { if (!current) return; const box = viewport.getBoundingClientRect(); view.scale = Math.min((box.width - 40) / current.width, (box.height - 40) / current.height, 1); view.scale = Math.max(view.scale, 0.000001); view.x = (box.width - current.width * view.scale) / 2; view.y = (box.height - current.height * view.scale) / 2; updateView(); }
  function zoom(factor, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2) { if (!current) return; const scale = Math.min(8, Math.max(.000001, view.scale * factor)); view.x = x - (x - view.x) * scale / view.scale; view.y = y - (y - view.y) * scale / view.scale; view.scale = scale; updateView(); }
  // Highlight the selected node and its immediate inputs and outputs.
  function selectNode(id) {
    selectedId = id;
    const index = current ? current.nodes.findIndex(v => v.id === id) : -1;
    const related = new Set([index]);
    if (index !== -1) for (const e of current.edges) {
      if (e.from === index || e.to === index) { related.add(e.from); related.add(e.to); }
    }
    scene.querySelectorAll('[data-node]').forEach(g => {
      const i = Number(g.getAttribute('data-node')), selected = i === index;
      g.setAttribute('opacity', index === -1 || related.has(i) ? 1 : .2);
      g.setAttribute('aria-pressed', String(selected));
      const shape = g.querySelector('rect, polygon, circle, path');
      shape.setAttribute('fill', selected ? '#365f62' : current.nodes[i].style?.fill || '#202f44');
      shape.setAttribute('stroke', selected ? '#9ff5cf' : index !== -1 && related.has(i) ? '#8cb9ff' : current.nodes[i].style?.stroke || '#87a9d7');
      shape.setAttribute('stroke-width', selected ? 3 : 1.3);
    });
    scene.querySelectorAll('[data-edge]').forEach(element => {
      const e = current.edges[Number(element.getAttribute('data-edge'))];
      const related = e.from === index || e.to === index;
      const input = e.to === index || (e.startArrow && e.from === index);
      const output = e.from === index || (e.startArrow && e.to === index);
      const kind = input && output ? 'both' : input ? 'input' : 'output';
      const color = kind === 'both' ? '#d6a4ff' : kind === 'input' ? '#8cb9ff' : '#ffc078';
      const highlighted = index !== -1 && related;
      element.setAttribute('opacity', index === -1 || related ? 1 : .15);
      if (element.tagName === 'path') {
        element.setAttribute('stroke', highlighted ? color : '#637c9c');
        element.setAttribute('stroke-width', highlighted ? 2.5 : 1.4);
        const marker = highlighted ? 'url(#arrow-' + kind + ')' : 'url(#arrow)';
        if (e.startArrow) element.setAttribute('marker-start', marker);
        if (e.arrow) element.setAttribute('marker-end', marker);
      } else element.setAttribute('fill', highlighted ? color : '#c3d5ec');
    });
  }
  function draw(graph) {
    drag = null;
    const fragment = document.createDocumentFragment(), defs = el('defs'), marker = el('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
    marker.append(el('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#849bb9' })); defs.append(marker); fragment.append(defs);
    for (const [kind, color] of [['input', '#8cb9ff'], ['output', '#ffc078'], ['both', '#d6a4ff']]) {
      const coloredMarker = el('marker', { id: 'arrow-' + kind, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
      coloredMarker.append(el('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: color }));
      defs.append(coloredMarker);
    }
    const groups = el('g');
    for (const group of graph.subgraphs || []) {
      if (group.w === undefined) continue;
      const g = el('g', { 'data-subgraph': group.id });
      g.append(el('rect', { x: group.x, y: group.y, width: group.w, height: group.h, rx: 10, fill: group.style?.fill || '#171e29', stroke: group.style?.stroke || '#536780', 'stroke-width': 1.3 }));
      g.append(el('text', { x: group.x + 14, y: group.y + 25, fill: group.style?.color || '#dce5f3', 'font-size': 14 }, group.label));
      groups.append(g);
    }
    fragment.append(groups);
    const edgeGroup = el('g', { fill: 'none', stroke: '#637c9c', 'stroke-width': 1.4, 'stroke-linejoin': 'miter' }), labels = el('g'), nodeGroup = el('g');
    graph.edges.forEach((e, edgeIndex) => {
      const d = e.points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
      const path = el('path', { d, 'data-edge': edgeIndex }); if (e.dotted) path.setAttribute('stroke-dasharray', '5 5'); if (e.startArrow) path.setAttribute('marker-start', 'url(#arrow)'); if (e.arrow) path.setAttribute('marker-end', 'url(#arrow)'); edgeGroup.append(path);
      if (e.label) {
        // Multi-line labels grow upward so the last line keeps its place above the segment.
        const lines = e.label.split('\n');
        const text = el('text', { 'data-edge': edgeIndex, x: e.labelX, y: e.labelY - 6 - (lines.length - 1) * 13, fill: '#c3d5ec', 'font-size': 11, 'text-anchor': 'middle', stroke: '#10141c', 'stroke-width': 4, 'paint-order': 'stroke', 'stroke-linejoin': 'round' });
        lines.forEach((line, i) => text.append(el('tspan', { x: e.labelX, dy: i ? 13 : 0 }, line))); labels.append(text);
      }
    });
    for (const [i, v] of graph.nodes.entries()) {
      const g = el('g', { 'data-node': i, tabindex: 0, role: 'button', 'aria-label': v.id + ': ' + v.label + '. Highlight connections', 'aria-pressed': 'false', style: 'cursor: pointer' }); g.append(el('title', {}, v.id + ': ' + v.label));
      const attrs = { fill: v.style?.fill || '#202f44', stroke: v.style?.stroke || '#87a9d7', 'stroke-width': 1.3 };
      if (v.shape === 'start' || v.shape === 'end') {
        g.append(el('circle', { ...attrs, cx: v.x + v.w / 2, cy: v.y + v.h / 2, r: v.w / 2 }));
        g.append(el('circle', { cx: v.x + v.w / 2, cy: v.y + v.h / 2, r: v.shape === 'start' ? v.w / 2 - 2 : 7, fill: '#87a9d7', 'pointer-events': 'none' }));
      }
      else if (v.shape === 'circle') g.append(el('circle', { ...attrs, cx: v.x + v.w / 2, cy: v.y + v.h / 2, r: v.w / 2 }));
      else if (v.shape === 'diamond') g.append(el('polygon', { ...attrs, points: `${v.x + v.w / 2},${v.y} ${v.x + v.w},${v.y + v.h / 2} ${v.x + v.w / 2},${v.y + v.h} ${v.x},${v.y + v.h / 2}` }));
      else if (v.shape === 'cylinder') {
        // Body outline with the bottom arc, then the visible front edge of the lid.
        const rx = v.w / 2, body = v.h - 20;
        g.append(el('path', { ...attrs, d: `M${v.x},${v.y + 10} a${rx},10 0 0 1 ${v.w},0 v${body} a${rx},10 0 0 1 ${-v.w},0 z m0,0 a${rx},10 0 0 0 ${v.w},0` }));
      }
      else g.append(el('rect', { ...attrs, x: v.x, y: v.y, width: v.w, height: v.h, rx: v.shape === 'round' ? 24 : 7 }));
      const text = el('text', { x: v.x + v.w / 2, y: v.y + v.h / 2 - (v.lines.length - 1) * 8.5 + 4 + (v.shape === 'cylinder' ? 5 : 0), fill: v.style?.color || '#e2ecfa', 'font-size': 13, 'text-anchor': 'middle' });
      v.lines.forEach((line, i) => text.append(el('tspan', { x: v.x + v.w / 2, dy: i ? 17 : 0 }, line))); g.append(text); nodeGroup.append(g);
    }
    fragment.append(edgeGroup, labels, nodeGroup); scene.replaceChildren(fragment);
    current = graph; for (const id of ['fit', 'minus', 'plus', 'actual', 'export']) $(id).disabled = false;
    selectNode(graph.nodes.some(v => v.id === selectedId) ? selectedId : null);
    fit();
  }
  function stop() { clearTimeout(renderTimer); renderTimer = null; version++; if (worker) worker.terminate(); worker = null; busy(false); }
  function render() {
    stop(); const token = version, started = performance.now(); $('error').hidden = true; busy(true); $('status').textContent = 'Parsing and laying out…';
    const program = 'const buildGraph=' + buildGraph.toString() + ';onmessage=e=>{try{postMessage({graph:buildGraph(e.data)})}catch(err){postMessage({error:err.message})}}';
    const url = URL.createObjectURL(new Blob([program], { type: 'text/javascript' }));
    try { worker = new Worker(url); } catch (err) { URL.revokeObjectURL(url); busy(false); error('Could not start the layout worker: ' + err.message); $('status').textContent = 'Render failed'; return; }
    URL.revokeObjectURL(url);
    worker.onmessage = e => {
      if (token !== version) return; worker.terminate(); worker = null;
      if (e.data.error) { busy(false); error(e.data.error); $('status').textContent = current ? 'Render failed · previous diagram shown' : 'Render failed'; return; }
      $('status').textContent = 'Drawing…';
      if (token !== version) return; try { draw(e.data.graph); $('status').textContent = `${current.nodes.length.toLocaleString()} nodes · ${current.edges.length.toLocaleString()} edges · ${((performance.now() - started) / 1000).toFixed(2)}s`; } catch (err) { error(err.message); $('status').textContent = 'Drawing failed'; } finally { busy(false); }
    };
    worker.onerror = e => { if (token !== version) return; stop(); error(e.message || 'Worker failed.'); $('status').textContent = 'Render failed'; };
    worker.postMessage(source.value);
  }
  function scheduleRender() {
    stop(); $('error').hidden = true; $('status').textContent = 'Waiting for typing…'; busy(true);
    renderTimer = setTimeout(render, 300);
  }
  $('cancel').onclick = () => { stop(); $('status').textContent = current ? 'Cancelled · previous diagram shown' : 'Cancelled'; };
  $('example').onclick = () => { source.value = example; render(); };
  source.addEventListener('input', scheduleRender);
  source.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); render(); } });
  $('file').onchange = async e => { const file = e.target.files[0]; if (!file) return; stop(); try { source.value = await file.text(); render(); } catch (err) { error('Could not read file: ' + err.message); } e.target.value = ''; };
  function download(text, type, name) { const url = URL.createObjectURL(new Blob([text], { type })), a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  $('saveSource').onclick = () => download(source.value, 'text/plain;charset=utf-8', 'diagram.mmd');
  $('export').onclick = () => { if (!current) return; const svg = el('svg', { xmlns: NS, viewBox: `-50 -50 ${current.width + 150} ${current.height + 150}`, width: current.width + 150, height: current.height + 150, 'font-family': 'system-ui, sans-serif' }); svg.append(el('rect', { x: -50, y: -50, width: current.width + 150, height: current.height + 150, fill: '#10141c' })); const clone = scene.cloneNode(true); clone.removeAttribute('transform'); svg.append(clone); download(new XMLSerializer().serializeToString(svg), 'image/svg+xml;charset=utf-8', 'diagram.svg'); };
  $('fit').onclick = fit; $('plus').onclick = () => zoom(1.3); $('minus').onclick = () => zoom(1 / 1.3); $('actual').onclick = () => zoom(1 / view.scale);
  viewport.addEventListener('wheel', e => { e.preventDefault(); const box = viewport.getBoundingClientRect(); zoom(Math.exp(-Math.max(-100, Math.min(100, e.deltaY)) * .002), e.clientX - box.left, e.clientY - box.top); }, { passive: false });
  viewport.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false, node: e.target.closest('[data-node]') };
    viewport.setPointerCapture(e.pointerId);
  });
  viewport.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) return;
    drag.moved = true;
    view.x += e.clientX - drag.x; view.y += e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY; updateView();
  });
  viewport.addEventListener('pointerup', e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved) {
      const id = drag.node ? current.nodes[Number(drag.node.getAttribute('data-node'))].id : null;
      selectNode(id === selectedId ? null : id);
    }
    drag = null;
  });
  for (const name of ['pointercancel', 'lostpointercapture']) viewport.addEventListener(name, () => drag = null);
  viewport.addEventListener('keydown', e => {
    const node = e.target.closest('[data-node]');
    if (node && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault(); const id = current.nodes[Number(node.getAttribute('data-node'))].id;
      selectNode(id === selectedId ? null : id); return;
    }
    if (e.key === 'Escape') { e.preventDefault(); selectNode(null); return; }
    const delta = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }[e.key]; if (delta) { e.preventDefault(); view.x += delta[0]; view.y += delta[1]; updateView(); } else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoom(1.3); } else if (e.key === '-') { e.preventDefault(); zoom(1 / 1.3); } else if (e.key.toLowerCase() === 'f') { e.preventDefault(); fit(); }
  });
  window.addEventListener('resize', () => { if (current) fit(); });
  render();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { buildGraph };
} else {
  initializeEditor();
}
