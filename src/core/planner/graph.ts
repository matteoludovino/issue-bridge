/**
 * Minimal directed graph for cycle detection in the Planner.
 * No external dependencies and no I/O — keeps `buildPlan` pure.
 */
export type DirectedGraph = Map<string, Set<string>>;

export function addEdge(graph: DirectedGraph, from: string, to: string): void {
  const targets = graph.get(from);
  if (targets === undefined) {
    graph.set(from, new Set([to]));
    return;
  }
  targets.add(to);
}

/**
 * Returns the strongly connected components that contain a cycle (size > 1 or
 * a self-loop), using Tarjan's algorithm. Each component is sorted
 * alphabetically so the Planner's output is deterministic.
 *
 * Recursion depth equals the DFS depth — acceptable because the graphs here
 * are (shallow) issue hierarchies, not arbitrary graphs.
 */
export function findCyclicComponents(graph: DirectedGraph): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cyclic: string[][] = [];

  const strongConnect = (node: string): void => {
    index.set(node, counter);
    lowLink.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) {
        strongConnect(next);
        lowLink.set(node, Math.min(lowLink.get(node) ?? 0, lowLink.get(next) ?? 0));
      } else if (onStack.has(next)) {
        lowLink.set(node, Math.min(lowLink.get(node) ?? 0, index.get(next) ?? 0));
      }
    }

    if (lowLink.get(node) !== index.get(node)) return;

    const component: string[] = [];
    let popped: string | undefined;
    do {
      popped = stack.pop();
      if (popped === undefined) break;
      onStack.delete(popped);
      component.push(popped);
    } while (popped !== node);

    const hasSelfLoop = graph.get(node)?.has(node) ?? false;
    if (component.length > 1 || hasSelfLoop) {
      cyclic.push([...component].sort());
    }
  };

  // Iterating over the keys alone is enough: every node in a cycle has an outgoing edge.
  for (const node of [...graph.keys()].sort()) {
    if (!index.has(node)) strongConnect(node);
  }

  return cyclic;
}
