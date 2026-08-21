export function renderPackageDependencyJson(graph) {
  return `${JSON.stringify(graph, null, 2)}\n`;
}

export function renderPackageDependencyMermaid(graph) {
  const nodeId = new Map(graph.nodes.map((node, index) => [node.id, `p${index}`]));
  const groups = groupNodes(graph.nodes);
  const lines = [
    "flowchart LR",
    "    %% An arrow from A to B means A consumes B.",
  ];

  for (const [group, nodes] of groups) {
    lines.push(`    subgraph ${mermaidId(group)}["${escapeMermaid(groupLabel(group))}"]`);
    for (const node of nodes) {
      lines.push(
        `        ${nodeId.get(node.id)}["${escapeMermaid(shortName(node.id))}<br/>${escapeMermaid(node.component)}"]`,
      );
    }
    lines.push("    end");
  }

  for (const edge of graph.edges) {
    const from = nodeId.get(edge.from);
    const to = nodeId.get(edge.to);
    if (edge.declaration === "development") {
      lines.push(`    ${from} -. "dev" .-> ${to}`);
    } else if (edge.declaration === "undeclared") {
      lines.push(`    ${from} ==>|"undeclared"| ${to}`);
    } else if (edge.usage === "not-observed") {
      lines.push(`    ${from} -->|"declared"| ${to}`);
    } else {
      lines.push(`    ${from} --> ${to}`);
    }
  }

  lines.push(
    "    classDef harness fill:#dbeafe,stroke:#2563eb,color:#172554",
    "    classDef product fill:#dcfce7,stroke:#16a34a,color:#052e16",
    "    classDef tooling fill:#fef3c7,stroke:#d97706,color:#451a03",
  );
  for (const node of graph.nodes) {
    lines.push(`    class ${nodeId.get(node.id)} ${node.kind}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderPackageDependencyHtml(graph) {
  const serialized = JSON.stringify(graph).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Agent Anything Package Dependencies</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #172033;
      background: #f5f7fa;
    }
    * { box-sizing: border-box; }
    body { margin: 0; min-width: 720px; }
    header {
      display: flex;
      align-items: center;
      gap: 16px;
      min-height: 64px;
      padding: 12px 20px;
      border-bottom: 1px solid #cbd5e1;
      background: #ffffff;
    }
    h1 { margin: 0; font-size: 18px; font-weight: 680; letter-spacing: 0; white-space: nowrap; }
    .controls { display: flex; align-items: center; gap: 8px; flex: 1; }
    input, select, button {
      height: 36px;
      border: 1px solid #94a3b8;
      border-radius: 6px;
      background: #ffffff;
      color: #172033;
      font: inherit;
    }
    input { width: min(360px, 32vw); padding: 0 10px; }
    select { padding: 0 30px 0 10px; }
    button { padding: 0 12px; cursor: pointer; }
    button:hover { border-color: #2563eb; background: #eff6ff; }
    .summary { margin-left: auto; color: #475569; font-size: 13px; white-space: nowrap; }
    main { display: grid; grid-template-columns: minmax(0, 1fr) 320px; height: calc(100vh - 64px); }
    #viewport { overflow: auto; background: #f8fafc; }
    #graph { display: block; min-width: 100%; min-height: 100%; }
    aside { overflow: auto; padding: 18px; border-left: 1px solid #cbd5e1; background: #ffffff; }
    aside h2 { margin: 0 0 4px; font-size: 16px; letter-spacing: 0; overflow-wrap: anywhere; }
    aside h3 { margin: 20px 0 8px; font-size: 13px; text-transform: uppercase; color: #475569; letter-spacing: 0; }
    aside p { margin: 4px 0; color: #475569; font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
    aside ul { margin: 0; padding: 0; list-style: none; }
    aside li { padding: 7px 0; border-bottom: 1px solid #e2e8f0; font-size: 13px; overflow-wrap: anywhere; }
    .legend { display: grid; grid-template-columns: 12px 1fr; gap: 7px 8px; align-items: center; }
    .swatch { width: 12px; height: 3px; background: #64748b; }
    .swatch.dev { border-top: 2px dashed #c2410c; background: none; }
    .swatch.unused { background: #94a3b8; }
    .swatch.issue { background: #dc2626; }
    .edge { fill: none; stroke: #64748b; stroke-width: 1.35; opacity: 0.52; }
    .edge.development { stroke: #c2410c; stroke-dasharray: 7 5; }
    .edge.not-observed { stroke: #94a3b8; stroke-dasharray: 3 4; }
    .edge.undeclared { stroke: #dc2626; stroke-width: 2.2; }
    .edge.muted { opacity: 0.08; }
    .edge.active { opacity: 0.95; stroke-width: 2.3; }
    .node { cursor: pointer; outline: none; }
    .node rect { stroke-width: 1.3; rx: 6; }
    .node.harness rect { fill: #dbeafe; stroke: #2563eb; }
    .node.product rect { fill: #dcfce7; stroke: #16a34a; }
    .node.tooling rect { fill: #fef3c7; stroke: #d97706; }
    .node text { pointer-events: none; fill: #172033; letter-spacing: 0; }
    .node .name { font-size: 13px; font-weight: 700; }
    .node .meta { font-size: 11px; fill: #475569; }
    .node.muted { opacity: 0.18; }
    .node.active rect { stroke-width: 3; }
    .empty { font-size: 15px; fill: #64748b; }
    .issue-box { margin-top: 18px; padding: 10px; border: 1px solid #fecaca; border-radius: 6px; background: #fef2f2; color: #991b1b; font-size: 12px; }
  </style>
</head>
<body>
  <header>
    <h1>Package Dependencies</h1>
    <div class="controls">
      <input id="search" type="search" placeholder="Find package or component" aria-label="Find package or component">
      <select id="kind" aria-label="Repository kind">
        <option value="all">All kinds</option>
        <option value="harness">Harness</option>
        <option value="product">Product</option>
        <option value="tooling">Tooling</option>
      </select>
      <button id="reset" type="button">Reset focus</button>
    </div>
    <div id="summary" class="summary"></div>
  </header>
  <main>
    <div id="viewport"><svg id="graph" role="img" aria-label="Package dependency graph"></svg></div>
    <aside id="details"></aside>
  </main>
  <script>
    const data = ${serialized};
    const svg = document.getElementById("graph");
    const details = document.getElementById("details");
    const summary = document.getElementById("summary");
    const search = document.getElementById("search");
    const kind = document.getElementById("kind");
    const reset = document.getElementById("reset");
    const NS = "http://www.w3.org/2000/svg";
    const NODE_WIDTH = 238;
    const NODE_HEIGHT = 58;
    let focused = null;

    search.addEventListener("input", render);
    kind.addEventListener("change", render);
    reset.addEventListener("click", () => { focused = null; search.value = ""; kind.value = "all"; render(); });

    function render() {
      const query = search.value.trim().toLowerCase();
      const selectedKind = kind.value;
      const matches = new Set(data.nodes.filter(node =>
        (selectedKind === "all" || node.kind === selectedKind) &&
        (!query || [node.id, node.path, node.component, node.productId || "", node.role || ""]
          .some(value => value.toLowerCase().includes(query)))
      ).map(node => node.id));
      const connected = focused === null ? null : new Set([
        focused,
        ...data.edges.filter(edge => edge.from === focused).map(edge => edge.to),
        ...data.edges.filter(edge => edge.to === focused).map(edge => edge.from),
      ]);
      const visibleNodes = data.nodes.filter(node => matches.has(node.id));
      const visibleIds = new Set(visibleNodes.map(node => node.id));
      const visibleEdges = data.edges.filter(edge => visibleIds.has(edge.from) && visibleIds.has(edge.to));
      const positions = layout(visibleNodes, visibleEdges);
      const width = Math.max(900, ...[...positions.values()].map(item => item.x + NODE_WIDTH + 70));
      const height = Math.max(620, ...[...positions.values()].map(item => item.y + NODE_HEIGHT + 70));
      svg.setAttribute("viewBox", "0 0 " + width + " " + height);
      svg.setAttribute("width", width);
      svg.setAttribute("height", height);
      svg.replaceChildren();
      addMarkers();

      for (const edge of visibleEdges) drawEdge(edge, positions, connected);
      for (const node of visibleNodes) drawNode(node, positions.get(node.id), connected);
      if (visibleNodes.length === 0) {
        const label = element("text", { x: 32, y: 48, class: "empty" });
        label.textContent = "No packages match the current filter.";
        svg.append(label);
      }
      summary.textContent = visibleNodes.length + " packages / " + visibleEdges.length + " dependencies";
      showDetails(focused && visibleIds.has(focused) ? focused : null);
    }

    function layout(nodes, edges) {
      const dependencies = new Map(nodes.map(node => [node.id, []]));
      for (const edge of edges) dependencies.get(edge.from)?.push(edge.to);
      const memo = new Map();
      function level(name, visiting = new Set()) {
        if (memo.has(name)) return memo.get(name);
        if (visiting.has(name)) return 0;
        const next = new Set(visiting); next.add(name);
        const deps = dependencies.get(name) || [];
        const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(dep => level(dep, next)));
        memo.set(name, value);
        return value;
      }
      const columns = new Map();
      for (const node of nodes) {
        const value = level(node.id);
        if (!columns.has(value)) columns.set(value, []);
        columns.get(value).push(node);
      }
      const positions = new Map();
      for (const [column, members] of [...columns].sort((a, b) => a[0] - b[0])) {
        members.sort((a, b) => a.path.localeCompare(b.path));
        members.forEach((node, index) => positions.set(node.id, {
          x: 48 + column * 292,
          y: 42 + index * 86,
        }));
      }
      return positions;
    }

    function drawEdge(edge, positions, connected) {
      const from = positions.get(edge.from);
      const to = positions.get(edge.to);
      if (!from || !to) return;
      const sx = from.x;
      const sy = from.y + NODE_HEIGHT / 2;
      const tx = to.x + NODE_WIDTH;
      const ty = to.y + NODE_HEIGHT / 2;
      const bend = Math.max(46, Math.abs(sx - tx) * 0.48);
      const active = focused !== null && (edge.from === focused || edge.to === focused);
      const muted = connected !== null && !active;
      const usageClass = edge.usage === "not-observed" ? "not-observed" : "";
      const classes = ["edge", edge.declaration, usageClass, active ? "active" : "", muted ? "muted" : ""]
        .filter(Boolean).join(" ");
      const path = element("path", {
        d: "M " + sx + " " + sy + " C " + (sx - bend) + " " + sy + ", " + (tx + bend) + " " + ty + ", " + tx + " " + ty,
        class: classes,
        "marker-end": edge.declaration === "undeclared" ? "url(#arrow-issue)" : "url(#arrow)",
      });
      const title = element("title");
      title.textContent = edge.from + " -> " + edge.to + " (" + edge.declaration + ", " + edge.usage + ")";
      path.append(title);
      svg.append(path);
    }

    function drawNode(node, position, connected) {
      const active = node.id === focused;
      const muted = connected !== null && !connected.has(node.id);
      const group = element("g", {
        class: ["node", node.kind, active ? "active" : "", muted ? "muted" : ""].filter(Boolean).join(" "),
        transform: "translate(" + position.x + " " + position.y + ")",
        tabindex: "0",
      });
      group.append(element("rect", { width: NODE_WIDTH, height: NODE_HEIGHT }));
      const name = element("text", { x: 12, y: 23, class: "name" });
      name.textContent = node.id.replace("@agent-anything/", "");
      const meta = element("text", { x: 12, y: 43, class: "meta" });
      meta.textContent = [node.component, node.role].filter(Boolean).join(" / ");
      const title = element("title");
      title.textContent = node.id + "\\n" + node.path;
      group.append(name, meta, title);
      group.addEventListener("click", () => { focused = focused === node.id ? null : node.id; render(); });
      group.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault(); focused = focused === node.id ? null : node.id; render();
        }
      });
      svg.append(group);
    }

    function showDetails(packageName) {
      if (packageName === null) {
        details.innerHTML =
          '<h2>Dependency Explorer</h2>' +
          '<p>An arrow from A to B means A consumes B.</p>' +
          '<h3>Relationships</h3>' +
          '<div class="legend">' +
          '<span class="swatch"></span><p>Observed production declaration</p>' +
          '<span class="swatch dev"></span><p>Development or test declaration</p>' +
          '<span class="swatch unused"></span><p>Declared, no static source use observed</p>' +
          '<span class="swatch issue"></span><p>Undeclared Workspace import</p>' +
          '</div>' +
          '<p>Click a package to highlight its direct dependencies and consumers.</p>' +
          issueSummary();
        return;
      }
      const node = data.nodes.find(item => item.id === packageName);
      const dependencies = data.edges.filter(edge => edge.from === packageName);
      const consumers = data.edges.filter(edge => edge.to === packageName);
      details.replaceChildren();
      const title = document.createElement("h2"); title.textContent = node.id;
      const path = document.createElement("p"); path.textContent = node.path;
      const architecture = document.createElement("p");
      architecture.textContent = [node.kind, node.productId, node.component, node.role].filter(Boolean).join(" / ");
      details.append(title, path, architecture);
      details.append(listSection("Direct dependencies", dependencies, edge => edge.to));
      details.append(listSection("Direct consumers", consumers, edge => edge.from));
      const relatedIssues = data.issues.filter(issue => issue.from === packageName || issue.to === packageName);
      if (relatedIssues.length) {
        const box = document.createElement("div"); box.className = "issue-box";
        box.textContent = relatedIssues.map(issue => issue.message).join(" ");
        details.append(box);
      }
    }

    function listSection(label, edges, nameOf) {
      const section = document.createDocumentFragment();
      const heading = document.createElement("h3"); heading.textContent = label;
      const list = document.createElement("ul");
      if (edges.length === 0) {
        const item = document.createElement("li"); item.textContent = "None"; list.append(item);
      } else {
        for (const edge of edges) {
          const item = document.createElement("li");
          item.textContent = nameOf(edge) + " [" + edge.declaration + "; " + edge.usage + "]";
          list.append(item);
        }
      }
      section.append(heading, list);
      return section;
    }

    function issueSummary() {
      if (data.issues.length === 0) return "";
      return '<div class="issue-box">' + data.issues.length + ' dependency issue(s) are present in this view.</div>';
    }

    function addMarkers() {
      const defs = element("defs");
      defs.innerHTML =
        '<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b"/></marker>' +
        '<marker id="arrow-issue" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#dc2626"/></marker>';
      svg.append(defs);
    }

    function element(name, attributes = {}) {
      const item = document.createElementNS(NS, name);
      for (const [key, value] of Object.entries(attributes)) item.setAttribute(key, value);
      return item;
    }

    render();
  </script>
</body>
</html>
`;
}

export function renderPackageInspection(inspection) {
  const lines = [
    `Package: ${inspection.package.id}`,
    `Path: ${inspection.package.path}`,
    `Architecture: ${[
      inspection.package.kind,
      inspection.package.productId,
      inspection.package.component,
      inspection.package.role,
    ].filter(Boolean).join(" / ")}`,
    "",
  ];
  appendEdgeList(lines, "Direct dependencies", inspection.directDependencies, "to");
  appendEdgeList(lines, "Direct consumers", inspection.directConsumers, "from");
  appendNameList(lines, "Transitive dependencies", inspection.transitiveDependencies);
  appendNameList(lines, "Transitive consumers", inspection.transitiveConsumers);
  return `${lines.join("\n")}\n`;
}

function appendEdgeList(lines, heading, edges, property) {
  lines.push(`${heading} (${edges.length}):`);
  if (edges.length === 0) {
    lines.push("  (none)", "");
    return;
  }
  for (const edge of edges) {
    lines.push(`  - ${edge[property]} [${edge.declaration}; ${edge.usage}]`);
  }
  lines.push("");
}

function appendNameList(lines, heading, names) {
  lines.push(`${heading} (${names.length}):`);
  if (names.length === 0) {
    lines.push("  (none)", "");
    return;
  }
  for (const name of names) lines.push(`  - ${name}`);
  lines.push("");
}

function groupNodes(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    const key = node.kind === "product" ? `product:${node.productId}` : node.kind;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function groupLabel(group) {
  if (group === "harness") return "Harness";
  if (group === "tooling") return "Tooling";
  if (group.startsWith("product:")) return `Product: ${group.slice("product:".length)}`;
  return group;
}

function shortName(packageName) {
  return packageName.replace("@agent-anything/", "");
}

function mermaidId(value) {
  return `g_${value.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

function escapeMermaid(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}
