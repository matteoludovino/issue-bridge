/**
 * Grafo dirigido mínimo para detecção de ciclos no Planner.
 * Sem dependências externas e sem I/O — mantém `buildPlan` puro.
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
 * Retorna os componentes fortemente conexos que contêm ciclo (tamanho > 1 ou
 * self-loop), via Tarjan. Cada componente vem ordenado alfabeticamente para que
 * a saída do Planner seja determinística.
 *
 * A recursão tem profundidade igual à do DFS — aceitável porque os grafos aqui
 * são de hierarquia de issues (rasos), não grafos arbitrários.
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

  // Iterar só as chaves basta: todo nó em ciclo tem aresta de saída.
  for (const node of [...graph.keys()].sort()) {
    if (!index.has(node)) strongConnect(node);
  }

  return cyclic;
}
