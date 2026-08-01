import type { IssueModel } from '../models/issue-model.js';

export interface ExtractOptions {
  /** Escopo a extrair, no formato da plataforma (`owner/repo`). */
  identifier: string;
  includeClosed?: boolean;
  /**
   * Extrai apenas itens alterados a partir deste instante (ISO 8601). É a base
   * do `sync`: sem isso, cada execução relê o projeto inteiro.
   *
   * O filtro é por data de ALTERAÇÃO, então comentário novo em issue antiga vem
   * junto com a issue-mãe.
   */
  updatedSince?: string;
  /** Extrai apenas issues que tenham ao menos um destes rótulos. */
  labelFilter?: string[];
  /** Teto de segurança para execuções exploratórias. */
  maxItems?: number;
}

/**
 * Porta de leitura. Um novo conector (GitLab, Linear, Notion) implementa apenas
 * esta interface — nenhuma linha de `src/core/` muda.
 *
 * Contrato:
 *  - Credenciais são injetadas na construção do adapter; o core nunca as vê.
 *  - Toda tradução payload-nativo → `IssueModel` acontece aqui, validada com Zod.
 *  - Falhas são lançadas como `MigrationError` (ver `src/core/errors.ts`).
 */
export interface SourceAdapter {
  /** Identificador da plataforma (`github`). Aparece em `SourceRef.platform`. */
  readonly platformName: string;

  authenticate(): Promise<void>;

  extract(options: ExtractOptions): Promise<IssueModel>;
}
